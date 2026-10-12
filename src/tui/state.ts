import type { AgentEvent, Message } from '../core/types.ts';

export interface Entry { kind: 'user' | 'assistant' | 'tool' | 'notice'; text: string; callId?: string; status?: string; toolName?: string; arguments?: string; result?: unknown }
export interface AgentControl { run(input: string): Promise<string>; cancel(): void }

export class TuiState {
  readonly entries: Entry[] = [];
  managed = true;
  commandIndex = 0;
  commandQuery = '';
  commandDismissed?: string;
  sessionId?: string;
  busy = false;
  pulse = 0;
  status = 'Ready';
  draft: string[] = [];
  cursor = 0;
  scroll = 0;
  showToolDetails = false;
  private reply?: Entry;
  private control?: AgentControl;
  private readonly changed: () => void;
  constructor(history: Message[], changed: () => void) {
    this.changed = changed;
    this.loadHistory(history);
  }
  loadHistory(history: Message[], id?: string): void {
    this.entries.length = 0; this.reply = undefined; this.scroll = 0; this.sessionId = id;
    for (const message of history) {
      if (message.role === 'user' || message.role === 'assistant') {
        if (message.content) this.entries.push({ kind: message.role, text: message.content });
        for (const call of message.tool_calls ?? []) {
          this.entries.push({ kind: 'tool', callId: call.id, text: `${call.function.name} ${call.function.arguments}`, toolName: call.function.name, arguments: call.function.arguments, status: 'unknown' });
        }
      } else if (message.role === 'tool') this.finishTool(message.tool_call_id!, message.content);
    }
    this.changed();
  }
  bind(control: AgentControl): void { this.control = control; }
  event(event: AgentEvent): void {
    if (event.type === 'text') {
      if (!this.reply) { this.reply = { kind: 'assistant', text: '' }; this.entries.push(this.reply); }
      this.reply.text += event.text;
    } else if (event.type === 'tool_start') {
      this.reply = undefined;
      this.status = 'Running tool';
      this.entries.push({ kind: 'tool', callId: event.call.id, text: `${event.call.function.name} ${event.call.function.arguments}`, toolName: event.call.function.name, arguments: event.call.function.arguments, status: 'running' });
    } else if (event.type === 'tool_end') {
      this.finishTool(event.call.id, event.result); this.status = 'Thinking';
    } else if (event.type === 'compacted') {
      this.entries.push({ kind: 'notice', text: 'Earlier context summarized' });
    } else if (event.type === 'end') {
      this.status = event.status === 'completed' ? 'Ready' : event.status === 'cancelled' ? 'Cancelled' : 'Failed';
      if (event.error && event.status !== 'cancelled') this.entries.push({ kind: 'notice', text: event.error });
    }
    this.changed();
  }
  private finishTool(callId: string, value: unknown): void {
    const entry = this.entries.find(item => item.callId === callId);
    if (!entry) return;
    let result = value;
    if (typeof result === 'string') { try { result = JSON.parse(result); } catch { /* Plain tool content remains displayable. */ } }
    const object = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    entry.result = result;
    entry.status = typeof object.status === 'string' ? object.status : 'completed';
    const detail = object.error ?? (object.exit_code != null ? `exit=${object.exit_code}` : '');
    if (detail) entry.text += ` — ${detail}`;
    if (typeof object.full_output_path === 'string') entry.text += `\nFull output: ${object.full_output_path}`;
  }
  async submit(): Promise<void> {
    if (!this.control || !this.draft.join('').trim() || this.busy) return;
    const input = this.draft.join('');
    this.draft = []; this.cursor = 0; this.scroll = 0; this.reply = undefined;
    this.entries.push({ kind: 'user', text: input });
    this.busy = true; this.status = 'Thinking'; this.changed();
    try {
      const answer = await this.control.run(input);
      // Some adapters do not stream. Show the final answer once in that case.
      if (answer && !this.reply) this.entries.push({ kind: 'assistant', text: answer });
    } catch (error) {
      if (this.status !== 'Cancelled' && this.status !== 'Failed') {
        this.status = 'Failed';
        this.entries.push({ kind: 'notice', text: error instanceof Error ? error.message : 'Request failed' });
      }
    } finally { this.busy = false; this.reply = undefined; this.changed(); }
  }
  cancel(): void {
    if (this.busy) { this.control?.cancel(); this.status = 'Cancelling'; this.changed(); }
  }
}
