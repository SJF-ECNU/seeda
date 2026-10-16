import type { Tool, ToolContext } from '../core/types.ts';
import { localCommand, type CommandInput, type CommandExecutor } from './command.ts';

export class BashTool implements Tool {
  readonly definition = {
    type: 'function' as const,
    function: {
      name: 'bash', description: 'Run a non-interactive Bash command. Each call has a fresh shell; cwd defaults to the project directory.',
      parameters: { type: 'object', properties: {
        command: { type: 'string' }, cwd: { type: 'string' }, timeout: { type: 'number', description: 'Seconds, default 30' },
      }, required: ['command'], additionalProperties: false },
    },
  };
  private readonly executor: CommandExecutor;
  constructor(maxOutputBytes = 16_384, onProcess?: (pid: number, started: boolean) => void, executor?: CommandExecutor) {
    this.executor = executor ?? localCommand(maxOutputBytes, onProcess);
  }
  async execute(args: unknown, context: ToolContext): Promise<unknown> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Bash parameters must be an object');
    const input = args as Record<string, unknown>;
    if (Object.keys(input).some(key => !['command', 'cwd', 'timeout'].includes(key)) ||
      typeof input.command !== 'string' || !input.command.trim() ||
      (input.cwd !== undefined && typeof input.cwd !== 'string') ||
      (input.timeout !== undefined && (typeof input.timeout !== 'number' || !Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > 3600))) {
      throw new Error('Invalid Bash parameters');
    }
    return this.executor(input as unknown as CommandInput, context);
  }
}
