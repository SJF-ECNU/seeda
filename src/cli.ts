#!/usr/bin/env -S node --use-env-proxy --experimental-strip-types
// Composition root: select presentation without moving execution into the frontend.
import { createInterface } from 'node:readline/promises';
import { parseArgs, slashCommand, help } from './cli-arguments.ts';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runtimeRoot } from './runtime/paths.ts';
import { projectDirectory } from './runtime/paths.ts';
import { resolve, join } from 'node:path';
import { Agent, Session, DeepSeekModel, BashTool } from './index.ts';
import { TuiState } from './tui/state.ts';
import { runTerminal } from './tui/terminal.ts';
import { configureNetwork } from './model/network.ts';
import { connectRuntime } from './runtime/bootstrap.ts';
import type { AgentEvent, Message } from './core/types.ts';

let parsed: ReturnType<typeof parseArgs>;
try { parsed = parseArgs(process.argv.slice(2)); }
catch (error) { console.error(error instanceof Error ? error.message : '参数错误'); process.exit(2); }
if (parsed.kind === 'help') { console.log(help); process.exit(0); }
if (parsed.kind === 'version') { console.log(`seeda ${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}`); process.exit(0); }
if (parsed.kind === 'exit') process.exit(0);
if (parsed.kind === 'manage') {
  process.argv.splice(2, process.argv.length - 2, ...parsed.args!);
  await import('./runtime/cli.ts'); process.exit(process.exitCode ?? 0);
}
if (process.env.SEEDA_MANAGED !== '0' && process.argv.length === 2 && process.stdin.isTTY && process.stdout.isTTY) {
  const database = join(runtimeRoot(process.cwd()), 'state.db');
  let seeded = false;
  if (existsSync(database)) { const db = new DatabaseSync(database, { readOnly: true }); try { seeded = Boolean(db.prepare('SELECT current_version FROM runtime_state WHERE id=1').get()?.current_version); } finally { db.close(); } }
  if (!seeded) { process.argv.push('seed'); await import('./runtime/cli.ts'); process.argv.pop(); if (process.exitCode === 130) process.exit(130); }
}
await configureNetwork();

const cwd = process.env.SEEDA_MANAGED === '0' ? process.cwd() : projectDirectory(process.cwd());
const path = resolve(process.env.SEEDA_SESSION ?? join(cwd, '.seeda', 'session.jsonl'));
const client = process.env.SEEDA_MANAGED === '0' ? undefined : await connectRuntime(cwd);
const session = client ? undefined : await Session.open(path, cwd);
const selected = client ? await client.request('session', { cwd }).catch(error => {
  client.close();
  if (error instanceof Error && error.message === 'Unknown operation') throw new Error('旧守护不支持会话管理，请执行 npm run manage -- stop 后重新 npm start；Agent 版本升级见运行指南');
  throw error;
}) as { id: string; messages: Message[] } : undefined;
if (client) client.sessionId = selected!.id;
const history = selected?.messages ?? session!.messages;
const model = client ? undefined : new DeepSeekModel({ apiKey: process.env.DEEPSEEK_API_KEY ?? '',
  baseUrl: process.env.DEEPSEEK_BASE_URL, model: process.env.DEEPSEEK_MODEL,
  thinking: process.env.SEEDA_THINKING === '1' });
const prompt = parsed.prompt ?? '';
const interactive = !prompt && Boolean(process.stdin.isTTY && process.stdout.isTTY);
let refresh = () => {};
const view = interactive ? new TuiState(history, () => refresh()) : undefined;
if (view) view.managed = Boolean(client);
const onEvent = (event: AgentEvent) => {
  if (view) { view.event(event); return; }
  if (event.type === 'text') process.stdout.write(event.text);
  if (event.type === 'tool_start') process.stdout.write(`\n[tool: ${event.call.function.name}]\n`);
  if (event.type === 'tool_end') process.stdout.write(`${JSON.stringify(event.result)}\n`);
  if (event.type === 'compacted') process.stdout.write('\n[context compacted]\n');
};
if (client) client.onSession = selected => { view?.loadHistory(selected.messages, selected.id); if (!view) process.stdout.write(`\n[session ${selected.id}]\n`); };
if (view && selected) view.sessionId = selected.id;
const agent = client ? { async run(input: string) {
  if (parsed.kind !== 'task' && input.trim().startsWith('/')) input = slashCommand(input);
  if (parsed.kind !== 'task' && (input === '/new' || input === '/sessions' || input === '/compact' || /^\/resume(?:\s|$)/.test(input))) {
    let ended = false;
    try {
      let answer: string;
      if (input === '/compact') answer = await client.request('compact', { session: client.sessionId }, event => { if (event.type === 'end') ended = true; onEvent(event); }) as string;
      else if (input === '/sessions') {
        const list = await client.request('sessions') as { current: string; sessions: { id: string; title: string; updated: string }[] };
        answer = list.sessions.map(row => `${row.id === list.current ? '* ' : '  '}${row.id}  ${row.title}  ${row.updated}`).join('\n');
      } else {
        const id = input.slice(7).trim();
        if (input !== '/new' && !id) throw new Error('用法：/resume <session id>，先用 /sessions 查看');
        const selected = await client.request(input === '/new' ? 'new' : 'resume', { id }) as { id: string };
        answer = `当前会话：${selected.id}`;
      }
      onEvent({ type: 'text', text: answer }); onEvent({ type: 'end', status: 'completed' }); return answer;
    } catch (error) { if (!ended) onEvent({ type: 'end', status: 'failed', error: error instanceof Error ? error.message : 'Session operation failed' }); throw error; }
  }
  if (parsed.kind !== 'task' && (input === '/versions' || input === '/rollback' || input.startsWith('/use '))) {
    try {
      const status = await client.request('manage', { operation: 'status' }) as { current_version: string; previous_version: string | null; versions: { id: string; reason: string }[] };
      let answer: string;
      if (input === '/versions') answer = status.versions.map(version => `${version.id === status.current_version ? '* ' : '  '}${version.id} ${version.reason}`).join('\n');
      else {
        const target = input === '/rollback' ? status.previous_version : input.slice(5).trim();
        if (!target) throw new Error('No previous version');
        answer = JSON.stringify(await client.request('select', { version: target }));
      }
      onEvent({ type: 'text', text: answer }); onEvent({ type: 'end', status: 'completed' }); return answer;
    } catch (error) { onEvent({ type: 'end', status: 'failed', error: error instanceof Error ? error.message : 'Version selection failed' }); throw error; }
  }
  return client.run(input, onEvent);
}, cancel: () => client.cancel() }
  : (() => { const core = new Agent({ cwd, session: session!, model: model!, tools: [new BashTool()], artifactDir: join(cwd, '.seeda', 'outputs'), onEvent }); return { run(input: string) { if (parsed.kind !== 'task' && input.trim().startsWith('/')) throw new Error('直接模式不支持该控制命令'); return core.run(input); }, cancel: () => core.cancel() }; })();
try {

if (view) {
  view.bind(agent);
  const terminal = runTerminal(view, { title: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash' });
  refresh = terminal.refresh;
  await terminal.done;
} else {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let running = false;
  terminal.on('SIGINT', () => { if (running) agent.cancel(); else terminal.close(); });
  try {
    if (prompt) {
      running = true;
      await agent.run(prompt);
      process.stdout.write('\n');
    } else {
      process.stdout.write('seeda core driver. /exit to quit; Ctrl+C cancels the current request.\n');
      process.stdout.write('\n> ');
    for await (const input of terminal) {
      if (input.trim() === '/exit') break;
      if (!input.trim()) continue;
      running = true;
      try { await agent.run(input); }
      catch (error) { process.stderr.write(`\n${error instanceof Error ? error.message : 'Request failed'}\n`); }
      finally { running = false; }
      process.stdout.write('\n> ');
    }
  }
  } finally { terminal.close(); }
}

} finally { client?.close(); }
