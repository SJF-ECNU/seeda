import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VersionStore } from '../src/versions/store.ts';
import { Supervisor, type RecoveryPolicy } from '../src/runtime/supervisor.ts';
import { Session } from '../src/core/session.ts';

async function fixture(t: any, bad: string, policy: RecoveryPolicy = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'seeda-crash-boundary-')));
  const store = await VersionStore.open(join(root, 'state'));
  for (const [id, source] of [['good', `process.on('message', m => { if(m.type==='stop')process.exit(0); if(m.type==='run')process.send({type:'result',answer:'healthy'}); }); process.send({type:'ready',messages:[],resume:true}); setInterval(()=>process.send?.({type:'heartbeat'}),1000);`], ['bad', bad]]) {
    const dir = join(root, id); await mkdir(join(dir, 'src/runtime'), {recursive:true});
    await writeFile(join(dir, 'src/runtime/worker.ts'), source);
    store.db.prepare('INSERT INTO versions(id,parent_id,git_commit,runtime_path,reason) VALUES(?,NULL,?,?,?)').run(id, id, dir, id);
  }
  store.db.prepare("UPDATE runtime_state SET current_version='bad',previous_version='good'").run();
  const supervisor = new Supervisor(store, root, {kind:'local'}, policy);
  t.after(async()=>{ await supervisor.close(); store.close(); await rm(root,{recursive:true,force:true}); });
  return {root,store,supervisor};
}
const crashOnRun = `process.on('message',m=>{ if(m.type==='stop')process.exit(0);if(m.type==='run')process.exit(23); });process.send({type:'ready',messages:[],resume:true});setInterval(()=>process.send?.({type:'heartbeat'}),1000);`;

test('startup retries the exact version twice before previous; stderr and attempts remain readable', async t=>{
  const {store,supervisor,root} = await fixture(t, `console.error('injected startup import failure');process.exit(19);`);
  await supervisor.start();
  assert.equal(store.state().current_version,'good');
  assert.deepEqual(store.db.prepare('SELECT version_id FROM instances ORDER BY rowid').all().map(r=>r.version_id),['bad','bad','bad','good']);
  const session=await Session.open(join(store.root,'sessions/main.jsonl'),root);
  assert.deepEqual(session.recoveries.map(r=>r.targetVersion),['bad','bad','good']);
  for(const record of session.recoveries)assert.match(await readFile(record.logPath,'utf8'),/injected startup import failure/);
  assert.equal(await supervisor.run('original task',()=>{}),'healthy');
});

test('ready alone never resets crash retries; same-version restart preserves the previous version', async t=>{
  const {store,supervisor}=await fixture(t,crashOnRun);
  await supervisor.start();
  assert.equal(await supervisor.run('original task',()=>{}),'healthy');
  assert.deepEqual(store.db.prepare('SELECT version_id FROM instances ORDER BY rowid').all().map(r=>r.version_id),['bad','bad','bad','good']);
  assert.equal(store.state().current_version,'good');
  assert.equal(store.state().previous_version,'bad');
});

test('fixed-version trial stops after same-version attempts and emits one failed end', async t=>{
  const {store,supervisor}=await fixture(t,crashOnRun,{allowFallback:false});
  await supervisor.start(); const events:any[]=[];
  await assert.rejects(supervisor.run('heldout',e=>events.push(e)),/exhausted|prohibited/);
  assert.equal(store.state().current_version,'bad');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM instances WHERE version_id='good'").get()!.n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM instances').get()!.n,3);
  assert.deepEqual(events.filter(e=>e.type==='end').map(e=>e.status),['failed']);
});

test('cancellation between exit and restart cannot create another worker', async t=>{
  let cancel=()=>{};
  const {store,supervisor}=await fixture(t,crashOnRun,{beforeResume:()=>cancel()});cancel=()=>supervisor.cancel();
  await supervisor.start();const events:any[]=[];
  await assert.rejects(supervisor.run('cancel',e=>events.push(e)),/cancelled/);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM instances').get()!.n,1);
  assert.deepEqual(events.filter(e=>e.type==='end').map(e=>e.status),['cancelled']);
});

test('owner budget or unknown usage refuses recovery without a new model allowance', async t=>{
  const {store,supervisor}=await fixture(t,crashOnRun,{beforeResume:()=>{throw new Error('unknown usage: stop');}});
  await supervisor.start();
  await assert.rejects(supervisor.run('budget',()=>{}),/unknown usage/);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM instances').get()!.n,1);
});

test('ordinary request errors do not restart a healthy worker', async t=>{
  const {store,supervisor}=await fixture(t,crashOnRun.replace('process.exit(23)',"process.send({type:'result',error:'Model HTTP error 401'})"));
  await supervisor.start();await assert.rejects(supervisor.run('error',()=>{}),/401/);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM instances').get()!.n,1);
});

test('legacy worker without resume stops safely without duplicating the task',async t=>{
  const {store,supervisor}=await fixture(t,crashOnRun.replace(',resume:true',''));
  await supervisor.start();await assert.rejects(supervisor.run('old version',()=>{}),/does not support safe request recovery/);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM instances').get()!.n,2);
  assert.equal(store.state().current_version,'bad');
});

test('cancellation after replacement ready prevents resuming the model',async t=>{
  let checks=0; let cancel=()=>{};
  const {store,supervisor}=await fixture(t,crashOnRun,{beforeResume:()=>{if(++checks===2)cancel();}});
  cancel=()=>supervisor.cancel();await supervisor.start();
  await assert.rejects(supervisor.run('cancel after ready',()=>{}),/cancelled/);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM instances').get()!.n,2);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM instances WHERE state='failed'").get()!.n,1);
});

test('close during restart admission never resurrects the worker',async t=>{
  let release!:()=>void; let entered!:()=>void;
  const waiting=new Promise<void>(r=>{entered=r;});
  const permission=new Promise<void>(r=>{release=r;});
  const {store,supervisor}=await fixture(t,crashOnRun,{beforeResume:async()=>{entered();await permission;}});
  await supervisor.start();
  const running=assert.rejects(supervisor.run('shutdown',()=>{}),/cancelled/);
  await waiting; const stopping=supervisor.close();release();await stopping;await running;
  assert.equal(store.state().phase,'stopped');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM instances').get()!.n,1);
});

test('startup readiness timeout remains a real process failure with retained diagnostic reason', {timeout:25000},async t=>{
  const {store,supervisor}=await fixture(t,"setInterval(()=>{},1000);",{beforeResume:()=>{throw new Error('stop after timeout evidence');}});
  await assert.rejects(supervisor.start(),/stop after timeout evidence/);
  assert.match(String(store.db.prepare('SELECT reason FROM instances').get()!.reason),/startup timed out/);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM instances').get()!.n,1);
});

test('recovery drains an interrupted management operation before the new worker reads state',async t=>{
  let entered!:()=>void, release!:()=>void;
  const requested=new Promise<void>(r=>{entered=r;});
  const pending=new Promise<void>(r=>{release=r;});
  const source=`import {existsSync} from 'node:fs';import {join} from 'node:path';process.on('message',m=>{if(m.type==='stop')process.exit(0);if(m.type==='run'){if(existsSync(join(process.argv[2],'management-finished')))process.send({type:'result',answer:'drained'});else process.send({type:'management',id:'pending',args:{operation:'status'}});}});process.send({type:'ready',messages:[],resume:true});setInterval(()=>process.send?.({type:'heartbeat'}),1000);`;
  const {store,supervisor,root}=await fixture(t,source);
  supervisor.manage=async()=>{entered();await pending;await writeFile(join(root,'management-finished'),'done');return {};};
  await supervisor.start();const running=supervisor.run('drain',()=>{});
  await requested;
  process.kill(Number(store.db.prepare("SELECT pid FROM instances WHERE ended_at IS NULL").get()!.pid),'SIGKILL');
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM instances').get()!.n,1,'cannot start a concurrent writer');
  release();assert.equal(await running,'drained');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM instances').get()!.n,2);
});
