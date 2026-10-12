import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, Message } from '../core/types.ts';

export class RuntimeClient {
  sessionId?: string;
  onSession?: (session: { id: string; messages: Message[] }) => void;
  private readonly socket: Socket;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; event?: (event: AgentEvent) => void }>();
  private constructor(socket: Socket) {
    this.socket = socket; socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString(); let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let response: { id: string; session?: { id: string; messages: Message[] }; event?: AgentEvent; error?: string; result?: unknown };
        try { response = JSON.parse(line); } catch { socket.destroy(new Error('Invalid manager response')); return; }
        if (response.session) { this.sessionId = response.session.id; this.onSession?.(response.session); continue; }
        const request = this.pending.get(response.id); if (!request) continue;
        if (response.event) { request.event?.(response.event); continue; }
        this.pending.delete(response.id);
        if (response.error) request.reject(new Error(response.error)); else request.resolve(response.result);
      }
    });
    const disconnected = () => { for (const request of this.pending.values()) request.reject(new Error('Supervisor disconnected; the request was not replayed')); this.pending.clear(); };
    socket.on('error', disconnected); socket.on('close', disconnected);
  }
  static async connect(path: string): Promise<RuntimeClient> {
    const socket = createConnection(path);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    return new RuntimeClient(socket);
  }
  request(operation: string, args?: Record<string, unknown>, event?: (event: AgentEvent) => void, input?: string): Promise<unknown> {
    if (this.socket.destroyed) return Promise.reject(new Error('Supervisor is disconnected'));
    const id = randomUUID();
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, event }); this.socket.write(JSON.stringify({ id, operation, args, input }) + '\n'); });
  }
  run(input: string, event?: (event: AgentEvent) => void): Promise<string> { return this.request('run', { session: this.sessionId }, event, input) as Promise<string>; }
  cancel(): void { void this.request('cancel').catch(() => {}); }
  close(): void { this.socket.end(); }
}
