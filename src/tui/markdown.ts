import { Lexer } from 'marked';
import stringWidth from 'string-width';
import { graphemes, safeText } from './text.ts';

interface Span { text: string; style?: string; }
interface Token {
  type: string; raw?: string; text?: string; tokens?: Token[]; depth?: number; lang?: string;
  href?: string; ordered?: boolean; start?: number; task?: boolean; checked?: boolean;
  items?: Token[]; header?: { text: string; tokens: Token[] }[]; rows?: { text: string; tokens: Token[] }[][];
}
export function tint(text: string, style: string, color = true): string { return color && text ? `\x1b[${style}m${text}\x1b[0m` : text; }
export function styledLines(spans: Span[], width: number, prefix = '', color = true): string[] {
  const lines: string[] = []; let line = prefix; let size = stringWidth(prefix);
  const flush = () => { lines.push(line); line = prefix; size = stringWidth(prefix); };
  for (const span of spans) {
    let fragment = '';
    const append = () => { line += span.style ? tint(fragment, span.style, color) : fragment; fragment = ''; };
    for (let character of graphemes(safeText(span.text))) {
      if (character === '\n') { append(); flush(); continue; }
      let length = stringWidth(character);
      if (length > width - stringWidth(prefix)) { character = '?'; length = 1; }
      if (size + length > width) { append(); flush(); }
      fragment += character; size += length;
    }
    append();
  }
  lines.push(line); return lines;
}
function inline(tokens: Token[], style = ''): Span[] {
  return tokens.flatMap(token => {
    if (token.type === 'strong' || token.type === 'em' || token.type === 'del') {
      const code = token.type === 'strong' ? '1' : token.type === 'em' ? '3' : '9';
      return inline(token.tokens ?? [], style ? `${style};${code}` : code);
    }
    if (token.type === 'codespan') return [{ text: token.text ?? '', style: '33' }];
    if (token.type === 'link') return [...inline(token.tokens ?? [], '4;36'), { text: ` (${token.href ?? ''})`, style: '90' }];
    if (token.type === 'image') return [{ text: `[图片: ${token.text ?? ''}]`, style: '90' }];
    if (token.type === 'br') return [{ text: '\n' }];
    if (token.tokens) return inline(token.tokens, style);
    return [{ text: token.text ?? token.raw ?? '', style }];
  });
}
export function markdown(source: string, width: number, color = true): string[] {
  const tokens = Lexer.lex(safeText(source), { gfm: true }) as unknown as Token[];
  const blocks = (items: Token[], space: number): string[] => items.flatMap(token => {
    const text = token.text ?? '';
    switch (token.type) {
      case 'space': return [''];
      case 'checkbox': return [];
      case 'heading': return [...styledLines(inline(token.tokens ?? [], '1;36'), space, '', color), ''];
      case 'paragraph': case 'text': return styledLines(inline(token.tokens ?? [{ type: 'text', text }]), space, '', color);
      case 'hr': return [tint('─'.repeat(space), '90', color)];
      case 'blockquote': if (space < 4) return blocks(token.tokens ?? [], space); return blocks(token.tokens ?? [], Math.max(1, space - 2)).map(line => tint('│ ', '90', color) + line);
      case 'code': if (space < 4) return styledLines([{ text, style: '36' }], space, '', color); return [styledLines([{ text: `┌─ ${token.lang?.split(/\s/)[0] || 'code'}`, style: '90' }], space, '', color)[0],
        ...styledLines([{ text, style: '36' }], space, '│ ', color), tint('└' + '─'.repeat(Math.max(0, space - 1)), '90', color)];
      case 'list': return (token.items ?? []).flatMap((item, index) => {
        const bullet = item.task ? (item.checked ? '✓ ' : '○ ') : token.ordered ? `${Number(token.start ?? 1) + index}. ` : '• ';
        if (space <= stringWidth(bullet)) return blocks(item.tokens ?? [], space);
        const lines = blocks(item.tokens ?? [], Math.max(1, space - stringWidth(bullet)));
        return lines.map((line, lineIndex) => (lineIndex ? ' '.repeat(stringWidth(bullet)) : tint(bullet, '36', color)) + line);
      });
      case 'table': {
        const headers = token.header ?? []; const count = headers.length;
        if (!count) return [];
        if (space < count * 7) return (token.rows ?? []).flatMap(row => row.flatMap((cell, index) => styledLines([
          { text: `${headers[index].text}: `, style: '1' }, ...inline(cell.tokens),
        ], space, '', color)).concat(''));
        const cellWidth = Math.floor((space - (count - 1) * 3) / count);
        const rowLines = (cells: { text: string; tokens: Token[] }[], bold = false) => {
          const parts = cells.map(cell => styledLines(inline(cell.tokens, bold ? '1' : ''), cellWidth, '', color));
          return Array.from({ length: Math.max(...parts.map(part => part.length)) }, (_, line) => parts.map(part => {
            const value = part[line] ?? ''; return value + ' '.repeat(Math.max(0, cellWidth - stringWidth(value)));
          }).join(tint(' │ ', '90', color)));
        };
        return [...rowLines(headers, true), tint(headers.map(() => '─'.repeat(cellWidth)).join('─┼─'), '90', color), ...(token.rows ?? []).flatMap(row => rowLines(row))];
      }
      default: return styledLines([{ text: safeText(token.raw ?? text) }], space, '', color);
    }
  });
  return blocks(tokens, Math.max(1, width)).filter((line, index, lines) => line !== '' || index === 0 || lines[index - 1] !== '');
}
