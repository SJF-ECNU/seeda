import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { WorkerProcess } from '../src/runtime/process.ts';
import type { VersionStore, Version } from '../src/versions/store.ts';

test('a paused supervisor grants a fresh window; continued heartbeat loss still kills the real worker with a specific reason', async t => {
  const root = await mkdtemp(join(tmpdir(), 'seeda-heartbeat-'));
  await mkdir(join(root, 'src/runtime'), { recursive: true });
  // A real IPC worker stays alive but deliberately sends no heartbeat.
  await writeFile(join(root, 'src/runtime/worker.ts'), "process.on('message', m => { if (m.type === 'stop') process.exit(0); }); process.send({type:'ready',messages:[]});");
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE instances(id TEXT PRIMARY KEY,version_id TEXT,role TEXT,state TEXT,pid INTEGER,reason TEXT,ended_at TEXT)');
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  let failure: Error | undefined;
  t.mock.timers.enable({ apis: ['setInterval'] });
  const observed = new WorkerProcess({ db } as unknown as VersionStore, { id: 'test-version', runtime_path: root } as Version, root, join(root,'session'), root, 'primary', () => {}, async () => null, (_, error) => { failure = error; });
  t.after(async () => { t.mock.timers.reset(); await observed.stop(); db.close(); await rm(root,{recursive:true,force:true}); });
  await observed.ready;
  now = 60_000; t.mock.timers.tick(1000);
  assert.equal(observed.child.signalCode, null, 'first check after a long suspension must not kill the worker');
  assert.equal(failure, undefined);
  for (let i=0;i<6;i++) { now += 1000; t.mock.timers.tick(1000); }
  assert.equal(observed.child.signalCode, null, 'worker receives the full six-second recovery window');
  const exited = once(observed.child,'exit');
  now += 1000; t.mock.timers.tick(1000);
  await exited;
  assert.equal(observed.child.signalCode,'SIGKILL');
  assert.match(failure!.message,/heartbeat timed out/);
  assert.match((db.prepare('SELECT reason FROM instances WHERE id=?').get(observed.id) as {reason:string}).reason,/heartbeat timed out/);
});
