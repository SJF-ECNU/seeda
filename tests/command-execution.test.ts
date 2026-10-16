import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { copyAgent } from '../src/versions/snapshot.ts';
import { VersionStore } from '../src/versions/store.ts';
import { Supervisor } from '../src/runtime/supervisor.ts';
import { RuntimeClient } from '../src/runtime/client.ts';
import type { AgentEvent, Message } from '../src/core/types.ts';

const exec = promisify(execFile);

test('one source version executes through local and Docker workers with cleanup and no host fallback', { timeout: 120000 }, async t => {
  const image = 'mirror.gcr.io/library/node:24-bookworm-slim';
  try { await exec('docker', ['image', 'inspect', image]); }
  catch { t.skip(`Docker integration requires the existing ${image} image`); return; }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seeda-command-')));
  const cwd = join(root, 'project with spaces'), source = join(root, 'source');
  await mkdir(cwd); await mkdir(source); await copyAgent(resolve('.'), source);
  const container = `seeda-command-${randomUUID()}`;
  const remoteCwd = '/project with spaces';
  const commands = new Map<string, { command: string; cwd?: string; timeout?: number }>();
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const messages = JSON.parse(body).messages as Message[];
    const task = messages.filter(message => message.role === 'user').at(-1)!.content!;
    const done = messages.at(-1)?.role === 'tool';
    const delta = done ? { content: 'done' } : { tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: 'bash', arguments: JSON.stringify(commands.get(task)) } }] };
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: done ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const saved = Object.fromEntries(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'SEEDA_SYSTEM_PROXY'].map(key => [key, process.env[key]]));
  process.env.DEEPSEEK_API_KEY = 'local-test'; process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${address.port}`; process.env.SEEDA_SYSTEM_PROXY = '0';
  const store = await VersionStore.open(join(root, 'state'));
  let supervisor: Supervisor | undefined, client: RuntimeClient | undefined;
  t.after(async () => {
    client?.close(); await supervisor?.close(); store.close();
    await exec('docker', ['rm', '-f', container]).catch(() => {});
    server.closeAllConnections(); server.close();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  const initial = await store.initialize(source);
  const run = async (task: string, args: { command: string; cwd?: string; timeout?: number }, onEvent?: (event: AgentEvent) => void) => {
    commands.set(task, args); const results: Record<string, unknown>[] = [];
    await client!.run(task, event => { if (event.type === 'tool_end') results.push(event.result as Record<string, unknown>); onEvent?.(event); });
    assert.equal(results.length, 1, `${task} must execute exactly one command`);
    return results[0];
  };
  await t.test('E1 same source version writes and reads in the local workspace', async () => {
    supervisor = new Supervisor(store, cwd, { kind: 'local' }); await supervisor.start();
    client = await RuntimeClient.connect(supervisor.socketPath);
    const result = await run('local file', { command: "printf local-only > marker.txt; pwd; cat marker.txt" });
    assert.equal(result.status, 'completed'); assert.match(String(result.output), /project with spaces/);
    assert.equal(await readFile(join(cwd, 'marker.txt'), 'utf8'), 'local-only');
    assert.equal(store.state().current_version, initial.id);
    client.close(); await supervisor.close();
  });
  await exec('docker', ['run', '-d', '--name', container, '--init', image, 'sleep', '300']);
  await exec('docker', ['exec', container, 'mkdir', '-p', remoteCwd]);
  supervisor = new Supervisor(store, cwd, { kind: 'docker', container, cwd: remoteCwd }); await supervisor.start();
  client = await RuntimeClient.connect(supervisor.socketPath);
  await t.test('E1/E2 Docker has a distinct filesystem and accepts a cwd with spaces', async () => {
    const result = await run('docker file', { command: 'test ! -e marker.txt; printf docker-only > marker.txt; pwd; cat marker.txt', cwd: remoteCwd });
    assert.equal(result.status, 'completed'); assert.match(String(result.output), /docker-only/);
    assert.equal((await exec('docker', ['exec', container, 'cat', `${remoteCwd}/marker.txt`])).stdout, 'docker-only');
    assert.equal(await readFile(join(cwd, 'marker.txt'), 'utf8'), 'local-only');
    assert.equal(store.state().current_version, initial.id);
  });
  await t.test('E3 output truncation retains a complete artifact and nonzero status', async () => {
    const result = await run('large output', { command: `node -e 'process.stdout.write("x".repeat(100000))'` });
    assert.equal(result.truncated, true); assert.ok(String(result.output).length < 100000);
    assert.equal(await readFile(String(result.full_output_path), 'utf8'), 'x'.repeat(100000));
    const failed = await run('nonzero exit', { command: 'printf expected-error >&2; exit 17' });
    assert.equal(failed.exit_code, 17); assert.equal(failed.status, 'failed'); assert.match(String(failed.output), /expected-error/);
  });
  const checkStopped = async (file: string) => {
    const inspect = `const fs=require('fs');const pids=fs.readFileSync(${JSON.stringify(`${remoteCwd}/${file}`)},'utf8').trim().split(/\\s+/);console.log(JSON.stringify(pids.map(pid=>{try{return {pid,state:fs.readFileSync('/proc/'+pid+'/stat','utf8').split(' ')[2]}}catch{return {pid,state:'gone'}}})))`;
    const states = JSON.parse((await exec('docker', ['exec', container, 'node', '-e', inspect])).stdout) as { pid: string; state: string }[];
    t.diagnostic(`${file} descendant states: ${JSON.stringify(states)}`);
    assert.ok(states.length >= 4, 'must inspect ordinary and detached descendants'); assert.ok(states.every(process => ['gone', 'Z'].includes(process.state)), JSON.stringify(states));
  };
  await t.test('E3 timeout terminates the container shell and its descendants', async () => {
    const result = await run('timeout command', { command: 'sleep 60 & child=$!; echo "$$ $child" > timeout.pids; setsid bash -c \'sleep 60 & echo "$BASHPID $!" >> timeout.pids; wait\' & wait', timeout: 1 });
    assert.equal(result.status, 'timed_out'); await checkStopped('timeout.pids');
  });
  await t.test('E3 cancellation terminates the container shell and its descendants', async () => {
    let cancel: Promise<void> | undefined;
    const pending = run('cancel command', { command: 'sleep 60 & child=$!; echo "$$ $child" > cancel.pids; setsid bash -c \'sleep 60 & echo "$BASHPID $!" >> cancel.pids; wait\' & wait', timeout: 60 }, event => {
      if (event.type === 'tool_start') cancel = (async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          try { await exec('docker', ['exec', container, 'bash', '-c', 'test "$(wc -w < "$1")" -ge 4', 'bash', `${remoteCwd}/cancel.pids`]); client!.cancel(); return; }
          catch { await new Promise(resolve => setTimeout(resolve, 25)); }
        }
        throw new Error('Command never started inside Docker');
      })();
    });
    await pending.catch(error => { assert.match(String(error), /cancel|abort/i); }); await cancel;
    await checkStopped('cancel.pids');
  });
  await t.test('E5 a missing container fails without executing on the host', async () => {
    client!.close(); await supervisor!.close();
    supervisor = new Supervisor(store, cwd, { kind: 'docker', container: `missing-${randomUUID()}`, cwd: remoteCwd }); await supervisor.start();
    client = await RuntimeClient.connect(supervisor.socketPath);
    const sentinel = join(cwd, 'must-not-exist');
    const result = await run('missing container', { command: `printf unsafe > ${JSON.stringify(sentinel)}` });
    assert.equal(result.status, 'failed');
    await assert.rejects(stat(sentinel), { code: 'ENOENT' });
  });
});
