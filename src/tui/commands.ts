import type { Key } from 'node:readline';
import type { TuiState } from './state.ts';

const commands = [
  { name: '/new', description: '新建会话，保留旧记录' },
  { name: '/sessions', description: '查看会话列表与 ID' },
  { name: '/resume', description: '恢复已有会话', argument: '<会话ID>' },
  { name: '/compact', description: '压缩早期上下文' },
  { name: '/versions', description: '查看 Agent 版本' },
  { name: '/use', description: '切换 Agent 版本', argument: '<版本ID>' },
  { name: '/rollback', description: '回退上一个版本' },
  { name: '/exit', description: '退出前端' },
];
export function commandMatches(state: TuiState) {
  const query = state.draft.join('');
  if (query !== state.commandQuery) { state.commandQuery = query; state.commandIndex = 0; }
  if (state.busy || state.cursor !== state.draft.length || !/^\/[a-z]*$/.test(query) || state.commandDismissed === query) return [];
  return commands.filter(command => (state.managed || command.name === '/exit') && command.name.startsWith(query));
}
export function commandKey(state: TuiState, key: Key): 'handled' | 'submit' | 'exit' | undefined {
  const matches = commandMatches(state);
  if (!matches.length || key.ctrl || key.meta) return;
  const index = Math.max(0, Math.min(state.commandIndex, matches.length - 1));
  if (key.name === 'up' || key.name === 'down') {
    state.commandIndex = (index + (key.name === 'down' ? 1 : -1) + matches.length) % matches.length;
    return 'handled';
  }
  if (key.name === 'escape') { state.commandDismissed = state.commandQuery; return 'handled'; }
  if (!['tab', 'return', 'enter'].includes(key.name ?? '')) return;
  const command = matches[index];
  const text = command.name + (command.argument ? ' ' : '');
  state.draft = Array.from(text); state.cursor = state.draft.length;
  state.commandDismissed = undefined;
  if (key.name === 'tab' || command.argument) return 'handled';
  return command.name === '/exit' ? 'exit' : 'submit';
}
