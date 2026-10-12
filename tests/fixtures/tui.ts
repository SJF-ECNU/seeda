// Real core + Bash, scripted local model: deterministic PTY behavior without API access.
import { resolve, join } from 'node:path';
import { Agent, BashTool, Session } from '../../src/index.ts';
import type { Model, ModelResponse } from '../../src/core/types.ts';
import { TuiState } from '../../src/tui/state.ts';
import { runTerminal } from '../../src/tui/terminal.ts';
const cwd = resolve(process.env.SEEDA_TUI_TEST_DIR!);
const session = await Session.open(join(cwd, 'session.jsonl'), cwd);
let refresh = () => {};
const view = new TuiState(session.messages, () => refresh());
let id = 0;
const model: Model = { async complete(messages, _tools, signal, onText): Promise<ModelResponse> {
  const last = messages.at(-1)!;
  if (last.role === 'tool') {
    const first = '## 任务完成\n\n';
    const rest = '**检查通过**，可以继续。\n\n- 中文与 emoji 🙂\n- `npm start` 默认托管\n\n> 原始记录保持完整。\n\n```ts\nconst answer = 42;\n```\n\n| 能力 | 状态 |\n|---|---|\n| Markdown | 已完成 |';
    onText?.(first); await new Promise(resolve => setTimeout(resolve, 40)); onText?.(rest);
    return { message: { role: 'assistant', content: first + rest }, finishReason: 'stop' };
  }
  const prompt = last.content ?? '';
  if (prompt === 'error') throw new Error('Simulated connection failure');
  if (prompt === 'cancel') {
    return { message: { role: 'assistant', content: null, tool_calls: [{ id: `c${++id}`, type: 'function', function: { name: 'bash', arguments: '{"command":"sleep 10"}' } }] }, finishReason: 'tool_calls' };
  }
  onText?.('正在');
  await new Promise<void>((resolveDelay, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolveDelay(); }, 150);
    signal.addEventListener('abort', abort, { once: true });
  });
  onText?.('检查');
  return { message: { role: 'assistant', content: '正在检查', tool_calls: [{ id: `c${++id}`, type: 'function', function: { name: 'bash', arguments: '{"command":"echo checked"}' } }] }, finishReason: 'tool_calls' };
} };
const agent = new Agent({ cwd, session, model, tools: [new BashTool()], artifactDir: join(cwd, 'outputs'), onEvent: event => view.event(event) });
view.bind(agent);
const terminal = runTerminal(view, { title: 'PTY fixture' }); refresh = terminal.refresh;
await terminal.done;
