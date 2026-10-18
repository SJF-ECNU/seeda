import { fork, execFile, type ChildProcess } from 'node:child_process';
import { realpathSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { configureNetwork } from '../model/network.ts';
import type { AgentEvent } from '../core/types.ts';

export type SandboxBackend = 'process' | 'container';
export function sandboxBackend(value: unknown): SandboxBackend {
  if (value === undefined) return 'process';
  if (value !== 'process' && value !== 'container') throw new Error('sandbox must be process or container; unsandboxed evaluation is not allowed');
  return value;
}
const directory = dirname(fileURLToPath(import.meta.url));
const bridge = join(directory, 'bridge.mjs');
const limit = 4 * 1024 * 1024;
interface Launch { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; cleanup?: string[]; macCleanup?: string[]; timeoutMs: number | null; maxOutputBytes?: number | null; }

// The guardian owns backend handles and remains alive if the supervisor dies.
class Execution {
  readonly child: ChildProcess;
  readonly done: Promise<void>;
  private error?: Error;
  private stderr = '';
  private stopping = false;
  constructor(config: Launch, output: (value: Buffer) => void) {
    this.child = fork(join(directory, 'guardian.mjs'), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    this.done = new Promise((resolveDone, reject) => {
      this.child.on('error', reject);
      this.child.on('message', (message: { type: string; data?: string; error?: string; code?: number; signal?: string }) => {
        if (message.type === 'stdout') output(Buffer.from(message.data!, 'base64'));
        else if (message.type === 'stderr') this.stderr = (this.stderr + Buffer.from(message.data!, 'base64').toString()).slice(-2048);
        else if (message.type === 'failure') this.error = new Error(message.error);
        else if (message.type === 'exit' && message.code !== 0 && !this.stopping) this.error ??= new Error(`Sandbox exited (${message.signal ?? message.code}): ${this.stderr}`);
      });
      this.child.on('exit', (code, signal) => {
        if (this.error) reject(this.error);
        else if (code !== 0) reject(new Error(`Sandbox guardian exited (${signal ?? code})`));
        else resolveDone();
      });
    });
    void this.done.catch(() => {});
    this.child.send({ type: 'start', ...config });
  }
  send(message: unknown): void { if (this.child.connected) this.child.send({ type: 'input', data: JSON.stringify(message) + '\n' }, () => {}); }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.child.connected) this.child.send({ type: 'stop' }, () => {});
    await this.done;
  }
}

export function macProfile(runtime: string, writable: string): string {
  const npm = join(dirname(process.execPath), 'npm');
  const tools = ['/Library/Developer/CommandLineTools', '/Applications/Xcode.app/Contents/Developer'];
  if (existsSync(npm)) tools.push(dirname(dirname(realpathSync(npm))));
  const paths = [...tools.filter(path => existsSync(path)), '/System/Library', '/usr/lib', '/usr/share', '/usr/bin', '/bin', '/sbin', '/dev/null', '/dev/urandom', '/dev/random', process.execPath, runtime, bridge];
  return `(version 1)(deny default)
    (allow process-exec)(allow process-fork)(allow signal (target same-sandbox))(allow sysctl-read)(allow file-read-metadata)
    (allow file-read* (literal "/"))
    (allow mach-lookup (global-name "com.apple.system.logger"))
    (allow file-read* ${paths.map(path => `(subpath ${JSON.stringify(realpathSync(path))})`).join(' ')})
    (allow file-read* file-write* (subpath ${JSON.stringify(writable)}))
    (allow file-write-data (literal "/dev/null"))
    (deny file-read* (subpath ${JSON.stringify(join(runtime, '.git'))}))
    (deny file-read* file-write* (literal ${JSON.stringify(join(writable, '.host-only'))}))
    (deny network*)`;
}
function processLaunch(runtime: string, work: string, env: NodeJS.ProcessEnv): Launch {
  const args = ['--experimental-strip-types', bridge, join(runtime, 'src/runtime/worker.ts'), join(work, 'workspace'), join(work, 'session.jsonl'), join(work, 'outputs'), 'candidate'];
  if (process.platform === 'darwin') return { command: '/usr/bin/sandbox-exec', args: ['-p', macProfile(runtime, work), process.execPath, ...args], cwd: runtime, env, macCleanup: [work, join(work, '.host-only')], timeoutMs: 120000 };
  if (process.platform !== 'linux') throw new Error('Process sandbox requires macOS Seatbelt or Linux bubblewrap; select container on this host');
  const binds: string[] = [];
  for (const path of ['/usr/bin', '/usr/lib', '/usr/share', '/bin', '/sbin', '/lib', '/lib64']) binds.push('--ro-bind-try', path, path);
  return { command: 'bwrap', args: ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--proc', '/proc', '--dev', '/dev', ...binds,
    '--ro-bind', process.execPath, process.execPath, '--ro-bind', runtime, runtime, '--ro-bind', bridge, bridge,
    '--bind', work, work, '--remount-ro', '/', '--chdir', runtime, '--', process.execPath, ...args], cwd: runtime, env, timeoutMs: 120000 };
}
function dockerLaunch(name: string, mounts: string[], args: string[], env: NodeJS.ProcessEnv, prepare = false): Launch {
  const options = ['run', '--rm', '-i', '--name', name, '--user', `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`, '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--pids-limit=128', '--memory=1g', '--cpus=2', '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456,mode=1777'];
  if (!prepare) options.push('--network=none');
  for (const mount of mounts) options.push('--mount', mount);
  for (const [key, value] of Object.entries(env)) options.push('-e', `${key}=${value}`);
  return { command: 'docker', args: [...options, 'node:24-bookworm-slim', ...args], cwd: directory, env: process.env,
    cleanup: ['docker', 'rm', '-f', name], timeoutMs: 120000 };
}
const mount = (source: string, target: string, readonly = false) => {
  if (source.includes(',')) throw new Error('Docker sandbox paths must not contain commas');
  return `type=bind,src=${source},dst=${target}${readonly ? ',readonly' : ''}`;
};

export interface CandidateBudget { timeoutMs: number; maxModelCalls: number; }
export const defaultCandidateBudget: CandidateBudget = { timeoutMs: 120_000, maxModelCalls: 64 };

export class SandboxCandidate {
  readonly ready: Promise<void>;
  readonly id = randomUUID();
  private execution?: Execution;
  private stopped = false;
  private cancelled = false;
  private pending?: { resolve: (answer: string) => void; reject: (error: Error) => void };
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private initialized: Promise<void>;
  private controller = new AbortController();
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private bytes = 0;
  private calls = 0;
  private modelBusy = false;
  private startup?: NodeJS.Timeout;
  readonly backend: SandboxBackend;
  readonly runtime: string;
  readonly work: string;
  private readonly event: (event: AgentEvent) => void;
  private readonly budget: CandidateBudget | null;
  constructor(backend: SandboxBackend, runtime: string, work: string, event: (event: AgentEvent) => void, budget: CandidateBudget | null = defaultCandidateBudget) {
    this.budget = budget; this.backend = backend; this.runtime = runtime; this.work = work; this.event = event;
    this.ready = new Promise((resolveReady, reject) => { this.readyResolve = resolveReady; this.readyReject = reject; });
    void this.ready.catch(() => {});
    this.initialized = this.initialize().catch(error => { this.fail(error); });
  }
  private fail(error: Error): void {
    this.readyReject(error); this.pending?.reject(error); this.pending = undefined;
    void this.stop().catch(() => {});
  }
  private async initialize(): Promise<void> {
    for (const name of ['workspace', 'outputs', 'home', 'tmp']) await mkdir(join(this.work, name), { recursive: true, mode: 0o700 });
    if (this.stopped) throw new Error('Sandbox cancelled before startup');
    const runtime = realpathSync(this.runtime); const work = realpathSync(this.work);
    const developerBins = process.platform === 'darwin' ? ['/Library/Developer/CommandLineTools/usr/bin', '/Applications/Xcode.app/Contents/Developer/usr/bin'].filter(path => existsSync(path)) : [];
    const env = { PATH: [join(runtime, 'node_modules/.bin'), dirname(process.execPath), ...developerBins, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'), HOME: join(work, 'home'), TMPDIR: join(work, 'tmp'),
      DEEPSEEK_API_KEY: 'sandbox-host-broker', DEEPSEEK_BASE_URL: 'https://sandbox.invalid', DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', SEEDA_SYSTEM_PROXY: '0', SEEDA_THINKING: process.env.SEEDA_THINKING ?? '1' };
    let launch: Launch;
    if (this.backend === 'process') {
      if (process.platform === 'darwin') {
        if (runtime === work || work.startsWith(runtime + '/') || runtime.startsWith(work + '/')) throw new Error('Sandbox runtime and workspace must be separate');
        await writeFile(join(work, '.host-only'), '', { mode: 0o600 });
        try { await promisify(execFile)('/usr/bin/python3', [join(directory, 'macos-cleanup.py'), '--check', work, join(work, '.host-only')], { timeout: 2000 }); }
        catch { throw new Error('macOS process sandbox requires system Python 3 and Seatbelt cleanup support'); }
      }
      launch = processLaunch(runtime, work, process.platform === 'darwin' ? { ...env, SEEDA_SANDBOX_VERIFY: '1' } : env);
    }
    else {
      const dependencyDir = join(dirname(work), 'dependencies');
      await mkdir(dependencyDir, { recursive: true, mode: 0o700 });
      const prep = dockerLaunch(`seeda-eval-${this.id}-prepare`, [mount(join(runtime, 'package.json'), '/input/package.json', true), mount(join(runtime, 'package-lock.json'), '/input/package-lock.json', true), mount(dependencyDir, '/deps')],
        ['sh', '-c', 'cp /input/package*.json /deps/ && cd /deps && npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/npm'], { HOME: '/tmp', npm_config_registry: 'https://registry.npmjs.org' }, true);
      this.execution = new Execution(prep, () => {}); await this.execution.done;
      if (this.stopped) throw new Error('Sandbox cancelled during dependency preparation');
      await mkdir(join(dependencyDir, 'node_modules'), { recursive: true });
      if (realpathSync(join(dependencyDir, 'node_modules')) !== join(dependencyDir, 'node_modules')) throw new Error('Sandbox dependencies must not redirect the host mount');
      launch = dockerLaunch(`seeda-eval-${this.id}`, [mount(runtime, '/candidate', true), mount(join(dependencyDir, 'node_modules'), '/candidate/node_modules', true), mount(work, '/evaluation'), mount(bridge, '/bridge.mjs', true)],
        ['node', '--experimental-strip-types', '/bridge.mjs', '/candidate/src/runtime/worker.ts', '/evaluation/workspace', '/evaluation/session.jsonl', '/evaluation/outputs', 'candidate'],
        { ...env, HOME: '/evaluation/home', TMPDIR: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin' });
    }
    if (this.stopped) throw new Error('Sandbox stopped');
    this.execution = new Execution({ ...launch, timeoutMs: this.budget?.timeoutMs ?? null, maxOutputBytes: this.budget === null ? null : 16 * 1024 * 1024 }, data => this.receive(data));
    this.startup = setTimeout(() => this.fail(new Error('Sandbox worker startup timed out')), 15000);
    void this.execution.done.then(() => { if (!this.stopped) this.fail(new Error('Sandbox exited before completing evaluation')); }, error => this.fail(error));
  }
  private receive(data: Buffer): void {
    try {
      this.bytes += data.length; this.buffer += this.decoder.write(data);
      if ((this.budget !== null && this.bytes > 16 * 1024 * 1024) || this.buffer.length > 8 * 1024 * 1024) throw new Error('Sandbox output limit exceeded');
      let index: number;
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(this.buffer.slice(0, index)); this.buffer = this.buffer.slice(index + 1);
        if (!message || typeof message !== 'object') throw new Error('Invalid sandbox message');
        if (message.type === 'ready') { clearTimeout(this.startup); this.readyResolve(); }
        else if (message.type === 'event') { if (!message.event || typeof message.event.type !== 'string') throw new Error('Invalid sandbox event'); this.event(message.event); }
        else if (message.type === 'result') {
          if (message.error !== undefined && typeof message.error !== 'string' || message.answer !== undefined && typeof message.answer !== 'string') throw new Error('Invalid sandbox result');
          if (message.error) this.pending?.reject(new Error(message.error)); else this.pending?.resolve(message.answer ?? '');
          this.pending = undefined;
        } else if (message.type === 'model') void this.model(message);
        else if (!['process', 'heartbeat'].includes(message.type)) throw new Error('Unsupported sandbox message');
      }
    } catch { this.fail(new Error('Invalid or oversized sandbox output')); }
  }
  private async model(message: { id: unknown; body: unknown }): Promise<void> {
    if (this.modelBusy || (this.budget !== null && ++this.calls > this.budget.maxModelCalls) || !Number.isSafeInteger(message.id) || typeof message.body !== 'string' || Buffer.byteLength(message.body) > limit) {
      this.fail(new Error('Sandbox model request limit exceeded')); return;
    }
    this.modelBusy = true;
    try {
      const body = JSON.parse(message.body);
      if (!body || !Array.isArray(body.messages) || body.model !== (process.env.DEEPSEEK_MODEL ?? 'deepseek-flash')) throw new Error('Invalid model body');
      const url = `${(process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '')}/chat/completions`;
      await configureNetwork();
      this.controller.signal.throwIfAborted();
      const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY ?? ''}` }, body: message.body,
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(120000)]) });
      let text = ''; let bytes = 0; const decoder = new TextDecoder();
      if (!response.body) throw new Error('No model response');
      const reader = response.body.getReader();
      try {
        while (true) { const item = await reader.read(); if (item.done) break; bytes += item.value.length; if (bytes > limit) throw new Error('Model response exceeds sandbox limit'); text += decoder.decode(item.value, { stream: true }); }
        text += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      this.execution?.send({ type: 'model_response', id: message.id, status: response.status, body: text });
    } catch { this.execution?.send({ type: 'model_response', id: message.id, error: 'Sandbox model request failed' }); }
    finally { this.modelBusy = false; }
  }
  async run(input: string): Promise<string> {
    await this.ready;
    if (this.stopped || this.pending) throw new Error(this.cancelled ? 'Sandbox evaluation cancelled' : 'Sandbox unavailable or busy');
    return new Promise((resolveRun, reject) => { this.pending = { resolve: resolveRun, reject }; this.execution!.send({ type: 'run', input }); });
  }
  cancel(): void { this.cancelled = true; this.fail(new Error('Sandbox evaluation cancelled')); }
  get wasCancelled(): boolean { return this.cancelled; }
  async stop(): Promise<void> {
    this.stopped = true; clearTimeout(this.startup); this.controller.abort();
    const error = new Error('Sandbox stopped'); this.readyReject(error); this.pending?.reject(error); this.pending = undefined;
    await this.execution?.stop();
    await this.initialized;
    await this.execution?.stop();
  }
}
