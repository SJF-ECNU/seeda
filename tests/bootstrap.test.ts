import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeClient } from '../src/runtime/client.ts';
import { VersionStore } from '../src/versions/store.ts';

const exec = promisify(execFile);
test('default CLI cold starts once, exposes RSI to the Agent, reconnects and rejects another project', { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'seeda-auto-')); const cwd = join(root, 'project'); const home = join(root, 'state'); await mkdir(cwd);
  let sawManagement = false;
  const server = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    const body = JSON.parse(data); sawManagement ||= body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'management');
    const statusResult = body.messages.at(-1).role === 'tool';
    const delta = statusResult ? { content: 'RSI connected' } : { tool_calls: [{ index: 0, id: `manage-${Date.now()}-${Math.random()}`, type: 'function', function: { name: 'management', arguments: '{"operation":"status"}' } }] };
    res.setHeader('Content-Type', 'text/event-stream'); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: statusResult ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    try { const client = await RuntimeClient.connect(join(home, 'control.sock')); await client.request('stop'); client.close(); } catch {}
    await new Promise(r => setTimeout(r, 300)); server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true });
  });
  const env: NodeJS.ProcessEnv = { ...process.env, SEEDA_HOME: home, SEEDA_LIBRARY: join(root, 'library'), DEEPSEEK_API_KEY: 'local-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`, SEEDA_SYSTEM_PROXY: '0' }; delete env.SEEDA_MANAGED;
  const cli = resolve('src/cli.ts');
  // Both cold launches race initialization and must attach to one managed primary.
  const starts = await Promise.all([exec(process.execPath, ['--experimental-strip-types', cli, '/versions'], { cwd, env, timeout: 20000 }), exec(process.execPath, ['--experimental-strip-types', cli, '/versions'], { cwd, env, timeout: 20000 })]).catch(async error => {
    for (const name of await readdir(home)) if (name.startsWith('startup-')) t.diagnostic(await readFile(join(home, name), 'utf8'));
    const failedStore = await VersionStore.open(home); t.diagnostic(JSON.stringify(failedStore.state())); failedStore.close();
    throw error;
  });
  assert.equal(starts[0].stdout, starts[1].stdout);
  const first = await exec(process.execPath, ['--experimental-strip-types', cli, 'run', 'hello'], { cwd, env, timeout: 10000 });
  assert.match(first.stdout, /RSI connected/); assert.equal(sawManagement, true);
  const store = await VersionStore.open(home); const instances = store.db.prepare("SELECT id FROM instances WHERE role='primary' AND ended_at IS NULL").all(); assert.equal(instances.length, 1); assert.equal(store.versions().length, 1);
  const second = await exec(process.execPath, ['--experimental-strip-types', cli, '/versions'], { cwd, env: { ...env, DEEPSEEK_API_KEY: '' }, timeout: 10000 }); assert.equal(second.stdout, starts[0].stdout);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM instances WHERE role='primary'").get()!.n, 1); store.close();
  const records = (await readFile(join(home, 'sessions/main.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(records.some(record => record.type === 'message' && record.message.tool_calls?.some((call: { function: { name: string } }) => call.function.name === 'management')));
  const other = join(root, 'other'); await mkdir(other);
  await assert.rejects(exec(process.execPath, ['--experimental-strip-types', cli, '/versions'], { cwd: other, env, timeout: 10000 }), /different project/);
});

test('automatic launch fails clearly without credentials or on initialization error, without direct fallback', async t => {
  const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'seeda-auto-fail-')); const home = join(root, 'state'); const cli = resolve('src/cli.ts');
  t.after(() => rm(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, SEEDA_HOME: home, SEEDA_LIBRARY: join(root, 'library'), DEEPSEEK_API_KEY: '' }; delete env.SEEDA_MANAGED;
  await assert.rejects(exec(process.execPath, ['--experimental-strip-types', cli, '/versions'], { cwd: root, env, timeout: 5000 }), /DEEPSEEK_API_KEY is required/);
  await assert.rejects(readFile(join(home, 'state.db')), /ENOENT/);
  await mkdir(home); await writeFile(join(home, 'repository'), 'simulate unusable version repository');
  await assert.rejects(exec(process.execPath, ['--experimental-strip-types', cli, '/versions'], { cwd: root, env: { ...env, DEEPSEEK_API_KEY: 'local-test' }, timeout: 10000 }), /Automatic supervisor startup failed/);
  await assert.rejects(readFile(join(home, 'sessions/main.jsonl')), /ENOENT/);
  const { createServer } = await import('node:net');
  const sockets = new Set<import('node:net').Socket>();
  const unresponsive = createServer(socket => { sockets.add(socket); socket.on('data', () => {}); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => unresponsive.listen(join(home, 'control.sock'), resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); unresponsive.close(); });
  await assert.rejects(exec(process.execPath, ['--experimental-strip-types', cli, '/versions'], { cwd: root, env, timeout: 5000 }), /control channel did not respond/);
});
