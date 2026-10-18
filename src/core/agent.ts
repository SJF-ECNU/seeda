import type { AgentEvent, ExecutionFailure, Model, Tool, ToolCall } from './types.ts';
import { executionFailure, toolFailure } from './runtime-records.ts';
import { Session } from './session.ts';
import { RuntimeRecordsTool } from './runtime-records-tool.ts';
import { SkillTool } from './skill-tool.ts';
import { VerificationTool } from '../tools/verification.ts';
import { compactContext, contextSize, ContextTokens, estimateContextTokens, loadInstructions } from './context.ts';

export interface AgentOptions {
  cwd: string;
  artifactDir: string;
  model: Model;
  session: Session;
  tools: Tool[];
  maxContextChars?: number;
  maxContextTokens?: number;
  onEvent?: (event: AgentEvent) => void;
  shouldYield?: () => boolean;
}
export class Agent {
  private readonly options: AgentOptions;
  private controller?: AbortController;
  private readonly tokens: ContextTokens;
  private get contextLimit(): number { return this.options.maxContextTokens ?? 1_000_000; }
  private get inputBudget(): number { return this.options.maxContextChars ?? Math.max(1, this.contextLimit - (this.options.model.maxOutputTokens ?? 4096)); }
  private get compactThreshold(): number { return Math.min(this.inputBudget, Math.floor((this.options.maxContextChars ?? this.contextLimit) * 0.85)); }
  constructor(options: AgentOptions) {
    const tools = [...options.tools];
    const bash = tools.find(tool => tool.definition.function.name === 'bash');
    if (bash && !tools.some(tool => tool.definition.function.name === 'verify')) tools.push(new VerificationTool(bash));
    if (!tools.some(tool => tool.definition.function.name === 'read_skill')) tools.push(new SkillTool());
    if (!tools.some(tool => tool.definition.function.name === 'runtime_records')) tools.push(new RuntimeRecordsTool(options.session, tools.map(tool => tool.definition.function.name)));
    const original = options.model;
    const model: Model = { maxOutputTokens: original.maxOutputTokens, async complete(...args) {
      const started = performance.now();
      try {
        const response = await original.complete(...args);
        const failure = ['stop', 'tool_calls'].includes(response.finishReason) ? undefined : executionFailure(new Error(`Model did not complete normally (${response.finishReason})`), 'model');
        await options.session.observe({ kind: 'model', durationMs: performance.now() - started,
          status: ['stop', 'tool_calls'].includes(response.finishReason) ? 'completed' : 'failed',
          finishReason: ['stop', 'tool_calls', 'length', 'content_filter'].includes(response.finishReason) ? response.finishReason : 'other', usage: response.usage, ...(failure ? { failure } : {}) });
        if (failure) { try { options.onEvent?.({ type: 'feedback', failure }); } catch {} }
        return response;
      } catch (error) {
        const failure = executionFailure(error, 'model', args[2].aborted);
        await options.session.observe({ kind: 'model', durationMs: performance.now() - started, status: args[2].aborted ? 'cancelled' : 'failed', failure });
        try { options.onEvent?.({ type: 'feedback', failure }); } catch {}
        throw error;
      }
    } };
    this.options = { ...options, tools, model }; this.tokens = new ContextTokens(tools.map(tool => tool.definition));
  }
  cancel(): void { this.controller?.abort(); }
  async compact(): Promise<string> {
    if (this.controller) throw new Error('An agent request is already running');
    const controller = new AbortController(); this.controller = controller;
    const emit = (event: AgentEvent) => { try { this.options.onEvent?.(event); } catch {} };
    try {
      await this.options.session.beginRequest();
      const instructions = await loadInstructions(this.options.cwd);
      await this.options.session.recordInstructions(instructions.sources);
      const changed = await compactContext(this.options.session, this.options.model,
        instructions.text, this.inputBudget, controller.signal, true, this.options.maxContextChars ? undefined : this.tokens.estimate, this.options.maxContextChars ? undefined : estimateContextTokens);
      if (changed) { this.tokens.reset(); emit({ type: 'compacted' }); }
      await this.options.session.end('completed');
      emit({ type: 'end', status: 'completed' });
      return changed ? '上下文已压缩，原始对话记录已保留。' : '当前没有可压缩的早期对话。';
    } catch (error) {
      const failure = this.options.session.runtime.recent(1)[0]?.recentCalls.at(-1)?.failure ?? executionFailure(error, 'runtime', controller.signal.aborted);
      await this.options.session.end(controller.signal.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : 'Compaction failed', failure);
      emit({ type: 'end', status: controller.signal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : 'Compaction failed', failure });
      throw error;
    } finally { this.controller = undefined; }
  }
  async run(input: string, resume?: { userCountBefore: number }): Promise<string> {
    if (this.controller) throw new Error('An agent request is already running');
    const controller = new AbortController(); this.controller = controller;
    const { model, session, cwd, tools } = this.options;
    let stage: ExecutionFailure['stage'] = 'runtime';
    const emit = (event: AgentEvent) => {
      // A frontend observer must not change the execution or persistence outcome.
      try { this.options.onEvent?.(event); } catch { /* The caller owns frontend recovery. */ }
    };
    try {
      if (!input.trim()) throw new Error('User input cannot be empty');
      await session.beginRequest();
      const instructions = await loadInstructions(cwd);
      await session.recordInstructions(instructions.sources);
      if (!resume || session.messages.filter(message => message.role === 'user').length <= resume.userCountBefore) await session.add({ role: 'user', content: input });
      const previous = session.runtime.recent(2).at(-2);
      const system = instructions.text + (previous ? `\nPrevious request ended: ${previous.status}${previous.reason ? ' (' + previous.reason + ')' : ''}. runtime_records can inspect your own execution facts.\n` : '')
        + (resume && previous && previous.implementationVersion !== process.env.SEEDA_VERSION ? `\nRuntime version switch facts: previous=${previous.implementationVersion}, current=${process.env.SEEDA_VERSION}. Continue the same task from recorded tool results; do not replay completed actions.\n` : '');
      while (true) {
        controller.signal.throwIfAborted();
        stage = 'model';
        if (await compactContext(session, model, system, this.inputBudget, controller.signal, false, this.options.maxContextChars ? undefined : this.tokens.estimate, this.options.maxContextChars ? undefined : estimateContextTokens, this.compactThreshold)) { this.tokens.reset(); emit({ type: 'compacted' }); }
        const response = await model.complete([{ role: 'system', content: system }, ...session.getContext()],
          tools.map(tool => tool.definition), controller.signal, text => emit({ type: 'text', text }));
        controller.signal.throwIfAborted();
        if (response.usage) emit({ type: 'usage', usage: response.usage, contextChars: contextSize(system, session.getContext()), maxContextChars: this.options.maxContextChars ?? 0, maxContextTokens: this.options.maxContextChars ? undefined : this.contextLimit });
        if (response.usage) this.tokens.record(system, session.getContext(), response.usage.promptTokens);
        if (response.finishReason === 'length' && response.usage && session.runtime.recordingComplete) {
          // Never persist or execute a truncated batch, even when some calls look complete.
          // A system fact keeps the original user task intact during context compaction.
          await session.add({ role: 'system', content: `Runtime feedback: model_length. The last response reached its output limit (reported output tokens: ${response.usage.completionTokens}). Its content and tool calls were discarded; none of those calls were executed. runtime_records can inspect this session's failure and usage. Continue the current task within the remaining budget and unchanged permissions.` });
          continue;
        }
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
        stage = 'runtime';
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
          const started = performance.now();
          stage = 'tool';
          const executed = await this.execute(call, controller.signal);
          const result = executed.result;
          const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
          const failure = executed.failure ?? toolFailure(record, controller.signal.aborted);
          await session.observe({ kind: 'tool', tool: tools.some(tool => tool.definition.function.name === call.function.name) ? call.function.name : 'unknown',
            durationMs: performance.now() - started, status: controller.signal.aborted || record.status === 'cancelled' ? 'cancelled' : record.status === 'timed_out' ? 'timed_out' : failure ? 'failed' : 'completed',
            ...(failure ? { failure } : {}),
            ...(typeof record.exit_code === 'number' || record.exit_code === null ? { exitCode: record.exit_code } : {}),
            ...(typeof record.truncated === 'boolean' ? { truncated: record.truncated } : {}) });
          await session.add({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
          emit({ type: 'tool_end', call, result, ...(failure ? { failure } : {}) });
          stage = 'runtime';
        }
        controller.signal.throwIfAborted();
        if (this.options.shouldYield?.()) {
          if (!session.runtime.recordingComplete) throw new Error('Cannot hand over with incomplete execution records');
          await session.end('yielded');
          return '';
        }
      }
    } catch (error) {
      const status = controller.signal.aborted ? 'cancelled' : 'failed';
      const message = error instanceof Error ? error.message : 'Agent request failed';
      const failure = executionFailure(error, stage, controller.signal.aborted);
      await session.end(status, message, failure);
      emit({ type: 'end', status, error: message, failure });
      throw error;
    } finally { this.controller = undefined; }
  }
  private async execute(call: ToolCall, signal: AbortSignal): Promise<{ result: unknown; failure?: ExecutionFailure }> {
    try {
      const tool = this.options.tools.find(tool => tool.definition.function.name === call.function.name);
      if (!tool) throw new Error(`Unknown tool: ${call.function.name}`);
      const args: unknown = JSON.parse(call.function.arguments);
      // Persist intent before any tool can create a side effect.
      await this.options.session.startTool(call.id);
      return { result: await tool.execute(args, { cwd: this.options.cwd, artifactDir: this.options.artifactDir, signal }) };
    } catch (error) {
      return { result: { status: signal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : 'Tool failed' }, failure: executionFailure(error, 'tool', signal.aborted) };
    }
  }
}
