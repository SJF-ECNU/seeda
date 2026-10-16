import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { copyAgent } from '../src/versions/snapshot.ts';
import { VersionStore } from '../src/versions/store.ts';
import { Supervisor } from '../src/runtime/supervisor.ts';
import { RuntimeClient } from '../src/runtime/client.ts';
import { Session } from '../src/core/session.ts';

type PromptMessage = { role: string; content: string };
type Instruction = { kind: string; path: string; loaded: boolean; characters: number };

test('real workers load versioned self context independently of project rules across evaluation, promotion and sessions', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seeda-instructions-')));
  const source = join(root, 'source'), cwd = join(root, 'project');
  await mkdir(source); await mkdir(join(cwd, '.agents/self'), { recursive: true });
  await copyAgent(resolve('.'), source);
  await mkdir(join(source, '.agents/self'), { recursive: true });
  await writeFile(join(source, '.agents/self/INSTRUCTIONS.md'), 'SELF_INITIAL_719\n');
  await writeFile(join(source, '.agents/self/MEMORY.md'), 'MEMORY_INITIAL_719\n');
  await writeFile(join(source, 'AGENTS.md'), 'SOURCE_PROJECT_TRAP_719\n');
  await writeFile(join(cwd, 'AGENTS.md'), 'PROJECT_RULE_719\n');
  await writeFile(join(cwd, '.agents/self/INSTRUCTIONS.md'), 'WORKSPACE_SELF_TRAP_719\n');
  await writeFile(join(cwd, '.agents/self/MEMORY.md'), 'WORKSPACE_MEMORY_TRAP_719\n');
  await mkdir(join(cwd, '.agents/skills/project-check'), { recursive: true });
  await writeFile(join(cwd, '.agents/skills/project-check/SKILL.md'), '---\nname: project-check\ndescription: PROJECT_SKILL_719\n---\nProject-only skill body.\n');
  const captures = new Map<string, PromptMessage[]>();
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const messages = JSON.parse(body).messages as PromptMessage[];
    const task = messages.filter(message => message.role === 'user').at(-1)!.content;
    captures.set(task, messages);
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const saved = Object.fromEntries(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'SEEDA_SYSTEM_PROXY'].map(key => [key, process.env[key]]));
  process.env.DEEPSEEK_API_KEY = 'local-test'; process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${address.port}`; process.env.SEEDA_SYSTEM_PROXY = '0';
  const store = await VersionStore.open(join(root, 'state'));
  const supervisor = new Supervisor(store, cwd);
  let client: RuntimeClient | undefined;
  t.after(async () => {
    client?.close(); await supervisor.close(); store.close(); server.closeAllConnections(); server.close();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  const initial = await store.initialize(source); await supervisor.start();
  client = await RuntimeClient.connect(supervisor.socketPath);
  const checkPrompt = (task: string, evolved: boolean, project: boolean) => {
    const messages = captures.get(task); assert.ok(messages, `missing model request: ${task}`);
    const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
    assert.ok(system.includes(evolved ? 'SELF_CANDIDATE_719' : 'SELF_INITIAL_719'));
    assert.ok(system.includes(evolved ? 'MEMORY_CANDIDATE_719' : 'MEMORY_INITIAL_719'));
    assert.ok(!system.includes(evolved ? 'SELF_INITIAL_719' : 'SELF_CANDIDATE_719'));
    assert.ok(!system.includes(evolved ? 'MEMORY_INITIAL_719' : 'MEMORY_CANDIDATE_719'));
    assert.equal(system.includes('PROJECT_RULE_719'), project);
    assert.equal(system.includes('PROJECT_SKILL_719'), project);
    assert.ok(!system.includes('SOURCE_PROJECT_TRAP_719'));
    assert.ok(!system.includes('WORKSPACE_SELF_TRAP_719'));
    assert.ok(!system.includes('WORKSPACE_MEMORY_TRAP_719'));
  };
  assert.equal(await client.run('initial request'), 'done'); checkPrompt('initial request', false, true);
  const draft = await store.draft(initial.id);
  await writeFile(join(draft.path, '.agents/self/INSTRUCTIONS.md'), 'SELF_CANDIDATE_719\n');
  await writeFile(join(draft.path, '.agents/self/MEMORY.md'), 'MEMORY_CANDIDATE_719\n');
  const candidate = await store.submit(draft.id, 'change both versioned instruction sources');
  const evaluation = await supervisor.manage({ operation: 'evaluate', version: candidate.id, task: 'isolated candidate request', sandbox: 'process' }) as { evaluation: string; status: string; evidence_path: string };
  assert.equal(evaluation.status, 'completed', JSON.stringify(evaluation));
  checkPrompt('isolated candidate request', true, false);
  await supervisor.manage({ operation: 'decide', evaluation: evaluation.evaluation, decision: 'accept', reason: 'candidate loaded its own instructions in isolated workspace' });
  await supervisor.manage({ operation: 'promote', version: candidate.id, evaluation: evaluation.evaluation, reason: 'verified instruction loading' });
  assert.equal(store.state().current_version, candidate.id);
  assert.equal(await client.run('promoted request'), 'done'); checkPrompt('promoted request', true, true);
  const created = await client.request('new') as { id: string };
  assert.equal(await client.run('fresh session request'), 'done'); checkPrompt('fresh session request', true, true);
  assert.ok(!JSON.stringify(captures.get('fresh session request')).includes('initial request'));
  await client.request('resume', { id: 'main' });
  assert.equal(await client.run('resumed request'), 'done'); checkPrompt('resumed request', true, true);
  await supervisor.manage({ operation: 'rollback', reason: 'verify retained version instruction restoration' });
  assert.equal(store.state().current_version, initial.id);
  assert.equal(await client.run('rollback request'), 'done'); checkPrompt('rollback request', false, true);
  const records = (await readFile(join(root, 'state/sessions/main.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const requests = records.filter(record => record.type === 'request');
  assert.equal(requests.length, 4);
  const restored = await Session.open(join(root, 'state/sessions/main.jsonl'), cwd);
  const runs = restored.runtime.recent(20);
  assert.equal(runs.length, requests.length);
  for (const [index, request] of requests.entries()) {
    const sources = runs[index].instructions as Instruction[];
    assert.ok(Array.isArray(sources));
    for (const kind of ['self_instructions', 'self_memory', 'project_rules']) {
      const entry = sources.find(source => source.kind === kind); assert.ok(entry, `missing ${kind}`);
      assert.equal(entry.loaded, true); assert.ok(entry.characters > 0); assert.equal(typeof entry.path, 'string');
      assert.deepEqual(Object.keys(entry).sort(), ['characters', 'kind', 'loaded', 'path']);
    }
    assert.equal(sources.find(source => source.kind === 'project_rules')!.path, join(cwd, 'AGENTS.md'));
    const skill = sources.find(source => source.kind === 'project_skill'); assert.ok(skill);
    assert.equal(skill.path, join(cwd, '.agents/skills/project-check/SKILL.md')); assert.equal(skill.loaded, true);
    const versionPath = request.implementationVersion === initial.id ? initial.runtime_path : candidate.runtime_path;
    assert.equal(sources.find(source => source.kind === 'self_instructions')!.path, join(versionPath, '.agents/self/INSTRUCTIONS.md'));
    assert.equal(sources.find(source => source.kind === 'self_memory')!.path, join(versionPath, '.agents/self/MEMORY.md'));
  }
  assert.equal(requests[0].implementationVersion, initial.id);
  assert.equal(requests[1].implementationVersion, candidate.id);
  assert.equal(requests[2].implementationVersion, candidate.id);
  assert.equal(requests[3].implementationVersion, initial.id);
  const fresh = await readFile(join(root, 'state/sessions', `${created.id}.jsonl`), 'utf8');
  assert.ok(!fresh.includes('SELF_CANDIDATE_719'), 'instruction bodies must not be persisted as conversation messages');
});
