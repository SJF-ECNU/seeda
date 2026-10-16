export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
}
export interface ModelResponse {
  message: Message;
  finishReason: string;
  usage?: Usage;
}
export interface Model {
  readonly maxOutputTokens?: number;
  complete(messages: Message[], tools: ToolDefinition[], signal: AbortSignal,
    onText?: (text: string) => void): Promise<ModelResponse>;
}
export interface ToolContext {
  cwd: string;
  artifactDir: string;
  signal: AbortSignal;
}
export interface Tool {
  definition: ToolDefinition;
  execute(args: unknown, context: ToolContext): Promise<unknown>;
}
export interface ExecutionFailure {
  stage: 'model' | 'tool' | 'runtime' | 'evaluation';
  reason: string;
  code?: string | number;
  summary: string;
}
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_end'; call: ToolCall; result: unknown; failure?: ExecutionFailure }
  | { type: 'feedback'; failure: ExecutionFailure }
  | { type: 'compacted' }
  | { type: 'usage'; usage: Usage; contextChars: number; maxContextChars: number; maxContextTokens?: number }
  | { type: 'retrying'; attempt: number; delayMs: number; error: string }
  | { type: 'end'; status: 'completed' | 'failed' | 'cancelled'; error?: string; failure?: ExecutionFailure };
