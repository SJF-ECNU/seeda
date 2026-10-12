import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { StrainLibrary, introduction } from '../src/strains/library.ts';
import { matches } from '../src/strains/select.ts';
import { intro } from './fixtures/introduction.ts';

test('standard introduction rejects missing or blank fields and normalizes text', () => {
  assert.throws(() => introduction(undefined), /requires/);
  for (const field of Object.keys(intro)) assert.throws(() => introduction({ ...intro, [field]: ' ' }), /requires/);
  assert.equal(introduction({ ...intro, summary: '  useful  ' }).summary, 'useful');
});
test('default setting persists, missing intro remains readable, unknown selection leaves default intact', async t => {
  const root = await mkdtemp('/tmp/seeda-choice-'); let library = await StrainLibrary.open(root);
  t.after(async () => { library.close(); await rm(root, { recursive: true, force: true }); });
  for (const name of ['origin','coding-plus']) library.db.prepare('INSERT INTO strains(id,name,git_commit,path,description) VALUES(?,?,?,?,?)').run(name, name, 'test', root + '/' + name, '旧介绍');
  assert.equal(library.defaultStrain().name, 'origin'); assert.equal(library.get('coding-plus').intro, null);
  library.setDefault('coding-plus'); library.close(); library = await StrainLibrary.open(root);
  assert.equal(library.defaultStrain().name, 'coding-plus');
  assert.throws(() => library.setDefault('missing'), /Unknown/); assert.equal(library.defaultStrain().name, 'coding-plus');
  assert.deepEqual(matches(library.list(), 'coding').map(row => row.name), ['coding-plus']);
  assert.equal(matches(library.list(), '旧介绍').length, 2);
});
