import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';
import { TuiState } from './state.ts';
import { commandKey } from './commands.ts';
import { layout, paint, graphemes, safeText, type Layout } from './render.ts';

export function editInput(state: TuiState, text: string, key: Key): void {
  state.commandDismissed = undefined;
  if (key.name === 'left') state.cursor = Math.max(0, state.cursor - 1);
  else if (key.name === 'right') state.cursor = Math.min(state.draft.length, state.cursor + 1);
  else if (key.name === 'home' || (key.ctrl && key.name === 'a')) state.cursor = 0;
  else if (key.name === 'end' || (key.ctrl && key.name === 'e')) state.cursor = state.draft.length;
  else if (key.name === 'backspace' && state.cursor > 0) state.draft.splice(--state.cursor, 1);
  else if (key.name === 'delete') state.draft.splice(state.cursor, 1);
  else if (key.ctrl && key.name === 'u') { state.draft = []; state.cursor = 0; }
  else if (!key.ctrl && !key.meta && text && !key.sequence?.startsWith('\x1b')) {
    const characters = graphemes(safeText(text).replace(/\n/g, ' '));
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
    output.write('\x1b[?25h\x1b[?1049l');
    complete();
  };
  const onInterrupt = () => { if (state.busy) state.cancel(); else close(); };
  const onEnd = () => { state.cancel(); close(); };
  const onKey = (text: string, key: Key) => {
    if (key.ctrl && key.name === 'c') { onInterrupt(); return; }
    if (key.ctrl && key.name === 'd') { onEnd(); return; }
    const command = commandKey(state, key);
    if (command === 'exit') { close(); return; }
    if (command === 'handled') { refresh(); return; }
    if (command === 'submit' || key.name === 'return' || key.name === 'enter') {
      if (!state.busy && state.draft.join('').trim() === '/exit') close();
      else void state.submit();
    } else if (key.ctrl && key.name === 'o') state.showToolDetails = !state.showToolDetails;
    else if (key.name === 'pageup') state.scroll += Math.max(1, (output.rows || 24) - 5);
    else if (key.name === 'pagedown') state.scroll = Math.max(0, state.scroll - Math.max(1, (output.rows || 24) - 5));
    else editInput(state, text, key);
    refresh();
  };
  emitKeypressEvents(input);
  input.setRawMode(true); input.resume();
  input.on('keypress', onKey); input.on('end', onEnd);
  output.on('resize', refresh); output.on('error', onEnd);
  process.on('SIGTERM', onEnd); process.on('SIGINT', onInterrupt); process.on('exit', close);
  output.write('\x1b[?1049h'); refresh();
  return { done, refresh };
}
