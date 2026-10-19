import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';
import { TuiState } from './state.ts';
import { commandKey } from './commands.ts';
import { layout, paint, graphemes, safeText, type Layout } from './render.ts';

// A pasted block may contain newlines. Without bracketed paste those newlines are
// indistinguishable from Enter presses, so a multi-line paste would be submitted
// line by line instead of landing in the draft. `paste` carries that flag.
const LINE_BREAK_KEYS = new Set(['return', 'enter', 'linefeed']);
const SCROLL_LINES = 3;
// Keep scroll-key handling pure so the TUI tests can cover wheel-style arrows
// without driving a real terminal. Returns true when the key was consumed.
export function scrollKey(state: TuiState, key: Key, rows: number): boolean {
  const page = Math.max(1, rows - 5);
  if (key.name === 'pageup') { state.scrollBy(page); return true; }
  if (key.name === 'pagedown') { state.scrollBy(-page); return true; }
  if (key.name === 'up') { state.scrollBy(SCROLL_LINES); return true; }
  if (key.name === 'down') { state.scrollBy(-SCROLL_LINES); return true; }
  if (key.ctrl && key.name === 'home') { state.scrollToTop(); return true; }
  if (key.ctrl && key.name === 'end') { state.scrollToBottom(); return true; }
  return false;
}
const isLineBreak = (key: Key): boolean => LINE_BREAK_KEYS.has(key.name ?? '') || key.sequence === '\r' || key.sequence === '\n';
export function editInput(state: TuiState, text: string, key: Key, paste = false): void {
  state.commandDismissed = undefined;
  if (key.name === 'left') state.cursor = Math.max(0, state.cursor - 1);
  else if (key.name === 'right') state.cursor = Math.min(state.draft.length, state.cursor + 1);
  else if (key.name === 'home' || (key.ctrl && key.name === 'a')) state.cursor = 0;
  else if (key.name === 'end' || (key.ctrl && key.name === 'e')) state.cursor = state.draft.length;
  else if (key.name === 'backspace' && state.cursor > 0) state.draft.splice(--state.cursor, 1);
  else if (key.name === 'delete') state.draft.splice(state.cursor, 1);
  else if (key.ctrl && key.name === 'u') { state.draft = []; state.cursor = 0; }
  else if (paste && isLineBreak(key)) {
    // A pasted CR or LF becomes a literal line break in the draft; CRLF collapses
    // to a single break so Windows line endings do not double up.
    if (state.draft[state.cursor - 1] !== '\n') { state.draft.splice(state.cursor, 0, '\n'); state.cursor++; }
  }
  else if (!key.ctrl && !key.meta && text && !key.sequence?.startsWith('\x1b')) {
    const characters = graphemes(paste ? safeText(text).replace(/\r\n?/g, '\n') : safeText(text).replace(/[\r\n]/g, ' '));
    state.draft.splice(state.cursor, 0, ...characters); state.cursor += characters.length;
  }
}
export interface TerminalOptions {
  input?: ReadStream;
  output?: WriteStream;
  title?: string;
}
export function runTerminal(state: TuiState, options: TerminalOptions = {}): { done: Promise<void>; refresh: () => void } {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY) throw new Error('TUI requires an interactive terminal');
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let previous: Layout | undefined;
  let dimensions = '';
  let pasting = false;
  let complete!: () => void;
  const done = new Promise<void>(resolve => { complete = resolve; });
  const wasRaw = input.isRaw;
  const refresh = () => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const columns = output.columns || 80; const rows = output.rows || 24;
      const currentDimensions = `${columns}x${rows}`;
      if (currentDimensions !== dimensions) {
        output.write('\x1b[H\x1b[2J'); previous = undefined; dimensions = currentDimensions;
      }
      const next = columns < 16 || rows < 6
        ? { lines: [safeText('Resize terminal (minimum 16x6)').slice(0, Math.max(1, columns - 1))], cursorRow: 1, cursorColumn: 1 }
        : layout(state, columns, rows, options.title ?? 'coding agent');
      const update = paint(next, previous);
      if (update) output.write(update);
      previous = next;
    }, 16);
  };
  const pulse = setInterval(() => { if (state.busy) { state.pulse++; refresh(); } }, 120);
  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    clearInterval(pulse);
    input.removeListener('keypress', onKey); input.removeListener('end', onEnd);
    output.removeListener('resize', refresh); output.removeListener('error', onEnd);
    process.removeListener('SIGTERM', onEnd); process.removeListener('SIGINT', onInterrupt);
    process.removeListener('exit', close);
    input.setRawMode(wasRaw ?? false);
    input.pause();
    output.write('\x1b[?25h\x1b[?2004l\x1b[?1007l\x1b[?1049l');
    complete();
  };
  const onInterrupt = () => { if (state.busy) state.cancel(); else close(); };
  const onEnd = () => { state.cancel(); close(); };
  const onKey = (text: string, key: Key) => {
    if (key.name === 'paste-start') { pasting = true; return; }
    if (key.name === 'paste-end') { pasting = false; return; }
    if (key.ctrl && key.name === 'c') { onInterrupt(); return; }
    if (key.ctrl && key.name === 'd') { onEnd(); return; }
    // While pasting, key presses are content: never trigger the command menu or
    // submit, so newlines stay in the draft instead of sending partial text.
    if (!pasting) {
      const command = commandKey(state, key);
      if (command === 'exit') { close(); return; }
      if (command === 'handled') { refresh(); return; }
      if (command === 'submit' || key.name === 'return' || key.name === 'enter') {
        if (!state.busy && state.draft.join('').trim() === '/exit') close();
        else void state.submit();
        refresh(); return;
      }
      if (key.ctrl && key.name === 'o') { state.showToolDetails = !state.showToolDetails; refresh(); return; }
      // Up/Down also cover mouse wheels in terminals that translate alternate-screen
      // wheel events into arrow keys (DECSET 1007), so no mouse capture is needed and
      // text selection keeps working.
      if (scrollKey(state, key, output.rows || 24)) { refresh(); return; }
    }
    editInput(state, text, key, pasting);
    refresh();
  };
  emitKeypressEvents(input);
  input.setRawMode(true); input.resume();
  input.on('keypress', onKey); input.on('end', onEnd);
  output.on('resize', refresh); output.on('error', onEnd);
  process.on('SIGTERM', onEnd); process.on('SIGINT', onInterrupt); process.on('exit', close);
  // Enable bracketed paste so the terminal marks pasted text and its embedded
  // newlines can be told apart from Enter.
  output.write('\x1b[?2004h\x1b[?1049h\x1b[?1007h'); refresh();
  return { done, refresh };
}
