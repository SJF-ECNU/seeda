import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/core/agent.ts';
import { Session } from '../src/core/session.ts';
import { compactContext, estimateContextTokens, projectInstructions } from '../src/core/context.ts';
import { RuntimeRecordsTool } from '../src/tools/runtime-records.ts';
import type { Message, Model } from '../src/core/types.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const cwd = await mkdtemp(join(tmpdir(), 'seeda-compaction-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, session: await Session.open(join(cwd, 'session.jsonl'), cwd) };
}
function scriptedModel(onSummary?: (messages: Message[]) => void): Model {
  return { maxOutputTokens: 64, async complete(messages, tools) {
    const summary = messages[0].content?.startsWith('Create a concise continuation checkpoint');
    if (summary) { assert.equal(tools.length, 0); onSummary?.(messages); }
    return { message: { role: 'assistant', content: summary ? 'Goal retained; verified progress; next action pending.' : 'continued' }, finishReason: 'stop' };
  } };
}

test('Agent triggers at 85 percent before full capacity and stays idle below it', async t => {
  for (const [targetTokens, expected] of [[1600, 0], [1800, 1]]) {
    const { cwd, session } = await fixture(t); let summaries = 0; const events: string[] = [];
    const system = await projectInstructions(cwd), definitions = [new RuntimeRecordsTool(session, []).definition];
    const base = estimateContextTokens(system, [{ role: 'user', content: '' }, { role: 'assistant', content: 'old result' }, { role: 'user', content: 'continue' }], definitions);
    const length = Math.max(0, (targetTokens - base) * 3);
    await session.add({ role: 'user', content: 'x'.repeat(length) });
    await session.add({ role: 'assistant', content: 'old result' });
    const agent = new Agent({ cwd, session, artifactDir: cwd, tools: [], maxContextTokens: 2000,
      model: scriptedModel(() => summaries++), onEvent: event => events.push(event.type) });
    assert.equal(await agent.run('continue'), 'continued');
    assert.equal(summaries > 0, expected > 0); assert.equal(events.includes('compacted'), expected > 0);
  }
});

test('oversized history is summarized in bounded batches with checkpoint carry and reload', async t => {
  const { cwd, session } = await fixture(t); const parts: string[] = []; let previous = '';
  await session.add({ role: 'user', content: 'goal: retain evidence' });
  await session.add({ role: 'assistant', content: null, tool_calls: [{ id: 'old', type: 'function', function: { name: 'bash', arguments: '{}' } }] });
  await session.add({ role: 'tool', tool_call_id: 'old', content: '😀'.repeat(6000) });
  await session.add({ role: 'user', content: 'latest goal' });
  await session.add({ role: 'assistant', content: null, tool_calls: [{ id: 'recent', type: 'function', function: { name: 'bash', arguments: '{}' } }] });
  await session.add({ role: 'tool', tool_call_id: 'recent', content: 'verified recent result' });
  const source = session.getContext();
  const model = scriptedModel(messages => {
    assert.ok(estimateContextTokens(messages[0].content!, messages.slice(1)) <= 1700);
    const payload = JSON.parse(messages[1].content!); assert.equal(payload.checkpoint, previous);
    parts.push(payload.transcript_fragment); previous = 'Goal retained; verified progress; next action pending.';
  });
  assert.equal(await compactContext(session, model, '', 2000, new AbortController().signal, false, estimateContextTokens, estimateContextTokens, 1700), true);
  assert.ok(parts.length > 1);
  assert.deepEqual(JSON.parse(parts.join('')), source.slice(0, 3));
  const context = session.getContext();
  assert.ok(context.some(m => m.content === 'latest goal'));
  assert.ok(context.some(m => m.tool_calls?.[0]?.id === 'recent'));
  assert.ok(context.some(m => m.tool_call_id === 'recent'));
  const reopened = await Session.open(session.path, cwd); assert.deepEqual(reopened.getContext(), context);
  assert.equal(reopened.messages.length, source.length);
  assert.ok((await readFile(session.path, 'utf8')).includes('retain evidence'));
});

test('failure or cancellation after a successful batch does not partially replace context', async t => {
  for (const cancel of [false, true]) {
    const { session } = await fixture(t); await session.add({ role: 'user', content: 'x'.repeat(20000) });
    await session.add({ role: 'assistant', content: 'done' }); await session.add({ role: 'user', content: 'continue' });
    const before = session.getContext(); const controller = new AbortController(); let calls = 0;
    const model: Model = { async complete() {
      if (++calls === 2) { if (cancel) controller.abort(); else throw new Error('summary rejected'); }
      return { message: { role: 'assistant', content: 'checkpoint' }, finishReason: 'stop' };
    } };
    await assert.rejects(compactContext(session, model, '', 2000, controller.signal, true, estimateContextTokens, estimateContextTokens));
    assert.equal(calls, 2); assert.deepEqual(session.getContext(), before);
    assert.ok(!(await readFile(session.path, 'utf8')).includes('"type":"compact"'));
  }
});

test('incomplete, empty and oversized summaries retain original context', async t => {
  for (const response of [{ content: 'partial', finishReason: 'length' }, { content: ' ', finishReason: 'stop' }, { content: 'x'.repeat(5000), finishReason: 'stop' }]) {
    const { session } = await fixture(t); await session.add({ role: 'user', content: 'old task' });
    await session.add({ role: 'assistant', content: 'old result' }); await session.add({ role: 'user', content: 'continue' });
    const before = session.getContext();
    const model: Model = { async complete() { return { message: { role: 'assistant', content: response.content }, finishReason: response.finishReason }; } };
    await assert.rejects(compactContext(session, model, '', 2000, new AbortController().signal, true, estimateContextTokens, estimateContextTokens));
    assert.deepEqual(session.getContext(), before);
  }
});

test('manual compaction works below threshold and repeated compaction carries earlier checkpoint', async t => {
  const { cwd, session } = await fixture(t); const checkpoints: string[] = [];
  const model = scriptedModel(messages => checkpoints.push(JSON.parse(messages[1].content!).transcript_fragment));
  const agent = new Agent({ cwd, session, artifactDir: cwd, tools: [], model });
  await agent.run('first goal'); await agent.run('second goal');
  assert.match(await agent.compact(), /已压缩/); await agent.run('third goal'); assert.match(await agent.compact(), /已压缩/);
  assert.ok(checkpoints[1].includes('Earlier session summary'));
});

test('automatic compaction retains current user instructions during a long tool turn', async t => {
  const { session } = await fixture(t); await session.add({ role: 'user', content: 'ACTIVE: only edit requested file' });
  for (let i = 0; i < 10; i++) {
    await session.add({ role: 'assistant', content: null, tool_calls: [{ id: `call${i}`, type: 'function', function: { name: 'bash', arguments: '{}' } }] });
    await session.add({ role: 'tool', tool_call_id: `call${i}`, content: 'x'.repeat(800) });
  }
  await compactContext(session, scriptedModel(), '', 2000, new AbortController().signal, false, estimateContextTokens, estimateContextTokens, 1700);
  assert.ok(session.getContext().some(m => m.content === 'ACTIVE: only edit requested file'));
  assert.ok(session.getContext().some(m => m.tool_call_id === 'call9'));
});

test('exact threshold compacts, one unit below it does not', async t => {
  const { session } = await fixture(t); await session.add({ role: 'user', content: 'old goal ' + 'x'.repeat(3000) });
  await session.add({ role: 'assistant', content: 'verified' }); await session.add({ role: 'user', content: 'next' });
  const measure = (system: string, messages: Message[]) => system.length + JSON.stringify(messages).length;
  const occupancy = measure('', session.getContext()); let summaries = 0;
  const model = scriptedModel(() => summaries++);
  assert.equal(await compactContext(session, model, '', 8000, new AbortController().signal, false, measure, measure, occupancy + 1), false);
  assert.equal(summaries, 0);
  assert.equal(await compactContext(session, model, '', 8000, new AbortController().signal, false, measure, measure, occupancy), true);
  assert.equal(summaries, 1);
});

test('the newest oversized tool exchange is summarized while active user instructions stay intact', async t => {
  const { session } = await fixture(t); await session.add({ role: 'user', content: 'keep this active goal' });
  await session.add({ role: 'assistant', content: null, tool_calls: [{ id: 'large', type: 'function', function: { name: 'bash', arguments: '{}' } }] });
  await session.add({ role: 'tool', tool_call_id: 'large', content: 'x'.repeat(18000) });
  let calls = 0;
  assert.equal(await compactContext(session, scriptedModel(() => calls++), '', 2000, new AbortController().signal, false, estimateContextTokens, estimateContextTokens, 1700), true);
  assert.ok(calls > 1); assert.ok(session.getContext().some(m => m.content === 'keep this active goal'));
  assert.equal(session.messages.length, 3);
  assert.ok(!session.getContext().some(m => m.role === 'tool'));
});
