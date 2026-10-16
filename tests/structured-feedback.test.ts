import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, Session, BashTool, DeepSeekModel } from '../src/index.ts';
import { executionFailure } from '../src/core/runtime-records.ts';
import type { AgentEvent, ModelResponse, Tool } from '../src/core/types.ts';

async function workspace(t: { after(fn: () => Promise<void>): void }) {
  const cwd = await mkdtemp(join(tmpdir(), 'seeda-feedback-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, session: await Session.open(join(cwd, 'session.jsonl'), cwd), artifactDir: join(cwd, 'outputs') };
}
const done = (): ModelResponse => ({ message: { role: 'assistant', content: 'an unverified answer' }, finishReason: 'stop' });
const call = (id: string, name: string, args: unknown): ModelResponse => ({ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls' });

test('HTTP and connection errors carry safe feedback through live events and restored history without invented usage', async t => {
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const task = JSON.parse(raw).messages.at(-1).content;
    if (['401', '429'].includes(task)) { res.writeHead(Number(task)); res.end('secret-response-body'); return; }
    const finish = task === 'length' ? 'length' : 'stop';
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' }, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const successful = await workspace(t);
  await new Agent({ ...successful, tools: [], model: new DeepSeekModel({ apiKey: 'unused', baseUrl: `http://127.0.0.1:${addr.port}`, retry: { attempts: 1 } }) }).run('success');
  assert.equal(successful.session.runtime.recent()[0].status, 'completed');
  assert.equal(successful.session.runtime.recent()[0].failure, undefined);
  for (const [task, reason, code] of [['401', 'authentication', 401], ['429', 'rate_limit', 429], ['length', 'model_length', undefined]] as const) {
    const w = await workspace(t); const events: AgentEvent[] = [];
    const model = new DeepSeekModel({ apiKey: 'secret-api-key', baseUrl: `http://127.0.0.1:${addr.port}`, retry: { attempts: 1 } });
    await assert.rejects(new Agent({ ...w, model, tools: [], onEvent: event => events.push(event) }).run(task));
    const restored = (await Session.open(w.session.path, w.cwd)).runtime.recent()[0];
    assert.deepEqual(restored.failure, { stage: 'model', reason, ...(code ? { code } : {}), summary: restored.failure!.summary });
    assert.equal(restored.usage, null); assert.equal(restored.modelCalls, 1);
    assert.deepEqual(restored.recentCalls[0].failure, restored.failure);
    assert.ok(events.some(event => event.type === 'feedback' && event.failure.reason === reason));
    assert.ok(events.some(event => event.type === 'end' && event.failure?.reason === reason));
    assert.ok(!JSON.stringify(restored).includes('secret-'));
  }
  const w = await workspace(t);
  const offline = createServer(); await new Promise<void>(resolve => offline.listen(0, '127.0.0.1', resolve));
  const offlineAddress = offline.address(); assert.ok(offlineAddress && typeof offlineAddress !== 'string');
  await new Promise<void>(resolve => offline.close(() => resolve()));
  await assert.rejects(new Agent({ ...w, tools: [], model: new DeepSeekModel({ apiKey: 'unused', baseUrl: `http://127.0.0.1:${offlineAddress.port}`, retry: { attempts: 1 } }) }).run('connection refused'));
  const failed = (await Session.open(w.session.path, w.cwd)).runtime.recent()[0];
  assert.equal(failed.failure!.reason, 'model_network'); assert.equal(failed.failure!.code, 'ECONNREFUSED');
  assert.equal(failed.usage, null); assert.equal(failed.modelCalls, 1);
  // A deterministic DNS error shape checks classification without relying on external DNS.
  assert.equal(executionFailure(new Error('private', { cause: Object.assign(new Error('private'), { code: 'ENOTFOUND' }) }), 'model').code, 'ENOTFOUND');
});

test('real command failures retain original output, errno, timeout and cancellation facts without implying task quality', async t => {
  const w = await workspace(t); let step = 0; const events: AgentEvent[] = [];
  const spawnFailure: Tool = { definition: { type: 'function', function: { name: 'spawn_failure', description: 'test real missing executable', parameters: {} } }, async execute() { await promisify(execFile)(join(w.cwd, 'missing-executable')); } };
  const script = [call('ok', 'bash', { command: 'printf original-output' }), call('nonzero', 'bash', { command: 'printf program-failure; exit 7' }), call('spawn', 'spawn_failure', {}), call('timeout', 'bash', { command: 'sleep 5', timeout: 0.05 }), done()];
  await new Agent({ ...w, tools: [new BashTool(), spawnFailure], onEvent: event => events.push(event), model: { async complete() { return script[step++]; } } }).run('commands');
  const restored = (await Session.open(w.session.path, w.cwd)).runtime.recent()[0];
  assert.equal(restored.status, 'completed'); assert.equal(restored.failure, undefined);
  assert.equal(restored.toolCalls, 4); assert.equal(restored.toolFailures, 3); assert.equal(restored.modelCalls, 5); assert.equal(restored.usage, null);
  const tools = restored.recentCalls.filter(record => record.kind === 'tool');
  assert.equal(tools[0].failure, undefined);
  assert.equal(tools[1].failure!.reason, 'nonzero_exit'); assert.equal(tools[1].failure!.code, 7);
  assert.equal(tools[2].failure!.reason, 'unknown'); assert.equal(tools[2].failure!.code, 'ENOENT');
  assert.equal(tools[3].failure!.reason, 'timeout');
  const original = JSON.parse(w.session.messages.find(message => message.tool_call_id === 'nonzero')!.content!);
  assert.equal(original.output, 'program-failure'); assert.equal(original.exit_code, 7); assert.equal(original.failure, undefined);
  assert.equal(events.filter(event => event.type === 'tool_end' && event.failure).length, 3);
  assert.ok(!JSON.stringify(restored).includes('program-failure'));
  const cancelled = await workspace(t); let running!: () => void; const ready = new Promise<void>(resolve => { running = resolve; });
  let calls = 0;
  const agent = new Agent({ ...cancelled, tools: [new BashTool()], onEvent: event => { if (event.type === 'tool_start') running(); }, model: { async complete() { return calls++ ? done() : call('cancel', 'bash', { command: 'printf started > cancellation-started; sleep 30' }); } } });
  const pending = agent.run('cancel real command'); await ready;
  let started = false;
  for (let attempt = 0; attempt < 100 && !started; attempt++) {
    try { started = await readFile(join(cancelled.cwd, 'cancellation-started'), 'utf8') === 'started'; } catch {}
    if (!started) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(started); agent.cancel(); await assert.rejects(pending);
  const run = (await Session.open(cancelled.session.path, cancelled.cwd)).runtime.recent()[0];
  assert.equal(run.failure!.reason, 'cancelled');
  assert.equal(run.recentCalls.find(record => record.kind === 'tool')!.failure!.reason, 'cancelled');
});

test('legacy records and unknown failures stay unknown; feedback never duplicates accounting or supplies quality', async t => {
  const w = await workspace(t);
  await writeFile(w.session.path, `${JSON.stringify({ type: 'request', id: 'old', implementationVersion: 'old' })}\n${JSON.stringify({ type: 'end', status: 'failed' })}\n`);
  const old = (await Session.open(w.session.path, w.cwd)).runtime.recent()[0];
  assert.equal(old.failure, undefined); assert.equal(old.usage, null);
  await assert.rejects(new Agent({ ...w, tools: [], model: { async complete() { throw new Error('Authorization: secret-private-error'); } } }).run('unknown'));
  const run = (await Session.open(w.session.path, w.cwd)).runtime.recent().at(-1)!;
  assert.equal(run.failure!.reason, 'unknown'); assert.equal(run.failure!.code, undefined);
  assert.equal(run.modelCalls, 1); assert.equal(run.usage, null); assert.ok(!JSON.stringify(run).includes('secret-private-error'));
  const raw = await readFile(w.session.path, 'utf8'); assert.ok(raw.includes('secret-private-error'), 'original error is retained separately from safe summaries');
});
