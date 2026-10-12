import { test } from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import { markdown } from '../src/tui/markdown.ts';
import { safeText } from '../src/tui/text.ts';
import { layout, paint } from '../src/tui/render.ts';
import { TuiState } from '../src/tui/state.ts';

test('Markdown presents headings, emphasis, lists, quotes, links, code and tables without raw fences', () => {
  const source = '# 新的界面\n\n**清晰**，*轻盈*，`npm start`\n\n- [x] 支持 Markdown\n- 中文🙂\n\n> 保留原始记录\n\n[指南](https://example.test/docs)\n\n```ts\nconst result = 42;\n```\n\n| 能力 | 状态 |\n|---|---|\n| 渲染 | 完成 |';
  const lines = markdown(source, 60); const text = lines.map(safeText).join('\n');
  for (const expected of ['新的界面', '清晰', 'npm start', '✓ 支持 Markdown', '• 中文🙂', '│ 保留原始记录', 'https://example.test/docs', 'const result = 42;', '能力', '完成']) assert.ok(text.includes(expected), expected);
  assert.equal(text.includes('```'), false); assert.equal(text.includes('**'), false); assert.equal(text.includes('# 新'), false);
  assert.match(lines.join(''), /\x1b\[1/);
  assert.ok(lines.every(line => stringWidth(line) <= 60));
  assert.equal(markdown(source, 60, false).join('').includes('\x1b'), false);
});

test('streaming Markdown and deeply nested narrow content remain bounded and sanitized', () => {
  const source = '## 标题🙂\n\n> > - 你好世界🙂\n\n```typescript\n  const 你好 = "🙂";\n\x1b[2J\x1b]52;c;bad\x07\n```\n\n| 名称 | 内容 |\n|---|---|\n| 你好 | 很长的中文🙂 |';
  for (const width of [1, 3, 8, 16, 40]) {
    for (let i = 1; i <= source.length; i += 7) {
      const lines = markdown(source.slice(0, i), width);
      assert.ok(lines.every(line => stringWidth(line) <= width), `width ${width} at ${i}: ${lines.map(safeText)}`);
      assert.equal(lines.join('').includes('\x1b[2J'), false); assert.equal(lines.join('').includes('\x1b]52'), false);
    }
  }
});

test('tool details preserve recorded data and compact layout hides JSON and output by default', () => {
  const history = [
    { role: 'assistant' as const, content: null, tool_calls: [{ id: 'tool', type: 'function' as const, function: { name: 'bash', arguments: '{"command":"npm test"}' } }] },
    { role: 'tool' as const, tool_call_id: 'tool', content: '{"status":"completed","exit_code":0,"output":"42 tests passed"}' },
  ];
  const before = structuredClone(history); const view = new TuiState(history, () => {});
  const compact = layout(view, 80, 24, 'flash', false).lines.join('\n');
  assert.ok(compact.includes('npm test')); assert.equal(compact.includes('{"command"'), false); assert.equal(compact.includes('42 tests passed'), false);
  view.showToolDetails = true;
  const details = layout(view, 80, 24, 'flash', false).lines.join('\n');
  assert.ok(details.includes('{"command"')); assert.ok(details.includes('42 tests passed')); assert.deepEqual(history, before);
});

test('presentation keeps fixed input, safe colored widths and incremental status-only animation', () => {
  for (const columns of [16, 24, 80]) {
    const view = new TuiState([], () => {});
    let previous = layout(view, columns, 12, 'deepseek-flash');
    assert.equal(previous.lines.length, 12); assert.ok(previous.lines.every(line => stringWidth(line) < columns));
    view.entries.push({ kind: 'assistant', text: '**你好**\n\n```ts\nconst x = 1;\n```' }); view.busy = true;
    previous = layout(view, columns, 12, 'flash'); view.pulse++;
    const next = layout(view, columns, 12, 'flash'); const update = paint(next, previous);
    assert.equal(/[\r\n]/.test(update), false); assert.equal(update.includes('\x1b[2J'), false);
    assert.equal(next.cursorRow, 11); assert.ok(next.lines.every(line => stringWidth(line) < columns));
  }
});

test('invalid tool parameters remain displayable before core validation reports failure', () => {
  const view = new TuiState([], () => {});
  for (const argumentsText of ['null', '[1]', '{"command":{"toString":1}}', '{bad']) {
    view.event({ type: 'tool_start', call: { id: argumentsText, type: 'function', function: { name: 'bash', arguments: argumentsText } } });
    assert.doesNotThrow(() => layout(view, 40, 12, 'flash'));
  }
});
