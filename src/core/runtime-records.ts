import type { Usage } from './types.ts';

export interface InstructionSource {
  kind: 'self_instructions' | 'self_memory' | 'project_rules' | 'project_skill';
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
  end(status: string, reason?: string, endedAt?: string): void {
    const run = this.runs.at(-1); if (!run) return;
    run.status = status; run.reason = reason; run.endedAt = endedAt;
    if (endedAt && run.startedAt) run.durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(run.startedAt));
  }
  recent(limit = 5): RuntimeRun[] { return structuredClone(this.runs.slice(-limit)); }
}
