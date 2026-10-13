import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent, BashTool, Session } from '../src/index.ts';
import { compactContext, messageGroups, projectInstructions } from '../src/core/context.ts';
import type { Message, Model, ModelResponse, ToolDefinition } from '../src/core/types.ts';

async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
  const cwd = await mkdtemp(join(tmpdir(), 'seeda-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const session = await Session.open(join(cwd, 'session.jsonl'), cwd);
  return { cwd, session, artifactDir: join(cwd, 'outputs') };
}
function call(id: string, command: string): Message {
  return { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } }] };
}
function response(message: Message): ModelResponse { return { message, finishReason: message.tool_calls ? 'tool_calls' : 'stop' }; }
function scripted(messages: Message[]): Model {
  return { async complete() { const message = messages.shift(); assert.ok(message); return response(message); } };
}

test('actual coding loop reads, edits, runs a failing test, fixes it, then resumes conversation', async t => {
  const w = await workspace(t);
  await writeFile(join(w.cwd, 'sum.cjs'), 'module.exports = (a,b) => a-b;');
  await writeFile(join(w.cwd, 'check.cjs'), "require('node:assert/strict').equal(require('./sum.cjs')(2,3),5)");
  let round = 0;
  const model: Model = { async complete(messages) {
    round++;
    if (round === 1) return response(call('inspect', 'cat sum.cjs; node check.cjs'));
    if (round === 2) {
      assert.ok(messages.some(m => m.role === 'tool' && JSON.parse(m.content!).exit_code !== 0));
      return response(call('fix', "printf 'module.exports = (a,b) => a+b;' > sum.cjs; node check.cjs"));
    }
    if (round === 3) {
      assert.equal(JSON.parse(messages.at(-1)!.content!).exit_code, 0);
      return response({ role: 'assistant', content: 'Fixed addition; test passed.' });
    }
    assert.ok(messages.some(m => m.content === 'Fixed addition; test passed.'));
    return response({ role: 'assistant', content: 'The previous task fixed addition.' });
  } };
  const agent = new Agent({ ...w, model, tools: [new BashTool()] });
  assert.match(await agent.run('Fix addition'), /test passed/);
  assert.equal(await readFile(join(w.cwd, 'sum.cjs'), 'utf8'), 'module.exports = (a,b) => a+b;');
  const loaded = await Session.open(w.session.path, w.cwd);
  assert.match(await new Agent({ ...w, session: loaded, model, tools: [new BashTool()] }).run('What did you fix?'), /addition/);
});

test('invalid arguments and unknown tools are returned to the model without side effects', async t => {
  const w = await workspace(t);
  const message = call('invalid', 'echo bad');
  message.tool_calls![0].function.arguments = '{bad';
  message.tool_calls!.push({ id: 'unknown', type: 'function', function: { name: 'missing', arguments: '{}' } });
  const agent = new Agent({ ...w, model: scripted([message, { role: 'assistant', content: 'Handled' }]), tools: [new BashTool()] });
  await agent.run('go');
  assert.equal(w.session.messages.filter(m => m.role === 'tool').length, 2);
  assert.ok(w.session.messages.filter(m => m.role === 'tool').every(m => JSON.parse(m.content!).status === 'failed'));
});

test('truncated assistant output never executes tool calls', async t => {
  const w = await workspace(t);
  const model: Model = { async complete() { return { message: call('cut', 'touch forbidden'), finishReason: 'length' }; } };
  await assert.rejects(new Agent({ ...w, model, tools: [new BashTool()] }).run('go'), /normally/);
  await assert.rejects(readFile(join(w.cwd, 'forbidden')), { code: 'ENOENT' });
});

test('Bash timeout and cancellation terminate a process tree', async t => {
  const w = await workspace(t);
  const tool = new BashTool();
  const timeout = await tool.execute({ command: '(sleep 1; touch orphan) & wait', timeout: 0.05 }, { ...w, signal: new AbortController().signal }) as { status: string };
  assert.equal(timeout.status, 'timed_out');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  const cancelled = await tool.execute({ command: 'sleep 10' }, { ...w, signal: controller.signal }) as { status: string };
  clearTimeout(timer);
  assert.equal(cancelled.status, 'cancelled');
  await new Promise(r => setTimeout(r, 1100));
  await assert.rejects(readFile(join(w.cwd, 'orphan')), { code: 'ENOENT' });
});

test('Bash reports nonzero exits, rejects bad parameters and retains long output', async t => {
  const w = await workspace(t); const signal = new AbortController().signal;
  const tool = new BashTool(32);
  const result = await tool.execute({ command: "printf '%0100d' 0; exit 7" }, { ...w, signal }) as { output: string; exit_code: number; truncated: boolean; full_output_path: string };
  assert.equal(result.exit_code, 7); assert.equal(result.truncated, true); assert.equal(result.output.length, 32);
  assert.equal((await readFile(result.full_output_path)).length, 100);
  await assert.rejects(tool.execute({ command: 'echo x', timeout: -1 }, { ...w, signal }), /Invalid/);
  await assert.rejects(tool.execute({ command: 'echo x', unexpected: true }, { ...w, signal }), /Invalid/);
});

test('session recovers unresolved calls as unknown or unexecuted, without replay', async t => {
  const w = await workspace(t);
  const message = call('started', 'touch do-not-repeat');
  message.tool_calls!.push({ id: 'not-started', type: 'function', function: { name: 'bash', arguments: '{}' } });
  await w.session.add(message); await w.session.startTool('started');
  const loaded = await Session.open(w.session.path, w.cwd);
  const results = loaded.messages.filter(m => m.role === 'tool');
  assert.equal(JSON.parse(results[0].content!).status, 'unknown');
  assert.equal(JSON.parse(results[1].content!).status, 'not_executed');
  assert.equal((await Session.open(w.session.path, w.cwd)).messages.filter(m => m.role === 'tool').length, 2);
  await assert.rejects(readFile(join(w.cwd, 'do-not-repeat')), { code: 'ENOENT' });
});

test('session preserves and repairs interrupted JSONL tail', async t => {
  const w = await workspace(t);
  await w.session.add({ role: 'user', content: 'original' });
  const original = await readFile(w.session.path, 'utf8');
  await writeFile(w.session.path, original + '{"type":');
  const loaded = await Session.open(w.session.path, w.cwd);
  await loaded.add({ role: 'user', content: 'next' });
  const again = await Session.open(w.session.path, w.cwd);
  assert.equal(again.messages.length, 2);
});

test('compaction keeps complete tool pairs, persists the summary, preserves original history', async t => {
  const w = await workspace(t);
  await w.session.add({ role: 'user', content: 'old goal '+ 'x'.repeat(3000) });
  await w.session.add({ role: 'assistant', content: 'old answer' });
  await w.session.add({ role: 'user', content: 'continue old goal' });
  await w.session.add(call('recent', 'pwd'));
  await w.session.add({ role: 'tool', content: 'result', tool_call_id: 'recent' });
  const groups = messageGroups(w.session.getContext());
  assert.equal(groups.at(-1)!.length, 2);
  assert.equal(await compactContext(w.session, scripted(Array.from({ length: 10 }, () => ({ role: 'assistant' as const, content: 'Goal and progress' }))), 'system', 1200, new AbortController().signal), true);
  assert.equal(w.session.messages.length, 5);
  assert.equal(w.session.getContext()[0].role, 'system');
  const loaded = await Session.open(w.session.path, w.cwd);
  const context = loaded.getContext();
  const callIndex = context.findIndex(m => m.tool_calls?.length);
  assert.ok(callIndex >= 0);
  assert.equal(context[callIndex].tool_calls![0].id, context[callIndex + 1].tool_call_id);
});

test('failed compaction keeps the original context', async t => {
  const w = await workspace(t);
  await w.session.add({ role: 'user', content: 'x'.repeat(2000) });
  await w.session.add({ role: 'assistant', content: 'recent' });
  await w.session.add({ role: 'user', content: 'continue' });
  const before = w.session.getContext();
  const model: Model = { async complete() { throw new Error('summary failed'); } };
  await assert.rejects(compactContext(w.session, model, '', 1000, new AbortController().signal), /summary failed/);
  assert.deepEqual(w.session.getContext(), before);
});

test('project instructions discover optional Skills without creating project memory', async t => {
  const w = await workspace(t);
  assert.match(await projectInstructions(w.cwd), /Working directory/);
  await assert.rejects(readFile(join(w.cwd, 'project-memory', '首页.md')), { code: 'ENOENT' });
  const dir = join(w.cwd, '.agents', 'skills', 'example');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), '---\nname: example\ndescription: Run example checks\n---\nSECRET_BODY_NOT_PRELOADED');
  await writeFile(join(w.cwd, 'AGENTS.md'), 'Use ordinary tests.');
  const instructions = await projectInstructions(w.cwd);
  assert.match(instructions, /Run example checks/); assert.match(instructions, /Use ordinary tests/);
  assert.ok(!instructions.includes('SECRET_BODY_NOT_PRELOADED'));
});

test('cancelled batch records unexecuted calls and permits the next user request', async t => {
  const w = await workspace(t);
  const message = call('wait', 'sleep 10');
  message.tool_calls!.push(...call('later', 'touch later').tool_calls!);
  const agent = new Agent({ ...w, model: scripted([message, { role: 'assistant', content: 'next' }]), tools: [new BashTool()] });
  const timer = setTimeout(() => agent.cancel(), 50);
  await assert.rejects(agent.run('wait'));
  clearTimeout(timer);
  assert.equal(w.session.messages.filter(m => m.role === 'tool').length, 2);
  await assert.rejects(readFile(join(w.cwd, 'later')), { code: 'ENOENT' });
  assert.equal(await agent.run('continue'), 'next');
});

test('frontend observer failures do not alter real tool execution or request outcome', async t => {
  const w = await workspace(t);
  const agent = new Agent({ ...w, tools: [new BashTool()],
    model: scripted([call('write', 'touch delivered'), { role: 'assistant', content: 'done' }]),
    onEvent() { throw new Error('frontend failed'); } });
  assert.equal(await agent.run('write'), 'done');
  assert.equal((await readFile(join(w.cwd, 'delivered'))).length, 0);
  assert.equal(JSON.parse(w.session.messages.find(m => m.role === 'tool')!.content!).status, 'completed');
});

test('manual compaction below budget retains latest turn and tool pairs, and survives reopening', async t => {
  const w = await workspace(t);
  await w.session.add({ role: 'user', content: 'remember old goal' });
  await w.session.add({ role: 'assistant', content: 'old progress' });
  await w.session.add({ role: 'user', content: 'latest task' });
  await w.session.add(call('latest-call', 'pwd'));
  await w.session.add({ role: 'tool', tool_call_id: 'latest-call', content: 'cwd' });
  await w.session.add({ role: 'assistant', content: 'latest answer' });
  const agent = new Agent({ ...w, tools: [], model: { async complete(messages, tools) {
    assert.deepEqual(tools, []); assert.match(messages[1].content!, /remember old goal/);
    assert.ok(!messages[1].content!.includes('latest-call'));
    return response({ role: 'assistant', content: 'old goal and progress' });
  } } });
  assert.match(await agent.compact(), /已压缩/);
  const loaded = await Session.open(w.session.path, w.cwd);
  assert.equal(loaded.messages.length, 6);
  assert.equal(loaded.getContext()[0].role, 'system');
  assert.equal(loaded.getContext()[1].content, 'latest task');
  assert.equal(loaded.getContext()[2].tool_calls![0].id, loaded.getContext()[3].tool_call_id);
  const continuing = new Agent({ ...w, session: loaded, tools: [], model: { async complete(messages) {
    assert.ok(messages.some(message => message.role === 'system' && message.content?.includes('old goal and progress')));
    assert.ok(!messages.some(message => message.role === 'user' && message.content === 'remember old goal'));
    return response({ role: 'assistant', content: 'continued after compaction' });
  } } });
  assert.equal(await continuing.run('continue'), 'continued after compaction');
});

test('manual compaction cancellation preserves context even if provider ignores abort', async t => {
  const w = await workspace(t);
  for (const content of ['first', 'second']) { await w.session.add({ role: 'user', content }); await w.session.add({ role: 'assistant', content: 'answer' }); }
  const before = w.session.getContext(); let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; }); let finish!: () => void;
  const agent = new Agent({ ...w, tools: [], model: { async complete() { started(); await new Promise<void>(resolve => { finish = resolve; }); return response({ role: 'assistant', content: 'summary' }); } } });
  const compacting = agent.compact(); const rejected = assert.rejects(compacting);
  await waiting; await assert.rejects(agent.run('concurrent'), /already running/);
  agent.cancel(); finish(); await rejected;
  assert.deepEqual(w.session.getContext(), before);
  assert.deepEqual((await Session.open(w.session.path, w.cwd)).getContext(), before);
});

test('manual compaction skips a single turn without making a model request', async t => {
  const w = await workspace(t); await w.session.add({ role: 'user', content: 'hi' });
  const agent = new Agent({ ...w, tools: [], model: { async complete() { throw new Error('should not call'); } } });
  assert.match(await agent.compact(), /没有可压缩/);
});
