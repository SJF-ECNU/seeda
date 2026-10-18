import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { VersionStore } from '../src/versions/store.ts';
import { Supervisor } from '../src/runtime/supervisor.ts';
import type { AgentEvent } from '../src/core/types.ts';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

type Mode = 'accept' | 'reject' | 'failed-evaluation' | 'startup-failure' | 'cancel' | 'ordinary' | 'crash-after' | 'cancel-startup';

// Local model responses drive the public tools; no management operation is called by the test.
// A real candidate process verifies executable BashTool code in the existing process sandbox.
async function exercise(t: any, mode: Mode) {
  const evidenceRoot = process.env.SEEDA_TEST_EVIDENCE_DIR;
  if (evidenceRoot) await mkdir(evidenceRoot, { recursive: true });
  const root = await realpath(await mkdtemp('/tmp/seeda-unified-'));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const store = await VersionStore.open(join(root, 'state'));
  const initial = await store.initialize(resolve('.'));
  let supervisor: Supervisor;
  let draft: any, version: any, evaluation: any;
  let phase = 0, requests = 0;
  let cancellation: ReturnType<typeof setInterval> | undefined;
  const errors: unknown[] = [], events: AgentEvent[] = [];
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const messages = JSON.parse(body).messages; requests++;
      const user = messages.filter((m: any) => m.role === 'user').at(-1)?.content;
      const tools = messages.filter((m: any) => m.role === 'tool');
      const result = tools.length ? JSON.parse(tools.at(-1).content) : undefined;
      let calls: { name: string; args: unknown }[] = [], answer = '';
      const call = (name: string, args: unknown) => { calls.push({ name, args }); };
      if (user === 'verify changed executable') {
        if (mode === 'failed-evaluation') { res.statusCode = 401; res.end('injected candidate model failure'); return; }
        if (!tools.length) call('bash', { command: 'printf candidate > isolated.txt' });
        else { assert.equal(result.exit_code, 0); assert.equal(result.implementation, 'candidate-code'); answer = 'verified executable candidate'; }
      } else {
        phase++;
        if (phase === 1) call('bash', { command: 'printf before > task.txt' });
        else if (mode === 'ordinary') answer = 'ordinary task complete';
        else if (phase === 2) call('management', { operation: 'draft' });
        else if (phase === 3) {
          draft = result;
          const script = `const fs=require('fs');const p=${JSON.stringify(join(draft.path, 'src/tools/bash.ts'))};let s=fs.readFileSync(p,'utf8');const old='return this.executor(input as unknown as CommandInput, context);';if(!s.includes(old))throw Error('fixture source changed');s=s.replace(old,"return { ...(await this.executor(input as unknown as CommandInput, context) as object), implementation: 'candidate-code' };");fs.writeFileSync(p,s);`;
          call('bash', { command: `node -e ${quote(script)}` });
          if (mode === 'crash-after') {
            const crash = `const fs=require('fs');const p=${JSON.stringify(join(draft.path, 'src/tools/bash.ts'))};let s=fs.readFileSync(p,'utf8');s=s.replace('const input = args as Record<string, unknown>;', \"const input = args as Record<string, unknown>; if (input.command === 'crash before work') process.exit(31);\");fs.writeFileSync(p,s);`;
            call('bash', { command: `node -e ${quote(crash)}` });
          }
          if (mode === 'startup-failure' || mode === 'cancel-startup') {
            const worker = join(draft.path, 'src/runtime/worker.ts');
            const injected = mode === 'startup-failure' ? "if (process.argv[5] === 'primary') process.exit(29);\n" : "if (process.argv[5] === 'primary') await new Promise(resolve => setTimeout(resolve, 2000));\n";
            const fault = `const fs=require('fs');const p=${JSON.stringify(worker)};fs.writeFileSync(p,${JSON.stringify(injected)}+fs.readFileSync(p,'utf8'));`;
            call('bash', { command: `node -e ${quote(fault)}` });
          }
        } else if (phase === 4) { assert.equal(result.exit_code, 0); call('management', { operation: 'submit', draft: draft.id, reason: 'Expose executable tool implementation provenance' }); }
        else if (phase === 5) { version = result; call('management', { operation: 'evaluate', version: version.id, task: 'verify changed executable', sandbox: 'process' }); }
        else if (phase === 6) {
          evaluation = result;
          assert.equal(result.status, mode === 'failed-evaluation' ? 'failed' : 'completed');
          call('management', { operation: 'decide', evaluation: evaluation.evaluation, decision: ['reject', 'failed-evaluation'].includes(mode) ? 'reject' : 'accept', reason: 'Use the actual isolated evaluation result' });
        } else if (phase === 7) {
          if (['reject', 'failed-evaluation'].includes(mode)) call('bash', { command: 'printf continued >> task.txt' });
          else {
            call('management', { operation: 'promote', version: version.id, evaluation: evaluation.evaluation, reason: 'Continue the original task with verified executable code' });
            call('bash', { command: mode === 'cancel' ? 'sleep 5; printf boundary >> task.txt' : 'printf boundary >> task.txt' });
          }
        } else if (phase === 8) {
          if (['reject', 'failed-evaluation'].includes(mode)) answer = 'continued without adoption';
          else call('bash', { command: mode === 'crash-after' ? 'crash before work' : 'printf after >> task.txt; cat task.txt' });
        } else if (mode === 'crash-after' && phase === 9) {
          assert.equal(result.status, 'unknown');
          call('bash', { command: 'printf after >> task.txt; cat task.txt' });
        } else {
          assert.equal(result.exit_code, 0);
          assert.equal(result.implementation, mode === 'startup-failure' ? undefined : 'candidate-code');
          answer = 'original task complete';
        }
      }
      const delta = calls.length ? { tool_calls: calls.map((c, index) => ({ index, id: `call-${requests}-${index}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : { content: answer };
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { errors.push(error); res.statusCode = 400; res.end('fixture assertion failed'); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const before = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL, SEEDA_SYSTEM_PROXY: process.env.SEEDA_SYSTEM_PROXY };
  Object.assign(process.env, { DEEPSEEK_API_KEY: 'local-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`, SEEDA_SYSTEM_PROXY: '0' });
  supervisor = new Supervisor(store, cwd);
  t.after(async () => { clearInterval(cancellation); await supervisor.close(); store.close(); server.closeAllConnections(); server.close(); if (evidenceRoot) { const evidence = { mode, root, initial: initial.id, candidate: version?.id, requests, errors: errors.map(String), events }; await writeFile(join(root, 'test-evidence.json'), JSON.stringify(evidence, null, 2)); await writeFile(join(resolve(evidenceRoot), `${mode}-${root.split('/').at(-1)}.json`), JSON.stringify(evidence, null, 2)); } else await rm(root, { recursive: true, force: true }); for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  await supervisor.start();
  const running = supervisor.run('Finish this project and improve your tools if useful', event => {
    events.push(event);
    if (mode === 'cancel-startup' && event.type === 'tool_end' && event.call.function.name === 'management' && JSON.parse(event.call.function.arguments).operation === 'promote') {
      cancellation = setInterval(() => {
        if (store.db.prepare("SELECT id FROM instances WHERE version_id=? AND role='primary' AND state='starting'").get(version.id)) { clearInterval(cancellation); supervisor.cancel(); }
      }, 5);
    }
    if (mode === 'cancel' && event.type === 'tool_end' && event.call.function.name === 'management' && JSON.parse(event.call.function.arguments).operation === 'promote') supervisor.cancel();
  });
  if (mode === 'cancel' || mode === 'cancel-startup') await assert.rejects(running, /cancel|abort/i);
  else assert.match(await running, /complete|without adoption/);
  assert.deepEqual(errors, []);
  const records = (await readFile(join(store.root, 'sessions/main.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.filter(r => r.type === 'message' && r.message.role === 'user').length, 1, 'one request and conversation across replacement');
  assert.equal(events.filter(e => e.type === 'end').length, 1, 'no intermediate terminal event');
  const output = await readFile(join(cwd, 'task.txt'), 'utf8');
  assert.equal(output, mode === 'cancel-startup' ? 'beforeboundary' : mode === 'ordinary' || mode === 'cancel' ? 'before' : ['reject', 'failed-evaluation'].includes(mode) ? 'beforecontinued' : 'beforeboundaryafter');
  assert.equal(store.state().current_version, ['accept', 'crash-after'].includes(mode) ? version.id : initial.id);
  assert.equal(store.state().switch_target, null);
  if (['accept', 'crash-after'].includes(mode)) {
    assert.equal(store.db.prepare("SELECT count(*) n FROM switches WHERE state='completed' AND kind != 'fault'").get()!.n, 1);
    const post = events.filter(e => e.type === 'tool_end' && e.call.function.name === 'bash').at(-1) as any;
    assert.equal(post.result.implementation, 'candidate-code');
    const boundary = events.find(e => e.type === 'tool_end' && e.call.function.arguments.includes('printf boundary')) as any;
    assert.equal(boundary.result.implementation, undefined, 'whole original batch drains before switching');
    await assert.rejects(readFile(join(cwd, 'isolated.txt')), /ENOENT/);
  }
  if (mode === 'startup-failure') {
    assert.equal(store.db.prepare("SELECT count(*) n FROM instances WHERE version_id=? AND role='primary'").get(version.id)!.n, 3);
    assert.equal(store.db.prepare("SELECT count(*) n FROM switches WHERE state='failed'").get()!.n, 1);
  }
  if (mode === 'cancel-startup') assert.equal(store.db.prepare("SELECT count(*) n FROM instances WHERE version_id=? AND role='primary'").get(version.id)!.n, 1);
  if (mode === 'cancel') assert.equal(store.db.prepare("SELECT count(*) n FROM instances WHERE version_id=? AND role='primary'").get(version.id)!.n, 0);
}

for (const mode of ['accept', 'reject', 'failed-evaluation', 'startup-failure', 'cancel', 'ordinary', 'crash-after', 'cancel-startup'] as const) {
  test(`one task work and self evolution: ${mode}`, { timeout: 90000 }, t => exercise(t, mode));
}
