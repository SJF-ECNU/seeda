import { randomUUID } from 'node:crypto';
import type { Tool, ToolContext } from '../core/types.ts';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');
function files(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(name => !text(name) || /[\r\n]/.test(name) || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('Invalid ' + label);
  const names = value as string[];
  if (names.some((name, i) => names.slice(i + 1).some(other => name === other || name.startsWith(other + '/') || other.startsWith(name + '/')))) throw new Error('Overlapping ' + label);
  return names;
}
function argv(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || !text(value[0]) || value.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid command argv');
  return value as string[];
}
const helpers = `
set -eu
umask 077
safe_file() {
  local base="$1" name="$2" part path="$1"
  [[ -d "$base" && ! -L "$base" && "$name" != /* && "$name" != *$'\n'* && "$name" != *$'\r'* ]] || return 1
  local parts=()
  IFS=/ read -r -a parts <<< "$name"
  [[ "$name" != */ && "$name" != *//* && "$name" != "" ]] || return 1
  for part in "\${parts[@]}"; do
    [[ "$part" != "" && "$part" != . && "$part" != .. ]] || return 1
    path="$path/$part"
    [[ ! -L "$path" ]] || return 1
  done
  [[ -f "$path" ]]
}
copy_file() {
  safe_file "$1" "$3" || { printf 'Invalid or symlink source: %s\n' "$3" >&2; exit 1; }
  mkdir -p -- "$2/$(dirname -- "$3")"
  cp -P -- "$1/$3" "$2/$3"
}
`;

export class VerificationTool implements Tool {
  readonly definition = {
    type: 'function' as const,
    function: {
      name: 'verify',
      description: 'Preserve selected untouched inputs once (capture), then test an explicit candidate in a fresh work directory (run). Uses the existing Bash execution environment and timeout. Pass target/check argv directly, not a wrapper that masks exit status. Passed requires target and every check exit 0 and all artifacts present; this is local verification, not an official score or a security sandbox. Keep earlier candidate copies after regressions. Without a passing attempt, report unresolved requirements honestly.',
      parameters: { type: 'object', properties: {
        operation: { type: 'string', enum: ['capture', 'run'] }, record_dir: { type: 'string' },
        source_dir: { type: 'string' }, inputs: { type: 'array', items: { type: 'string' } },
        candidate_source: { type: 'string' }, candidates: { type: 'array', items: { type: 'string' } },
        command: { type: 'array', items: { type: 'string' } }, checks: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        artifacts: { type: 'array', items: { type: 'string' } }, hypothesis: { type: 'string' },
        timeout: { type: 'number', description: 'Existing Bash timeout in seconds; default 30, no new experiment budget' },
      }, required: ['operation', 'record_dir'], additionalProperties: false },
    },
  };
  private readonly bash: Tool;
  constructor(bash: Tool) { this.bash = bash; }
  async execute(args: unknown, context: ToolContext): Promise<unknown> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Verification parameters must be an object');
    const input = args as Record<string, unknown>;
    const capture = input.operation === 'capture';
    const keys = capture ? ['operation', 'record_dir', 'source_dir', 'inputs', 'timeout'] : ['operation', 'record_dir', 'candidate_source', 'candidates', 'command', 'checks', 'artifacts', 'hypothesis', 'timeout'];
    if ((!capture && input.operation !== 'run') || Object.keys(input).some(key => !keys.includes(key)) || !text(input.record_dir) ||
      (input.timeout !== undefined && (typeof input.timeout !== 'number' || !Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > 3600))) throw new Error('Invalid verification parameters');
    const marker = 'SEEDA_VERIFY_' + randomUUID() + ':';
    const attempt = 'attempt-' + randomUUID();
    let script = helpers;
    let attemptPath: string | undefined;
    if (capture) {
      if (!text(input.source_dir)) throw new Error('source_dir is required');
      const selected = files(input.inputs, 'inputs');
      script += '\nsource=' + quote(input.source_dir) + '\nrecord=' + quote(input.record_dir) + '\n';
      script += '[[ -d "$source" && ! -L "$source" ]]\n';
      script += selected.map(name => 'safe_file "$source" ' + quote(name)).join('\n') + '\n';
      script += 'mkdir -- "$record"\nmkdir -- "$record/inputs"\n';
      script += selected.map(name => 'copy_file "$source" "$record/inputs" ' + quote(name)).join('\n') + '\n';
      script += 'printf \'%s\' ' + quote(selected.map(name => name + '\n').join('')) + ' > "$record/inputs.txt"\n';
      const result = JSON.stringify({ operation: 'capture', status: 'captured', record_dir: input.record_dir, source_dir: input.source_dir, inputs: selected });
      script += 'printf \'%s\\n\' ' + quote(result) + ' > "$record/capture.json"\nprintf \'%s\\n\' ' + quote(marker + result) + '\n';
    } else {
      if (!text(input.candidate_source) || !text(input.hypothesis)) throw new Error('candidate_source and hypothesis are required');
      const selected = files(input.candidates, 'candidates');
      const artifacts = files(input.artifacts, 'artifacts');
      const command = argv(input.command);
      if (!Array.isArray(input.checks)) throw new Error('checks must be argv arrays');
      const checks = input.checks.map(argv);
      if (!selected.length || !checks.length || !artifacts.length) throw new Error('At least one candidate, check and artifact are required');
      attemptPath = input.record_dir.replace(/\/$/, '') + '/' + attempt;
      script += '\nrecord_arg=' + quote(input.record_dir) + '\n[[ -d "$record_arg" && ! -L "$record_arg" ]]\nrecord=$(cd -- "$record_arg" && pwd -P)\n';
      script += 'safe_file "$record" capture.json\nsafe_file "$record" inputs.txt\n';
      script += 'attempt="$record/' + attempt + '"\nmkdir -- "$attempt"\nmkdir -- "$attempt/candidate" "$attempt/work"\n';
      script += 'printf \'%s\\n\' ' + quote(JSON.stringify(input)) + ' > "$attempt/spec.json"\n';
      script += 'printf \'%s\\n\' \'{"status":"incomplete","command_exit_code":null}\' > "$attempt/result.json"\n';
      script += 'while IFS= read -r name; do\n';
      for (const name of selected) script += '  [[ "$name" != ' + quote(name) + ' && "$name" != ' + quote(name + '/') + '* && ' + quote(name) + ' != "$name/"* ]] || { printf \'Candidate overlaps captured input: %s\\n\' "$name" >&2; exit 1; }\n';
      script += '  copy_file "$record/inputs" "$attempt/work" "$name"\ndone < "$record/inputs.txt"\nsource=' + quote(input.candidate_source) + '\n';
      script += '[[ -d "$source" && ! -L "$source" ]]\n';
      for (const name of selected) script += 'copy_file "$source" "$attempt/candidate" ' + quote(name) + '\ncopy_file "$attempt/candidate" "$attempt/work" ' + quote(name) + '\n';
      script += 'set +e\n(cd -- "$attempt/work" && ' + command.map(quote).join(' ') + ') > "$attempt/command.log" 2>&1\ntarget_code=$?\n';
      script += 'printf \'%s\\n\' "$target_code" > "$attempt/command.exit"\nset -e\ncodes=""\npassed=true\n[[ "$target_code" -eq 0 ]] || passed=false\n';
      checks.forEach((check, i) => {
        script += 'set +e\n(cd -- "$attempt/work" && ' + check.map(quote).join(' ') + ') > "$attempt/check-' + i + '.log" 2>&1\ncode=$?\n';
        script += 'printf \'%s\\n\' "$code" > "$attempt/check-' + i + '.exit"\nset -e\ncodes="$codes' + (i ? ',' : '') + '$code"\n[[ "$code" -eq 0 ]] || passed=false\n';
      });
      script += 'artifacts_ok=true\n';
      for (const name of artifacts) script += 'safe_file "$attempt/work" ' + quote(name) + ' || artifacts_ok=false\n';
      script += '[[ "$artifacts_ok" == true ]] || passed=false\nstatus=failed\n[[ "$passed" == true ]] && status=passed\n';
      script += 'printf \'{"status":"%s","command_exit_code":%s,"check_exit_codes":[%s],"artifacts_ok":%s}\\n\' "$status" "$target_code" "$codes" "$artifacts_ok" > "$attempt/result.json"\n';
      script += 'printf \'%s\' ' + quote(marker) + '\ncat "$attempt/result.json"\n[[ "$passed" == true ]]\n';
    }
    const execution = await this.bash.execute({ command: script, ...(input.timeout === undefined ? {} : { timeout: input.timeout }) }, context) as Record<string, unknown>;
    const lines = typeof execution.output === 'string' ? execution.output.split('\n').filter(line => line.startsWith(marker)) : [];
    let verification: unknown = { status: 'incomplete' };
    if (lines.length === 1 && execution.status !== 'cancelled' && execution.status !== 'timed_out') {
      try { verification = JSON.parse(lines[0].slice(marker.length)); } catch { /* No trustworthy terminal result. */ }
    }
    return { ...execution, record_dir: input.record_dir, ...(attemptPath ? { attempt_dir: attemptPath } : {}), verification };
  }
}
