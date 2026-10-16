import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadInstructions } from '../src/core/context.ts';
import { Agent, Session } from '../src/index.ts';
import { RuntimeRecordsTool } from '../src/tools/runtime-records.ts';

test('own instructions and memory come from implementation while rules and Skills come from project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seeda-instr-')); t.after(() => rm(root, { recursive: true, force: true }));
  const implementation = join(root, 'implementation'), cwd = join(root, 'project');
  for (const p of [join(implementation, '.agents/self'), join(cwd, '.agents/self'), join(cwd, '.agents/skills/example')]) await mkdir(p, { recursive: true });
  await writeFile(join(implementation, '.agents/self/INSTRUCTIONS.md'), 'OWN-MARKER');
  await writeFile(join(implementation, '.agents/self/MEMORY.md'), 'MEMORY-PRIVATE-BODY');
  await writeFile(join(implementation, 'AGENTS.md'), 'IMPLEMENTATION-REPO-RULES-NOT-OWN');
  await writeFile(join(cwd, '.agents/self/INSTRUCTIONS.md'), 'PROJECT-SELF-TRAP');
  await writeFile(join(cwd, '.agents/self/MEMORY.md'), 'PROJECT-MEMORY-TRAP');
  await writeFile(join(cwd, 'AGENTS.md'), 'PROJECT-MARKER');
  await writeFile(join(cwd, '.agents/skills/example/SKILL.md'), '---\nname: example\ndescription: example skill\n---\n');
  const loaded = await loadInstructions(cwd, implementation);
  for (const marker of ['OWN-MARKER', 'MEMORY-PRIVATE-BODY', 'PROJECT-MARKER', 'example skill']) assert.ok(loaded.text.includes(marker));
  for (const marker of ['PROJECT-SELF-TRAP', 'PROJECT-MEMORY-TRAP', 'IMPLEMENTATION-REPO-RULES-NOT-OWN']) assert.ok(!loaded.text.includes(marker));
  assert.equal(loaded.sources.find(s => s.kind === 'self_memory')!.characters, 19);
  assert.ok(loaded.sources.every(s => !JSON.stringify(s).includes('MEMORY-PRIVATE-BODY')));
  assert.ok(loaded.sources.some(s => s.kind === 'project_skill' && s.loaded));
});

test('old implementation without self files runs and never substitutes its AGENTS.md', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seeda-legacy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'), implementation = join(root, 'legacy'); await mkdir(cwd); await mkdir(implementation);
  await writeFile(join(implementation, 'AGENTS.md'), 'DO-NOT-MIGRATE');
  const loaded = await loadInstructions(cwd, implementation);
  assert.ok(!loaded.text.includes('DO-NOT-MIGRATE'));
  assert.deepEqual(loaded.sources.filter(s => s.kind.startsWith('self_')).map(s => s.loaded), [false, false]);
});

test('real Agent requests and compression record actual prompt sources without their contents', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'seeda-prov-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'AGENTS.md'), 'PROJECT-SECRET-CONTENT');
  const path = join(cwd, 'session.jsonl'), session = await Session.open(path, cwd);
  const agent = new Agent({ cwd, session, artifactDir: join(cwd, 'outputs'), tools: [], model: { async complete(messages) {
    assert.ok(messages[0].content!.includes('PROJECT-SECRET-CONTENT'));
    return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
  } } });
  await agent.run('first'); await agent.compact();
  const loaded = await Session.open(path, cwd);
  const report = await new RuntimeRecordsTool(loaded, []).execute({}) as any;
  for (const run of report.runs) {
    assert.ok(run.instructions.some((s: any) => s.kind === 'project_rules' && s.path === join(cwd, 'AGENTS.md') && s.loaded));
    assert.ok(run.instructions.some((s: any) => s.kind === 'self_instructions' && s.path.startsWith(resolve('.agents/self'))));
  }
  assert.ok(!JSON.stringify(report).includes('PROJECT-SECRET-CONTENT'));
  assert.ok(!(await readFile(path, 'utf8')).includes('PROJECT-SECRET-CONTENT'));
});
