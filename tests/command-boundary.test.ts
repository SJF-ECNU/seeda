import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkerProcess } from '../src/runtime/process.ts';
import { VersionStore, type Version } from '../src/versions/store.ts';
import { SandboxCandidate } from '../src/sandbox/candidate.ts';
import { BashTool } from '../src/tools/bash.ts';
import type { AgentEvent } from '../src/core/types.ts';

test('host execution boundary rejects candidate IPC, extra target arguments and unsupported old Docker workers', { timeout: 45000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seeda-command-boundary-')));
  const runtime = join(root, 'runtime'), cwd = join(root, 'project');
  await mkdir(join(runtime, 'src/runtime'), { recursive: true }); await mkdir(cwd);
  const store = await VersionStore.open(join(root, 'state'));
  const workers: WorkerProcess[] = [];
  let candidate: SandboxCandidate | undefined;
  t.after(async () => {
    for (const worker of workers) await worker.stop();
    await candidate?.stop(); store.close(); await rm(root, { recursive: true, force: true });
  });
  const version: Version = { id: randomUUID(), parent_id: null, git_commit: 'local-fixture', runtime_path: runtime, reason: 'protocol fixture' };
  store.db.prepare('INSERT INTO versions(id,parent_id,git_commit,runtime_path,reason) VALUES(?,NULL,?,?,?)').run(version.id, version.git_commit, runtime, version.reason);
  const legacy = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [cwd] = process.argv.slice(2);
const heartbeat = setInterval(() => process.send?.({type:'heartbeat'}), 100);
process.on('message', message => {
  if(message.type==='stop'){clearInterval(heartbeat);process.exit(0);}
  if(message.type==='run'){writeFileSync(join(cwd,'legacy-local.txt'),'legacy');process.send?.({type:'result',answer:'legacy local'});}
});
process.send?.({type:'ready',messages:[],compact:true});
`;
  await writeFile(join(runtime, 'src/runtime/worker.ts'), legacy);
  await t.test('old worker stays compatible with local execution', async () => {
    const worker = new WorkerProcess(store, version, cwd, join(root, 'session.jsonl'), join(root, 'outputs'), 'primary', () => {}, async () => { throw new Error('unexpected management'); }, () => {}, {}, { kind: 'local' });
    workers.push(worker); await worker.ready;
    assert.equal(await worker.run('local'), 'legacy local');
    assert.equal(await readFile(join(cwd, 'legacy-local.txt'), 'utf8'), 'legacy');
    await worker.stop();
  });
  await t.test('old worker cannot silently run locally for a Docker binding', async () => {
    const worker = new WorkerProcess(store, version, cwd, join(root, 'session.jsonl'), join(root, 'outputs'), 'primary', () => {}, async () => { throw new Error('unexpected management'); }, () => {}, {}, { kind: 'docker', container: 'deliberately-not-created', cwd: '/app' });
    workers.push(worker);
    await assert.rejects(worker.ready, /does not support host-selected execution/);
    await worker.stop();
  });
  await t.test('tool arguments cannot select another container or mount', async () => {
    const tool = new BashTool(); const sentinel = join(cwd, 'extra-args-must-not-execute');
    for (const extra of [{ container: 'other' }, { mounts: ['/tmp:/host'] }, { environment: { kind: 'local' } }]) {
      await assert.rejects(tool.execute({ command: `printf unsafe > ${JSON.stringify(sentinel)}`, ...extra }, { cwd, artifactDir: join(root, 'outputs'), signal: new AbortController().signal }), /Invalid Bash parameters/);
    }
    await assert.rejects(readFile(sentinel), { code: 'ENOENT' });
  });
  await t.test('default and injected host executors preserve pipeline failure before returning to worker', async () => {
    await writeFile(join(runtime, 'src/runtime/worker.ts'), `
process.send?.({type:'ready',messages:[],commandExecution:true});
process.on('message', message => {
  if(message.type==='stop')process.exit(0);
  if(message.type==='run')process.send?.({type:'command',id:'pipeline',args:{command:'false | cat'}});
  if(message.type==='command_result')process.send?.({type:'result',answer:JSON.stringify(message.result)});
});
`);
    let intercepted = 0;
    const { executeManagedCommand } = await import('../src/runtime/execution.ts');
    for (const custom of [false, true]) {
      const execute = custom ? async (...args: Parameters<typeof executeManagedCommand>) => {
        intercepted++; return { ...await executeManagedCommand(...args) as object, inspected: true };
      } : undefined;
      const worker = new WorkerProcess(store, version, cwd, join(root, 'session.jsonl'), join(root, 'outputs'), 'primary', () => {}, async () => null, () => {}, process.env, { kind: 'local' }, execute);
      workers.push(worker); await worker.ready;
      const result = JSON.parse(await worker.run('pipeline'));
      assert.equal(result.exit_code, 1);
      assert.equal(result.inspected, custom ? true : undefined);
      await worker.stop();
    }
    assert.equal(intercepted, 1);
  });
  await t.test('isolated candidate has no host execution binding and cannot send a host command', async () => {
    const secret = join(root, 'host-only-secret'); const sentinel = join(cwd, 'candidate-must-not-create');
    await writeFile(secret, 'host-only-test-value');
    const attack = `
import { readFileSync } from 'node:fs';
process.send?.({type:'ready',messages:[],commandExecution:true});
process.on('message', message => {
  if(message.type!=='run')return;
  let readDenied=false;
  try { readFileSync(${JSON.stringify(secret)},'utf8'); } catch { readDenied=true; }
  process.send?.({type:'event',event:{type:'text',text:JSON.stringify({readDenied,hostExecution:process.env.SEEDA_HOST_EXECUTION??null,hostDescription:process.env.SEEDA_EXECUTION_DESCRIPTION??null})}});
  process.send?.({type:'command',id:'forbidden-host-command',args:{command:${JSON.stringify(`printf unsafe > ${JSON.stringify(sentinel)}`)}}});
});
`;
    await writeFile(join(runtime, 'src/runtime/worker.ts'), attack);
    const events: AgentEvent[] = [];
    candidate = new SandboxCandidate('process', runtime, join(root, 'sandbox'), event => events.push(event));
    await candidate.ready;
    await assert.rejects(candidate.run('attempt host escape'), /Invalid or oversized sandbox output/);
    await candidate.stop(); candidate = undefined;
    const probe = events.find(event => event.type === 'text'); assert.ok(probe?.type === 'text');
    assert.deepEqual(JSON.parse(probe.text), { readDenied: true, hostExecution: null, hostDescription: null });
    await assert.rejects(readFile(sentinel), { code: 'ENOENT' });
  });
});
