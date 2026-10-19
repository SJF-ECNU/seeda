import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxCandidate } from '../src/sandbox/candidate.ts';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seeda-command-eval-')));
  const runtime = join(root, 'runtime');
  await mkdir(join(runtime, 'src/runtime'), { recursive: true });
  await writeFile(join(runtime, 'src/runtime/worker.ts'), `
process.send({type:'ready'});
process.on('message', m => {
  if(m.type==='run') process.send({type:'command',id:'one',args:{command:'browser fixture'}});
  if(m.type==='command_result') process.send({type:'result',answer:JSON.stringify(m)});
});`);
  return { root, runtime, work: join(root, 'sandbox') };
}
test('candidate command requires explicit owner binding', async () => {
  const f = await fixture();
  const candidate = new SandboxCandidate('process', f.runtime, f.work, () => {}, null);
  try { await assert.rejects(candidate.run('run'), /Invalid or oversized sandbox output/); }
  finally { await candidate.stop(); await rm(f.root, { recursive: true, force: true }); }
});
test('explicit candidate command binding returns owner results and waits for cancellation cleanup', async () => {
  const f = await fixture(); let calls = 0;
  let candidate = new SandboxCandidate('process', f.runtime, f.work, () => {}, null, async (args, context) => {
    calls++; assert.equal(args.command, 'browser fixture');
    assert.equal(context.cwd, f.work); assert.equal(context.artifactDir, join(f.work, 'outputs'));
    return { exit_code: 0, owner: 'isolated' };
  });
  try {
    const value = JSON.parse(await candidate.run('run'));
    assert.equal(value.result.owner, 'isolated'); assert.equal(calls, 1);
    await candidate.stop();
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; }); let cleaned = false;
    candidate = new SandboxCandidate('process', f.runtime, join(f.root, 'second'), () => {}, null, async (_args, context) => {
      started();
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { setTimeout(() => { cleaned = true; resolve(); }, 40); }, { once: true }));
      throw new Error('cancelled');
    });
    const running = candidate.run('run'); void running.catch(() => {});
    await ready; candidate.cancel(); await assert.rejects(running, /cancelled/);
    await candidate.stop(); assert.equal(cleaned, true);
  } finally { await candidate.stop(); await rm(f.root, { recursive: true, force: true }); }
});
