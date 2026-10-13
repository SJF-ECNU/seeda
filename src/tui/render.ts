import stringWidth from 'string-width';
import { graphemes, safeText, wrap } from './text.ts';
export { graphemes, safeText, wrap } from './text.ts';
import { markdown, styledLines, tint } from './markdown.ts';
import { commandMatches } from './commands.ts';
import { cacheHitRate, contextRatio, formatTokens, type TuiState } from './state.ts';

export interface Layout { lines: string[]; cursorRow: number; cursorColumn: number; }
export function layout(state: TuiState, columns: number, rows: number, title: string, color = process.env.NO_COLOR === undefined): Layout {
  const width = Math.max(1, columns - 1);
  const bodyHeight = Math.max(1, rows - 5);
  const contentWidth = Math.max(1, width - 4);
  const fit = (text: string, limit = width) => wrap(text, limit)[0] ?? '';
  const matches = commandMatches(state);
  const selected = Math.max(0, Math.min(state.commandIndex, matches.length - 1));
  const count = Math.min(6, bodyHeight, matches.length);
  const menuStart = Math.max(0, Math.min(selected - count + 1, matches.length - count));
  const preview = matches.slice(menuStart, menuStart + count).map((command, offset) => {
    const active = menuStart + offset === selected;
    return tint(fit(` ${active ? '›' : ' '} ${command.name}${command.argument ? ` ${command.argument}` : ''}  ${command.description}`), active ? '1;36' : '90', color);
  });
  const height = bodyHeight - preview.length;
  const history = state.entries.flatMap(entry => {
    if (entry.kind === 'tool') {
      const name = entry.toolName ?? entry.text.split(' ')[0];
      let args: Record<string, unknown> = {};
      try { const value: unknown = JSON.parse(entry.arguments ?? '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) args = value as Record<string, unknown>; } catch { /* Invalid arguments remain available in details. */ }
      const result = entry.result && typeof entry.result === 'object' ? entry.result as Record<string, unknown> : {};
      const failed = ['failed', 'timed_out', 'unknown', 'not_executed'].includes(entry.status ?? '');
      const tone = failed ? '31' : entry.status === 'running' ? '36' : '32';
      const icon = failed ? '!' : entry.status === 'running' ? '◌' : '✓';
      const description = name === 'bash' ? (typeof args.command === 'string' ? args.command : '') : (typeof args.operation === 'string' ? args.operation : name);
      const exit = result.exit_code != null ? ` · 退出 ${result.exit_code}` : '';
      const statuses: Record<string, string> = { completed: '完成', running: '执行中', failed: '失败', timed_out: '超时', cancelled: '已取消', unknown: '未知', not_executed: '未执行' };
      const label = name === 'bash' ? 'Bash' : name === 'management' ? 'RSI' : name;
      const summary = `  ${icon} ${label} · ${statuses[entry.status ?? 'unknown'] ?? entry.status}  ${description.replace(/\s+/g, ' ')}${exit}`;
      const lines = [tint(fit(summary), tone, color)];
      if (result.error) lines.push(...wrap(typeof result.error === 'string' ? result.error : JSON.stringify(result.error), contentWidth).map(line => tint(`    ${line}`, '31', color)));
      if (state.showToolDetails) {
        lines.push(...wrap(entry.text, contentWidth).map(line => tint(`    ${line}`, '90', color)));
        const output = typeof result.output === 'string' ? result.output : entry.result !== undefined ? JSON.stringify(entry.result, null, 2) : '';
        if (output) lines.push(...wrap(output, contentWidth).map(line => tint(`    ${line}`, '90', color)));
      } else if (result.full_output_path) lines.push(tint(fit(`    日志 ${result.full_output_path}`), '90', color));
      return [...lines, ''];
    }
    if (entry.kind === 'notice') return [...wrap(entry.text, contentWidth).map(line => tint(`  ! ${line}`, '33', color)), ''];
    const label = entry.kind === 'user' ? '  › 你' : '  ● seeda';
    const body = entry.kind === 'assistant' ? markdown(entry.text, contentWidth, color) : wrap(entry.text, contentWidth);
    return [tint(label, entry.kind === 'user' ? '1;32' : '1;36', color), ...body.map(line => `    ${line}`), ''];
  });
  if (!history.length) history.push('', ...wrap('你好，我是 seeda。', contentWidth).map(line => tint(`  ${line}`, '1;36', color)), '', ...wrap('描述一个任务，我们从这里开始。', contentWidth).map(line => `  ${line}`), '', tint(fit('  /new 新会话 · /sessions 列表 · /resume ID 恢复 · /compact 压缩'), '90', color));
  const scroll = Math.max(0, Math.min(state.scroll, Math.max(0, history.length - height)));
  state.scroll = scroll;
  const end = history.length - scroll;
  const visible = history.slice(Math.max(0, end - height), end);
  while (visible.length < height) visible.push('');
  const draft = state.draft.map(character => safeText(character).replace(/\n/g, ' '));
  let start = state.cursor;
  let size = 0;
  const inputWidth = Math.max(1, width - 4);
  while (start > 0 && size + stringWidth(draft[start - 1]) <= inputWidth - 1) { start--; size += stringWidth(draft[start]); }
  let shown = ''; let used = 0;
  for (const character of draft.slice(start)) {
    if (used + stringWidth(character) > inputWidth) break;
    shown += character; used += stringWidth(character);
  }
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'][state.pulse % 8];
  const statusNames: Record<string, string> = { Ready: '就绪', Thinking: '正在思考', 'Running tool': '正在执行', Cancelling: '正在取消', Cancelled: '已取消', Failed: '请求失败' };
  const statusTone = state.status === 'Failed' ? '31' : state.busy ? '36' : '32';
  const metrics = state.metrics;
  // Keep plain text for layout: fit() strips ANSI, so colors must be applied
  // *after* fitting, otherwise nested tints are dropped and widths overcount.
  const segments: { text: string; tone: string }[] = [];
  if (metrics) {
    const percent = Math.round(contextRatio(metrics) * 100);
    // Warn before compaction rather than after the request fails.
    const contextTone = percent >= 90 ? '31' : percent >= 70 ? '33' : '90';
    segments.push({ text: `上下文 ${formatTokens(metrics.maxContextTokens ? metrics.promptTokens : metrics.contextChars)}/${formatTokens(metrics.maxContextTokens ?? metrics.maxContextChars)} ${metrics.maxContextTokens ? "tokens" : "字符"} ${percent}%`, tone: contextTone });
    const rate = cacheHitRate(metrics);
    if (rate !== undefined) segments.push({ text: `缓存命中 ${Math.round(rate * 100)}%`, tone: '90' });
  }
  const plainTail = ` ${state.busy ? spinner : '●'} ${state.busy && state.status === 'Ready' ? '正在收尾' : statusNames[state.status] ?? state.status}${segments.length ? ` · ${segments.map(segment => segment.text).join(' · ')}` : ''}${scroll ? ' · 浏览历史' : ''}${state.showToolDetails ? ' · 工具详情' : ''}`;
  const fittedTail = fit(plainTail);
  // Tint each surviving plain segment in place, restoring the status tone after
  // each reset so the surrounding text keeps its colour on the same line.
  const tintedTail = color && segments.length
    ? segments.reduce((line, segment) => line.replace(segment.text, `\x1b[${segment.tone}m${segment.text}\x1b[0m\x1b[${statusTone}m`), fittedTail)
    : fittedTail;
  const lines = [tint('seeda', '1;36', color) + tint(fit(`  /  ${title}${state.sessionId ? `  · 会话 ${state.sessionId === 'main' ? 'main' : state.sessionId.slice(0, 8)}` : ''}`, Math.max(1, width - 5)), '90', color),
    tint('─'.repeat(width), '90', color), ...visible, ...preview,
    tint(tintedTail, statusTone, color),
    tint(' › ', '1;36', color) + (shown || tint(fit('输入消息…', inputWidth), '90', color)),
    tint(fit(matches.length ? ` ↑↓ 选择 ${selected + 1}/${matches.length} · Tab 补全 · Enter 确认 · Esc 收起` : ' Enter 发送 · Ctrl+C 取消/退出 · Ctrl+O 工具详情 · PgUp/PgDn 历史'), '90', color)];
  return { lines, cursorRow: Math.max(1, rows - 1), cursorColumn: Math.min(columns, size + 4) };
}
export function paint(next: Layout, previous?: Layout): string {
  let output = '';
  next.lines.forEach((line, index) => {
    if (line !== previous?.lines[index]) output += `\x1b[${index + 1};1H\x1b[2K${line}`;
  });
  if (!output && next.cursorRow === previous?.cursorRow && next.cursorColumn === previous?.cursorColumn) return '';
  return `\x1b[?25l${output}\x1b[${next.cursorRow};${next.cursorColumn}H\x1b[?25h`;
}
export function frame(state: TuiState, columns: number, rows: number, title: string): string {
  return paint(layout(state, columns, rows, title));
}
