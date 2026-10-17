import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, Session, BashTool } from '../src/index.ts';
import { RuntimeRecordsTool } from '../src/tools/runtime-records.ts';
import type { Model, ModelResponse, Message } from '../src/core/types.ts';

async function workspace(t: { after(fn: () => Promise<void>): void }) {
  const cwd = await mkdtemp(join(tmpdir(), 'seeda-records-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, session: await Session.open(join(cwd, 'session.jsonl'), cwd), artifactDir: join(cwd, 'outputs') };
}
const done = (content = 'done'): ModelResponse => ({ message: { role: 'assistant', content }, finishReason: 'stop' });
function call(id: string, name: string, args: unknown): ModelResponse {
  return { message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls' };
}

test('length feedback is readable in the same run; the whole truncated batch stays unexecuted', async t => {
  const w = await workspace(t); let step = 0;
  const usage = { promptTokens: 12, completionTokens: 9, totalTokens: 21, promptCacheHitTokens: 0, promptCacheMissTokens: 12 };
  const model: Model = { async complete(messages, tools) {
    assert.ok(tools.some(tool => tool.function.name === 'runtime_records'));
    switch (step++) {
      case 0: {
        const cut = call('cut-valid', 'bash', { command: 'touch forbidden' });
        cut.message.tool_calls!.push({ id: 'cut-partial', type: 'function', function: { name: 'bash', arguments: '{"command":' } });
        return { ...cut, finishReason: 'length', usage };
      }
      case 1:
        assert.match(messages.at(-1)!.content!, /Runtime feedback: model_length/);
        assert.equal(messages.at(-1)!.role, 'system');
        assert.equal(messages.findLast(m => m.role === 'user')!.content, 'original task');
        assert.ok(!messages.some(m => m.tool_calls?.some(c => c.id.startsWith('cut-'))));
        return call('inspect', 'runtime_records', {});
      case 2: {
        const report = JSON.parse(messages.at(-1)!.content!);
        assert.equal(report.scope, 'current_session');
        const failure = report.runs[0].recentCalls.find((c: any) => c.failure?.reason === 'model_length');
        assert.equal(failure.usage.completionTokens, 9);
        assert.equal(report.runs[0].usage.totalTokens, 21);
        return call('adjust', 'bash', { command: 'test ! -e forbidden && printf adjusted > proof' });
      }
      default: return done();
    }
  } };
  await new Agent({ ...w, tools: [new BashTool()], model }).run('original task');
  assert.equal(await readFile(join(w.cwd, 'proof'), 'utf8'), 'adjusted');
  await assert.rejects(readFile(join(w.cwd, 'forbidden')), { code: 'ENOENT' });
  const restored = await Session.open(w.session.path, w.cwd);
  const report = await new RuntimeRecordsTool(restored, ['bash']).execute({}) as any;
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].status, 'completed');
  assert.equal(report.runs[0].modelCalls, 4);
  assert.equal(report.runs[0].toolCalls, 2);
  assert.ok(report.runs[0].recentCalls.some((c: any) => c.failure?.reason === 'model_length'));
  assert.ok(!(await readFile(w.session.path, 'utf8')).includes('cut-valid'));
});

test('cancel on length feedback prevents another request and never executes its tools', async t => {
  const w = await workspace(t); let calls = 0;
  const agent = new Agent({ ...w, tools: [new BashTool()], onEvent(event) {
    if (event.type === 'feedback' && event.failure.reason === 'model_length') agent.cancel();
  }, model: { async complete() {
    calls++;
    return { ...call('cut', 'bash', { command: 'touch forbidden' }), finishReason: 'length', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, promptCacheHitTokens: 0, promptCacheMissTokens: 1 } };
  } } });
  await assert.rejects(agent.run('cancel'));
  assert.equal(calls, 1);
  assert.equal(w.session.runtime.recent()[0].status, 'cancelled');
  await assert.rejects(readFile(join(w.cwd, 'forbidden')), { code: 'ENOENT' });
});

test('actual nonzero exit and Bash timeout are counted without copying arguments or output', async t => {
  const w = await workspace(t); let step = 0;
  const script = [call('fail', 'bash', { command: 'echo private-body; exit 7' }), call('timeout', 'bash', { command: 'sleep 5', timeout: 0.05 }), done()];
  await new Agent({ ...w, tools: [new BashTool()], model: { async complete() { return script[step++]; } } }).run('tools');
  const report = await new RuntimeRecordsTool(w.session, ['bash']).execute({}) as any;
  assert.equal(report.runs[0].toolFailures, 2);
  assert.equal(report.runs[0].recentCalls.find((c: any) => c.exitCode === 7).status, 'failed');
  assert.ok(report.runs[0].recentCalls.some((c: any) => c.status === 'timed_out'));
  assert.ok(!JSON.stringify(report).includes('private-body'));
  const telemetry = (await readFile(w.session.path, 'utf8')).split('\n').filter(line => line.includes('"type":"runtime"')).join('\n');
  assert.ok(!telemetry.includes('private-body'));
});

test('cancellation records a measured task ending without inventing failed-request usage', async t => {
  const w = await workspace(t); let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const agent = new Agent({ ...w, tools: [], model: { async complete(_m, _t, signal) { started(); await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('private-error')), { once: true })); return done(); } } });
  const pending = agent.run('cancel'); await ready; agent.cancel();
  await assert.rejects(pending);
  const loaded = await Session.open(w.session.path, w.cwd);
  const run = loaded.runtime.recent()[0];
  assert.equal(run.status, 'cancelled'); assert.equal(run.reason, 'cancelled');
  assert.equal(run.modelCalls, 1); assert.equal(run.usage, null);
  assert.ok(!JSON.stringify(run).includes('private-error'));
});

test('old sessions explicitly report unknown measurements and reads do not mutate the file', async t => {
  const w = await workspace(t);
  await writeFile(w.session.path, JSON.stringify({ type: 'request', id: 'old', implementationVersion: 'old-version' }) + '\n' + JSON.stringify({ type: 'end', status: 'failed', error: 'private-error' }) + '\n');
  const loaded = await Session.open(w.session.path, w.cwd);
  const before = await readFile(w.session.path, 'utf8');
  const report = await new RuntimeRecordsTool(loaded, []).execute({}) as any;
  assert.equal(report.runs[0].measured, false); assert.equal(report.runs[0].modelCalls, null);
  assert.equal(report.runs[0].durationMs, undefined);
  assert.ok(!JSON.stringify(report).includes('private-error'));
  assert.equal(await readFile(w.session.path, 'utf8'), before);
  for (const args of [{ limit: 0 }, { limit: 21 }, { path: '/other/session' }, { limit: 1.5 }]) await assert.rejects(new RuntimeRecordsTool(loaded, []).execute(args));
});

test('history is bounded and survives context compression', async t => {
  const w = await workspace(t);
  for (let i = 0; i < 25; i++) { await w.session.beginRequest(); await w.session.end('completed'); }
  await w.session.compact([{ role: 'user', content: 'summary' }]);
  const loaded = await Session.open(w.session.path, w.cwd);
  assert.equal(loaded.runtime.recent(20).length, 20);
  assert.equal(loaded.runtime.recent().length, 5);
  assert.equal(loaded.runtime.recent()[0].status, 'completed');
});

test('telemetry write failure leaves execution usable and marks missing coverage', async t => {
  const w = await workspace(t);
  await w.session.beginRequest(); await rm(w.session.path); await mkdir(w.session.path);
  await w.session.observe({ kind: 'model', status: 'failed', durationMs: 1 });
  assert.equal(w.session.runtime.recordingComplete, false);
  await rm(w.session.path, { recursive: true }); await writeFile(w.session.path, '');
  await new Agent({ ...w, tools: [], model: { async complete() { return done(); } } }).run('still works');
  assert.equal((await Session.open(w.session.path, w.cwd)).runtime.recordingComplete, false);
});
