import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { copyAgent } from '../src/versions/snapshot.ts';

const exec = promisify(execFile);
const pause = () => new Promise(resolve => setTimeout(resolve, 100));

test('SIGKILL of the Supervisor host cleans local and Docker commands through the independent guardian', { timeout: 60000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sd-')));
  const source = join(root, 'source'); await mkdir(source); await copyAgent(resolve('.'), source);
  let command = '', passed = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const messages = JSON.parse(body).messages;
    const done = messages.at(-1)?.role === 'tool';
    res.setHeader('Content-Type', 'text/event-stream');
    const delta = done ? { content: 'done' } : { tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, timeout: 60 }) } }] };
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: done ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const image = 'mirror.gcr.io/library/node:24-bookworm-slim';
  const container = `seeda-command-death-${randomUUID()}`;
  let dockerCreated = false;
  t.after(async () => {
    if (dockerCreated) await exec('docker', ['rm', '-f', container]).catch(() => {});
    server.closeAllConnections(); server.close();
    if (passed === 2) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`Failure evidence retained at ${root}`);
  });
  for (const kind of ['local', 'docker'] as const) await t.test(kind, async st => {
    if (kind === 'docker') {
      try { await exec('docker', ['image', 'inspect', image]); }
      catch { st.skip(`Requires existing ${image}`); return; }
      await exec('docker', ['run', '-d', '--init', '--name', container, image, 'sleep', '180']); dockerCreated = true;
    }
    const cwd = join(root, kind); await mkdir(cwd);
    const remoteCwd = '/command death';
    if (kind === 'docker') await exec('docker', ['exec', container, 'mkdir', '-p', remoteCwd]);
    command = 'sleep 60 & echo "$$ $!" > pids';
    if (kind === 'docker') command += '; setsid bash -c \'sleep 60 & echo "$BASHPID $!" >> pids; wait\' &';
    command += '; wait';
    // The Docker background operator already separates the following wait.
    command = command.replace('&; wait', '& wait');
    const child = fork(fileURLToPath(new URL('./fixtures/command-host.ts', import.meta.url)), [join(root, `${kind}-state`), source, cwd, JSON.stringify(kind === 'local' ? { kind } : { kind, container, cwd: remoteCwd })], {
      execArgv: ['--experimental-strip-types'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, DEEPSEEK_API_KEY: 'local-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`, SEEDA_SYSTEM_PROXY: '0' },
    });
    let logs = ''; child.stdout?.on('data', data => { logs += data; }); child.stderr?.on('data', data => { logs += data; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let pids: number[] = [];
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const text = kind === 'local' ? await readFile(join(cwd, 'pids'), 'utf8') : (await exec('docker', ['exec', container, 'cat', `${remoteCwd}/pids`])).stdout;
          pids = text.trim().split(/\s+/).map(Number);
          if (pids.length === (kind === 'local' ? 2 : 4)) break;
        } catch { /* Wait for the real command to register its descendants. */ }
        await pause();
      }
      assert.equal(pids.length, kind === 'local' ? 2 : 4, logs);
      assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 1));
      assert.equal(child.kill('SIGKILL'), true);
      assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
      let states: string[] = [];
      for (let attempt = 0; attempt < 100; attempt++) {
        if (kind === 'local') states = await Promise.all(pids.map(async pid => {
          try { return (await exec('ps', ['-o', 'stat=', '-p', String(pid)])).stdout.trim().slice(0, 1); }
          catch { return 'gone'; }
        }));
        else {
          const inspect = `const fs=require('fs');console.log(JSON.stringify(${JSON.stringify(pids)}.map(pid=>{try{return fs.readFileSync('/proc/'+pid+'/stat','utf8').split(' ')[2]}catch{return 'gone'}})))`;
          states = JSON.parse((await exec('docker', ['exec', container, 'node', '-e', inspect])).stdout);
        }
        if (states.every(state => ['gone', 'Z'].includes(state))) break;
        await pause();
      }
      const evidence = { supervisorPid: child.pid, pids, states };
      await writeFile(join(root, `${kind}-processes.json`), JSON.stringify(evidence, null, 2)); st.diagnostic(JSON.stringify(evidence));
      assert.ok(states.every(state => ['gone', 'Z'].includes(state)), JSON.stringify(evidence)); passed++;
    } finally {
      child.kill('SIGKILL'); await writeFile(join(root, `${kind}-fixture.log`), logs);
      // Clean only PIDs recorded by this test, even if the implementation failed.
      const cleanupPids = pids.filter(pid => Number.isSafeInteger(pid) && pid > 1);
      if (kind === 'local') for (const pid of cleanupPids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      else if (cleanupPids.length) await exec('docker', ['exec', container, 'kill', '-KILL', ...cleanupPids.map(String)]).catch(() => {});
    }
  });
});
