import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { VersionStore } from '../src/versions/store.ts';
import { StrainLibrary } from '../src/strains/library.ts';
import { copyAgent } from '../src/versions/snapshot.ts';
import { intro } from './fixtures/introduction.ts';

const exec = promisify(execFile);
const implementation = ['src/cli.ts', 'src/runtime/supervisor.ts', 'src/runtime/execution.ts', 'src/versions/store.ts', 'src/sandbox/candidate.ts', 'src/strains/library.ts', 'src/obsolete-helper.ts', 'tests/host.test.ts', '.agents/skills/verify/SKILL.md'];
async function put(root: string, name: string, content = `fixture ${name}`) {
  await mkdir(join(root, name, '..'), { recursive: true }); await writeFile(join(root, name), content);
}
async function fixture(root: string) {
  for (const name of implementation) await put(root, name);
  await put(root, 'package.json', JSON.stringify({ name: 'seeda', version: '1.0.0', private: true, bin: { seeda: 'src/cli.ts' }, scripts: { check: 'true', test: 'true', manage: 'node src/cli.ts' } }));
  await put(root, 'package-lock.json', JSON.stringify({ name: 'seeda', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'seeda', version: '1.0.0' } } }));
}

test('full implementation survives submission, strain publication and checkout without runtime data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seeda-full-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await fixture(source);
  await put(source, 'bin/launch', 'echo fixture'); await put(source, 'scripts/check.ts', 'export const check = true;');
  for (const name of ['.env', '.seeda/state.db', 'node_modules/private.js', 'src/.env.local', 'src/state.db-wal', '.agents/.ssh/id_rsa', 'scripts/node_modules/private.js']) await put(source, name, 'do not copy');
  const store = await VersionStore.open(join(root, 'state')); const library = await StrainLibrary.open(join(root, 'library'));
  t.after(() => { library.close(); store.close(); });
  const original = await store.initialize(source);
  const draft = await store.draft(original.id);
  await put(draft.path, 'src/runtime/supervisor.ts', 'candidate host implementation');
  await put(draft.path, 'src/.env', 'candidate secret');
  await rm(join(draft.path, 'src/obsolete-helper.ts'));
  const version = await store.submit(draft.id, 'Change full runtime');
  const strain = await library.publish('complete', store, version, source, intro);
  const checkout = await library.checkout(strain);

  for (const path of [version.runtime_path, strain.path, checkout.path]) {
    for (const name of implementation.filter(name => name !== 'src/obsolete-helper.ts')) assert.ok((await readFile(join(path, name))).length);
    assert.equal(await readFile(join(path, 'src/runtime/supervisor.ts'), 'utf8'), 'candidate host implementation');
    assert.equal(await readFile(join(path, 'bin/launch'), 'utf8'), 'echo fixture');
    assert.ok((await readFile(join(path, 'scripts/check.ts'))).length);
    const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'seeda'); assert.equal(manifest.bin.seeda, 'src/cli.ts'); assert.ok(manifest.scripts.manage);
    for (const name of ['src/obsolete-helper.ts', '.env', '.seeda/state.db', 'src/.env', 'src/.env.local', 'src/state.db-wal', '.agents/.ssh/id_rsa', 'scripts/node_modules/private.js']) await assert.rejects(readFile(join(path, name)), /ENOENT/);
  }
  await checkout.close();
  assert.equal(await readFile(join(draft.path, 'src/.env'), 'utf8'), 'candidate secret');
});

test('old sources without optional directories remain publishable and unsafe staged files never become versions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seeda-old-source-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await fixture(source);
  await rm(join(source, 'src/runtime'), { recursive: true });
  await put(source, 'src/runtime/worker.ts', 'export const worker = true;');
  const copy = join(root, 'copy'); await copyAgent(source, copy);
  const store = await VersionStore.open(join(root, 'state')); const library = await StrainLibrary.open(join(root, 'library')); t.after(() => { library.close(); store.close(); });
  const original = await store.initialize(copy);
  const published = await library.publish('legacy', store, original, copy, intro);
  const checkout = await library.checkout(published);

  const extracted = checkout.path;
  assert.equal(await readFile(join(extracted, 'src/runtime/worker.ts'), 'utf8'), 'export const worker = true;');
  await assert.rejects(readFile(join(extracted, 'scripts/check.ts')), /ENOENT/);
  await checkout.close();
  const draft = await store.draft(original.id);
  await put(draft.path, '.env', 'never publish');
  await exec('git', ['-C', draft.path, 'add', '--', '.env']);
  await assert.rejects(store.submit(draft.id, 'Invalid staged credential'), /outside the implementation snapshot/);
  assert.equal(store.versions().length, 1);
  assert.equal(store.db.prepare('SELECT state FROM drafts WHERE id=?').get(draft.id)!.state, 'editing');
  await exec('git', ['-C', draft.path, 'reset', '--', '.env']);
  await symlink(join(root, 'source/package.json'), join(draft.path, 'src/link.ts'));
  await assert.rejects(store.submit(draft.id, 'Invalid source link'), /Unsupported implementation file/);
  assert.equal(store.versions().length, 1);
});
