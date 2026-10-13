import { test } from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import { TuiState } from '../src/tui/state.ts';
import { layout, paint, graphemes, safeText, wrap } from '../src/tui/render.ts';
import { editInput } from '../src/tui/terminal.ts';
import type { ToolCall } from '../src/core/types.ts';

const call: ToolCall = { id: 'one', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } };

test('TUI renders streaming text and updates one tool row without owning execution', async () => {
  const view = new TuiState([], () => {});
  view.bind({ async run(input) {
    assert.equal(input, 'hello');
    view.event({ type: 'text', text: 'Hello ' }); view.event({ type: 'text', text: '世界' });
    view.event({ type: 'tool_start', call });
    view.event({ type: 'tool_end', call, result: { status: 'completed', exit_code: 0 } });
    view.event({ type: 'text', text: 'Done' }); view.event({ type: 'end', status: 'completed' });
    return 'Done';
  }, cancel() {} });
  view.draft = graphemes('hello'); await view.submit();
  assert.equal(view.entries.filter(e => e.kind === 'tool').length, 1);
  assert.equal(view.entries.find(e => e.kind === 'tool')!.status, 'completed');
  assert.deepEqual(view.entries.filter(e => e.kind === 'assistant').map(e => e.text), ['Hello 世界', 'Done']);
  assert.equal(view.busy, false); assert.equal(view.status, 'Ready');
});

test('busy Enter preserves draft; cancellation uses core and permits another request', async () => {
  const view = new TuiState([], () => {});
  let resolve!: (text: string) => void; let calls = 0; let cancellations = 0;
  view.bind({ run() { calls++; return new Promise(r => { resolve = r; }); }, cancel() { cancellations++; } });
  view.draft = ['a']; const pending = view.submit();
  view.draft = ['b']; await view.submit();
  assert.equal(calls, 1); assert.equal(view.draft.join(''), 'b');
  view.cancel(); assert.equal(cancellations, 1);
  view.event({ type: 'end', status: 'cancelled' }); resolve(''); await pending;
  assert.equal(view.status, 'Cancelled'); assert.equal(view.busy, false);
});

test('failures remain visible and non-streaming replies appear once', async () => {
  const view = new TuiState([], () => {});
  view.bind({ async run() { throw new Error('offline'); }, cancel() {} });
  view.draft = ['x']; await view.submit();
  assert.equal(view.status, 'Failed'); assert.equal(view.busy, false);
  view.bind({ async run() { view.event({ type: 'end', status: 'completed' }); return 'answer'; }, cancel() {} });
  view.draft = ['y']; await view.submit();
  assert.equal(view.entries.filter(e => e.text === 'answer').length, 1);
});

test('session history presentation does not mutate or replay the original messages', () => {
  const history = [
    { role: 'user' as const, content: 'prior' },
    { role: 'assistant' as const, content: null, tool_calls: [call] },
    { role: 'tool' as const, content: '{"status":"failed","exit_code":2}', tool_call_id: 'one' },
  ];
  const before = structuredClone(history); const view = new TuiState(history, () => {});
  assert.deepEqual(history, before); assert.equal(view.entries[1].status, 'failed');
});

test('Chinese and emoji editing uses grapheme boundaries', () => {
  const view = new TuiState([], () => {});
  editInput(view, '你好👨‍👩‍👧‍👦', {});
  assert.equal(view.cursor, 3);
  editInput(view, '', { name: 'backspace' }); assert.equal(view.draft.join(''), '你好');
  editInput(view, '', { name: 'left' }); editInput(view, 'a', {});
  assert.equal(view.draft.join(''), '你a好');
  editInput(view, '', { ctrl: true, name: 'u' }); assert.equal(view.draft.length, 0);
});

test('rendering handles widths, scrolling, resize and strips model terminal escapes', () => {
  assert.ok(wrap('你好世界🙂', 5).every(line => stringWidth(line) <= 5));
  assert.equal(safeText('\x1b[2Jhello\x1b]52;c;bad\x07'), 'hello');
  const view = new TuiState([], () => {});
  view.entries.push({ kind: 'assistant', text: '\x1b[2J'+'你好\n'.repeat(20) }); view.scroll = 10;
  view.draft = graphemes('很长的中文输入🙂'); view.cursor = view.draft.length;
  for (const columns of [20, 40, 80]) {
    const display = layout(view, columns, 10, 'flash');
    const rows = display.lines;
    assert.equal(rows.length, 10);
    assert.ok(rows.every(line => stringWidth(line) <= columns - 1));
  }
});

test('redirected CLI queues input lines and keeps plain output without terminal controls', async t => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const cwd = await mkdtemp(join(tmpdir(), 'seeda-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const prompts: string[] = [];
  const server = createServer(async (req, res) => {
    let source = ''; for await (const part of req) source += part;
    const body = JSON.parse(source); prompts.push(body.messages.at(-1).content);
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: '+JSON.stringify({ choices: [{ delta: { content: 'plain reply' }, finish_reason: 'stop' }] })+'\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const child = spawn(process.execPath, ['--experimental-strip-types', resolve('src/cli.ts')], {
    cwd, env: { ...process.env, SEEDA_MANAGED: '0', DEEPSEEK_API_KEY: 'local-test-only', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`, SEEDA_SESSION: join(cwd, 'session.jsonl') },
  });
  t.after(() => child.kill());
  let output = ''; let error = '';
  child.stdout.on('data', part => { output += part; }); child.stderr.on('data', part => { error += part; });
  child.stdin.end('first\nsecond\n/exit\n');
  const code = await new Promise<number | null>(r => child.on('close', r));
  assert.equal(code, 0, error); assert.deepEqual(prompts, ['first', 'second']);
  assert.equal(output.includes('\x1b'), false); assert.match(output, /plain reply/);
});

test('streaming redraw writes only changed rows without scrolling or clearing the screen', () => {
  const view = new TuiState([], () => {});
  view.entries.push({ kind: 'assistant', text: '你好' });
  let previous = layout(view, 40, 12, 'flash');
  assert.equal(paint(previous, previous), '');
  for (let i = 0; i < 100; i++) {
    view.entries[0].text += '世界🙂';
    const next = layout(view, 40, 12, 'flash');
    const update = paint(next, previous);
    assert.equal(/[\r\n]/.test(update), false);
    assert.equal(update.includes('\x1b[2J'), false);
    assert.equal(update.includes('seeda ·'), false);
    assert.equal(update.includes('Enter send'), false);
    assert.ok(next.lines.every(line => stringWidth(line) < 40));
    previous = next;
  }
});

test('session history replacement discards old display while preserving an unsent draft', () => {
  const state = new TuiState([{ role: 'user', content: 'old session' }], () => {});
  state.draft = ['未', '发']; state.cursor = 1; state.scroll = 8;
  state.loadHistory([{ role: 'user', content: 'new session' }], 'main');
  assert.equal(state.entries.length, 1); assert.equal(state.entries[0].text, 'new session');
  assert.equal(state.draft.join(''), '未发'); assert.equal(state.cursor, 1); assert.equal(state.scroll, 0); assert.equal(state.sessionId, 'main');
});

test('pasting multi-line text keeps newlines in the draft instead of submitting', () => {
  const view = new TuiState([], () => {});
  // CR inside a paste becomes one line break, not a submit.
  editInput(view, '', { name: 'return', sequence: '\r' } as any, true);
  editInput(view, 'hello', {} as any, true);
  editInput(view, '', { name: 'linefeed', sequence: '\n' } as any, true);
  editInput(view, 'world', {} as any, true);
  assert.equal(view.draft.join(''), '\nhello\nworld');
  assert.equal(view.busy, false);
  // Escapes inside a paste are stripped like any other input.
  const clean = new TuiState([], () => {});
  editInput(clean, 'a\x1b[2Jb', {} as any, true);
  assert.equal(clean.draft.join(''), 'ab');
  // A CRLF pair collapses to a single line break.
  const crlf = new TuiState([], () => {});
  editInput(crlf, '', { name: 'return', sequence: '\r' } as any, true);
  editInput(crlf, '', { name: 'linefeed', sequence: '\n' } as any, true);
  assert.equal(crlf.draft.join(''), '\n');
});

test('outside a paste stray newlines fold to spaces and the draft shows a break marker', () => {
  const view = new TuiState([], () => {});
  editInput(view, 'one\ntwo', {} as any, false);
  assert.equal(view.draft.join(''), 'one two');
  const pasted = new TuiState([], () => {});
  pasted.draft = graphemes('a\nb'); pasted.cursor = pasted.draft.length;
  const display = layout(pasted, 40, 10, 'flash');
  assert.ok(display.lines.some(line => line.includes('\u23ce')));
  assert.ok(display.lines.every(line => !line.includes('\n')));
});
