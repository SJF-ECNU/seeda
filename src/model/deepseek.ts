import { networkError } from './network.ts';
import { retry, type RetryOptions } from './retry.ts';
import type { Message, Model, ModelResponse, ToolCall, ToolDefinition, Usage } from '../core/types.ts';

// Every provider reports usage differently; the cache fields are the ones the
// status line needs, so a missing field is normalized instead of dropped.
export function normalizeUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const count = (key: string): number => { const raw = record[key]; return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0; };
  const promptTokens = count('prompt_tokens');
  const completionTokens = count('completion_tokens');
  const totalTokens = count('total_tokens') || promptTokens + completionTokens;
  const promptCacheHitTokens = count('prompt_cache_hit_tokens');
  const promptCacheMissTokens = count('prompt_cache_miss_tokens');
  if (!promptTokens && !completionTokens && !totalTokens) return undefined;
  return { promptTokens, completionTokens, totalTokens, promptCacheHitTokens, promptCacheMissTokens };
}

// SSE framing is independent of network chunks and UTF-8 character boundaries.
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line === '') {
          if (data.length) { yield data.join('\n'); data = []; }
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (done) break;
    }
    // Only terminated frames are accepted. An incomplete final frame is truncation.
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  thinking?: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
  maxTokens?: number;
  timeoutMs?: number;
  retry?: RetryOptions;
}
export class DeepSeekModel implements Model {
  static fromEnvironment(onRetry?: RetryOptions['onRetry']): DeepSeekModel {
    return new DeepSeekModel({ apiKey: process.env.DEEPSEEK_API_KEY ?? '',
      baseUrl: process.env.DEEPSEEK_BASE_URL, model: process.env.DEEPSEEK_MODEL,
      thinking: process.env.SEEDA_THINKING !== '0', retry: { onRetry } });
  }
  get maxOutputTokens(): number {
    if (this.options.maxTokens !== undefined) return this.options.maxTokens;
    if (this.options.thinking === false) return 8192;
    return (this.options.reasoningEffort ?? 'max') === 'max' ? 131072 : 65536;
  }
  private readonly options: DeepSeekOptions;
  constructor(options: DeepSeekOptions) {
    if (!options.apiKey) throw new Error('DEEPSEEK_API_KEY is required');
    this.options = options;
  }
  async complete(messages: Message[], tools: ToolDefinition[], signal: AbortSignal,
    onText?: (text: string) => void): Promise<ModelResponse> {
    // A transient failure retries the whole request: a fresh connection and a
    // fresh stream. Once any text has been streamed to the caller a retry would
    // duplicate it, so from that point the attempt is final.
    let streamed = false;
    const guarded = onText ? (text: string) => { streamed = true; onText(text); } : undefined;
    return retry(() => this.attempt(messages, tools, signal, guarded), signal, {
      attempts: 3, baseDelayMs: 500, maxDelayMs: 8000, ...this.options.retry,
      shouldRetry: () => !streamed,
    });
  }
  private async attempt(messages: Message[], tools: ToolDefinition[], signal: AbortSignal,
    onText?: (text: string) => void): Promise<ModelResponse> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 120_000)]);
    const response = await fetch(`${(this.options.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({
        model: this.options.model ?? 'deepseek-flash', messages, stream: true,
        max_tokens: this.maxOutputTokens,
        stream_options: { include_usage: true },
        thinking: { type: this.options.thinking === false ? 'disabled' : 'enabled' },
        ...(this.options.thinking === false ? {} : { reasoning_effort: this.options.reasoningEffort ?? 'max' }),
        ...(tools.length ? { tools } : {}),
      }),
      signal: requestSignal,
    }).catch(error => { throw networkError(error); });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Model HTTP error ${response.status}`);
    }
    if (!response.body) throw new Error('Model returned no response stream');
    let content = '';
    let reasoning = '';
    let finishReason = '';
    let usage: Usage | undefined;
    let completed = false;
    const calls = new Map<number, ToolCall>();
    for await (const data of sseData(response.body)) {
      requestSignal.throwIfAborted();
      if (data === '[DONE]') { completed = true; break; }
      const item = JSON.parse(data);
      if (item.error) throw new Error('Model returned a stream error');
      // The usage frame carries no choices, so it must be read before the guard.
      usage = normalizeUsage(item.usage) ?? usage;
      const choice = item.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string') { content += delta.content; onText?.(delta.content); }
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      for (const fragment of delta.tool_calls ?? []) {
        if (!Number.isInteger(fragment.index)) throw new Error('Tool fragment missing index');
        const call = calls.get(fragment.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (fragment.type && fragment.type !== 'function') throw new Error('Unsupported tool call type');
        call.id += fragment.id ?? '';
        call.function.name += fragment.function?.name ?? '';
        call.function.arguments += fragment.function?.arguments ?? '';
        calls.set(fragment.index, call);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    if (!completed || !finishReason) throw new Error('Model stream was interrupted before completion');
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    const message: Message = { role: 'assistant', content: content || null };
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.length) message.tool_calls = toolCalls;
    return { message, finishReason, ...(usage ? { usage } : {}) };
  }
}
