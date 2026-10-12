import { intro } from './fixtures/introduction.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { StrainLibrary } from '../src/strains/library.ts';
import { VersionStore } from '../src/versions/store.ts';
import { Supervisor } from '../src/runtime/supervisor.ts';

test('Agent grafts through existing Bash/Git and management tools, verifies, promotes and retains conflicts', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp('/tmp/seeda-agraft-')); const project = join(root, 'target'); await mkdir(project);
  const library = await StrainLibrary.open(join(root, 'library')); const source = await VersionStore.open(join(root, 'source'));
  const target = await VersionStore.open(join(root, 'target-state'));
  const origin = await library.ensureOrigin(resolve('.')); const a = await source.initialize(origin.path);
  const change = await source.draft(a.id); await writeFile(join(change.path, 'src/grafted-feature.ts'), 'export function feature() { return "grafted"; }\n');
  await writeFile(join(change.path, 'src/unrelated-feature.ts'), 'export const unrelated = true;\n');
  const sourceVersion = await source.submit(change.id, 'source feature'); const strain = await library.publish('source-plus', source, sourceVersion, 'source-project', intro);
  const first = await target.initialize(origin.path); const own = await target.draft(first.id);
  await writeFile(join(own.path, 'src/target-feature.ts'), 'export const ownFeature = true;\n');
  const parent = await target.submit(own.id, 'target own feature'); const id = target.requestSwitch(parent.id, 'manual', 'target setup'); target.finishSwitch(id, true);
  const previous = { key: process.env.DEEPSEEK_API_KEY, base: process.env.DEEPSEEK_BASE_URL, library: process.env.SEEDA_LIBRARY, proxy: process.env.SEEDA_SYSTEM_PROXY };
  let phase = 0; let draft: { id: string; path: string }; let version: { id: string; runtime_path: string }; let evaluation: { evaluation: string }; let evidenceVerified = false;
  const operations: string[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const data = JSON.parse(body);
    const user = data.messages.filter((m: {role:string}) => m.role === 'user').at(-1).content;
    const last = data.messages.at(-1); const result = last.role === 'tool' ? JSON.parse(last.content) : undefined;
    let name = ''; let args: unknown; let text = ''; let callId = '';
    if (user.startsWith('verify graft at ')) {
      if (last.role === 'tool') text = result.exit_code === 0 && result.output.includes('grafted') ? 'verified graft' : 'failed graft';
      else { name = 'bash'; args = { command: `node --experimental-strip-types -e 'import(${JSON.stringify(join(user.slice(16), 'src/grafted-feature.ts'))}).then(m=>console.log(m.feature()))'` }; callId = 'candidate-check'; }
    } else {
      if (last.role === 'user') phase = 0;
      phase++;
      callId = `primary-${phase}-${Date.now()}`;
      if (phase === 1) { name = 'management'; args = { operation: 'strains' }; }
      if (phase === 2) { assert.ok(result.some((item: {id:string}) => item.id === strain.id)); name = 'management'; args = { operation: 'draft' }; }
      if (phase === 3) {
        draft = result; name = 'bash';
        const patch = join(root, 'graft.patch');
        // The scripted model chooses normal Git commands, not a platform graft API.
        args = { command: ['set -e', `git -C ${JSON.stringify(strain.path)} diff --binary --full-index --no-renames ${origin.git_commit} ${strain.git_commit} -- src/grafted-feature.ts > ${JSON.stringify(patch)}`, `git -C ${JSON.stringify(draft.path)} apply --check ${JSON.stringify(patch)}`, `git -C ${JSON.stringify(draft.path)} apply ${JSON.stringify(patch)}`].join('\n') };
      }
      if (phase === 4) {
        if (result.exit_code !== 0) text = 'Conflict retained in the draft; primary unchanged.';
        else { name = 'management'; args = { operation: 'submit', draft: draft.id, reason: `Graft ${strain.id}: ${origin.git_commit} -> ${strain.git_commit}; src/grafted-feature.ts` }; }
      }
      if (phase === 5) { version = result; name = 'management'; args = { operation: 'evaluate', version: version.id, task: `verify graft at ${version.runtime_path}` }; }
      if (phase === 6) { evaluation = result; name = 'management'; args = { operation: 'evidence', evaluation: evaluation.evaluation }; }
      if (phase === 7) {
        evidenceVerified = result.status === 'completed' && result.answer === 'verified graft' && result.events.some((item: {type:string;result?:{exit_code:number;output:string}}) => item.type === 'tool_end' && item.result?.exit_code === 0 && item.result.output.includes('grafted'));
        assert.equal(evidenceVerified, true); name = 'management'; args = { operation: 'decide', evaluation: evaluation.evaluation, decision: 'accept', reason: 'Actual candidate Bash executed the grafted function' };
      }
      if (phase === 8) { name = 'management'; args = { operation: 'promote', version: version.id, evaluation: evaluation.evaluation, reason: 'Candidate evidence accepted' }; }
      if (phase === 9) text = 'Graft verified and selected.';
      if (name === 'management') operations.push((args as {operation:string}).operation);
    }
    const delta = name ? { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: text };
    res.setHeader('Content-Type', 'text/event-stream'); res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  process.env.DEEPSEEK_API_KEY = 'local-test'; process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${address.port}`; process.env.SEEDA_LIBRARY = library.root; process.env.SEEDA_SYSTEM_PROXY = '0';
  const supervisor = new Supervisor(target, project);
  t.after(async () => {
    await supervisor.close(); source.close(); target.close(); library.close(); server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true });
    for (const [key,value] of Object.entries({ DEEPSEEK_API_KEY: previous.key, DEEPSEEK_BASE_URL: previous.base, SEEDA_LIBRARY: previous.library, SEEDA_SYSTEM_PROXY: previous.proxy })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  await supervisor.start(); assert.match(await supervisor.run('graft selected feature', () => {}), /verified/);
  assert.equal(evidenceVerified, true); assert.notEqual(target.state().current_version, parent.id);
  const grafted = target.version(target.state().current_version!); assert.equal(grafted.parent_id, parent.id);
  assert.match(grafted.reason, new RegExp(strain.id));
  assert.match(await readFile(join(grafted.runtime_path, 'src/target-feature.ts'), 'utf8'), /ownFeature/);
  await assert.rejects(readFile(join(grafted.runtime_path, 'src/unrelated-feature.ts')), /ENOENT/);
  assert.deepEqual(operations.slice(0, 7), ['strains', 'draft', 'submit', 'evaluate', 'evidence', 'decide', 'promote']);
  assert.match(await supervisor.run('graft selected feature', () => {}), /Conflict/);
  assert.equal(target.state().current_version, grafted.id);
  const retained = target.db.prepare("SELECT path FROM drafts WHERE state='editing'").get()!;
  assert.match(await readFile(join(String(retained.path), 'src/grafted-feature.ts'), 'utf8'), /grafted/);
  await supervisor.manage({ operation: 'rollback', reason: 'verify retained pre-graft target' }); assert.equal(target.state().current_version, parent.id);
  // The platform has no dedicated graft command or graft table.
  await assert.rejects(supervisor.manage({ operation: 'graft_import', artifact: 'unused' }), /Unknown/);
  assert.equal(target.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='grafts'").get(), undefined);
});
