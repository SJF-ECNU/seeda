import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VersionStore, type Version } from '../src/versions/store.ts';
import { Supervisor } from '../src/runtime/supervisor.ts';
import { RuntimeClient } from '../src/runtime/client.ts';

test('native evolution preserves explicit acceptance while reducing management round trips and bounding evidence', { timeout: 120000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seeda-evolution-')));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const messages = JSON.parse(body).messages;
    const task = messages.filter((m: { role: string }) => m.role === 'user').at(-1).content;
    requests.push(task);
    if (task === 'slow-candidate') await new Promise(resolve => setTimeout(resolve, 350));
    const toolDone = messages.at(-1).role === 'tool';
    const withTool = task.startsWith('verify-') && !toolDone;
    const delta = withTool ? { tool_calls: [{ index: 0, id: `check-${requests.length}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'printf isolated > verification.txt' }) } }] } : { content: task.startsWith('verify-') ? 'x'.repeat(8000) : 'done' };
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: task === 'truncated-candidate' ? 'length' : withTool ? 'tool_calls' : 'stop' }], ...(task === 'missing-usage' ? {} : { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 2 } }) })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const saved = Object.fromEntries(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'SEEDA_SYSTEM_PROXY'].map(key => [key, process.env[key]]));
  process.env.DEEPSEEK_API_KEY = 'local-test'; process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${address.port}`; process.env.SEEDA_SYSTEM_PROXY = '0';
  const store = await VersionStore.open(join(root, 'state'));
  let supervisor = new Supervisor(store, cwd);
  let client: RuntimeClient | undefined;
  t.after(async () => {
    client?.close(); await supervisor.close(); store.close(); server.closeAllConnections(); server.close();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  const initial = await store.initialize(resolve('.')); await supervisor.start();
  client = await RuntimeClient.connect(supervisor.socketPath);
  type Evaluation = { evaluation: string; status: string; answer: string; answer_truncated: boolean; source_version: string; candidate_version: string; workspace: string; summary: { model_calls: number; tool_calls: number; usage: { totalTokens: number }; missing_usage: number; recording_complete: boolean } };
  const counts: Record<string, { calls: number; bytes: number; milliseconds: number }> = {};
  async function call(flow: string, args: Record<string, unknown>): Promise<any> {
    const start = performance.now(); const result = await supervisor.manage(args);
    const metrics = counts[flow] ??= { calls: 0, bytes: 0, milliseconds: 0 };
    metrics.calls++; metrics.bytes += Buffer.byteLength(JSON.stringify(result)); metrics.milliseconds += performance.now() - start;
    return result;
  }
  async function candidate(flow: string, marker: string): Promise<Version> {
    const draft = await call(flow, { operation: 'draft' });
    assert.equal(draft.source_version, store.state().current_version);
    assert.equal(draft.source_commit, store.version(draft.source_version).git_commit);
    await writeFile(join(draft.path, 'src/evolution-marker.ts'), `export const marker = '${marker}';\n`);
    const version = await call(flow, { operation: 'submit', draft: draft.id, reason: marker });
    assert.equal(version.draft, draft.id); assert.equal(version.source_version, draft.source_version);
    return version;
  }
  await call('old', { operation: 'status' });
  const old = await candidate('old', 'old');
  const oldEvaluation = await call('old', { operation: 'evaluate', version: old.id, task: 'verify-old', sandbox: 'process' }) as Evaluation;
  assert.equal(oldEvaluation.status, 'completed'); assert.equal(oldEvaluation.answer.length, 4000); assert.equal(oldEvaluation.answer_truncated, true);
  assert.equal(oldEvaluation.source_version, initial.id); assert.equal(oldEvaluation.candidate_version, old.id);
  assert.equal(oldEvaluation.summary.model_calls, 2); assert.equal(oldEvaluation.summary.tool_calls, 1);
  assert.equal(oldEvaluation.summary.usage.totalTokens, 10); assert.equal(oldEvaluation.summary.missing_usage, 0); assert.equal(oldEvaluation.summary.recording_complete, true);
  assert.equal(await readFile(join(oldEvaluation.workspace, 'verification.txt'), 'utf8'), 'isolated');
  await assert.rejects(readFile(join(cwd, 'verification.txt')));
  const full = await call('old', { operation: 'evidence', evaluation: oldEvaluation.evaluation });
  assert.equal(full.answer.length, 8000); assert.ok(full.events.length > 0);
  await assert.rejects(supervisor.manage({ operation: 'promote', version: old.id, evaluation: oldEvaluation.evaluation, reason: 'no automatic acceptance' }), /acceptance/);
  assert.equal(store.evaluation(oldEvaluation.evaluation).decision, null);
  await call('old', { operation: 'decide', evaluation: oldEvaluation.evaluation, decision: 'accept', reason: 'reviewed evidence' });
  await call('old', { operation: 'promote', version: old.id, evaluation: oldEvaluation.evaluation, reason: 'old verified flow' });
  assert.equal(store.state().current_version, old.id); assert.equal(counts.old.calls, 7);

  const merged = await candidate('merged', 'merged');
  const evaluation = await call('merged', { operation: 'evaluate', version: merged.id, task: 'verify-merged', sandbox: 'process' }) as Evaluation;
  assert.equal(evaluation.status, 'completed');
  for (const change of [{ version: old.id, acceptReason: 'wrong candidate' }, { acceptReason: '' }, { acceptReason: 4 }, { reason: '' }]) {
    await assert.rejects(supervisor.manage({ operation: 'promote', version: merged.id, evaluation: evaluation.evaluation, reason: 'verified', acceptReason: 'explicit evidence review', ...change }));
    assert.equal(store.evaluation(evaluation.evaluation).decision, null);
  }
  await assert.rejects(supervisor.manage({ operation: 'promote', version: merged.id, evaluation: evaluation.evaluation, reason: 'stale', acceptReason: 'stale' }, initial.id), /Stale/);
  const failed = await supervisor.manage({ operation: 'evaluate', version: merged.id, task: 'truncated-candidate', sandbox: 'process' }) as Evaluation;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.summary.model_calls, 1); assert.equal(failed.summary.usage.totalTokens, 5);
  await assert.rejects(supervisor.manage({ operation: 'promote', version: merged.id, evaluation: failed.evaluation, reason: 'must fail', acceptReason: 'cannot accept incomplete' }), /acceptance/);
  assert.equal(store.evaluation(failed.evaluation).decision, null);
  const slowEvaluation = supervisor.manage({ operation: 'evaluate', version: merged.id, task: 'slow-candidate', sandbox: 'process' });
  await assert.rejects(supervisor.manage({ operation: 'promote', version: merged.id, evaluation: evaluation.evaluation, reason: 'busy', acceptReason: 'must not accept while busy' }), /busy/);
  assert.equal(store.evaluation(evaluation.evaluation).decision, null); await slowEvaluation;
  const missingUsage = await supervisor.manage({ operation: 'evaluate', version: merged.id, task: 'missing-usage', sandbox: 'process' }) as Evaluation;
  assert.equal(missingUsage.summary.model_calls, 1); assert.equal(missingUsage.summary.missing_usage, 1); assert.equal(missingUsage.summary.usage, null);
  const requestsBeforeRestart = requests.length;
  client.close(); await supervisor.close();
  supervisor = new Supervisor(store, cwd); await supervisor.start();
  client = await RuntimeClient.connect(supervisor.socketPath);
  assert.equal(store.evaluation(evaluation.evaluation).status, 'completed');
  assert.equal(store.evaluation(evaluation.evaluation).decision, null);
  assert.equal(requests.length, requestsBeforeRestart, 'restart must not rerun candidate evaluation');
  const running = supervisor.run('verify-promotion-drain', () => {});
  const selection = await call('merged', { operation: 'promote', version: merged.id, evaluation: evaluation.evaluation, reason: 'verified merged flow', acceptReason: 'two model calls and isolated artifact reviewed' });
  assert.equal(selection.status, 'pending'); assert.equal(selection.acceptance, 'recorded');
  assert.equal(store.state().current_version, old.id);
  await assert.rejects(supervisor.manage({ operation: 'promote', version: merged.id, evaluation: evaluation.evaluation, reason: 'duplicate pending', acceptReason: 'must not queue again' }), /busy/);
  await running; assert.equal(store.state().current_version, merged.id); assert.equal(counts.merged.calls, 4);
  assert.ok(counts.merged.bytes < counts.old.bytes);
  assert.equal(store.evaluation(evaluation.evaluation).reason, 'two model calls and isolated artifact reviewed');
  t.diagnostic(JSON.stringify({ deterministic_local_model_management_cost: counts, scope: 'local simulation, not real model cost or quality' }));

  const brokenDraft = await supervisor.manage({ operation: 'draft' }) as { id: string; path: string };
  const worker = join(brokenDraft.path, 'src/runtime/worker.ts');
  await writeFile(worker, "if (process.argv.at(-1) === 'primary') process.exit(7);\n" + await readFile(worker, 'utf8'));
  const broken = await supervisor.manage({ operation: 'submit', draft: brokenDraft.id, reason: 'exercise primary startup failure after successful isolated evaluation' }) as Version;
  const brokenEvaluation = await supervisor.manage({ operation: 'evaluate', version: broken.id, task: 'candidate startup succeeds', sandbox: 'process' }) as Evaluation;
  assert.equal(brokenEvaluation.status, 'completed');
  const rejectedSwitch = await supervisor.manage({ operation: 'promote', version: broken.id, evaluation: brokenEvaluation.evaluation, reason: 'exercise switch recovery', acceptReason: 'candidate completed, primary may fail' }) as { status: string; acceptance: string };
  assert.equal(rejectedSwitch.status, 'failed'); assert.equal(rejectedSwitch.acceptance, 'recorded');
  assert.equal(store.state().current_version, merged.id);
  assert.equal(store.evaluation(brokenEvaluation.evaluation).decision, 'accept');
  assert.equal(await client.run('after failed switch'), 'done');

  client.close(); await supervisor.close();
  supervisor = new Supervisor(store, cwd); await supervisor.start();
  client = await RuntimeClient.connect(supervisor.socketPath);
  assert.equal(store.state().current_version, merged.id);
  assert.equal(store.evaluation(evaluation.evaluation).decision, 'accept');
  assert.equal(store.evaluation(brokenEvaluation.evaluation).decision, 'accept');
  assert.ok(store.db.prepare("SELECT id FROM switches WHERE to_version=? AND state='failed'").get(broken.id));
  const before = requests.length;
  const again = await supervisor.manage({ operation: 'promote', version: merged.id, evaluation: evaluation.evaluation, reason: 'already switched retry', acceptReason: 'reviewed' }, old.id).then(() => 'unexpected', error => error.message);
  assert.match(again, /Stale/); assert.equal(requests.length, before, 'retry must not repeat candidate execution');
});
