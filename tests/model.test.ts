import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DeepSeekModel, sseData } from '../src/model/deepseek.ts';

async function server(t: { after: (fn: () => Promise<void>) => void }, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const http = createServer(handler);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
function frame(delta: unknown, finish: string | null = null) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\r\n\r\n`;
}

test('SSE reconstructs UTF-8, CRLF, multiline data and ignores keepalive comments', async () => {
  const bytes = Buffer.from(': keepalive\r\ndata: 中文\r\ndata: second\r\n\r\ndata: [DONE]\n\n');
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const data = [];
  for await (const item of sseData(body)) data.push(item);
  assert.deepEqual(data, ['中文\nsecond', '[DONE]']);
});

test('native HTTP adapter reassembles multiple indexed calls and retains reasoning', async t => {
  let request: Record<string, any> = {};
  const baseUrl = await server(t, async (req, res) => {
    assert.equal(req.url, '/chat/completions');
    let body = ''; for await (const part of req) body += part;
    request = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(frame({ reasoning_content: 'reason' }));
    res.write(frame({ content: '检查', tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'bash', arguments: '{"command":' } },
      { index: 0, id: 'a', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } }] }));
    res.write(frame({ tool_calls: [{ index: 1, function: { arguments: '"ls"}' } }] }));
    res.end(frame({}, 'tool_calls')+'data: [DONE]\n\n');
  });
  let text = '';
  const model = new DeepSeekModel({ baseUrl, apiKey: 'test-only', thinking: true });
  const result = await model.complete([{ role: 'assistant', content: 'prior', reasoning_content: 'preserved' }], [], new AbortController().signal, s => { text += s; });
  assert.equal(request.model, 'deepseek-flash'); assert.equal(request.messages[0].reasoning_content, 'preserved');
  assert.equal(request.thinking.type, 'enabled');
  assert.equal(result.message.reasoning_content, 'reason'); assert.equal(text, '检查');
  assert.deepEqual(result.message.tool_calls!.map(c => c.id), ['a', 'b']);
  assert.equal(JSON.parse(result.message.tool_calls![1].function.arguments).command, 'ls');
});

test('interrupted stream rejects even if an apparent finish event was received', async t => {
  const baseUrl = await server(t, (_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(frame({ content: 'partial' }, 'stop'));
  });
  const model = new DeepSeekModel({ baseUrl, apiKey: 'test-only' });
  await assert.rejects(model.complete([], [], new AbortController().signal), /interrupted/);
});

test('HTTP errors do not expose response body or credentials', async t => {
  const baseUrl = await server(t, (_, res) => { res.writeHead(401); res.end('potentially sensitive provider body'); });
  await assert.rejects(new DeepSeekModel({ baseUrl, apiKey: 'test-only' }).complete([], [], new AbortController().signal), error => {
    assert.equal((error as Error).message, 'Model HTTP error 401'); return true;
  });
});

test('a model request can time out or be cancelled while waiting for SSE', async t => {
  const baseUrl = await server(t, (_, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': waiting\n\n'); });
  const model = new DeepSeekModel({ baseUrl, apiKey: 'test-only', timeoutMs: 50 });
  await assert.rejects(model.complete([], [], new AbortController().signal));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  await assert.rejects(new DeepSeekModel({ baseUrl, apiKey: 'test-only' }).complete([], [], controller.signal));
  clearTimeout(timer);
});
