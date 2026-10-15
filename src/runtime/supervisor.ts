import { realpathSync } from 'node:fs';
import { createServer, createConnection, type Socket, type Server } from 'node:net';
import { chmod, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { StrainLibrary } from '../strains/library.ts';
import { libraryRoot } from './paths.ts';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../core/types.ts';
import { VersionStore, type Version, type SeedOrigin } from '../versions/store.ts';
import { WorkerProcess } from './process.ts';
import { SandboxCandidate, sandboxBackend } from '../sandbox/candidate.ts';
import { sessionPath, sessionHistory, listSessions } from './sessions.ts';

export class Supervisor {
  readonly store: VersionStore;
  readonly cwd: string;
  readonly socketPath: string;
  private server?: Server;
  private ownsSocket = false;
  private sockets = new Set<Socket>();
  private primary?: WorkerProcess;
  private candidate?: SandboxCandidate;
  private listener?: (event: AgentEvent) => void;
  private switching?: Promise<void>;
  private switchId?: string;
  private closed = false;
  private recovering = false;
  private evaluationBusy = false;
  private retries = 0;
  constructor(store: VersionStore, cwd: string) { this.store = store; this.cwd = realpathSync(cwd); this.socketPath = join(store.root, 'control.sock'); }
  private worker(version: Version, role: string, cwd = this.cwd, session = sessionPath(this.store.root, this.sessionId()), artifacts = join(this.store.root, 'outputs')): WorkerProcess {
    // Candidates use only model connection settings, not arbitrary service credentials.
    const env = role === 'primary' ? process.env : Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'SEEDA_THINKING', 'BRAVE_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'].includes(key)));
    return new WorkerProcess(this.store, version, cwd, session, artifacts, role,
      event => { if (role === 'primary' && this.primary?.version.id === version.id) this.listener?.(event); },
      args => { if (role !== 'primary' || this.primary?.version.id !== version.id) throw new Error('Only the current primary can manage evolution'); return this.manage(args, version.id); },
      (worker, error) => { if (this.primary === worker) void this.recoverFailure(error); }, env);
  }
  sessionId(): string {
    return String(this.store.db.prepare('SELECT session FROM session_selection WHERE id=1').get()!.session);
  }
  async changeSession(id: string = randomUUID(), create = false): Promise<{ id: string }> {
    if (this.closed || this.recovering || this.switching || this.evaluationBusy || this.primary?.busy || this.store.state().switch_target || this.store.state().phase !== 'running') throw new Error('请等待当前任务或版本切换结束后再切换会话');
    const path = sessionPath(this.store.root, id);
    if (!create) await sessionHistory(this.store.root, id);
    // Recheck after the asynchronous read before claiming exclusive worker ownership.
    if (this.primary?.busy || this.switching || this.recovering || this.closed || this.evaluationBusy || this.store.state().switch_target) throw new Error('Runtime is busy');
    const old = this.sessionId(); const version = this.store.version(this.store.state().current_version!);
    this.switching = (async () => {
      await this.primary?.stop();
      try {
        if (this.closed) throw new Error('Supervisor is stopping');
        this.primary = this.worker(version, 'primary', this.cwd, path); await this.primary.ready;
        if (this.closed) throw new Error('Supervisor is stopping');
        this.store.db.prepare('UPDATE session_selection SET session=? WHERE id=1').run(id);
        const notification = JSON.stringify({ session: { id, messages: this.primary.messages } }) + '\n';
        for (const socket of this.sockets) if (!socket.destroyed) socket.write(notification);
      } catch (error) {
        await this.primary?.stop();
        if (!this.closed) {
          this.primary = this.worker(version, 'primary', this.cwd, sessionPath(this.store.root, old));
          try { await this.primary.ready; } catch { this.store.db.prepare("UPDATE runtime_state SET phase='failed' WHERE id=1").run(); }
        }
        throw error;
      }
    })().finally(() => { this.switching = undefined; });
    await this.switching; return { id };
  }
  async start(source?: string, origin?: SeedOrigin): Promise<void> {
    // A startup transaction serializes socket ownership across competing managers.
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
    // Probe existing socket; never unlink another running manager's endpoint.
    const occupied = await new Promise<boolean>(resolve => {
      const socket = createConnection(this.socketPath); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false));
    });
    if (occupied) throw new Error('Supervisor is already running');
    if (source && !this.store.state().current_version) {
      if (origin) await this.store.seed(source, origin); else await this.store.initialize(source);
    }
    try { await unlink(this.socketPath); await new Promise(r => setTimeout(r, 2600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.server = createServer(socket => this.connection(socket));
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.socketPath, () => { this.server!.removeListener('error', reject); resolve(); }); });
    this.ownsSocket = true;
    await chmod(this.socketPath, 0o600);
    this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    this.store.recover();
    const current = this.store.state().current_version;
    if (!current) { await this.close(); throw new Error('Initialize a version before starting'); }
    try { this.primary = this.worker(this.store.version(current), 'primary'); await this.primary.ready; }
    catch (error) { await this.recoverFailure(error instanceof Error ? error : new Error('Startup failed')); }
    if (this.primary?.child.connected) this.store.db.prepare("UPDATE runtime_state SET phase='running' WHERE id=1").run();
  }
  private async recoverFailure(error: Error): Promise<void> {
    if (this.closed || this.recovering || this.switching) return;
    this.recovering = true;
    this.store.db.prepare("UPDATE runtime_state SET phase='recovering' WHERE id=1").run();
    try {
      this.listener?.({ type: 'end', status: 'failed', error: error.message });
      await this.primary?.stop();
      if (this.closed) return;
      if (this.switchId) { this.store.finishSwitch(this.switchId, false); this.switchId = undefined; }
      const state = this.store.state(); const target = state.previous_version ?? state.current_version;
      if (!target || ++this.retries > 3) { this.store.db.prepare("UPDATE runtime_state SET phase='failed' WHERE id=1").run(); return; }
      const id = this.store.requestSwitch(target, 'fault', error.message);
      try { this.primary = this.worker(this.store.version(target), 'primary'); await this.primary.ready; this.store.finishSwitch(id, true); }
      catch { this.store.finishSwitch(id, false); this.store.db.prepare("UPDATE runtime_state SET phase='failed' WHERE id=1").run(); }
    } finally { this.recovering = false; }
  }
  async run(input: string, event: (event: AgentEvent) => void, compact = false): Promise<string> {
    if (this.closed || this.recovering || this.switching || this.store.state().phase !== 'running' || this.store.state().switch_target || !this.primary) throw new Error('Runtime is changing version or unavailable');
    if (this.primary.busy) throw new Error('A request is already running');
    this.listener = event;
    try { const answer = await (compact ? this.primary.compact() : this.primary.run(input)); this.retries = 0; return answer; }
    finally { this.listener = undefined; if (!this.closed && this.store.state().switch_target && !this.recovering) await this.performSwitch(); }
  }
  cancel(): void { this.primary?.cancel(); this.candidate?.cancel(); }
  async select(target: string, kind = 'manual', reason = 'User selected version'): Promise<unknown> {
    if (this.recovering || this.switching || this.evaluationBusy) throw new Error('Runtime is busy changing or evaluating a version');
    if (target === this.store.state().current_version) return { status: 'already_current', version: target };
    this.switchId = this.store.requestSwitch(target, kind, reason);
    if (this.primary?.busy) return { status: 'pending', version: target };
    await this.performSwitch(); return { status: this.store.state().current_version === target ? 'completed' : 'failed', version: this.store.state().current_version };
  }
  private async performSwitch(): Promise<void> {
    if (this.switching) return this.switching;
    const target = this.store.state().switch_target; const id = this.switchId;
    if (!target || !id) return;
    this.switching = (async () => {
      const old = this.store.state().current_version!;
      // Stop the previous session writer before the new process opens the shared session.
      await this.primary?.stop();
      try {
        if (this.closed) throw new Error('Supervisor is stopping');
        this.primary = this.worker(this.store.version(target), 'primary'); await this.primary.ready; this.store.finishSwitch(id, true);
      }
      catch {
        this.store.finishSwitch(id, false);
        if (this.closed) return;
        this.primary = this.worker(this.store.version(old), 'primary');
        try { await this.primary.ready; } catch { this.store.db.prepare("UPDATE runtime_state SET phase='failed' WHERE id=1").run(); }
      }
    })().finally(() => { this.switching = undefined; this.switchId = undefined; });
    await this.switching;
  }
  private async evaluate(version: string, task: string, source: string, requestedSandbox?: unknown): Promise<unknown> {
    if (this.evaluationBusy || this.switching || this.recovering) throw new Error('A candidate evaluation or switch is already active');
    if (!task.trim()) throw new Error('Evaluation task is required');
    const sandbox = sandboxBackend(requestedSandbox);
    const target = this.store.version(version);
    if (target.parent_id !== source) throw new Error('Candidate must descend from the current source');
    this.evaluationBusy = true;
    const id = randomUUID(); const dir = join(this.store.root, 'evaluations', id); const cwd = join(dir, 'sandbox/workspace'); const evidence = join(dir, 'result.json');
    try {
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      this.store.db.prepare("INSERT INTO evaluations(id,source_version,candidate_version,status,evidence_path) VALUES(?,?,?,'running',?)").run(id, source, version, evidence);
      const events: AgentEvent[] = []; let answer = ''; let status = 'failed'; let error: string | undefined;
      const candidate = new SandboxCandidate(sandbox, target.runtime_path, join(dir, 'sandbox'), event => events.push(event));
      this.candidate = candidate;
      this.store.db.prepare("INSERT INTO instances(id,version_id,role,state) VALUES(?,?,'candidate','starting')").run(candidate.id, version);
      const timeout = setTimeout(() => candidate.cancel(), 120_000);
      try {
        await candidate.ready;
        this.store.db.prepare("UPDATE instances SET state='ready' WHERE id=?").run(candidate.id);
        answer = await candidate.run(task); status = 'completed';
      } catch (failure) {
        error = failure instanceof Error ? failure.message : 'Candidate failed';
        status = candidate.wasCancelled ? 'cancelled' : 'failed';
      } finally {
        clearTimeout(timeout);
        try { await candidate.stop(); } catch (failure) { status = 'failed'; error = failure instanceof Error ? failure.message : 'Sandbox cleanup failed'; }
        this.candidate = undefined;
        this.store.db.prepare("UPDATE instances SET state=?,reason=?,ended_at=CURRENT_TIMESTAMP WHERE id=?").run(status, error ?? null, candidate.id);
      }
      await writeFile(evidence, JSON.stringify({ id, source, version, task, sandbox, status, answer, error, events, cwd: join(dir, 'sandbox/workspace') }, null, 2), { mode: 0o600 });
      this.store.db.prepare('UPDATE evaluations SET status=? WHERE id=?').run(status, id);
      return { evaluation: id, status, answer, error, evidence_path: evidence, workspace: join(dir, 'sandbox/workspace'), sandbox };
    } finally { this.evaluationBusy = false; }
  }
  async manage(args: Record<string, unknown>, source = this.store.state().current_version!): Promise<unknown> {
    if (source !== this.store.state().current_version) throw new Error('Stale source version');
    const str = (key: string) => { const value = args[key]; if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`); return value; };
    switch (args.operation) {
      case 'status': return { cwd: this.cwd, seed: this.store.origin(), ...this.store.state(), versions: this.store.versions(), evaluations: this.store.db.prepare('SELECT * FROM evaluations ORDER BY rowid DESC LIMIT 20').all() };
      case 'strains': {
        const library = await StrainLibrary.open(libraryRoot());
        try { return library.list(); } finally { library.close(); }
      }
      case 'publish': {
        const library = await StrainLibrary.open(libraryRoot());
        try { return await library.publish(str('name'), this.store, this.store.version(typeof args.version === 'string' ? args.version : source), this.cwd, args.introduction); } finally { library.close(); }
      }
      case 'draft': return this.store.draft(source);
      case 'submit': return this.store.submit(str('draft'), str('reason'));
      case 'evaluate': return this.evaluate(str('version'), str('task'), source, args.sandbox);
      case 'evidence': return JSON.parse(await readFile(this.store.evaluation(str('evaluation')).evidence_path, 'utf8'));
      case 'decide': this.store.decision(str('evaluation'), source, str('decision'), str('reason')); return { status: 'recorded' };
      case 'promote': {
        const evaluation = this.store.evaluation(str('evaluation')); const version = str('version');
        if (evaluation.source_version !== source || evaluation.candidate_version !== version || evaluation.decision !== 'accept' || evaluation.status !== 'completed') throw new Error('Promotion requires source Agent acceptance of a completed candidate evaluation');
        return this.select(version, 'quality', str('reason'));
      }
      case 'rollback': { const target = this.store.state().previous_version; if (!target) throw new Error('No previous version'); return this.select(target, 'quality', str('reason')); }
      default: throw new Error('Unknown management operation');
    }
  }
  private connection(socket: Socket): void {
    socket.setEncoding('utf8');
    this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket));
    let buffer = ''; const send = (value: unknown) => { if (!socket.destroyed) socket.write(JSON.stringify(value) + '\n'); };
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk.toString(); if (buffer.length > 1_000_000) { socket.destroy(); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let request: { id: string; operation: string; input?: string; args?: Record<string, unknown> };
        try { request = JSON.parse(line); if (typeof request.id !== 'string') throw new Error('Missing request id'); }
        catch { socket.destroy(); return; }
        const handle = async () => {
          if (request.operation === 'history') {
            if (request.args?.cwd && realpathSync(String(request.args.cwd)) !== this.cwd) throw new Error('Supervisor belongs to a different working directory');
            return sessionHistory(this.store.root, this.sessionId());
          }
          if (request.operation === 'session') {
            if (request.args?.cwd && realpathSync(String(request.args.cwd)) !== this.cwd) throw new Error('Supervisor belongs to a different working directory');
            const id = this.sessionId(); const messages = await sessionHistory(this.store.root, id);
            if (this.switching || id !== this.sessionId()) throw new Error('Session is changing; reconnect after the switch');
            return { id, messages };
          }
          if (request.operation === 'sessions') return { current: this.sessionId(), sessions: await listSessions(this.store.root) };
          if (request.operation === 'new') return this.changeSession(undefined, true);
          if (request.operation === 'resume') return this.changeSession(String(request.args?.id));
          if (request.operation === 'run' || request.operation === 'compact') {
            if (request.args?.session && request.args.session !== this.sessionId()) throw new Error('会话已切换，请确认当前会话后重新发送');
            if (request.operation === 'run' && typeof request.input !== 'string') throw new Error('Missing input');
            return this.run(request.input ?? '', event => send({ id: request.id, event }), request.operation === 'compact');
          }
          if (request.operation === 'cancel') { this.cancel(); return { status: 'cancelled' }; }
          if (request.operation === 'select') return this.select(String(request.args?.version));
          if (request.operation === 'manage') return this.manage(request.args ?? {});
          if (request.operation === 'stop') { setTimeout(() => { void this.close(); }, 20); return { status: 'stopping' }; }
          throw new Error('Unknown operation');
        };
        void handle().then(result => send({ id: request.id, result }), error => send({ id: request.id, error: error instanceof Error ? error.message : 'Runtime failed' }));
      }
    });
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    if (!this.ownsSocket && !this.primary) return;
    this.cancel(); await this.candidate?.stop(); await this.primary?.stop();
    await this.switching;
    for (const socket of this.sockets) socket.destroy();
    this.server?.close();
    if (this.ownsSocket) await unlink(this.socketPath).catch(() => {});
    this.store.db.prepare("UPDATE runtime_state SET phase='stopped' WHERE id=1").run();
  }
}
