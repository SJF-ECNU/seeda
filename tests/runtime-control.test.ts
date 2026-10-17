import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, type Socket } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VersionStore } from '../src/versions/store.ts';
import { Supervisor } from '../src/runtime/supervisor.ts';
import { Session } from '../src/core/session.ts';

test('control socket preserves framing, event correlation and cancellation during a running request', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'seeda-control-'));
  const store = await VersionStore.open(join(root, 'state'));
  const runtime = join(root, 'version'); await mkdir(join(runtime, 'src/runtime'), { recursive: true });
  await writeFile(join(runtime, 'src/runtime/worker.ts'), `
process.on('message', message => {
  if (message.type === 'stop') process.exit(0);
  if (message.type === 'run') process.send({ type: 'event', event: { type: 'text', text: 'waiting' } });
  if (message.type === 'cancel') {
    process.send({ type: 'event', event: { type: 'end', status: 'cancelled' } });
    process.send({ type: 'result', error: 'Request cancelled' });
  }
});
process.send({ type: 'ready', messages: [], resume: true });
setInterval(() => process.send({ type: 'heartbeat' }), 1000);
`);
  store.db.prepare('INSERT INTO versions(id,parent_id,git_commit,runtime_path,reason) VALUES(?,NULL,?,?,?)').run('fixture', 'fixture', runtime, 'control fixture');
  store.db.prepare("UPDATE runtime_state SET current_version='fixture'").run();
  await Session.open(join(store.root, 'sessions/main.jsonl'), root);
  const supervisor = new Supervisor(store, root); const sockets: Socket[] = [];
  t.after(async () => { for (const socket of sockets) socket.destroy(); await supervisor.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  await supervisor.start();
  const connect = async () => { const socket = createConnection(supervisor.socketPath); sockets.push(socket); socket.on('error', () => {}); await once(socket, 'connect'); return socket; };
  const socket = await connect(); const rows: any[] = []; let buffer = '';
  socket.setEncoding('utf8'); socket.on('data', chunk => {
    buffer += chunk; let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) { rows.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
  });
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { assert.ok(Date.now() < deadline, JSON.stringify(rows)); await new Promise(r => setTimeout(r, 10)); }
  };
  socket.write('{"id":"history","operation":');
  await new Promise<void>(resolve => setImmediate(resolve));
  socket.write('"history"}\n{"id":"session","operation":"session"}\n');
  await wait(() => rows.filter(row => row.result !== undefined).length === 2);
  assert.deepEqual(rows.find(row => row.id === 'history').result, []);
  assert.equal(rows.find(row => row.id === 'session').result.id, 'main');
  socket.write('{"id":"run","operation":"run","input":"wait","args":{"session":"main"}}\n');
  await wait(() => rows.some(row => row.id === 'run' && row.event?.text === 'waiting'));
  socket.write('{"id":"cancel","operation":"cancel"}\n{"id":"history2","operation":"history"}\n');
  await wait(() => rows.some(row => row.id === 'run' && row.error) && rows.some(row => row.id === 'history2' && row.result));
  assert.equal(rows.find(row => row.id === 'cancel').result.status, 'cancelled');
  assert.match(rows.find(row => row.id === 'run' && row.error).error, /cancelled/);
  assert.equal(rows.filter(row => row.event?.type === 'end').length, 1);
  assert.ok(rows.filter(row => row.event).every(row => row.id === 'run'));
  for (const invalid of ['{bad json}\n', '{"operation":"history"}\n', 'x'.repeat(1_000_001)]) {
    const bad = await connect(); const closed = new Promise<void>(resolve => bad.once('close', () => resolve()));
    bad.write(invalid); await closed;
  }
});
