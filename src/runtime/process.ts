import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandExecutor, executeManagedCommand, type ExecutionEnvironment } from './execution.ts';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, Message } from '../core/types.ts';
import type { VersionStore, Version } from '../versions/store.ts';
import type { ManagerMessage, WorkerMessage } from './protocol.ts';

// Kill a process group only when the pid can name one. Node treats pid 0 as
// "the current process group", so an unguarded negative pid could signal the
// supervisor and its ancestors. ESRCH means the group is already gone.
export function killGroup(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { /* group already reaped or not ours */ } }
}

export class WorkerProcess {
  readonly child: ChildProcess;
  readonly id = randomUUID();
  readonly version: Version;
  messages: Message[] = [];
  supportsCompact = false;
  supportsResume = false;
  supportsYield = false;
  yielded = false;
  failure?: Error;
  readonly logPath: string;
  private managementDone = new Set<Promise<void>>();
  busy = false;
  stopping = false;
  private groups = new Set<number>();
  private lastHeartbeat = performance.now();
  private interval: NodeJS.Timeout;
  private command?: { id: string; controller: AbortController };
  private commandDone?: Promise<void>;
  private runPending?: { resolve: (answer: string) => void; reject: (error: Error) => void };
  readonly ready: Promise<void>;
  constructor(store: VersionStore, version: Version, cwd: string, session: string, artifacts: string, role: string,
    event: (event: AgentEvent) => void, management: (args: Record<string, unknown>) => Promise<unknown>, failed: (worker: WorkerProcess, error: Error) => void,
    env: NodeJS.ProcessEnv = process.env, execution: ExecutionEnvironment = { kind: 'local' }, execute: typeof executeManagedCommand = executeManagedCommand) {
    this.version = version;
    const logs = join(store.root ?? artifacts, 'worker-logs');
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    this.logPath = join(logs, `${this.id}.stderr.log`);
    writeFileSync(this.logPath, '', { mode: 0o600 });
    commandExecutor(execution); // Validate the host binding before starting a worker.
    this.child = fork(join(version.runtime_path, 'src/runtime/worker.ts'), [cwd, session, artifacts, role], {
      cwd: version.runtime_path, execArgv: ['--experimental-strip-types'], env: { ...env, SEEDA_VERSION: version.id, SEEDA_HOST_EXECUTION: role === 'primary' ? '1' : '0', SEEDA_EXECUTION_DESCRIPTION: execution.kind === 'local' ? `local, cwd ${cwd}` : `docker, cwd ${execution.cwd}` }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = Buffer.alloc(0);
    this.child.stderr!.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-16384);
      try { writeFileSync(this.logPath, stderr, { mode: 0o600 }); } catch { this.child.kill('SIGKILL'); }
    });
    store.db.prepare("INSERT INTO instances(id,version_id,role,state,pid) VALUES(?,?,?,'starting',?)").run(this.id, version.id, role, this.child.pid ?? null);
    let readyResolve!: () => void; let readyReject!: (error: Error) => void; let initialized = false; let exited = false;
    this.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    let terminationReason: string | undefined;
    const terminate = (reason: string) => { terminationReason ??= reason; this.child.kill('SIGKILL'); };
    const deadline = setTimeout(() => terminate('Worker startup timed out'), 15_000);
    const onExit = (error: Error) => {
      if (exited) return; exited = true;
      if (!this.stopping) this.failure = error;
      this.command?.controller.abort();
      for (const pid of this.groups) killGroup(pid);
      this.groups.clear(); clearTimeout(deadline); clearInterval(this.interval);
      store.db.prepare('UPDATE instances SET state=?,reason=?,ended_at=CURRENT_TIMESTAMP WHERE id=?').run(this.stopping ? 'stopped' : 'failed', this.stopping ? null : error.message, this.id);
      if (!initialized) readyReject(error);
      this.runPending?.reject(error); this.runPending = undefined; this.busy = false;
      if (!this.stopping && initialized) failed(this, error);
    };
    this.child.on('error', error => onExit(error));
    this.child.on('exit', (code, signal) => onExit(new Error(terminationReason ?? `Worker exited (${signal ?? code})`)));
    this.child.on('message', (message: WorkerMessage) => {
      if (message.type === 'process') { if (message.started) { if (Number.isInteger(message.pid) && message.pid > 1) this.groups.add(message.pid); } else this.groups.delete(message.pid); }
      else if (message.type === 'heartbeat') this.lastHeartbeat = performance.now();
      else if (message.type === 'ready') {
        if (execution.kind === 'docker' && message.commandExecution !== true) { terminate('Agent version does not support host-selected execution'); return; }
        initialized = true; this.lastHeartbeat = performance.now(); clearTimeout(deadline); this.messages = message.messages; this.supportsCompact = message.compact === true; this.supportsResume = message.resume === true; this.supportsYield = message.yield === true;
        store.db.prepare("UPDATE instances SET state='ready' WHERE id=?").run(this.id); readyResolve();
      } else if (message.type === 'event') event(message.event);
      else if (message.type === 'result') {
        const pending = this.runPending; this.runPending = undefined; this.busy = false; this.yielded = message.yielded === true && !message.error;
        if (message.error) pending?.reject(new Error(message.error)); else pending?.resolve(message.answer ?? '');
      } else if (message.type === 'command_cancel') {
        if (this.command?.id === message.id) this.command.controller.abort();
      } else if (message.type === 'command') {
        if (role !== 'primary' || !this.busy || this.stopping || this.command || typeof message.id !== 'string') {
          this.send({ type: 'command_result', id: message.id, error: 'Host command execution unavailable' }); return;
        }
        const controller = new AbortController(); this.command = { id: message.id, controller };
        this.commandDone = execute(execution, message.args, { cwd, artifactDir: artifacts, signal: controller.signal })
          .then(result => this.send({ type: 'command_result', id: message.id, result }),
            () => this.send({ type: 'command_result', id: message.id, error: 'Host command execution failed or parameters were invalid' }))
          .finally(() => { this.command = undefined; });
      } else if (message.type === 'management') {
        if (this.stopping || this.failure) return;
        const operation = management(message.args).then(result => this.send({ type: 'management_result', id: message.id, result }),
          error => this.send({ type: 'management_result', id: message.id, error: error instanceof Error ? error.message : 'Management failed' }));
        this.managementDone.add(operation);
        void operation.finally(() => this.managementDone.delete(operation));
      }
    });
    let lastCheck = performance.now();
    this.interval = setInterval(() => {
      const now = performance.now();
      // Sleep or a suspended supervisor is not evidence of a dead worker.
      if (now - lastCheck > 6000) this.lastHeartbeat = now;
      lastCheck = now;
      if (!this.stopping && initialized && now - this.lastHeartbeat > 6000) terminate('Worker heartbeat timed out');
    }, 1000);
  }
  send(message: ManagerMessage): void { if (this.child.connected) this.child.send(message, () => {}); }
  run(input: string, resume?: { userCountBefore: number }): Promise<string> {
    if (resume && !this.supportsResume) return Promise.reject(new Error('Agent version does not support safe request recovery'));
    if (this.busy || this.stopping || !this.child.connected) return Promise.reject(new Error('Worker unavailable or busy'));
    this.busy = true; this.yielded = false;
    return new Promise((resolve, reject) => { this.runPending = { resolve, reject }; this.send({ type: 'run', input, ...(resume ? { resume } : {}) }); });
  }
  compact(): Promise<string> {
    if (!this.supportsCompact) return Promise.reject(new Error('当前 Agent 版本不支持主动压缩，请升级 Agent 版本后重试'));
    if (this.busy || this.stopping || !this.child.connected) return Promise.reject(new Error('Worker unavailable or busy'));
    this.busy = true;
    return new Promise((resolve, reject) => { this.runPending = { resolve, reject }; this.send({ type: 'compact' }); });
  }
  cancel(): void { this.command?.controller.abort(); this.send({ type: 'cancel' }); }
  async stop(): Promise<void> {
    this.stopping = true;
    this.command?.controller.abort();
    if (this.child.exitCode !== null || this.child.signalCode !== null) { await this.commandDone; await Promise.all(this.managementDone); return; }
    const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()));
    this.send({ type: 'stop' });
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2500);
    await exited; clearTimeout(timer); await this.commandDone; await Promise.all(this.managementDone);
  }
}
