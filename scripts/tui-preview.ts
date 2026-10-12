// Deterministic visual fixture rendered by the same layout used in the live terminal.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { TuiState } from '../src/tui/state.ts';
import { layout } from '../src/tui/render.ts';
const root = resolve('.seeda/tui-presentation-preview'); await mkdir(root, { recursive: true });
const state = new TuiState([], () => {});
state.entries.push({ kind: 'user', text: '检查一下启动方式，给我一个简明的说明。' });
state.entries.push({ kind: 'tool', toolName: 'bash', arguments: '{"command":"npm run check"}', text: 'bash {"command":"npm run check"}', status: 'completed', result: { status: 'completed', exit_code: 0, output: 'type check passed' } });
state.entries.push({ kind: 'assistant', text: '## 已准备就绪\n\n现在只需要 **一条命令**，就能开始对话。\n\n```bash\nnpm start\n```\n\n- 自动连接或启动守护进程\n- Agent 可以使用 `management` 改进自己\n- 重新打开时，继续同一份会话\n\n> 退出前端不会停止守护，原始记录也不会被改写。\n\n| 操作 | 作用 |\n| --- | --- |\n| Ctrl+O | 展开工具参数与输出 |\n| /versions | 查看已保留的版本 |\n\n你可以直接描述下一个任务。' });
await writeFile(join(root, 'layout.json'), JSON.stringify(layout(state, 96, 36, 'deepseek-flash', true), null, 2));
console.log(root);
