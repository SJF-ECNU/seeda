import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from '../core/session.ts';
import type { Tool } from '../core/types.ts';

export class RuntimeRecordsTool implements Tool {
  readonly definition = { type: 'function' as const, function: {
    name: 'runtime_records',
    description: 'Read your own current-session runtime facts: recent task endings, model requests and reported token usage, tool failures and durations, implementation directory and available tools. Read-only; no commands, outputs, credentials or diagnosis. Missing old measurements are unknown. Model calls count the Agent interface, not provider-internal retries.',
    parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Recent tasks, default 5; each includes at most 20 recent calls.' } }, additionalProperties: false },
  } };
  private session: Session;
  private names: string[];
  constructor(session: Session, names: string[]) { this.session = session; this.names = names; }
  async execute(args: unknown): Promise<unknown> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Runtime record arguments must be an object');
    const input = args as Record<string, unknown>;
    if (Object.keys(input).some(key => key !== 'limit') || (input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 20))) throw new Error('Invalid runtime record limit');
    return {
      scope: 'current_session', implementationDirectory: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
      tools: [...this.names, 'runtime_records'], recordingComplete: this.session.runtime.recordingComplete,
      runs: this.session.runtime.recent(Number(input.limit ?? 5)).map(run => run.measured ? run : { ...run, modelCalls: null, toolCalls: null, toolFailures: null, modelCallsWithUsage: null }),
      notes: ['measured=false means old records lack counters and timings; zero is not evidence of no activity', 'usage counts only model calls that returned usage; failed requests can have unknown consumption', 'provider-internal retries and abrupt process-exit causes are not measured', 'interrupted/unfinished means no persisted task ending, not a diagnosed cause'],
    };
  }
}
