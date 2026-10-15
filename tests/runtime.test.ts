import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { VersionStore } from '../src/versions/store.ts';
import { Supervisor } from '../src/runtime/supervisor.ts';
import { RuntimeClient } from '../src/runtime/client.ts';
import type { AgentEvent } from '../src/core/types.ts';

async function until(check: () => boolean, ms = 12000): Promise<void> {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > ms) throw new Error('Condition did not become true'); await new Promise(r => setTimeout(r, 50)); }
}
test('managed runtime retains versions, isolates candidate, drains requests, restores faults and survives restart', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'seeda-rt-')); const cwd = join(root, 'project');
  const { mkdir } = await import('node:fs/promises'); await mkdir(cwd);
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const messages = JSON.parse(body).messages;
    const user = messages.filter((m: {role:string}) => m.role === 'user').at(-1).content;
    const toolDone = messages.at(-1).role === 'tool';
    if (user === 'fail-task') { res.statusCode = 500; res.end('private-body'); return; }
    if (user === 'slow' || user === 'candidate-task') await new Promise(r => setTimeout(r, 400));
    let delta: unknown = { content: user === 'slow' ? 'finished slow' : 'done' }; let finish = 'stop';
    if (['candidate-task', 'block'].includes(user) && !toolDone) {
      delta = { tool_calls: [{ index: 0, id: `bash-${Date.now()}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: user === 'block' ? 'echo $$ > block.pid; sleep 30' : 'printf isolated > candidate.txt; pwd' }) } }] }; finish = 'tool_calls';
    }
    res.setHeader('Content-Type', 'text/event-stream'); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const env = { key: process.env.DEEPSEEK_API_KEY, base: process.env.DEEPSEEK_BASE_URL, proxy: process.env.SEEDA_SYSTEM_PROXY };
  process.env.DEEPSEEK_API_KEY = 'local-test'; process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${addr.port}`; process.env.SEEDA_SYSTEM_PROXY = '0';
  let store = await VersionStore.open(join(root, 'state')); let supervisor = new Supervisor(store, cwd);
  t.after(async () => { await supervisor.close(); store.close(); server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true });
    for (const [name,value] of [['DEEPSEEK_API_KEY',env.key],['DEEPSEEK_BASE_URL',env.base],['SEEDA_SYSTEM_PROXY',env.proxy]]) { if (value === undefined) delete process.env[name!]; else process.env[name!] = value; }
  });
  const a = await store.initialize(resolve('.'));
  const competingStore = await VersionStore.open(join(root, 'state'));
  const competing = new Supervisor(competingStore, cwd);
  const starts = await Promise.allSettled([supervisor.start(), competing.start()]);
  assert.equal(starts[0].status, 'fulfilled'); assert.equal(starts[1].status, 'rejected');
  await competing.close(); competingStore.close();
  const second = new Supervisor(store, cwd); await assert.rejects(second.start(), /already running/); await second.close();
  const client = await RuntimeClient.connect(supervisor.socketPath);
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const frontend = await promisify(execFile)(process.execPath, ['--experimental-strip-types', resolve('src/cli.ts'), '/versions'], { cwd, env: { ...process.env, SEEDA_HOME: join(root, 'state'), SEEDA_MANAGED: '1', DEEPSEEK_API_KEY: '' } });
  assert.match(frontend.stdout, new RegExp(a.id));
  assert.equal(await client.run('hi'), 'done');
  assert.equal((await client.request('history') as unknown[]).length, 2);
  const observer = await RuntimeClient.connect(supervisor.socketPath);
  const changes: string[] = []; observer.onSession = selected => changes.push(selected.id);
  const created = await client.request('new') as { id: string };
  assert.equal(client.sessionId, created.id);
  await until(() => changes.includes(created.id));
  assert.deepEqual(await client.request('history'), []);
  assert.equal(await client.run('independent first'), 'done');
  assert.equal(await client.run('independent second'), 'done');
  assert.match(await client.request('compact', { session: created.id }) as string, /已压缩/);
  const compactedFile = await readFile(join(root, 'state/sessions', `${created.id}.jsonl`), 'utf8');
  assert.ok(compactedFile.includes('"type":"compact"'));
  assert.equal((await client.request('history') as unknown[]).length, 4);
  const list = await client.request('sessions') as { current: string; sessions: { id: string }[] };
  assert.equal(list.current, created.id); assert.equal(list.sessions.length, 2);
  await assert.rejects(client.request('resume', { id: '../main' }), /Invalid/);
  await assert.rejects(client.request('resume', { id: '00000000-0000-0000-0000-000000000000' }), /ENOENT/);
  const busySession = client.run('slow');
  await assert.rejects(client.request('new'), /等待/); await busySession;
  await client.request('resume', { id: 'main' });
  assert.equal((await client.request('history') as unknown[]).length, 2);
  await assert.rejects(client.request('run', { session: created.id }, undefined, 'stale'), /会话已切换/);
  const sessionsFrontend = await promisify(execFile)(process.execPath, ['--experimental-strip-types', resolve('src/cli.ts'), '/sessions'], { cwd, env: { ...process.env, SEEDA_HOME: join(root, 'state') } });
  assert.match(sessionsFrontend.stdout, new RegExp(created.id));
  assert.equal((await client.request('history') as unknown[]).length, 2);
  observer.close();
  const draft = await store.draft(a.id);
  await writeFile(join(draft.path, 'src/evolution.ts'), 'export const improvement = "B";\n');
  const legacyReady = await readFile(join(draft.path, 'src/runtime/worker.ts'), 'utf8');
  await writeFile(join(draft.path, 'src/runtime/worker.ts'), legacyReady.replace('messages: session.messages, compact: true', 'messages: session.messages'));
  const b = await store.submit(draft.id, 'candidate B');
  assert.notEqual(a.runtime_path, b.runtime_path);
  const lightweight = await supervisor.manage({ operation: 'evaluate', version: b.id, task: 'prompt-only' }) as { status: string; sandbox: string; answer: string };
  assert.equal(lightweight.status, 'completed'); assert.equal(lightweight.sandbox, 'process'); assert.equal(lightweight.answer, 'done');
  const evaluating = supervisor.manage({ operation: 'evaluate', version: b.id, task: 'candidate-task' });
  await until(() => Number(store.db.prepare("SELECT count(*) AS n FROM instances WHERE role='candidate' AND ended_at IS NULL").get()!.n) === 1);
  assert.equal(await client.run('A remains available'), 'done');
  const evaluation = await evaluating as { evaluation: string; workspace: string; status: string };
  assert.equal(evaluation.status, 'completed', JSON.stringify(evaluation));
  assert.equal(await readFile(join(evaluation.workspace, 'candidate.txt'), 'utf8'), 'isolated');
  await assert.rejects(readFile(join(cwd, 'candidate.txt')));
  await assert.rejects(supervisor.manage({ operation: 'promote', version: b.id, evaluation: evaluation.evaluation, reason: 'better' }), /acceptance/);
  const failedEvaluation = await supervisor.manage({ operation: 'evaluate', version: b.id, task: 'fail-task' }) as { evaluation: string; status: string };
  assert.equal(failedEvaluation.status, 'failed');
  await assert.rejects(supervisor.manage({ operation: 'decide', evaluation: failedEvaluation.evaluation, decision: 'accept', reason: 'unsupported acceptance' }), /incomplete/);
  await supervisor.manage({ operation: 'decide', evaluation: failedEvaluation.evaluation, decision: 'reject', reason: 'Model request failed; no completed verification' });
  const cancellation = supervisor.manage({ operation: 'evaluate', version: b.id, task: 'block', sandbox: 'container' });
  let candidatePid = '';
  for (let i = 0; i < 500 && !candidatePid; i++) {
    const latest = store.db.prepare("SELECT evidence_path FROM evaluations WHERE status='running'").get() as { evidence_path: string } | undefined;
    if (latest) { try { candidatePid = await readFile(join(latest.evidence_path, '../sandbox/workspace/block.pid'), 'utf8'); } catch {} }
    if (!candidatePid) await new Promise(r => setTimeout(r, 30));
  }
  assert.ok(candidatePid); supervisor.cancel();
  assert.equal((await cancellation as { status: string }).status, 'cancelled');
  await supervisor.manage({ operation: 'decide', evaluation: evaluation.evaluation, decision: 'accept', reason: 'B completes isolated task' });
  const events: AgentEvent[] = []; const running = supervisor.run('slow', event => events.push(event));
  await new Promise(r => setTimeout(r, 80));
  const selection = await supervisor.manage({ operation: 'promote', version: b.id, evaluation: evaluation.evaluation, reason: 'verified' }) as { status: string };
  assert.equal(selection.status, 'pending'); assert.equal(store.state().current_version, a.id);
  await assert.rejects(supervisor.run('new', () => {}), /changing/);
  assert.equal(await running, 'finished slow'); assert.equal(store.state().current_version, b.id);
  assert.ok(events.some(event => event.type === 'end'));
  await assert.rejects(supervisor.manage({ operation: 'draft' }, a.id), /Stale/);
  const primary = store.db.prepare("SELECT pid FROM instances WHERE role='primary' AND ended_at IS NULL").get() as { pid: number };
  process.kill(primary.pid, 'SIGKILL');
  await until(() => store.state().current_version === a.id && store.state().phase === 'running');
  assert.equal(await client.run('after fault'), 'done');
  // A target that crashes before ready never takes ownership of the main session.
  const brokenDraft = await store.draft(a.id);
  await writeFile(join(brokenDraft.path, 'src/runtime/worker.ts'), 'process.exit(7);\n');
  const broken = await store.submit(brokenDraft.id, 'simulate startup failure');
  const brokenSelection = await supervisor.select(broken.id) as { status: string };
  assert.equal(brokenSelection.status, 'failed'); assert.equal(store.state().current_version, a.id);
  assert.equal(await client.run('still alive'), 'done');
  await client.request('resume', { id: created.id });
  await supervisor.select(b.id); assert.equal(supervisor.sessionId(), created.id);
  await assert.rejects(client.request('compact'), /不支持主动压缩/);
  await supervisor.select(a.id); assert.equal(supervisor.sessionId(), created.id);
  client.close(); await supervisor.close(); store.close();
  store = await VersionStore.open(join(root, 'state')); store.requestSwitch(b.id, 'manual', 'simulate interrupted intent'); store.close();
  store = await VersionStore.open(join(root, 'state')); supervisor = new Supervisor(store, cwd); await supervisor.start();
  assert.equal(store.state().current_version, a.id); assert.equal(store.state().switch_target, null);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM switches WHERE state='interrupted'").get()!.n, 1);
  const reconnect = await RuntimeClient.connect(supervisor.socketPath);
  assert.equal(supervisor.sessionId(), created.id);
  assert.equal(await reconnect.run('reopened'), 'done');
  await reconnect.request('resume', { id: 'main' }); reconnect.close();
  // A live process with a stopped event loop misses heartbeat and falls back.
  await supervisor.select(b.id);
  const blocked = store.db.prepare("SELECT pid FROM instances WHERE role='primary' AND ended_at IS NULL").get() as { pid: number };
  process.kill(blocked.pid, 'SIGSTOP');
  await until(() => store.state().current_version === a.id && store.state().phase === 'running');
  assert.equal(store.versions().length, 3);
  // Kill a worker during a detached Bash command: the manager cleans its process group and never replays it.
  const interrupted = supervisor.run('block', () => {}); const rejected = assert.rejects(interrupted, /Worker exited/);
  let bashPid = 0;
  for (let i = 0; i < 100 && !bashPid; i++) {
    try { bashPid = Number(await readFile(join(cwd, 'block.pid'), 'utf8')); } catch { await new Promise(r => setTimeout(r, 30)); }
  }
  assert.ok(bashPid);
  const active = store.db.prepare("SELECT pid FROM instances WHERE role='primary' AND ended_at IS NULL").get() as { pid: number };
  process.kill(active.pid, 'SIGKILL'); await rejected;
  await until(() => store.state().phase === 'running');
  await until(() => { try { process.kill(bashPid, 0); return false; } catch { return true; } });
  const main = (await readFile(join(root, 'state/sessions/main.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(main.filter(item => item.type === 'message' && item.message.role === 'user' && item.message.content === 'block').length, 1);
  assert.ok(main.some(item => item.type === 'message' && item.message.role === 'tool' && JSON.parse(item.message.content).status === 'unknown'));

});

test('killed supervisor releases workers and recovers persisted intent and committed selection', { timeout: 60000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'seeda-daemon-')); const cwd = join(root, 'project'); await mkdir(cwd);
  const store = await VersionStore.open(join(root, 'state'));
  const a = await store.initialize(resolve('.')); const draft = await store.draft(a.id);
  const workerSource = await readFile(join(draft.path, 'src/runtime/worker.ts'), 'utf8');
  await writeFile(join(draft.path, 'src/runtime/worker.ts'), workerSource.replace("send({ type: 'ready', messages: session.messages, compact: true });", "await new Promise(resolve => setTimeout(resolve, 2000));\nsend({ type: 'ready', messages: session.messages, compact: true });"));
  const b = await store.submit(draft.id, 'delay startup for interruption exercise');
  let child: ReturnType<typeof spawn> | undefined;
  const start = async () => {
    child = spawn(process.execPath, ['--experimental-strip-types', resolve('src/runtime/cli.ts'), 'serve', cwd], { env: { ...process.env, SEEDA_HOME: join(root, 'state'), DEEPSEEK_API_KEY: 'not-used-for-ready' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', () => {});
    await until(() => output.includes('seeda supervisor:'), 20000);
  };
  const kill = async () => { const stopped = new Promise<void>(resolve => child!.once('close', () => resolve())); child!.kill('SIGKILL'); await stopped; };
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) await kill(); store.close(); await rm(root, { recursive: true, force: true }); });
  await start(); let client = await RuntimeClient.connect(join(root, 'state/control.sock'));
  const requested = client.request('select', { version: b.id }); const rejected = assert.rejects(requested, /disconnected/);
  await until(() => store.state().switch_target === b.id); await kill(); await rejected; client.close();
  await start(); assert.equal(store.state().current_version, a.id); assert.equal(store.state().switch_target, null);
  client = await RuntimeClient.connect(join(root, 'state/control.sock')); await client.request('select', { version: b.id }); client.close();
  assert.equal(store.state().current_version, b.id);
  const old = store.db.prepare("SELECT pid FROM instances WHERE ended_at IS NULL AND role='primary'").get() as { pid: number };
  await kill();
  await until(() => { try { process.kill(old.pid, 0); return false; } catch { return true; } });
  await start(); assert.equal(store.state().current_version, b.id);
  client = await RuntimeClient.connect(join(root, 'state/control.sock')); await client.request('stop'); client.close();
  await until(() => child!.exitCode !== null);
  // A selected B whose environment later stops booting falls back to retained A on supervisor restart.
  await writeFile(join(b.runtime_path, 'src/runtime/worker.ts'), 'process.exit(9);\n');
  await start(); assert.equal(store.state().current_version, a.id);
  client = await RuntimeClient.connect(join(root, 'state/control.sock')); await client.request('stop'); client.close();
  await until(() => child!.exitCode !== null);
});
