import { execFile, fork } from 'node:child_process';
import type { ToolContext } from '../core/types.ts';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localCommand, runCommand, type CommandExecutor } from '../tools/command.ts';

export type ExecutionEnvironment = { kind: 'local' } | { kind: 'docker'; container: string; cwd: string };
const exec = promisify(execFile);

// A per-command marker follows ordinary descendants, including setsid children.
// This is cleanup within the caller-owned task container, not a sandbox boundary.
const cleanup = `
matches() {
  for p in /proc/[0-9]*; do
    n=\${p##*/}; [[ $n -gt 1 ]] || continue
    [[ -r $p/environ ]] || continue
    if grep -zqxF -- "SEEDA_COMMAND_ID=$1" "$p/environ" 2>/dev/null; then
      state=$(awk '{print $3}' "$p/stat" 2>/dev/null)
      [[ $state == Z ]] || printf '%s\\n' "$n"
    fi
  done
}
for attempt in 1 2 3; do
  pids=$(matches "$1")
  [[ -n $pids ]] || exit 0
  kill -STOP $pids 2>/dev/null || :
  kill -KILL $pids 2>/dev/null || :
  sleep 0.05
done
[[ -z $(matches "$1") ]]
`;

export function commandExecutor(environment: ExecutionEnvironment, onProcess?: (pid: number, started: boolean) => void): CommandExecutor {
  if (environment.kind === 'local') return localCommand(16_384, onProcess);
  if (environment.kind !== 'docker' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(environment.container) ||
      typeof environment.cwd !== 'string' || !environment.cwd.startsWith('/')) throw new Error('Invalid Docker execution environment');
  // Copy configuration: the caller cannot change the target during an execution.
  const container = environment.container, base = environment.cwd;
  return (input, context) => {
    const cwd = posix.resolve(base, input.cwd ?? '.');
    const marker = randomUUID();
    return runCommand(input, context, {
      program: 'docker', cwd: context.cwd,
      args: ['exec', '-w', cwd, '-e', `SEEDA_COMMAND_ID=${marker}`, container,
        'timeout', '--signal=KILL', `${input.timeout ?? 30}s`, 'bash', '--noprofile', '--norc', '-o', 'pipefail', '-c', input.command],
      environment: { kind: 'docker', container, cwd }, artifactLocation: 'host',
      cleanup: async () => { await exec('docker', ['exec', container, 'bash', '--noprofile', '--norc', '-c', cleanup, 'seeda-cleanup', marker], { timeout: 10_000, maxBuffer: 16_384 }); },
    }, 16_384, onProcess);
  };
}

// Runs outside the Agent snapshot and survives supervisor death long enough to
// clean up. The candidate sandbox never receives this IPC endpoint.
export function executeManagedCommand(environment: ExecutionEnvironment, args: unknown, context: ToolContext): Promise<unknown> {
  context.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const guardian = fork(fileURLToPath(new URL('./command-guardian.ts', import.meta.url)), [], {
      execArgv: ['--experimental-strip-types'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let response: { result?: unknown; error?: string } | undefined;
    const cancel = () => { if (guardian.connected) guardian.send({ type: 'cancel' }, () => {}); };
    context.signal.addEventListener('abort', cancel, { once: true });
    guardian.on('message', message => { response = message as typeof response; });
    guardian.once('error', reject);
    guardian.once('exit', () => {
      context.signal.removeEventListener('abort', cancel);
      if (!response || response.error) reject(new Error(response?.error ?? 'Command guardian exited before reporting cleanup'));
      else resolve(response.result);
    });
    guardian.send({ type: 'execute', environment, args, cwd: context.cwd, artifacts: context.artifactDir }, () => {});
    if (context.signal.aborted) cancel();
  });
}
