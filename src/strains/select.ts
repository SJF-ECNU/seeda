import { emitKeypressEvents, type Key } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';
import type { Strain } from './library.ts';
import { graphemes, safeText, wrap } from '../tui/text.ts';
import stringWidth from 'string-width';
import { tint } from '../tui/markdown.ts';
import { paint, type Layout } from '../tui/render.ts';

export class SelectionCancelled extends Error { constructor() { super('种系选择已取消，未播种项目'); } }
export function matches(strains: Strain[], query: string): Strain[] {
  const text = query.toLowerCase();
  return strains.filter(strain => `${strain.name} ${strain.intro?.summary ?? strain.description} ${strain.intro?.scenarios ?? ''}`.toLowerCase().includes(text));
}
export async function selectStrain(strains: Strain[], input: ReadStream = process.stdin, output: WriteStream = process.stdout): Promise<Strain> {
  let query = ''; let detailScroll = 0; let index = Math.max(0, strains.findIndex(strain => strain.is_default)); let previous: Layout | undefined; let dimensions = '';
  const wasRaw = input.isRaw;
  let accept!: (strain: Strain) => void; let cancel!: (error: Error) => void;
  const selected = new Promise<Strain>((resolve, reject) => { accept = resolve; cancel = reject; });
  const onCancel = () => cancel(new SelectionCancelled());
  const render = () => {
    const columns = Math.max(1, output.columns || 80); const rows = Math.max(1, output.rows || 24); const width = Math.max(1, columns - 1);
    const fit = (text: string) => wrap(safeText(text), width)[0] ?? '';
    if (`${columns}x${rows}` !== dimensions) { output.write('\x1b[H\x1b[2J'); previous = undefined; dimensions = `${columns}x${rows}`; }
    if (columns < 16 || rows < 6) { output.write(paint({ lines: [fit('请放大终端（至少16×6）')], cursorRow: 1, cursorColumn: 1 }, previous)); previous = undefined; return; }
    const found = matches(strains, query); index = Math.max(0, Math.min(index, found.length - 1));
    const count = Math.min(5, Math.max(1, rows - 6)); const start = Math.max(0, index - count + 1);
    const color = process.env.NO_COLOR === undefined;
    const lines = [tint(fit('播种 · 选择起始种系'), '1;36', color), fit('搜索：' + query)];
    for (let n = start; n < Math.min(found.length, start + count); n++) {
      const strain = found[n]; lines.push(tint(fit(`${n === index ? '›' : ' '} ${strain.is_default ? '★ ' : ''}${strain.name}  ${strain.intro?.summary ?? '介绍缺失 · ' + strain.description}`), n === index ? '1;36' : '90', color));
    }
    if (!found.length) lines.push(fit('没有匹配的种系'));
    const strain = found[index];
    if (strain) {
      lines.push('');
      const details = strain.intro ? [ ['简介', strain.intro.summary], ['改进', strain.intro.improvements], ['场景', strain.intro.scenarios], ['限制/依赖', strain.intro.limitations], ['验证', strain.intro.validation] ] : [['介绍', '旧种系未提供标准介绍']];
      const detailLines = details.flatMap(([label,text]) => wrap(safeText(`${label}：${text}`), width));
      detailLines.push(fit('ID：' + strain.id));
      const space = Math.max(0, rows - 1 - lines.length);
      detailScroll = Math.min(detailScroll, Math.max(0, detailLines.length - space));
      lines.push(...detailLines.slice(detailScroll, detailScroll + space));
    }
    const display = lines.slice(0, rows - 1); while (display.length < rows - 1) display.push('');
    display.push(fit('↑↓ 选择 · 输入搜索 · Enter 播种 · PgUp/PgDn 介绍 · Esc 取消'));
    const frame = { lines: display, cursorRow: 2, cursorColumn: Math.min(columns, stringWidth(wrap(safeText('搜索：' + query), width)[0] ?? '') + 1) };
    output.write(paint(frame, previous)); previous = frame;
  };
  const onKey = (text: string, key: Key) => {
    if (key.name === 'escape' || (key.ctrl && ['c', 'd'].includes(key.name ?? ''))) { onCancel(); return; }
    const found = matches(strains, query);
    if (key.name === 'return' || key.name === 'enter') { if ((output.columns || 80) < 16 || (output.rows || 24) < 6) return; if (found[index]) accept(found[index]); return; }
    if (key.name === 'pageup' || key.name === 'pagedown') { detailScroll = Math.max(0, detailScroll + (key.name === 'pagedown' ? 1 : -1) * Math.max(1, (output.rows || 24) - 8)); render(); return; }
    detailScroll = 0;
    if (['up', 'down'].includes(key.name ?? '')) index = found.length ? (index + (key.name === 'down' ? 1 : -1) + found.length) % found.length : 0;
    else if (key.name === 'backspace') { query = graphemes(query).slice(0, -1).join(''); index = 0; }
    else if (!key.ctrl && !key.meta && text && !key.sequence?.startsWith('\x1b')) { query += safeText(text).replace(/\n/g, ' '); index = 0; }
    render();
  };
  emitKeypressEvents(input);
  try {
    input.setRawMode(true); input.resume(); output.write('\x1b[?1049h');
    input.on('keypress', onKey); input.on('end', onCancel); output.on('resize', render); output.on('error', onCancel);
    process.on('SIGINT', onCancel); process.on('SIGTERM', onCancel); render();
    return await selected;
  } finally {
    input.removeListener('keypress', onKey); input.removeListener('end', onCancel); output.removeListener('resize', render); output.removeListener('error', onCancel);
    process.removeListener('SIGINT', onCancel); process.removeListener('SIGTERM', onCancel);
    input.setRawMode(wasRaw ?? false); input.pause(); output.write('\x1b[?25h\x1b[?1049l');
  }
}
