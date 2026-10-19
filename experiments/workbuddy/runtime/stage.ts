import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { sessionMetrics } from './metrics.ts';

export const HOST = '/Users/shjf/.local/share/seeda/releases/experiment-unbudgeted-1017-162524';
import type { StageSpec } from './types.ts';

// The outer sandbox protects other projects and credentials. Native candidate isolation remains intact.
// Runtime write access is required by the native host and is not a tamper-proof evidence boundary.
export function stageProfile(spec: StageSpec, extraRead: string[] = []): string {
  if (spec.nativeEvidenceRoot && !['learn', 'work'].includes(spec.phase)) throw new Error('Native evidence root is only available during learning');
  if (spec.comparisonEvidencePaths?.length && !['learn', 'decision'].includes(spec.phase)) throw new Error('Comparison logs are only available during learning and decision');
  if (spec.semaphorePrefix && !/^\/sd-[0-9a-f]{16}$/.test(spec.semaphorePrefix)) throw new Error("Invalid semaphore namespace");
  const reads = [new URL("./python_support", import.meta.url).pathname,spec.hostPath ?? HOST, dirname(dirname(process.execPath)), '/System/Library', '/usr/lib', '/usr/share', '/usr/bin', '/bin', '/sbin', '/dev/null', '/dev/random', '/dev/urandom', '/Library/Developer/CommandLineTools', '/Applications/Xcode.app/Contents/Developer', '/Applications/Docker.app/Contents/Resources/bin', new URL(import.meta.url).pathname, new URL('./metrics.ts', import.meta.url).pathname, new URL('./types.ts', import.meta.url).pathname, spec.sourcePath, spec.nativeEvidenceRoot, (spec.dependenciesPath ?? new URL('./dependencies', import.meta.url).pathname), ...extraRead].filter((path): path is string => Boolean(path && existsSync(path))).map(path => realpathSync(path));
  const writes = [spec.runtimeRoot, spec.workspace, dirname(spec.resultPath), dirname(spec.eventsPath)].map(path => realpathSync(path));
  const ports = [new URL(spec.baseUrl).port, ...(spec.dockerHost ? [new URL(spec.dockerHost).port] : []), ...(spec.nativeEvaluateUrl ? [new URL(spec.nativeEvaluateUrl).port] : []), ...(spec.scoreUrl ? [new URL(spec.scoreUrl).port] : [])];
  return `(version 1)(deny default)
    (allow process-exec)(allow process-fork)(allow signal (target same-sandbox))(allow sysctl-read)(allow file-read-metadata)
    ${spec.semaphorePrefix ? `(allow ipc-posix-sem (ipc-posix-name-regex #"^${spec.semaphorePrefix}-"))` : ""}
    (allow mach-lookup (global-name "com.apple.system.logger"))
    (allow file-read* (literal "/") ${reads.map(path => `(subpath ${JSON.stringify(path)})`).join(' ')})
    (allow file-read* file-write* ${writes.map(path => `(subpath ${JSON.stringify(path)})`).join(' ')})
    (allow file-write-data (literal "/dev/null"))
    ${(spec.comparisonEvidencePaths ?? []).map(path => `(allow file-read-data (literal ${JSON.stringify(realpathSync(path))}))`).join('\n')}
    ${spec.yieldRequestPath ? `(allow file-read-data (literal ${JSON.stringify(realpathSync(spec.yieldRequestPath))}))` : ''}
    ${spec.commandProofPath ? `(allow file-read-data (literal ${JSON.stringify(spec.commandProofPath)}))` : ''}
    (allow network-bind (local unix-socket))
    (allow network-inbound (local unix-socket))
    ${ports.map(port => `(allow network-outbound (remote tcp "localhost:${port}"))`).join('\n')}`;
}

// Run one stage per OS process in production. No real credentials enter this process.
export async function runStage(spec: StageSpec) {
  const url = new URL(spec.baseUrl);
  if ('scoreUrl' in spec && spec.scoreUrl) { const scoring = new URL(spec.scoreUrl); if (scoring.protocol !== 'http:' || scoring.hostname !== '127.0.0.1' || scoring.username || scoring.password) throw new Error('Public scoring broker must be local and credential-free'); }
  if (spec.nativeEvaluateUrl) { const broker = new URL(spec.nativeEvaluateUrl); if (broker.protocol !== 'http:' || broker.hostname !== '127.0.0.1' || broker.username || broker.password) throw new Error('Native evaluation broker must be local and credential-free'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password) throw new Error('Stage requires the credential-free loopback accounting proxy');
  if (!['solve', 'learn', 'decision', 'work'].includes(spec.phase)) throw new Error('Invalid stage phase');
  if (spec.timeoutMs !== null && !(Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0)) throw new Error('Invalid stage timeout');
  if (!['solve', 'work'].includes(spec.phase) && spec.execution.kind !== 'local') throw new Error('Learning requires a separate local workspace');
  if (spec.phase === 'decision' && !spec.allowedEvaluationId) throw new Error('Decision requires the externally compared evaluation');
  for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) || /^(HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key)) delete process.env[key];
  process.env.PATH = [...(spec.dependenciesPath ? [join(spec.dependenciesPath, 'bin')] : []), dirname(process.execPath), '/Applications/Xcode.app/Contents/Developer/usr/bin', '/Library/Developer/CommandLineTools/usr/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/Applications/Docker.app/Contents/Resources/bin'].join(':');
  process.env.SEEDA_SEMAPHORE_PREFIX = spec.semaphorePrefix ?? '';
  process.env.PYTHONPATH = [new URL('./python_support', import.meta.url).pathname, join(spec.workspace, 'src'), (spec.dependenciesPath ?? new URL('./dependencies', import.meta.url).pathname)].join(':');
  process.env.PYTHONNOUSERSITE = '1';

  Object.assign(process.env, { DEVELOPER_DIR: '/Library/Developer/CommandLineTools', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', npm_config_offline: 'true', DEEPSEEK_API_KEY: 'stage-proxy-placeholder', DEEPSEEK_BASE_URL: spec.baseUrl, DEEPSEEK_MODEL: spec.model, SEEDA_THINKING: spec.thinking === false ? '0' : '1', SEEDA_SYSTEM_PROXY: '0' });
  delete process.env.SEEDA_YIELD_REQUEST_PATH; delete process.env.SEEDA_YIELD_AFTER_TOOLS;
  if (spec.yieldRequestPath) process.env.SEEDA_YIELD_REQUEST_PATH = spec.yieldRequestPath;
  if (spec.yieldAfterTools?.length) process.env.SEEDA_YIELD_AFTER_TOOLS = JSON.stringify(spec.yieldAfterTools);
  if (spec.dockerHost) {
    const dockerUrl = new URL(spec.dockerHost);
    if (dockerUrl.protocol !== 'tcp:' || dockerUrl.hostname !== '127.0.0.1') throw new Error('Docker access must use the task-limited loopback proxy');
    process.env.DOCKER_HOST = spec.dockerHost; delete process.env.DOCKER_CONTEXT;
  }
  const host = spec.hostPath ?? HOST;
  const { VersionStore } = await import(pathToFileURL(join(host, 'src/versions/store.ts')).href);
  const { Supervisor } = await import(pathToFileURL(join(host, 'src/runtime/supervisor.ts')).href);
  const { executeManagedCommand } = await import(pathToFileURL(join(host, 'src/runtime/execution.ts')).href);
  await mkdir(spec.workspace, { recursive: true });
  await mkdir(join(spec.workspace, '.seeda-tmp'), { recursive: true });
  process.env.TMPDIR = join(spec.workspace, '.seeda-tmp');
  process.env.TMP = process.env.TMPDIR;
  process.env.TEMP = process.env.TMPDIR;
  process.env.npm_config_cache = join(process.env.HOME!, '.npm');
  process.env.HOME = spec.workspace;
  process.env.npm_config_userconfig = join(spec.runtimeRoot, 'npm-user.conf');
  process.env.npm_config_globalconfig = join(spec.runtimeRoot, 'npm-global.conf');
  await writeFile(process.env.npm_config_userconfig, '', { mode: 0o600 });
  await writeFile(process.env.npm_config_globalconfig, '', { mode: 0o600 });
  await mkdir(dirname(spec.resultPath), { recursive: true });
  await mkdir(dirname(spec.eventsPath), { recursive: true });
  const startedAt = new Date().toISOString(); const started = performance.now();
  const sessionId = spec.sessionId ?? randomUUID();
  const log = (type: string, data: unknown) => appendFileSync(spec.eventsPath, JSON.stringify({ at: new Date().toISOString(), type, data }) + '\n', { mode: 0o600 });
  const store = await VersionStore.open(spec.runtimeRoot);
  const manager = new Supervisor(store, spec.workspace, spec.execution, {
    allowFallback: spec.phase === 'work',
    executeCommand: async (environment: any, args: any, context: any) => {
      // Explicit native draft cwd routes only self-code edits locally, inside the
      // same outer sandbox. Normal project commands stay in the task container.
      if (environment.kind === 'docker' && typeof args?.cwd === 'string' && args.cwd.startsWith(spec.runtimeRoot + '/drafts/')) {
        const localCwd = realpathSync(args.cwd);
        const drafts = store.db.prepare("SELECT path FROM drafts WHERE state='editing'").all() as Array<{path: string}>;
        if (!drafts.some(d => localCwd === realpathSync(d.path) || localCwd.startsWith(realpathSync(d.path) + '/'))) throw new Error('Local cwd must belong to an active native draft');
        return executeManagedCommand({kind: 'local'}, args, {...context, cwd: localCwd});
      }
      const probeEnvironment = async (commandResult?: any) => {
        if (context.signal.aborted) return;
        // Probe the same Docker environment as project commands. The code is trusted,
        // independent of project imports; dependency import paths are image-owned.
        const probeCommand = spec.execution.kind === 'docker'
          ? `cd /workspace && python3 -I -c 'import os,tempfile,subprocess; assert os.path.isdir("/workspace"); f=tempfile.TemporaryFile(); f.write(b"probe"); f.close(); assert subprocess.run(["/bin/sh","-c","exit 0"]).returncode == 0'`
          : `node -e 'require("node:fs").accessSync(process.cwd(), 6)'`;
        let probeResult: any;
        const probeStarted = performance.now();
        result.execution_probes ??= { count: 0, wall_time_seconds: 0 };
        result.execution_probes.count++;
        try {
          probeResult = await executeManagedCommand(environment, {
            command: probeCommand,
            timeout: 15,
          }, { ...context, cwd: spec.workspace });
        } catch (error) {
          log('execution_capability_probe_error', { command: commandResult, error: String(error) });
          if (!context.signal.aborted) executionFault('Trusted execution capability probe could not execute');
          throw error;
        } finally {
          result.execution_probes.wall_time_seconds += (performance.now() - probeStarted) / 1000;
        }
        log('execution_capability_probe', { command: commandResult, probe: probeResult });
        if (probeResult?.exit_code !== 0 && !context.signal.aborted) {
          executionFault('Trusted execution capability probe failed');
          throw new Error('Execution environment capability failed');
        }
      };
      if (!result.execution_probes) await probeEnvironment();
      let commandResult: any;
      try {
        commandResult = await executeManagedCommand(environment, args, context);
        return commandResult;
      } finally {
        // A later echo or an executor exception must not bypass environment classification.
        if (!context.signal.aborted && commandResult?.status !== 'cancelled') await probeEnvironment(commandResult);
      }
    },
    beforeResume: async () => {
      const checkLocal = () => {
        if (stageDeadline !== undefined && performance.now() >= stageDeadline) timedOut = true;
        if (signalled || timedOut) throw new Error('Recovery denied: original stage cancelled or expired');
        if (result.execution_failure) throw new Error('Recovery denied: execution environment failed');
      };
      checkLocal();
      if (spec.yieldRequestPath && existsSync(spec.yieldRequestPath)) {
        const pending = JSON.parse(readFileSync(spec.yieldRequestPath, 'utf8') || 'null');
        if (pending) {
          result.checkpoint_failure = { reason: 'pending_checkpoint_interrupted', request: pending };
          log('checkpoint_recovery_denied', result.checkpoint_failure);
          throw new Error('Recovery denied: pending checkpoint interrupted before external acknowledgement');
        }
      }
      const remaining = stageDeadline === undefined ? Infinity : stageDeadline - performance.now();
      let accounting;
      try {
        const response = await fetch(spec.baseUrl.replace(/\/$/, '') + '/recovery', { redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(5000, Math.ceil(remaining)))) });
        if (!response.ok) throw new Error(`Recovery accounting unavailable (${response.status})`);
        accounting = await response.json();
      } catch (error) { checkLocal(); throw error; }
      log('recovery_accounting', accounting);
      checkLocal();
      if (accounting.allowed !== true) {
        result.recovery_stop_reason = accounting.reason ?? 'accounting unavailable';
        recoveryBudgetExhausted = ['stage_attempt_budget', 'global_attempt_budget', 'global_token_budget', 'stage_deadline', 'global_deadline'].includes(result.recovery_stop_reason);
        throw new Error(`Recovery denied: ${result.recovery_stop_reason}`);
      }
    },
  }, spec.phase === 'work' ? null : undefined);
  const nativeManage = manager.manage.bind(manager);
  const nativeAbort = new AbortController();
  const management: any[] = [];
  const priorEvaluationIds = new Set(store.db.prepare('SELECT id FROM evaluations').all().map((row: any) => row.id));
  manager.manage = async (args: Record<string, unknown>, source?: string) => {
    const entry: any = { at: new Date().toISOString(), source: source ?? store.state().current_version, args };
    management.push(entry); log('management_start', entry);
    try {
      const operation = String(args.operation);
      const allowed = spec.phase === 'solve' ? [] : spec.formatCorrection ? ['status', 'evidence'] : spec.phase === 'learn' ? ['status', 'draft', 'submit', 'evaluate', 'evidence'] : spec.phase === 'decision' ? ['status', 'evidence', 'decide', 'promote', 'rollback'] : [];
      if (spec.phase !== 'work' && !allowed.includes(operation)) throw new Error(`Management ${operation} is disabled in ${spec.phase}`);
      if (spec.phase === 'decision' && ['evidence', 'decide', 'promote'].includes(operation) && args.evaluation !== spec.allowedEvaluationId) throw new Error('Decision must refer to the externally compared evaluation');
      if (operation === 'evaluate') {
        if (args.sandbox && args.sandbox !== 'process') throw new Error('Native candidate evaluation uses the process sandbox');
      }
      let value: unknown;
      if (operation === 'evaluate' && spec.nativeEvaluateUrl) {
        let response: { status: number; body: string };
        try {
          response = await new Promise((resolveResponse, reject) => {
            const request = httpRequest(spec.nativeEvaluateUrl!, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: nativeAbort.signal }, incoming => {
              let body = ''; incoming.setEncoding('utf8');
              incoming.on('data', data => { body += data; });
              incoming.on('error', reject);
              incoming.on('end', () => resolveResponse({ status: incoming.statusCode!, body }));
            });
            request.on('error', reject);
            request.end(JSON.stringify({ version: args.version, task: args.task, sandbox: 'process' }));
          });
        } catch (error) { if (!nativeAbort.signal.aborted) executionFault('Native evaluation broker connection failed'); throw error; }
        if (response.status >= 500) executionFault('Native evaluation host failed');
        if (response.status < 200 || response.status >= 300) throw new Error(`Native evaluation broker rejected request (${response.status}): ${response.body.slice(0, 2000)}`);
        value = JSON.parse(response.body);
        const imported = (value as any).import_record;
        if (imported) {
          try {
            if (imported.source_version !== source || imported.candidate_version !== args.version || !/^[a-zA-Z0-9-]+$/.test(imported.id)) throw new Error('Native evaluation import identity mismatch');
            const directory = join(spec.runtimeRoot, 'evaluations', imported.id);
            await mkdir(join(directory, 'sandbox'), { recursive: true });
            for (const [name, text] of Object.entries(imported.files)) {
              if (!['result.json', 'sandbox/session.jsonl'].includes(name) || typeof text !== 'string') throw new Error('Invalid native evidence projection');
              await writeFile(join(directory, name), text, { flag: 'wx', mode: 0o600 });
            }
            const evidence = join(directory, 'result.json');
            store.db.prepare('INSERT INTO evaluations(id,source_version,candidate_version,status,evidence_path) VALUES(?,?,?,?,?)').run(imported.id, imported.source_version, imported.candidate_version, imported.status, evidence);
            (value as any).evidence_path = evidence;
            delete (value as any).import_record;
          } catch (error) { executionFault('Native evaluation evidence import failed'); throw error; }
        }
      } else value = await nativeManage(args, source);
      if (operation === 'status') value = { ...value as Record<string, unknown>, drafts: store.db.prepare("SELECT * FROM drafts WHERE state='editing'").all() };
      entry.result = value; log('management_result', entry); return value;
    } catch (error) { entry.error = String(error); log('management_rejected', entry); throw error; }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stageDeadline: number | undefined;
  let recoveryBudgetExhausted = false;
  let timedOut = false, signalled = false, answer = '', error: string | undefined, before: any, after: any;
  const onSignal = () => { signalled = true; log('cancel', { reason: 'signal' }); nativeAbort.abort(); manager.cancel(); };
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  const result: any = { phase: spec.phase, started_at: startedAt, host, execution: spec.execution, workspace: spec.workspace, session_id: sessionId, runtime_root: spec.runtimeRoot, events_path: spec.eventsPath, source_version: spec.sourceVersion ?? null };
  const commandStarts = new Map<string, number>();
  const executionFault = (reason: string) => {
    result.execution_failure ??= { stage: 'execution_environment', reason };
    log('execution_environment_failure', result.execution_failure); manager.cancel();
  };
  const observe = (event: any) => {
    log('agent_event', event);
    if (spec.phase === 'work' && event.type === 'tool_end' && (['Cannot save tool output', 'Command environment cleanup failed'].includes(event.result?.error) || event.result?.error === 'Could not start command in the requested environment' && event.result?.environment?.cwd === spec.workspace)) executionFault(event.result.error);
    if (event.type === 'yielded') result.yield_request = { request_id: event.request_id, reason: event.reason };
    if (!spec.commandProofPath || !['bash', 'verify'].includes(event.call?.function?.name)) return;
    try {
      const proof = JSON.parse(readFileSync(spec.commandProofPath, 'utf8'));
      if (event.type === 'tool_start') commandStarts.set(event.call.id, proof.started);
      if (event.type === 'tool_end') {
        if (proof.failure) executionFault(proof.failure);
        else if (event.result?.environment?.kind === 'docker' && proof.started <= (commandStarts.get(event.call.id) ?? proof.started)) executionFault('Docker task command did not start');
        commandStarts.delete(event.call.id);
      }
    } catch { executionFault('Docker execution evidence unavailable'); }
  };
  try {
    if (!store.state().current_version) {
      if (!spec.sourcePath) throw new Error('Initial stage needs sourcePath');
      await store.initialize(spec.sourcePath);
    }
    if (!spec.resumeSession) store.db.prepare('UPDATE session_selection SET session=? WHERE id=1').run(sessionId);
    else if (store.db.prepare('SELECT session FROM session_selection WHERE id=1').get()?.session !== sessionId) throw new Error('Resume session must match learning session');
    await manager.start();
    if (spec.versionId && spec.versionId !== store.state().current_version) await manager.select(spec.versionId, 'experiment', 'Host-selected evaluation version');
    before = store.version(store.state().current_version!); log('stage_start', { ...result, actual_version: before });
    if (spec.timeoutMs !== null) {
      stageDeadline = started + spec.timeoutMs;
      timer = setTimeout(() => { timedOut = true; log('cancel', { reason: 'stage_timeout' }); nativeAbort.abort(); manager.cancel(); }, Math.max(1, stageDeadline - performance.now()));
    }
    if (signalled) throw new Error('Stage interrupted before model execution');
    answer = await manager.run(spec.prompt, observe);
  } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); log('stage_error', { error }); }
  finally {
    if (timer) clearTimeout(timer);
    nativeAbort.abort();
    after = store.state().current_version ? store.version(store.state().current_version!) : null;
    result.state_before_close = store.state();
    try { await manager.close(); } catch (failure) { result.cleanup_error = String(failure); }
    result.evaluations = store.db.prepare('SELECT * FROM evaluations').all().filter((row: any) => !priorEvaluationIds.has(row.id));
    result.all_evaluations = store.db.prepare('SELECT * FROM evaluations').all();
    result.versions = store.versions();
    result.drafts = store.db.prepare('SELECT * FROM drafts').all();
    result.switches = store.db.prepare('SELECT * FROM switches ORDER BY rowid').all();
    store.close(); process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal);
  }
  Object.assign(result, { ended_at: new Date().toISOString(), wall_ms: performance.now() - started, answer, error, timed_out: timedOut, signalled, version_before: before, version_after: after, management,
    execution_status: result.execution_failure ? 'failed' : timedOut || recoveryBudgetExhausted ? 'budget_exhausted' : signalled ? 'interrupted' : error || result.cleanup_error ? 'failed' : 'completed' });
  try { result.metrics = await sessionMetrics(join(spec.runtimeRoot, 'sessions', `${sessionId}.jsonl`)); }
  catch (failure) { result.metrics_error = String(failure); }
  result.candidate_metrics = [];
  for (const evaluation of result.evaluations) {
    try { result.candidate_metrics.push(await sessionMetrics(join(spec.runtimeRoot, 'evaluations', evaluation.id, 'sandbox/session.jsonl'))); }
    catch (failure) { result.candidate_metrics.push({ evaluation: evaluation.id, error: String(failure) }); }
  }
  log('stage_end', result);
  await writeFile(spec.resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  return result;
}

export interface NativeEvaluationSpec {
  candidateExecution?: {kind: string; container: string; cwd: string}; dockerHost?: string;
  hostPath?: string;
  runtimeRoot: string; workspace: string; sourceVersionId: string; candidateVersionId: string;
  importedVersions?: { current: string; versions: Array<{ id: string; parent_id: string | null; git_commit: string; runtime_path: string; reason: string }> };
  task: string; baseUrl: string; model: string; thinking?: boolean; resultPath: string; evaluationBudget?: { timeoutMs: number; maxModelCalls: number } | null;
}
export async function nativeEvaluate(spec: NativeEvaluationSpec) {
  const url = new URL(spec.baseUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Native evaluation requires local accounting proxy');
  for (const key of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) || /^(HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key)) delete process.env[key];
  process.env.PATH = [...(spec.dependenciesPath ? [join(spec.dependenciesPath, 'bin')] : []), dirname(process.execPath), '/Applications/Xcode.app/Contents/Developer/usr/bin', '/Library/Developer/CommandLineTools/usr/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  Object.assign(process.env, { DEVELOPER_DIR: '/Library/Developer/CommandLineTools', DEEPSEEK_API_KEY: 'stage-proxy-placeholder', DEEPSEEK_BASE_URL: spec.baseUrl, DEEPSEEK_MODEL: spec.model, SEEDA_THINKING: spec.thinking === false ? '0' : '1', SEEDA_SYSTEM_PROXY: '0' });
  const host = spec.hostPath ?? HOST;
  const { VersionStore } = await import(pathToFileURL(join(host, 'src/versions/store.ts')).href);
  const { Supervisor } = await import(pathToFileURL(join(host, 'src/runtime/supervisor.ts')).href);
  const { executeManagedCommand } = await import(pathToFileURL(join(host, 'src/runtime/execution.ts')).href);
  const store = await VersionStore.open(spec.runtimeRoot);
  if (spec.importedVersions) {
    for (const version of spec.importedVersions.versions) {
      // External snapshot paths are derived from version IDs, never loaded from Agent DB paths.
      const parent = spec.importedVersions.versions.some(item => item.id === version.parent_id) ? version.parent_id : null;
      store.db.prepare('INSERT INTO versions(id,parent_id,git_commit,runtime_path,reason) VALUES(?,?,?,?,?)').run(version.id, parent, version.git_commit, join(spec.runtimeRoot, 'versions', version.id), version.reason);
    }
    store.db.prepare('UPDATE runtime_state SET current_version=? WHERE id=1').run(spec.importedVersions.current);
  }
  if (spec.dockerHost) {
    const endpoint = new URL(spec.dockerHost);
    if (endpoint.protocol !== 'tcp:' || endpoint.hostname !== '127.0.0.1' || !spec.candidateExecution) throw new Error('Invalid isolated candidate execution');
    process.env.DOCKER_HOST = spec.dockerHost; delete process.env.DOCKER_CONTEXT;
    process.env.PATH += ':/Applications/Docker.app/Contents/Resources/bin';
  }
  let candidateExecutionFailure: string | undefined;
  const manager = new Supervisor(store, spec.workspace, { kind: 'local' }, {
    ...(spec.candidateExecution ? { candidateCommand: async (args: any, context: any) => {
      let value: unknown; let commandError: unknown;
      try { value = await executeManagedCommand(spec.candidateExecution, args, context); } catch (failure) { commandError = failure; }
      if (!context.signal.aborted) {
        try {
          const probe: any = await executeManagedCommand(spec.candidateExecution, {command: "python3 -I -c 'import tempfile; f=tempfile.TemporaryFile(); f.close()'", timeout: 15}, context);
          if (probe.exit_code !== 0) throw new Error('Candidate execution capability probe failed');
        } catch (failure) {
          candidateExecutionFailure = 'Candidate execution capability unavailable'; manager.cancel(); throw failure;
        }
      }
      if (commandError) throw commandError;
      return value;
    }} : {})
  }, spec.evaluationBudget);
  const existingEvaluations = new Set(store.db.prepare('SELECT id FROM evaluations').all().map((row: any) => row.id));
  const evaluationStarted = () => store.db.prepare('SELECT id FROM evaluations').all().some((row: any) => !existingEvaluations.has(row.id));
  let preflightRejected = false;
  const cancel = () => manager.cancel();
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  try {
    const target = store.versions().find(version => version.id === spec.candidateVersionId);
    if (store.state().current_version !== spec.sourceVersionId || !target || target.parent_id !== spec.sourceVersionId) { preflightRejected = true; throw new Error('Native evaluation source or candidate is stale'); }
    // Deliberately never start/recover/close another Supervisor: the stage retains its primary and socket.
    const nativeResult = await manager.manage({ operation: 'evaluate', version: spec.candidateVersionId, task: spec.task, sandbox: 'process' }, spec.sourceVersionId);
    const result = { ...nativeResult as Record<string, unknown>, evaluation_started: evaluationStarted(), validation_host: host, validation_host_scope: 'external_initial_seed', infrastructure_failure: Boolean(candidateExecutionFailure), execution_failure: candidateExecutionFailure, candidate_version: spec.candidateVersionId };
    await mkdir(dirname(spec.resultPath), { recursive: true });
    await writeFile(spec.resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
    return result;
  } catch (error) {
    await mkdir(dirname(spec.resultPath), { recursive: true });
    await writeFile(spec.resultPath, JSON.stringify({ status: 'failed', error: String(error), evaluation_started: evaluationStarted(), infrastructure_failure: !preflightRejected }, null, 2), { mode: 0o600 });
    throw error;
  } finally { process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel); store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--native-evaluate') {
    const spec = JSON.parse(await readFile(process.argv[3], 'utf8')) as NativeEvaluationSpec;
    const result: any = await nativeEvaluate(spec);
    process.stdout.write(JSON.stringify({ result: spec.resultPath, status: result.status }) + '\n');
    if (result.status !== 'completed') process.exitCode = 1;
  } else {
    const spec = JSON.parse(await readFile(process.argv[2], 'utf8')) as StageSpec;
    const result = await runStage(spec);
    process.stdout.write(JSON.stringify({ result: spec.resultPath, execution_status: result.execution_status, version: result.version_after?.id }) + '\n');
    if (result.execution_status === 'failed' || spec.phase === 'work' && !['completed', 'budget_exhausted'].includes(result.execution_status)) process.exitCode = 1;
  }
}
