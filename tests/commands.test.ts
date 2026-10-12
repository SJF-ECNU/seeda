import { test } from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import { TuiState } from '../src/tui/state.ts';
import { commandMatches, commandKey } from '../src/tui/commands.ts';
import { editInput } from '../src/tui/terminal.ts';
import { layout, paint } from '../src/tui/render.ts';

function draft(state: TuiState, text: string) { state.draft = Array.from(text); state.cursor = state.draft.length; }

test('slash preview filters supported commands, hides arguments and respects direct mode', () => {
  const state = new TuiState([], () => {});
  draft(state, '/'); assert.equal(commandMatches(state).length, 8);
  draft(state, '/res'); assert.deepEqual(commandMatches(state).map(command => command.name), ['/resume']);
  draft(state, '/resume main'); assert.equal(commandMatches(state).length, 0);
  draft(state, '/missing'); assert.equal(commandMatches(state).length, 0);
  draft(state, '/'); state.busy = true; assert.equal(commandMatches(state).length, 0);
  state.busy = false; state.managed = false; assert.deepEqual(commandMatches(state).map(command => command.name), ['/exit']);
});

test('arrow navigation wraps and Tab completes without executing; Enter waits for required arguments', () => {
  const state = new TuiState([], () => {}); draft(state, '/');
  assert.equal(commandKey(state, { name: 'down' }), 'handled');
  assert.equal(commandKey(state, { name: 'tab' }), 'handled'); assert.equal(state.draft.join(''), '/sessions');
  assert.equal(commandKey(state, { name: 'return' }), 'submit');
  draft(state, '/res'); assert.equal(commandKey(state, { name: 'return' }), 'handled');
  assert.equal(state.draft.join(''), '/resume '); assert.equal(state.cursor, 8);
  draft(state, '/use'); assert.equal(commandKey(state, { name: 'return' }), 'handled'); assert.equal(state.draft.join(''), '/use ');
  draft(state, '/'); commandKey(state, { name: 'up' }); assert.equal(state.commandIndex, 7);
  assert.equal(commandKey(state, { name: 'return' }), 'exit');
});

test('Escape dismisses only the current prefix and editing reopens the preview', () => {
  const state = new TuiState([], () => {}); draft(state, '/');
  commandKey(state, { name: 'escape' }); assert.equal(commandMatches(state).length, 0);
  editInput(state, 's', {}); assert.deepEqual(commandMatches(state).map(command => command.name), ['/sessions']);
  editInput(state, '', { name: 'backspace' }); assert.equal(commandMatches(state).length, 8);
  state.cursor = 0; assert.equal(commandMatches(state).length, 0);
});

test('menu scrolls the selected command into view and preserves fixed input on narrow and short screens', () => {
  const state = new TuiState([{ role: 'assistant', content: 'history\n'.repeat(30) }], () => {}); draft(state, '/');
  commandKey(state, { name: 'up' });
  for (const columns of [16, 40, 100]) for (const rows of [6, 10, 24]) {
    const frame = layout(state, columns, rows, 'flash', false);
    assert.equal(frame.lines.length, rows);
    assert.equal(frame.cursorRow, rows - 1);
    assert.ok(frame.lines.every(line => stringWidth(line) < columns));
    assert.ok(frame.lines.some(line => line.includes('› /exit')));
    assert.ok(frame.lines[rows - 2].includes('› /'));
  }
  const before = layout(state, 80, 24, 'flash');
  commandKey(state, { name: 'down' });
  const next = layout(state, 80, 24, 'flash');
  assert.ok(next.lines.some(line => line.includes('› /new')));
  const update = paint(next, before);
  assert.equal(/[\r\n]/.test(update), false); assert.equal(update.includes('\x1b[2J'), false);
});
