import stringWidth from 'string-width';
import { stripVTControlCharacters } from 'node:util';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function graphemes(text: string): string[] { return [...segmenter.segment(text)].map(item => item.segment); }
export function safeText(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of safeText(text).split('\n')) {
    let line = ''; let size = 0;
    for (const character of graphemes(paragraph)) {
      const length = stringWidth(character);
      if (size + length > width && line) { lines.push(line); line = ''; size = 0; }
      if (length > width) { line += '?'; size++; } else { line += character; size += length; }
    }
    lines.push(line);
  }
  return lines;
}
