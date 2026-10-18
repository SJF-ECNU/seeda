import { readFile } from 'node:fs/promises';
import { loadInstructions } from './context.ts';
import type { Tool, ToolContext } from './types.ts';

export class SkillTool implements Tool {
  readonly definition = { type: 'function' as const, function: {
    name: 'read_skill',
    description: 'Read a discovered version or project skill using its exact Source path from the skill catalog. Reads on the Agent host independently of the Bash execution environment. Returns the skill text and its source; does not execute instructions or scripts.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  } };
  async execute(args: unknown, context: ToolContext): Promise<unknown> {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Skill arguments must be an object');
    const input = args as Record<string, unknown>;
    if (typeof input.path !== 'string' || Object.keys(input).some(key => key !== 'path')) throw new Error('An exact skill path is required');
    const instructions = await loadInstructions(context.cwd);
    const source = instructions.sources.find(source => source.path === input.path && source.loaded && (source.kind === 'self_skill' || source.kind === 'project_skill'));
    if (!source) throw new Error('Path is not a discovered skill');
    context.signal.throwIfAborted();
    return { source, content: await readFile(source.path, 'utf8') };
  }
}
