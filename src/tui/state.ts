import type { AgentEvent, Message, Usage } from '../core/types.ts';

// Context occupancy and cache hit rate are the two numbers an operator watches
// while a long request runs, so they are derived here instead of the renderer.
export interface StatusMetrics {
  contextChars: number;
  maxContextChars: number;
  maxContextTokens?: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  promptTokens: number;
}
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  // Rounding may reach 1000k, which must render as 1.0M rather than 1000k.
  if (count < 999_500) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
export function contextRatio(metrics: StatusMetrics): number {
  if (metrics.maxContextTokens) return Math.min(1, metrics.promptTokens / metrics.maxContextTokens);
  return metrics.maxContextChars ? Math.min(1, metrics.contextChars / metrics.maxContextChars) : 0;
}
export function cacheHitRate(metrics: StatusMetrics): number | undefined {
  const total = metrics.cacheHitTokens + metrics.cacheMissTokens;
  return total ? metrics.cacheHitTokens / total : undefined;
}

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
  metrics?: StatusMetrics;
  draft: string[] = [];
  cursor = 0;
  scroll = 0;
  showToolDetails = false;
  // Rendering state used to keep a scrolled viewport anchored while a reply streams.
  renderedHistoryLines?: number;
  renderedWidth?: number;
  scrollBy(lines: number): void { this.scroll = Math.max(0, this.scroll + lines); }
  scrollToTop(): void { this.scroll = Number.MAX_SAFE_INTEGER; }
  scrollToBottom(): void { this.scroll = 0; }
  private reply?: Entry;
  private control?: AgentControl;
  private readonly changed: () => void;
  constructor(history: Message[], changed: () => void) {
    this.changed = changed;
    this.loadHistory(history);
  }
  loadHistory(history: Message[], id?: string): void {
    this.entries.length = 0; this.reply = undefined; this.scroll = 0; this.sessionId = id; this.metrics = undefined;
    this.renderedHistoryLines = undefined; this.renderedWidth = undefined;
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
    } else if (event.type === 'usage') {
      this.metrics = this.accumulate(event.usage, event.contextChars, event.maxContextChars, event.maxContextTokens);
    } else if (event.type === 'compacted') {
      this.entries.push({ kind: 'notice', text: 'Earlier context summarized' });
    } else if (event.type === 'retrying') {
      this.reply = undefined;
      this.status = `Retrying (${event.attempt})`;
      this.entries.push({ kind: 'notice', text: `Request failed: ${event.error} — retrying in ${Math.round(event.delayMs / 1000)}s` });
    } else if (event.type === 'end') {
      this.status = event.status === 'completed' ? 'Ready' : event.status === 'cancelled' ? 'Cancelled' : 'Failed';
      if (event.error && event.status !== 'cancelled') this.entries.push({ kind: 'notice', text: event.error });
    }
    this.changed();
  }
  // A request may call the model repeatedly; the last frame wins for occupancy
  // while cache tokens accumulate so the rate covers the whole request.
  private accumulate(usage: Usage, contextChars: number, maxContextChars: number, maxContextTokens?: number): StatusMetrics {
    const previous = this.metrics;
    return {
      contextChars, maxContextChars, maxContextTokens,
      cacheHitTokens: (previous?.cacheHitTokens ?? 0) + usage.promptCacheHitTokens,
      cacheMissTokens: (previous?.cacheMissTokens ?? 0) + usage.promptCacheMissTokens,
      promptTokens: usage.promptTokens,
    };
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
    this.busy = true; this.status = 'Thinking'; this.metrics = undefined; this.changed();
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
