import type { AgentEvent, Model, Tool, ToolCall } from './types.ts';
import { Session } from './session.ts';
import { compactContext, contextSize, ContextTokens, projectInstructions } from './context.ts';

export interface AgentOptions {
  cwd: string;
  artifactDir: string;
  model: Model;
  session: Session;
  tools: Tool[];
  maxContextChars?: number;
  maxContextTokens?: number;
  onEvent?: (event: AgentEvent) => void;
}
export class Agent {
  private readonly options: AgentOptions;
  private controller?: AbortController;
  private readonly tokens: ContextTokens;
  private get contextLimit(): number { return this.options.maxContextTokens ?? 1_000_000; }
  private get inputBudget(): number { return this.options.maxContextChars ?? Math.max(1, this.contextLimit - (this.options.model.maxOutputTokens ?? 4096)); }
  constructor(options: AgentOptions) { this.options = options; this.tokens = new ContextTokens(options.tools.map(tool => tool.definition)); }
  cancel(): void { this.controller?.abort(); }
  async compact(): Promise<string> {
    if (this.controller) throw new Error('An agent request is already running');
    const controller = new AbortController(); this.controller = controller;
    const emit = (event: AgentEvent) => { try { this.options.onEvent?.(event); } catch {} };
    try {
      const changed = await compactContext(this.options.session, this.options.model,
        await projectInstructions(this.options.cwd), this.inputBudget, controller.signal, true, this.options.maxContextChars ? undefined : this.tokens.estimate);
      if (changed) { this.tokens.reset(); emit({ type: 'compacted' }); }
      emit({ type: 'end', status: 'completed' });
      return changed ? '上下文已压缩，原始对话记录已保留。' : '当前没有可压缩的早期对话。';
    } catch (error) {
      emit({ type: 'end', status: controller.signal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : 'Compaction failed' });
      throw error;
    } finally { this.controller = undefined; }
  }
  async run(input: string): Promise<string> {
    if (this.controller) throw new Error('An agent request is already running');
    const controller = new AbortController(); this.controller = controller;
    const { model, session, cwd, tools } = this.options;
    const emit = (event: AgentEvent) => {
      // A frontend observer must not change the execution or persistence outcome.
      try { this.options.onEvent?.(event); } catch { /* The caller owns frontend recovery. */ }
    };
    try {
      if (!input.trim()) throw new Error('User input cannot be empty');
      await session.beginRequest();
      await session.add({ role: 'user', content: input });
      const system = await projectInstructions(cwd);
      while (true) {
        controller.signal.throwIfAborted();
        if (await compactContext(session, model, system, this.inputBudget, controller.signal, false, this.options.maxContextChars ? undefined : this.tokens.estimate)) { this.tokens.reset(); emit({ type: 'compacted' }); }
        const response = await model.complete([{ role: 'system', content: system }, ...session.getContext()],
          tools.map(tool => tool.definition), controller.signal, text => emit({ type: 'text', text }));
        controller.signal.throwIfAborted();
        if (response.usage) emit({ type: 'usage', usage: response.usage, contextChars: contextSize(system, session.getContext()), maxContextChars: this.options.maxContextChars ?? 0, maxContextTokens: this.options.maxContextChars ? undefined : this.contextLimit });
        if (response.usage) this.tokens.record(system, session.getContext(), response.usage.promptTokens);
        const calls = response.message.tool_calls ?? [];
        if ((response.finishReason !== 'stop' && response.finishReason !== 'tool_calls') ||
          (calls.length > 0 && response.finishReason !== 'tool_calls') ||
          (calls.length === 0 && response.finishReason !== 'stop')) throw new Error(`Model did not complete normally (${response.finishReason})`);
        // A malformed batch is not persisted as executable calls.
        const ids = new Set(session.messages.flatMap(message => message.tool_calls ?? []).map(call => call.id));
        for (const call of calls) {
          if (!call.id || !call.function.name || ids.has(call.id)) throw new Error('Invalid or duplicate tool call ID');
          ids.add(call.id);
        }
        await session.add(response.message);
        if (!calls.length) {
          await session.end('completed'); emit({ type: 'end', status: 'completed' });
          return response.message.content ?? '';
        }
        for (const call of calls) {
          if (controller.signal.aborted) {
            await session.add({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ status: 'not_executed', error: 'Request cancelled' }) });
            continue;
          }
          emit({ type: 'tool_start', call });
          const result = await this.execute(call, controller.signal);
          await session.add({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
          emit({ type: 'tool_end', call, result });
        }
        controller.signal.throwIfAborted();
      }
    } catch (error) {
      const status = controller.signal.aborted ? 'cancelled' : 'failed';
      const message = error instanceof Error ? error.message : 'Agent request failed';
      await session.end(status, message);
      emit({ type: 'end', status, error: message });
      throw error;
    } finally { this.controller = undefined; }
  }
  private async execute(call: ToolCall, signal: AbortSignal): Promise<unknown> {
    try {
      const tool = this.options.tools.find(tool => tool.definition.function.name === call.function.name);
      if (!tool) throw new Error(`Unknown tool: ${call.function.name}`);
      const args: unknown = JSON.parse(call.function.arguments);
      // Persist intent before any tool can create a side effect.
      await this.options.session.startTool(call.id);
      return await tool.execute(args, { cwd: this.options.cwd, artifactDir: this.options.artifactDir, signal });
    } catch (error) {
      return { status: signal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : 'Tool failed' };
    }
  }
}
