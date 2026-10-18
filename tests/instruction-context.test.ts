import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, readFile, realpath, symlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { loadInstructions } from '../src/core/context.ts';
import { Agent, Session } from '../src/index.ts';
import { RuntimeRecordsTool } from '../src/core/runtime-records-tool.ts';
import type { Message, Tool, ToolDefinition } from '../src/core/types.ts';

test('own instructions and memory come from implementation while rules come from project', async t => {
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

test('version and project skills retain separate identities and opt in to always-loaded bodies', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seeda-skills-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const implementation = join(root, 'implementation'), cwd = join(root, 'project');
  const fixtures = [
    { directory: implementation, folder: 'shared', kind: 'self_skill', name: 'shared', description: 'version procedure', flag: '', body: 'VERSION-ON-DEMAND-BODY' },
    { directory: cwd, folder: 'shared', kind: 'project_skill', name: 'shared', description: 'project procedure', flag: '', body: 'PROJECT-ON-DEMAND-BODY' },
    { directory: implementation, folder: 'always', kind: 'self_skill', name: 'version-always', description: 'version reminder', flag: 'always: true\n', body: 'VERSION-ALWAYS-BODY' },
    { directory: cwd, folder: 'always', kind: 'project_skill', name: 'project-always', description: 'project reminder', flag: 'always: true\n', body: 'PROJECT-ALWAYS-BODY' },
    { directory: implementation, folder: 'optional', kind: 'self_skill', name: 'optional', description: 'optional procedure', flag: 'always: false\n', body: 'OPTIONAL-BODY' },
  ];
  for (const fixture of fixtures) {
    const directory = join(fixture.directory, '.agents/skills', fixture.folder); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${fixture.name}\ndescription: ${fixture.description}\n${fixture.flag}---\n${fixture.body}`);
  }
  const loaded = await loadInstructions(cwd, implementation);
  for (const fixture of fixtures) {
    const path = join(fixture.directory, '.agents/skills', fixture.folder, 'SKILL.md');
    assert.ok(loaded.text.includes(`${fixture.name} (${fixture.kind}): ${fixture.description}\nSource: ${path}`));
    assert.equal(loaded.text.includes(fixture.body), fixture.flag === 'always: true\n');
    assert.deepEqual(loaded.sources.find(source => source.path === path), { kind: fixture.kind, path, loaded: true, characters: (await readFile(path, 'utf8')).length });
  }
  assert.equal(loaded.sources.filter(source => source.kind === 'self_skill').length, 3);
  assert.equal(loaded.sources.filter(source => source.kind === 'project_skill').length, 2);
  assert.ok(!loaded.text.includes('read instructions with Bash'));
  assert.ok(!JSON.stringify(loaded.sources).includes('ALWAYS-BODY'));
});

test('the same skill directory is read once even through a project symlink', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seeda-skill-alias-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const implementation = join(root, 'implementation'), cwd = join(root, 'project');
  await mkdir(join(implementation, '.agents/skills/shared'), { recursive: true });
  await mkdir(join(cwd, '.agents'), { recursive: true });
  await symlink(join(implementation, '.agents/skills'), join(cwd, '.agents/skills'), 'dir');
  const path = join(implementation, '.agents/skills/shared/SKILL.md');
  await writeFile(path, '---\r\nname: shared\r\ndescription: one physical skill\r\nalways: true\r\n---\r\nONE-BODY');
  for (const project of [implementation, cwd]) {
    const loaded = await loadInstructions(project, implementation);
    assert.deepEqual(loaded.sources.filter(source => source.kind.endsWith('_skill')), [{ kind: 'self_skill', path, loaded: true, characters: (await readFile(path, 'utf8')).length }]);
    assert.equal(loaded.text.split('ONE-BODY').length - 1, 1);
  }
});

test('actual Agent reads discovered host skills without routing through its separate Bash environment', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seeda-agent-skills-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const implementation = join(root, 'implementation'), cwd = join(root, 'host-project'), commandCwd = join(root, 'command-workspace');
  for (const directory of ['core', 'tools']) await cp(resolve('src', directory), join(implementation, 'src', directory), { recursive: true });
  await mkdir(join(implementation, '.agents/skills/own'), { recursive: true });
  await mkdir(join(implementation, '.agents/skills/always'), { recursive: true });
  await mkdir(join(cwd, '.agents/skills/local'), { recursive: true }); await mkdir(commandCwd);
  const ownPath = join(implementation, '.agents/skills/own/SKILL.md'), projectPath = join(cwd, '.agents/skills/local/SKILL.md');
  await writeFile(ownPath, '---\nname: own\ndescription: version skill\n---\nVERSION-SKILL-BODY');
  await writeFile(projectPath, '---\nname: local\ndescription: project skill\n---\nPROJECT-SKILL-BODY');
  await writeFile(join(implementation, '.agents/skills/always/SKILL.md'), '---\nname: reminder\ndescription: version reminder\nalways: true\n---\nALWAYS-IN-SYSTEM');
  const privatePath = join(cwd, 'private.txt'); await writeFile(privatePath, 'NOT-A-SKILL-SECRET');
  const { Agent: IsolatedAgent } = await import(pathToFileURL(join(implementation, 'src/core/agent.ts')).href);
  let bashCalls = 0, modelCalls = 0;
  const bash: Tool = {
    definition: { type: 'function', function: { name: 'bash', description: `Execution is bound to a separate workspace: ${commandCwd}`, parameters: { type: 'object' } } },
    async execute() { bashCalls++; throw new Error('Host skill paths are unavailable in this execution environment'); },
  };
  const session = await Session.open(join(root, 'session.jsonl'), cwd);
  const agent = new IsolatedAgent({ cwd, session, artifactDir: join(root, 'outputs'), tools: [bash], model: { async complete(messages: Message[], tools: ToolDefinition[]) {
    modelCalls++;
    assert.ok(messages[0].content!.includes('ALWAYS-IN-SYSTEM'));
    assert.ok(!messages[0].content!.includes('VERSION-SKILL-BODY'));
    assert.ok(messages[0].content!.includes(`Source: ${ownPath}`));
    assert.ok(messages[0].content!.includes(`Source: ${projectPath}`));
    assert.deepEqual(tools.map(tool => tool.function.name), ['bash', 'verify', 'read_skill', 'runtime_records']);
    if (modelCalls === 1) return { message: { role: 'assistant', content: null, tool_calls: [ownPath, projectPath, privatePath, ownPath.replace('/SKILL.md', '/./SKILL.md')].map((path, index) => ({ id: `skill-${index}`, type: 'function', function: { name: 'read_skill', arguments: JSON.stringify({ path }) } })) }, finishReason: 'tool_calls' };
    if (modelCalls === 2) {
      const results = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content!));
      assert.equal(results[0].source.kind, 'self_skill'); assert.equal(results[0].source.path, ownPath); assert.match(results[0].content, /VERSION-SKILL-BODY/);
      assert.equal(results[1].source.kind, 'project_skill'); assert.equal(results[1].source.path, projectPath); assert.match(results[1].content, /PROJECT-SKILL-BODY/);
      assert.equal(results[2].status, 'failed'); assert.match(results[2].error, /not a discovered skill/);
      assert.equal(results[3].status, 'failed'); assert.match(results[3].error, /not a discovered skill/);
      assert.ok(!JSON.stringify(messages).includes('NOT-A-SKILL-SECRET'));
      return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'skill-records', type: 'function', function: { name: 'runtime_records', arguments: '{}' } }] }, finishReason: 'tool_calls' };
    }
    assert.deepEqual(JSON.parse(messages.at(-1)!.content!).tools, ['bash', 'verify', 'read_skill', 'runtime_records']);
    return { message: { role: 'assistant', content: 'skills inspected' }, finishReason: 'stop' };
  } } });
  assert.equal(await agent.run('Inspect the discovered version and project skills.'), 'skills inspected');
  assert.equal(modelCalls, 3); assert.equal(bashCalls, 0);
});

test('Agent preserves explicitly supplied skill and verification tools without duplicate names', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'seeda-tool-names-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  const tools: Tool[] = ['bash', 'verify', 'read_skill'].map(name => ({ definition: { type: 'function', function: { name, description: `explicit ${name}`, parameters: { type: 'object' } } }, async execute() { return name; } }));
  const session = await Session.open(join(cwd, 'session.jsonl'), cwd);
  const agent = new Agent({ cwd, session, artifactDir: join(cwd, 'outputs'), tools, model: { async complete(_messages, definitions) {
    assert.deepEqual(definitions.map(tool => tool.function.name), ['bash', 'verify', 'read_skill', 'runtime_records']);
    assert.equal(definitions.find(tool => tool.function.name === 'read_skill')!.function.description, 'explicit read_skill');
    assert.equal(definitions.find(tool => tool.function.name === 'verify')!.function.description, 'explicit verify');
    return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
  } } });
  assert.equal(await agent.run('Check explicit tools.'), 'done');
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
  const agent = new Agent({ cwd, session, artifactDir: join(cwd, 'outputs'), tools: [], model: { async complete(messages, definitions) {
    assert.ok(messages[0].content!.includes('PROJECT-SECRET-CONTENT'));
    assert.deepEqual(definitions.map(tool => tool.function.name), ['read_skill', 'runtime_records']);
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
