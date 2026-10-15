import { randomUUID } from 'node:crypto';
import { Agent, Session, DeepSeekModel, BashTool } from '../index.ts';
import { configureNetwork } from '../model/network.ts';
import type { ManagerMessage, WorkerMessage } from './protocol.ts';
import type { Tool } from '../core/types.ts';

const [cwd, sessionPath, artifactDir, role] = process.argv.slice(2);
const send = (message: WorkerMessage) => { if (process.connected) process.send?.(message); };
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const management: Tool = {
  definition: { type: 'function', function: { name: 'management', description: 'Manage self evolution. Operations: status; strains (list global strains); publish(name,introduction,optional version); introduction requires summary/improvements/scenarios/limitations/validation text, report actual verification or explicitly unverified to retain a saved implementation for other projects; draft; submit(draft,reason); evaluate(version,task,sandbox process/container); evidence(evaluation); decide(evaluation,decision accept/reject,reason); promote(version,evaluation,reason); rollback(reason). Edit only the returned draft directory with Bash. For grafting, use Bash Git diff between saved strain commits and apply it only in the returned draft; resolve conflicts there, submit with source provenance in reason, then evaluate, inspect evidence and decide before promote. All evaluations require a sandbox: choose process for local checks with Bash, tests and available tools; choose container for a separate Linux environment or independent dependencies (candidate source: /candidate). Omitted sandbox defaults to process. No unsandboxed fallback; an unavailable backend fails. Candidate verification uses its own workspace. Promotion waits for the current request to finish.', parameters: { type: 'object', properties: { operation: { type: 'string' }, name: { type: 'string' }, introduction: { type: 'object', properties: Object.fromEntries(['summary','improvements','scenarios','limitations','validation'].map(name => [name, { type: 'string' }])), required: ['summary','improvements','scenarios','limitations','validation'], additionalProperties: false }, draft: { type: 'string' }, version: { type: 'string' }, task: { type: 'string' }, sandbox: { type: 'string', enum: ['process', 'container'] }, evaluation: { type: 'string' }, decision: { type: 'string' }, reason: { type: 'string' } }, required: ['operation'], additionalProperties: false } } },
  execute(args, context) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Management arguments must be an object');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => { pending.delete(id); reject(new Error('Management operation cancelled')); };
      context.signal.addEventListener('abort', abort, { once: true });
      pending.set(id, { resolve: value => { context.signal.removeEventListener('abort', abort); resolve(value); }, reject: error => { context.signal.removeEventListener('abort', abort); reject(error); } });
      send({ type: 'management', id, args: args as Record<string, unknown> });
    });
  },
};
await configureNetwork();
const session = await Session.open(sessionPath, cwd);
const bash = new BashTool(16_384, (pid, started) => send({ type: 'process', pid, started }));
const agent = new Agent({ cwd, session, artifactDir, model: new DeepSeekModel({ apiKey: process.env.DEEPSEEK_API_KEY ?? '', baseUrl: process.env.DEEPSEEK_BASE_URL, model: process.env.DEEPSEEK_MODEL, thinking: process.env.SEEDA_THINKING === '1', retry: { onRetry: info => send({ type: 'event', event: { type: 'retrying', attempt: info.attempt, delayMs: info.delayMs, error: info.error.message } }) } }), tools: role === 'primary' ? [bash, management] : [bash], onEvent: event => send({ type: 'event', event }) });
let active: Promise<void> | undefined;
const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 1000);
const stop = () => {
  clearInterval(heartbeat); agent.cancel();
  for (const request of pending.values()) request.reject(new Error('Supervisor disconnected')); pending.clear();
  const timer = setTimeout(() => process.exit(0), 2000); timer.unref();
  void (active ?? Promise.resolve()).finally(() => process.exit(0));
};
process.on('disconnect', stop); process.on('SIGTERM', stop);
process.on('message', (message: ManagerMessage) => {
  if (message.type === 'stop') stop();
  else if (message.type === 'cancel') agent.cancel();
  else if (message.type === 'management_result') {
    const request = pending.get(message.id); pending.delete(message.id);
    if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.result);
  } else if (message.type === 'run' || message.type === 'compact') {
    if (active) { send({ type: 'result', error: 'Worker is busy' }); return; }
    active = (message.type === 'compact' ? agent.compact() : agent.run(message.input)).then(answer => send({ type: 'result', answer }), error => send({ type: 'result', error: error instanceof Error ? error.message : 'Request failed' })).finally(() => { active = undefined; });
  }
});
send({ type: 'ready', messages: session.messages, compact: true });
