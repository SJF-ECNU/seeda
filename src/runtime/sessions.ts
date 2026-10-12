import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '../core/types.ts';

export function sessionPath(root: string, id: string): string {
  if (id !== 'main' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid session ID');
  return join(root, 'sessions', `${id}.jsonl`);
}
export async function sessionHistory(root: string, id: string): Promise<Message[]> {
  const text = await readFile(sessionPath(root, id), 'utf8');
  return text.split('\n').slice(0, -1).flatMap(line => {
    try { const item = JSON.parse(line); return item.type === 'message' ? [item.message as Message] : []; }
    catch { return []; }
  });
}
export async function listSessions(root: string): Promise<{ id: string; title: string; updated: string }[]> {
  const files = await readdir(join(root, 'sessions'));
  const rows = [];
  for (const file of files) {
    const id = file.replace(/\.jsonl$/, '');
    if (file !== `${id}.jsonl` || (id !== 'main' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) continue;
    const history = await sessionHistory(root, id);
    rows.push({ id, title: history.find(message => message.role === 'user')?.content?.replace(/\s+/g, ' ').slice(0, 70) ?? '新会话', updated: (await stat(sessionPath(root, id))).mtime.toISOString() });
  }
  return rows.sort((a, b) => b.updated.localeCompare(a.updated));
}
