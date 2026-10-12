import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message, ToolCall } from './types.ts';

type RecordEntry =
  | { type: 'message'; message: Message }
  | { type: 'tool_started'; callId: string }
  | { type: 'end'; status: string; error?: string }
  | { type: 'compact'; messages: Message[] }
  | { type: 'metadata'; cwd: string; createdAt: string }
  | { type: 'request'; id: string; implementationVersion: string };

export class Session {
  readonly path: string;
  readonly messages: Message[] = [];
  private context: Message[] = [];
  private readonly started = new Set<string>();
  private constructor(path: string) { this.path = path; }
  static async open(path: string, cwd: string): Promise<Session> {
    const session = new Session(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let data: string;
    try { data = await readFile(path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await session.record({ type: 'metadata', cwd, createdAt: new Date().toISOString() });
      return session;
    }
    // Preserve a crash-truncated tail before repairing the append boundary.
    if (data && !data.endsWith('\n')) {
      const cut = data.lastIndexOf('\n') + 1;
      await writeFile(`${path}.interrupted-${Date.now()}`, data.slice(cut), { mode: 0o600 });
      data = data.slice(0, cut);
      await writeFile(path, data, { mode: 0o600 });
    }
    for (const line of data.split('\n').filter(Boolean)) {
      const entry: RecordEntry = JSON.parse(line);
      if (entry.type === 'metadata' && entry.cwd !== cwd) throw new Error('Session belongs to a different working directory');
      if (entry.type === 'message') { session.messages.push(entry.message); session.context.push(entry.message); }
      else if (entry.type === 'compact') session.context = entry.messages;
      else if (entry.type === 'tool_started') session.started.add(entry.callId);
    }
    const resolved = new Set(session.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id));
    const pending: ToolCall[] = session.messages.flatMap(m => m.tool_calls ?? []).filter(call => !resolved.has(call.id));
    for (const call of pending) {
      await session.add({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({
        status: session.started.has(call.id) ? 'unknown' : 'not_executed',
        error: 'Previous request was interrupted. Inspect the workspace before deciding whether any action should be retried.',
      }) });
    }
    return session;
  }
  private async record(entry: RecordEntry): Promise<void> {
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }
  async beginRequest(): Promise<void> {
    await this.record({ type: 'request', id: randomUUID(), implementationVersion: process.env.SEEDA_VERSION ?? '0.1.0' });
  }
  async add(message: Message): Promise<void> {
    await this.record({ type: 'message', message });
    this.messages.push(message); this.context.push(message);
  }
  async startTool(callId: string): Promise<void> {
    await this.record({ type: 'tool_started', callId }); this.started.add(callId);
  }
  async end(status: string, error?: string): Promise<void> {
    await this.record({ type: 'end', status, ...(error ? { error } : {}) });
  }
  getContext(): Message[] { return structuredClone(this.context); }
  async compact(messages: Message[]): Promise<void> {
    await this.record({ type: 'compact', messages }); this.context = structuredClone(messages);
  }
}
