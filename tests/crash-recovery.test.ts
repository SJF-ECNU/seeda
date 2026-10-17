import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VersionStore } from '../src/versions/store.ts';
import { Supervisor } from '../src/runtime/supervisor.ts';
import { Session } from '../src/core/session.ts';
import { sessionPath } from '../src/runtime/sessions.ts';
import type { Message } from '../src/core/types.ts';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test('crashed worker resumes its version, inspects logs and promotes a verified repair through real tools', { timeout: 180000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seeda-crash-repair-')));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const evidenceDirectory = resolve('.seeda/validation/crash-self-repair');
  await mkdir(evidenceDirectory, { recursive: true });
  const requests: { task: string; messages: Message[]; version: string | null }[] = [];
  const fixtureErrors: string[] = [];
  const evidence: Record<string, unknown> = { root, scope: 'deterministic local HTTP model; no provider calls or autonomous capability claim' };
  const store = await VersionStore.open(join(root, 'state'));
  let beforeResumeCalls = 0;
  const supervisor = new Supervisor(store, cwd, { kind: 'local' }, { beforeResume: () => { beforeResumeCalls++; } });
  let draft: { id: string; path: string };
  let candidate: { id: string; runtime_path: string };
  let evaluation: { evaluation: string; status: string; workspace: string };
  let records: { recoveries: { failedVersion: string; targetVersion: string; logPath: string }[] };
  let repeatedCrashes = 0;
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const messages = JSON.parse(body).messages as Message[];
      const task = messages.filter(message => message.role === 'user').at(-1)!.content!;
      requests.push({ task, messages, version: store.state().current_version });
      const last = messages.at(-1)!;
      const toolResult = () => JSON.parse(last.content!);
      const tool = (id: string, name: string, args: unknown) => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      let delta: { content?: string; tool_calls?: unknown[] };
      if (task === 'verify-repair') {
        assert.match(messages[0].content!, /RECOVERY_REPAIR_LOADED/);
        if (last.role !== 'tool') delta = tool('native-proof', 'bash', { command: 'printf verified > native-proof.txt' });
        else { assert.equal(toolResult().exit_code, 0); delta = { content: 'native repair verified' }; }
      } else if (task === 'after-repair') {
        assert.match(messages[0].content!, /RECOVERY_REPAIR_LOADED/);
        if (last.role === 'user') delta = tool('loaded-records', 'runtime_records', {});
        else if (last.tool_call_id === 'loaded-records') {
          const run = toolResult().runs.at(-1);
          assert.equal(run.implementationVersion, candidate.id);
          assert.ok(run.instructions.some((source: { kind: string; path: string; loaded: boolean }) => source.kind === 'self_instructions' && source.loaded && source.path === join(candidate.runtime_path, '.agents/self/INSTRUCTIONS.md')));
          delta = tool('after-proof', 'bash', { command: 'printf repaired > after-repair.txt' });
        } else { assert.equal(toolResult().exit_code, 0); delta = { content: 'repair is active' }; }
      } else if (task === 'repeated-crashes') {
        // Readiness alone must not reset the retry count: each restarted worker
        // reaches a model request and then dies again before task completion.
        if (repeatedCrashes < 3) {
          const row = store.db.prepare("SELECT pid FROM instances WHERE role='primary' AND ended_at IS NULL ORDER BY rowid DESC LIMIT 1").get()!;
          assert.ok(Number(row.pid) > 1);
          repeatedCrashes++;
          delta = tool(`repeat-crash-${repeatedCrashes}`, 'bash', { command: `printf crash >> repeated.txt; kill -KILL ${Number(row.pid)}; sleep 10` });
        } else delta = { content: 'fallback resumed original task' };
      } else {
        assert.equal(task, 'repair-crash');
        if (last.role === 'user') {
          const row = store.db.prepare("SELECT pid FROM instances WHERE role='primary' AND ended_at IS NULL ORDER BY rowid DESC LIMIT 1").get()!;
          assert.ok(Number(row.pid) > 1);
          delta = tool('crash-once', 'bash', { command: `printf once >> crash-count.txt; kill -KILL ${Number(row.pid)}; sleep 10` });
        } else if (last.role === 'system') {
          assert.match(last.content!, /Runtime recovery facts/);
          const interrupted = messages.find(message => message.tool_call_id === 'crash-once');
          assert.equal(JSON.parse(interrupted!.content!).status, 'unknown');
          delta = tool('read-recovery', 'runtime_records', {});
        } else if (last.tool_call_id === 'read-recovery') {
          records = toolResult(); assert.equal(records.recoveries.length, 1);
          assert.equal(records.recoveries[0].failedVersion, store.state().current_version);
          assert.equal(records.recoveries[0].targetVersion, store.state().current_version);
          delta = tool('inspect-log', 'bash', { command: `cat ${quote(records.recoveries[0].logPath)}; test "$(cat crash-count.txt)" = once && printf inspected > inspected.txt` });
        } else if (last.tool_call_id === 'inspect-log') {
          assert.equal(toolResult().exit_code, 0);
          delta = tool('repair-draft', 'management', { operation: 'draft' });
        } else if (last.tool_call_id === 'repair-draft') {
          draft = toolResult(); assert.ok(draft.id && draft.path);
          delta = tool('edit-repair', 'bash', { command: `printf '\nRECOVERY_REPAIR_LOADED: Inspect unknown tool outcomes before retrying; preserve the original request budget.\n' >> ${quote(join(draft.path, '.agents/self/INSTRUCTIONS.md'))}` });
        } else if (last.tool_call_id === 'edit-repair') {
          assert.equal(toolResult().exit_code, 0);
          delta = tool('submit-repair', 'management', { operation: 'submit', draft: draft.id, reason: 'retain recovery inspection discipline after actual worker crash' });
        } else if (last.tool_call_id === 'submit-repair') {
          candidate = toolResult(); assert.ok(candidate.id);
          delta = tool('evaluate-repair', 'management', { operation: 'evaluate', version: candidate.id, task: 'verify-repair', sandbox: 'process' });
        } else if (last.tool_call_id === 'evaluate-repair') {
          evaluation = toolResult(); assert.equal(evaluation.status, 'completed');
          assert.equal(await readFile(join(evaluation.workspace, 'native-proof.txt'), 'utf8'), 'verified');
          delta = tool('inspect-evidence', 'management', { operation: 'evidence', evaluation: evaluation.evaluation });
        } else if (last.tool_call_id === 'inspect-evidence') {
          assert.equal(toolResult().status, 'completed');
          delta = tool('promote-repair', 'management', { operation: 'promote', version: candidate.id, evaluation: evaluation.evaluation, reason: 'verified isolated artifact and repaired instruction loading', acceptReason: 'reviewed completed native evaluation, exit code and actual artifact' });
        } else {
          assert.equal(last.tool_call_id, 'promote-repair');
          assert.equal(toolResult().status, 'pending'); assert.equal(toolResult().acceptance, 'recorded');
          delta = { content: 'verified repair submitted for handoff' };
        }
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      fixtureErrors.push(error instanceof Error ? error.stack! : String(error));
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'fixture assertion failed; retained for inspection' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const saved = Object.fromEntries(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'SEEDA_SYSTEM_PROXY'].map(key => [key, process.env[key]]));
  process.env.DEEPSEEK_API_KEY = 'local-test'; process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${address.port}`; process.env.SEEDA_SYSTEM_PROXY = '0';
  t.after(async () => {
    await supervisor.close();
    Object.assign(evidence, { fixtureErrors, requests: requests.length, observedTokens: requests.length * 5, beforeResumeCalls,
      switches: store.db.prepare('SELECT * FROM switches ORDER BY rowid').all(), instances: store.db.prepare('SELECT * FROM instances ORDER BY rowid').all() });
    await writeFile(join(root, 'model-requests.json'), JSON.stringify(requests, null, 2));
    await writeFile(join(root, 'test-evidence.json'), JSON.stringify(evidence, null, 2));
    await writeFile(join(evidenceDirectory, 'test-evidence.json'), JSON.stringify(evidence, null, 2));
    store.close(); server.closeAllConnections(); server.close();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    // Retain the isolated version store, sessions, command artifacts and logs on
    // success and failure so the full path can be independently audited.
  });
  const initial = await store.initialize(resolve('.')); await supervisor.start();
  assert.equal(await supervisor.run('repair-crash', () => {}), 'verified repair submitted for handoff');
  assert.deepEqual(fixtureErrors, []);
  assert.equal(store.state().current_version, candidate!.id);
  assert.equal(store.state().previous_version, initial.id);
  assert.equal(store.evaluation(evaluation!.evaluation).decision, 'accept');
  assert.ok(store.db.prepare("SELECT id FROM switches WHERE to_version=? AND kind='quality' AND state='completed'").get(candidate!.id));
  assert.equal(await readFile(join(cwd, 'crash-count.txt'), 'utf8'), 'once', 'interrupted tool is never automatically replayed');
  assert.equal(await readFile(join(cwd, 'inspected.txt'), 'utf8'), 'inspected');
  assert.equal(await supervisor.run('after-repair', () => {}), 'repair is active');
  assert.equal(await readFile(join(cwd, 'after-repair.txt'), 'utf8'), 'repaired');
  const repairedSession = await Session.open(sessionPath(store.root, supervisor.sessionId()), cwd);
  assert.equal(repairedSession.messages.filter(message => message.role === 'user' && message.content === 'repair-crash').length, 1);
  assert.equal(repairedSession.recoveries.length, 1);
  assert.equal(repairedSession.recoveries[0].failedVersion, initial.id);
  assert.equal(repairedSession.recoveries[0].targetVersion, initial.id);
  const mainRequests = requests.filter(request => request.task !== 'verify-repair');
  assert.equal(repairedSession.runtime.recent(20).reduce((sum, run) => sum + (run.usage?.totalTokens ?? 0), 0), mainRequests.length * 5, 'reported model usage survives restarts');
  Object.assign(evidence, { repair: { initial: initial.id, candidate: candidate!.id, evaluation: evaluation!.evaluation, recoveries: repairedSession.recoveries, session: repairedSession.path, userMessages: repairedSession.messages.filter(message => message.role === 'user').length, nativeArtifact: join(evaluation!.workspace, 'native-proof.txt'), loadedArtifact: join(cwd, 'after-repair.txt') } });

  await supervisor.changeSession(undefined, true);
  assert.equal(await supervisor.run('repeated-crashes', () => {}), 'fallback resumed original task');
  assert.deepEqual(fixtureErrors, []);
  const repeated = await Session.open(sessionPath(store.root, supervisor.sessionId()), cwd);
  assert.deepEqual(repeated.recoveries.map(record => record.targetVersion), [candidate!.id, candidate!.id, initial.id]);
  assert.deepEqual(repeated.recoveries.map(record => record.attempt), [1, 2, 3]);
  assert.deepEqual(requests.filter(request => request.task === 'repeated-crashes').map(request => request.version), [candidate!.id, candidate!.id, candidate!.id, initial.id]);
  assert.equal(repeated.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(await readFile(join(cwd, 'repeated.txt'), 'utf8'), 'crashcrashcrash');
  assert.equal(store.state().current_version, initial.id);
  assert.ok(beforeResumeCalls >= 4, 'recovery checks the original owner budget on every attempt');
  Object.assign(evidence, { repeated: { recoveries: repeated.recoveries, session: repeated.path }, passed: true });
  t.diagnostic(JSON.stringify({ evidence: join(evidenceDirectory, 'test-evidence.json'), retainedRoot: root, requests: requests.length }));
});
