import type { ExecutionFailure, Usage } from './types.ts';

export interface InstructionSource {
  kind: 'self_instructions' | 'self_memory' | 'project_rules' | 'self_skill' | 'project_skill';
  path: string;
  loaded: boolean;
  characters: number;
}
export interface RuntimeObservation {
  kind: 'model' | 'tool';
  durationMs: number;
  status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  tool?: string;
  exitCode?: number | null;
  truncated?: boolean;
  finishReason?: string;
  usage?: Usage;
  failure?: ExecutionFailure;
}
export interface RuntimeRun {
  id: string;
  implementationVersion: string;
  instructions?: InstructionSource[];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  status: string;
  reason?: string;
  failure?: ExecutionFailure;
  measured: boolean;
  modelCalls: number;
  toolCalls: number;
  toolFailures: number;
  usage: Usage | null;
  modelCallsWithUsage: number;
  recentCalls: RuntimeObservation[];
}

export function failureReason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'cancelled';
    if (error.name === 'TimeoutError' || /timed out|timeout/i.test(error.message)) return 'timeout';
    if (error.message === 'Model did not complete normally (length)') return 'model_length';
    if (/Model did not complete normally/.test(error.message)) return 'model_finish';
    if (/network request failed/i.test(error.message)) return 'model_network';
    if (/^Model HTTP error (401|403)$/.test(error.message)) return 'authentication';
    if (/^Model HTTP error 429$/.test(error.message)) return 'rate_limit';
  }
  return 'execution_error';
}

export function executionFailure(error: unknown, stage: ExecutionFailure['stage'], cancelled = false): ExecutionFailure {
  let reason = cancelled ? 'cancelled' : failureReason(error);
  let code: string | number | undefined;
  let cause: unknown = error;
  for (let depth = 0; depth < 4 && cause && typeof cause === 'object'; depth++) {
    const record = cause as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string' && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EPIPE', 'ECANCELED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(record.code)) { code = record.code; break; }
    cause = record.cause;
  }
  const http = error instanceof Error ? error.message.match(/^Model HTTP error ([1-5][0-9]{2})$/) : undefined;
  if (http) { code = Number(http[1]); if (reason === 'execution_error') reason = 'model_http'; }
  if (reason === 'execution_error' && stage === 'model' && typeof code === 'string' && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) reason = 'model_network';
  if (reason === 'execution_error') reason = 'unknown';
  const descriptions: Record<string, string> = {
    cancelled: 'Execution was cancelled.', timeout: 'Execution timed out.', model_length: 'Model output reached its response limit.',
    model_finish: 'Model did not return a normal completion.', model_network: 'Model connection failed.',
    authentication: 'Model authentication or authorization failed.', rate_limit: 'Model request was rate limited.', model_http: 'Model returned an HTTP error.',
    unknown: 'Execution failed; the cause is unknown.',
  };
  return { stage, reason, ...(code !== undefined ? { code } : {}), summary: descriptions[reason] ?? descriptions.unknown };
}

export function toolFailure(record: Record<string, unknown>, cancelled = false): ExecutionFailure | undefined {
  if (cancelled || record.status === 'cancelled') return executionFailure(undefined, 'tool', true);
  if (record.status === 'timed_out') return { stage: 'tool', reason: 'timeout', summary: 'Tool execution timed out.' };
  if (typeof record.exit_code === 'number' && record.exit_code !== 0) return { stage: 'tool', reason: 'nonzero_exit', code: record.exit_code, summary: `Command exited with code ${record.exit_code}.` };
  if (['failed', 'unknown', 'not_executed'].includes(String(record.status))) {
    const failure = executionFailure({ code: record.error_code }, 'tool');
    return { ...failure, summary: failure.code ? 'Tool execution failed with an operating-system error.' : 'Tool execution failed; the cause is unknown.' };
  }
  return undefined;
}

export class RuntimeHistory {
  private runs: RuntimeRun[] = [];
  recordingComplete = true;
  request(id: string, implementationVersion: string, startedAt?: string, live = false): void {
    const prior = this.runs.at(-1);
    if (prior && ['running', 'unfinished'].includes(prior.status)) prior.status = 'interrupted';
    this.runs.push({ id, implementationVersion, startedAt, status: live ? 'running' : 'unfinished', measured: Boolean(startedAt), modelCalls: 0, toolCalls: 0, toolFailures: 0, usage: null, modelCallsWithUsage: 0, recentCalls: [] });
    this.runs = this.runs.slice(-20);
  }
  observe(observation: RuntimeObservation): void {
    const run = this.runs.at(-1); if (!run) return;
    if (observation.kind === 'model') {
      run.modelCalls++;
      if (observation.usage) {
        run.modelCallsWithUsage++;
        run.usage ??= { promptTokens: 0, completionTokens: 0, totalTokens: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0 };
        for (const key of Object.keys(run.usage) as (keyof Usage)[]) run.usage[key] += observation.usage[key];
      }
    } else {
      run.toolCalls++;
      if (observation.status !== 'completed') run.toolFailures++;
    }
    run.recentCalls.push(observation); run.recentCalls = run.recentCalls.slice(-20);
  }
  instructions(sources: InstructionSource[]): void {
    const run = this.runs.at(-1); if (run) run.instructions = structuredClone(sources);
  }
  end(status: string, reason?: string, endedAt?: string, failure?: ExecutionFailure): void {
    const run = this.runs.at(-1); if (!run) return;
    run.status = status; run.reason = reason; run.endedAt = endedAt;
    if (failure) run.failure = structuredClone(failure);
    if (endedAt && run.startedAt) run.durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(run.startedAt));
  }
  recent(limit = 5): RuntimeRun[] { return structuredClone(this.runs.slice(-limit)); }
}
