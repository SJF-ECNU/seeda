import { networkError } from './network.ts';
import type { Message, Model, ModelResponse, ToolCall, ToolDefinition } from '../core/types.ts';

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
  maxTokens?: number;
  timeoutMs?: number;
}
export class DeepSeekModel implements Model {
  get maxOutputTokens(): number { return this.options.maxTokens ?? 4096; }
  private readonly options: DeepSeekOptions;
  constructor(options: DeepSeekOptions) {
    if (!options.apiKey) throw new Error('DEEPSEEK_API_KEY is required');
    this.options = options;
  }
  async complete(messages: Message[], tools: ToolDefinition[], signal: AbortSignal,
    onText?: (text: string) => void): Promise<ModelResponse> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 120_000)]);
    const response = await fetch(`${(this.options.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({
        model: this.options.model ?? 'deepseek-flash', messages, stream: true,
        stream_options: { include_usage: true },
        max_tokens: this.options.maxTokens ?? 4096,
        thinking: { type: this.options.thinking ? 'enabled' : 'disabled' },
        ...(this.options.thinking ? { reasoning_effort: 'high' } : {}),
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
    let completed = false;
    let usage: ModelResponse['usage'];
    const calls = new Map<number, ToolCall>();
    for await (const data of sseData(response.body)) {
      requestSignal.throwIfAborted();
      if (data === '[DONE]') { completed = true; break; }
      const item = JSON.parse(data);
      if (item.error) throw new Error('Model returned a stream error');
      if (Number.isFinite(item.usage?.prompt_tokens)) usage = { promptTokens: item.usage.prompt_tokens, completionTokens: item.usage.completion_tokens ?? 0, totalTokens: item.usage.total_tokens ?? 0, promptCacheHitTokens: item.usage.prompt_cache_hit_tokens ?? 0, promptCacheMissTokens: item.usage.prompt_cache_miss_tokens ?? 0 };
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
    return { message, finishReason, usage };
  }
}
