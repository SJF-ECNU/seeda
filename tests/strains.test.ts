import { intro } from './fixtures/introduction.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { StrainLibrary } from '../src/strains/library.ts';
import { VersionStore } from '../src/versions/store.ts';
import { RuntimeClient } from '../src/runtime/client.ts';
import { projectDirectory } from '../src/runtime/paths.ts';

const exec = promisify(execFile);
test('selected strains seed independent projects, publish saved code and survive concurrent default launches', { timeout: 90000 }, async t => {
  const root = await realpath(await mkdtemp('/tmp/seeda-seed-'));
  const a = join(root, 'a'); const b = join(root, 'b'); const c = join(root, 'c'); const d = join(root, 'd');
  for (const path of [a,b,c,d]) await mkdir(path);
  const libraryPath = join(root, 'library'); const cli = resolve('src/runtime/cli.ts'); const front = resolve('src/cli.ts');
  const env: NodeJS.ProcessEnv = { ...process.env, SEEDA_LIBRARY: libraryPath, SEEDA_SYSTEM_PROXY: '0', DEEPSEEK_API_KEY: 'local-test' }; delete env.SEEDA_HOME; delete env.SEEDA_MANAGED;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const messages = JSON.parse(body).messages;
    const answer = messages.filter((item: {role:string}) => item.role === 'user').at(-1).content;
    res.setHeader('Content-Type', 'text/event-stream'); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert.ok(address && typeof address !== 'string'); env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    for (const path of [a,b,c,d]) { try { const client = await RuntimeClient.connect(join(path, '.seeda/runtime/control.sock')); await client.request('stop'); client.close(); } catch {} }
    await new Promise(r => setTimeout(r, 300)); server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true });
  });
  const manage = (cwd: string, ...args: string[]) => exec(process.execPath, ['--experimental-strip-types', cli, ...args], { cwd, env, timeout: 30000 });
  // Two independent processes create origin concurrently, yielding one catalog entry.
  const origins = await Promise.all([manage(a, 'strains'), manage(b, 'strains')]);
  assert.deepEqual(JSON.parse(origins[0].stdout), JSON.parse(origins[1].stdout));
  const origin = JSON.parse(origins[0].stdout)[0]; assert.equal(origin.name, 'origin');
  await assert.rejects(manage(a, 'seed', 'missing'), /Unknown strain/);
  await exec(front, ['seed', 'origin'], { cwd: a, env, timeout: 30000 });
  const storeA = await VersionStore.open(join(a, '.seeda/runtime')); const original = storeA.state().current_version!;
  t.after(() => { try { storeA.close(); } catch {} });
  assert.equal(storeA.origin()!.strain_id, origin.id);
  const draft = await storeA.draft(original); await writeFile(join(draft.path, 'src/seed-feature.ts'), 'export const feature = "from A";\n');
  const improved = await storeA.submit(draft.id, 'A adds a feature');
  const introFile = join(root, 'intro.json'); await writeFile(introFile, JSON.stringify(intro));
  await assert.rejects(manage(a, 'publish', 'missing-intro', improved.id), /--intro/);
  const published = JSON.parse((await manage(a, 'publish', 'coding-plus', improved.id, '--intro', introFile)).stdout);
  assert.equal(published.source_version, improved.id); assert.equal(published.parent_id, origin.id);
  await writeFile(join(improved.runtime_path, 'src/seed-feature.ts'), 'UNSAVED CHANGE');
  const same = JSON.parse((await manage(a, 'publish', 'saved-again', improved.id, '--intro', introFile)).stdout);
  assert.equal(await readFile(join(same.path, 'src/seed-feature.ts'), 'utf8'), 'export const feature = "from A";\n');
  await assert.rejects(readFile(join(same.path, 'state.db')), /ENOENT/);
  await assert.rejects(readFile(join(same.path, '.seeda')), /ENOENT/);
  await assert.rejects(manage(a, 'publish', 'coding-plus', improved.id, '--intro', introFile), /already exists/);
  const library = await StrainLibrary.open(libraryPath); assert.equal(library.list().length, 3); library.close();
  await writeFile(join(published.path, 'src/seed-feature.ts'), 'LIBRARY WORKTREE CHANGE');
  await manage(b, 'seed', published.id);
  const storeB = await VersionStore.open(join(b, '.seeda/runtime')); const firstB = storeB.state().current_version!;
  assert.equal(storeB.origin()!.strain_id, published.id); assert.notEqual(firstB, original);
  assert.equal(await readFile(join(storeB.version(firstB).runtime_path, 'src/seed-feature.ts'), 'utf8'), 'export const feature = "from A";\n');
  await assert.rejects(manage(b, 'seed', 'origin'), /already seeded/); assert.equal(storeB.state().current_version, firstB);
  const nested = join(b, 'nested'); await mkdir(nested); assert.equal(projectDirectory(nested), b);
  const replies = await Promise.all([exec(process.execPath, ['--experimental-strip-types', front, 'run', 'project A'], { cwd: a, env, timeout: 30000 }), exec(process.execPath, ['--experimental-strip-types', front, 'run', 'project B'], { cwd: nested, env, timeout: 30000 })]);
  assert.match(replies[0].stdout, /project A/); assert.match(replies[1].stdout, /project B/);
  const clientA = await RuntimeClient.connect(join(a, '.seeda/runtime/control.sock')); const clientB = await RuntimeClient.connect(join(b, '.seeda/runtime/control.sock'));
  const agentCatalog = await clientA.request('manage', { operation: 'strains' }) as unknown[]; assert.equal(agentCatalog.length, 3);
  const agentPublished = await clientA.request('manage', { operation: 'publish', name: 'agent-published', version: improved.id, introduction: intro }) as { source_version: string }; assert.equal(agentPublished.source_version, improved.id);
  const historyA = await clientA.request('history') as { content: string }[]; const historyB = await clientB.request('history') as { content: string }[];
  assert.ok(historyA.some(item => item.content === 'project A')); assert.ok(!historyA.some(item => item.content === 'project B'));
  assert.ok(historyB.some(item => item.content === 'project B')); assert.ok(!historyB.some(item => item.content === 'project A'));
  assert.equal(storeA.versions().length, 2); assert.equal(storeB.versions().length, 1);
  const bDraft = await clientB.request('manage', { operation: 'draft' }); assert.ok(bDraft);
  assert.equal(storeA.db.prepare('SELECT count(*) AS n FROM drafts').get()!.n, 1);
  assert.equal(storeB.db.prepare('SELECT count(*) AS n FROM drafts').get()!.n, 1);
  await clientB.request('stop'); clientB.close(); clientA.close(); await new Promise(r => setTimeout(r, 300));
  // Reopening retains provenance and history without re-seeding.
  const reopened = await exec(process.execPath, ['--experimental-strip-types', front, '/versions'], { cwd: nested, env: { ...env, SEEDA_LIBRARY: join(root, 'unavailable-library') }, timeout: 15000 }); assert.match(reopened.stdout, new RegExp(firstB));
  assert.equal(storeB.origin()!.strain_id, published.id); storeB.close();
  await manage(a, 'strains', 'default', published.id);
  const reopenedLibrary = await StrainLibrary.open(libraryPath); assert.equal(reopenedLibrary.defaultStrain().id, published.id); assert.equal(reopenedLibrary.get(published.id).intro?.summary, intro.summary); reopenedLibrary.close();
  // Fresh projects auto-seed independently from the selected default.
  await Promise.all([exec(process.execPath, ['--experimental-strip-types', front, '/versions'], { cwd: c, env, timeout: 30000 }), exec(process.execPath, ['--experimental-strip-types', front, '/versions'], { cwd: d, env, timeout: 30000 })]);
  for (const path of [c,d]) { const store = await VersionStore.open(join(path, '.seeda/runtime')); assert.equal(store.origin()!.strain_id, published.id); assert.equal(store.versions().length, 1); store.close(); }
  // Git roots are reused from uninitialized subdirectories too, including worktree .git files.
  const gitRoot = join(root, 'git-project'); await mkdir(join(gitRoot, 'inner'), { recursive: true }); await writeFile(join(gitRoot, '.git'), 'gitdir: elsewhere');
  assert.equal(projectDirectory(join(gitRoot, 'inner')), gitRoot);
});
