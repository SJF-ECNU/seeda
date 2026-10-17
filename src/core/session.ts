import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExecutionFailure, Message, ToolCall } from './types.ts';
import { RuntimeHistory, failureReason, type RuntimeObservation, type InstructionSource } from './runtime-records.ts';

export interface RecoveryRecord {
  at: string;
  instance: string;
  failedVersion: string;
  targetVersion: string | null;
  reason: string;
  attempt: number;
  logPath: string;
}

type RecordEntry =
  | { type: 'message'; message: Message }
  | { type: 'tool_started'; callId: string }
  | { type: 'end'; status: string; error?: string; endedAt?: string; reason?: string; recordingComplete?: boolean; failure?: ExecutionFailure }
  | { type: 'compact'; messages: Message[] }
  | { type: 'metadata'; cwd: string; createdAt: string }
  | { type: 'request'; id: string; implementationVersion: string; startedAt?: string; recordingComplete?: boolean }
  | { type: 'runtime'; observation: RuntimeObservation }
  | { type: 'instructions'; sources: InstructionSource[] }
  | { type: 'recovery'; recovery: RecoveryRecord };

export class Session {
  readonly path: string;
  readonly messages: Message[] = [];
  readonly runtime = new RuntimeHistory();
  readonly recoveries: RecoveryRecord[] = [];
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
      if ((entry.type === 'request' || entry.type === 'end') && entry.recordingComplete === false) session.runtime.recordingComplete = false;
      if (entry.type === 'metadata' && entry.cwd !== cwd) throw new Error('Session belongs to a different working directory');
      if (entry.type === 'message') { session.messages.push(entry.message); session.context.push(entry.message); }
      else if (entry.type === 'compact') session.context = entry.messages;
      else if (entry.type === 'tool_started') session.started.add(entry.callId);
      else if (entry.type === 'request') session.runtime.request(entry.id, entry.implementationVersion, entry.startedAt);
      else if (entry.type === 'runtime') session.runtime.observe(entry.observation);
      else if (entry.type === 'recovery') session.recoveries.push(entry.recovery);
      else if (entry.type === 'instructions') session.runtime.instructions(entry.sources);
      else if (entry.type === 'end') session.runtime.end(entry.status, entry.reason ?? (entry.error ? failureReason(new Error(entry.error)) : undefined), entry.endedAt, entry.failure);
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
    const id = randomUUID(), implementationVersion = process.env.SEEDA_VERSION ?? '0.1.0', startedAt = new Date().toISOString();
    await this.record({ type: 'request', id, implementationVersion, startedAt, recordingComplete: this.runtime.recordingComplete });
    this.runtime.request(id, implementationVersion, startedAt, true);
  }
  async recordRecovery(recovery: RecoveryRecord): Promise<void> {
    await this.record({ type: 'recovery', recovery }); this.recoveries.push(recovery);
  }
  async recordInstructions(sources: InstructionSource[]): Promise<void> {
    await this.record({ type: 'instructions', sources });
    this.runtime.instructions(sources);
  }
  async add(message: Message): Promise<void> {
    await this.record({ type: 'message', message });
    this.messages.push(message); this.context.push(message);
  }
  async startTool(callId: string): Promise<void> {
    await this.record({ type: 'tool_started', callId }); this.started.add(callId);
  }
  async end(status: string, error?: string, failure?: ExecutionFailure): Promise<void> {
    const endedAt = new Date().toISOString(), reason = status === 'cancelled' ? 'cancelled' : error ? failureReason(new Error(error)) : undefined;
    await this.record({ type: 'end', status, endedAt, reason, recordingComplete: this.runtime.recordingComplete, ...(error ? { error } : {}), ...(failure ? { failure } : {}) });
    this.runtime.end(status, reason, endedAt, failure);
  }
  async observe(observation: RuntimeObservation): Promise<void> {
    const usage = observation.usage ? Object.fromEntries(['promptTokens', 'completionTokens', 'totalTokens', 'promptCacheHitTokens', 'promptCacheMissTokens'].map(key => {
      const value = observation.usage![key as keyof typeof observation.usage];
      return [key, typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0];
    })) as unknown as typeof observation.usage : undefined;
    const safe = { ...observation, usage };
    try { await this.record({ type: 'runtime', observation: safe }); this.runtime.observe(safe); }
    catch { this.runtime.recordingComplete = false; }
  }
  getContext(): Message[] { return structuredClone(this.context); }
  async compact(messages: Message[]): Promise<void> {
    await this.record({ type: 'compact', messages }); this.context = structuredClone(messages);
  }
}
