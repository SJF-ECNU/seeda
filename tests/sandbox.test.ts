import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { spawnSync, fork } from 'node:child_process';
import { SandboxCandidate, sandboxBackend } from '../src/sandbox/candidate.ts';

const processSupported = process.platform === 'darwin' || process.platform === 'linux' && spawnSync('bwrap', ['--version']).status === 0;
const dockerSupported = spawnSync('docker', ['info', '--format', '{{.OSType}}'], { timeout: 10000 }).status === 0;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'seeda-sandbox-'));
  const runtime = join(root, 'runtime'); await mkdir(join(runtime, 'src/runtime'), { recursive: true });
  await mkdir(join(runtime, 'node_modules'));
  await writeFile(join(runtime, 'package.json'), '{"name":"sandbox-fixture","version":"1.0.0","type":"module"}');
  await writeFile(join(runtime, 'package-lock.json'), '{"name":"sandbox-fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"sandbox-fixture","version":"1.0.0"}}}');
  return { root, runtime, work: join(root, 'sandbox') };
}
const checkingWorker = `
import {readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {Socket} from 'node:net';
process.send({type:'ready'});
process.on('message',async m=>{
 if(m.type!=='run')return;
 const input=JSON.parse(m.input), cwd=process.argv[2];
 const results={};
 for(const op of ['read','write','symlink','signal']){
  try{if(op==='read')readFileSync(input.secret);if(op==='write')writeFileSync(input.secret,'bad');if(op==='symlink'){symlinkSync(input.secret,cwd+'/link');readFileSync(cwd+'/link');}if(op==='signal')process.kill(input.pid,0);results[op]='ALLOWED';}catch{results[op]='blocked';}
 }
 results.key=process.env.DEEPSEEK_API_KEY;
 writeFileSync(cwd+'/ok.txt','sandbox');
 results.fork=spawnSync('/bin/sh',['-c','echo child'],{encoding:'utf8'}).status;
 results.network=await new Promise(resolve=>{const s=new Socket();s.setTimeout(300);s.on('connect',()=>{s.destroy();resolve('ALLOWED');});s.on('error',()=>resolve('blocked'));s.on('timeout',()=>{s.destroy();resolve('blocked');});s.connect(input.port,'127.0.0.1');});
 results.socket=await new Promise(resolve=>{const s=new Socket();s.setTimeout(300);s.on('connect',()=>{s.destroy();resolve('ALLOWED');});s.on('error',()=>resolve('blocked'));s.on('timeout',()=>{s.destroy();resolve('blocked');});s.connect(input.socketPath);});
 process.send({type:'process',pid:input.pid,started:true});
 const response=await fetch(process.env.DEEPSEEK_BASE_URL+'/chat/completions',{method:'POST',body:JSON.stringify({model:process.env.DEEPSEEK_MODEL,messages:[]})});
 results.model=await response.text();
 process.send({type:'result',answer:JSON.stringify(results)});
});`;
for (const backend of ['process', 'container'] as const) {
 test(`${backend} sandbox enforces file/network/credential boundaries and host model broker`, { skip: backend === 'process' ? !processSupported : !dockerSupported, timeout: 40000 }, async t => {
  const f = await fixture(); const secret = join(f.root, 'secret'); await writeFile(secret, 'private');
  await writeFile(join(f.runtime, 'src/runtime/worker.ts'), checkingWorker);
  const socketPath=join(f.root,'control.sock'); const socketServer=createSocketServer(s=>s.destroy());await new Promise<void>(r=>socketServer.listen(socketPath,r));
  const prior = { key: process.env.DEEPSEEK_API_KEY, base: process.env.DEEPSEEK_BASE_URL };
  let calls=0;
  const server=createServer((req,res)=>{assert.equal(req.url,'/chat/completions');assert.equal(req.headers.authorization,'Bearer host-only-secret');calls++;res.end('model-ok');});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
  process.env.DEEPSEEK_API_KEY='host-only-secret';process.env.DEEPSEEK_BASE_URL=`http://127.0.0.1:${address.port}`;
  const candidate=new SandboxCandidate(backend,f.runtime,f.work,()=>{});
  t.after(async()=>{await candidate.stop().catch(()=>{});server.closeAllConnections();server.close();socketServer.close();await rm(f.root,{recursive:true,force:true});for(const [key,value]of Object.entries(prior)){const name=key==='key'?'DEEPSEEK_API_KEY':'DEEPSEEK_BASE_URL';if(value===undefined)delete process.env[name];else process.env[name]=value;}});
  const answer=JSON.parse(await candidate.run(JSON.stringify({secret,pid:process.pid,port:address.port,socketPath})));
  assert.equal(answer.read,'blocked');assert.equal(answer.write,'blocked');assert.equal(answer.symlink,'blocked');assert.equal(answer.signal,'blocked');assert.equal(answer.network,'blocked');assert.equal(answer.socket,'blocked');
  assert.equal(answer.key,'sandbox-host-broker');assert.equal(answer.model,'model-ok');assert.equal(calls,1);
  assert.equal(answer.fork,backend==='process'&&process.platform==='darwin'?null:0);
  assert.equal(await readFile(join(f.work,'workspace/ok.txt'),'utf8'),'sandbox');
  await candidate.stop();assert.equal(await readFile(secret,'utf8'),'private');
  if(backend==='container')assert.notEqual(spawnSync('docker',['inspect',`seeda-eval-${candidate.id}`]).status,0);
 });
}
test('sandbox selection rejects none and unknown values',()=>{
 assert.equal(sandboxBackend(undefined),'process');assert.equal(sandboxBackend('container'),'container');
 for(const value of ['none','docker',null,{},true])assert.throws(()=>sandboxBackend(value),/sandbox must/);
});
test('malformed output fails rather than becoming evaluation evidence', {skip:!processSupported},async()=>{
 const f=await fixture();await writeFile(join(f.runtime,'src/runtime/worker.ts'),"console.log('not protocol');");
 const candidate=new SandboxCandidate('process',f.runtime,f.work,()=>{});
 try{await assert.rejects(candidate.ready,/Invalid/);}finally{await candidate.stop().catch(()=>{});await rm(f.root,{recursive:true,force:true});}
});
test('guardian reclaims workload when supervisor is killed', {skip:!processSupported,timeout:15000},async()=>{
 const f=await fixture();await writeFile(join(f.runtime,'src/runtime/worker.ts'),`import{writeFileSync}from'node:fs';import{spawn}from'node:child_process';const cwd=process.argv[2];writeFileSync(cwd+'/pid',String(process.pid));if(process.platform==='linux')spawn(process.execPath,['-e',\`const fs=require('fs');setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),10)\`,cwd+'/heartbeat'],{detached:true,stdio:'ignore'}).unref();setInterval(()=>writeFileSync(cwd+'/heartbeat',String(Date.now())),10);`);
 const launcher=join(f.root,'launcher.mjs');
 await writeFile(launcher,`import{SandboxCandidate}from ${JSON.stringify('file://'+resolve('src/sandbox/candidate.ts'))};new SandboxCandidate('process',${JSON.stringify(f.runtime)},${JSON.stringify(f.work)},()=>{});process.send('started');`);
 const parent=fork(launcher,[],{execArgv:['--experimental-strip-types'],stdio:['ignore','ignore','ignore','ipc']});
 let pid=0;
 try{
  for(let n=0;n<100&&!pid;n++){try{pid=Number(await readFile(join(f.work,'workspace/pid'),'utf8'));}catch{}if(!pid)await new Promise(r=>setTimeout(r,30));}
  assert.ok(pid);await new Promise(r=>setTimeout(r,100));
  const exit=new Promise(r=>parent.once('exit',r));parent.kill('SIGKILL');await exit;
  if(process.platform==='darwin'){
   for(let n=0;n<100;n++){try{process.kill(pid,0);}catch{pid=0;break;}await new Promise(r=>setTimeout(r,30));}
   assert.equal(pid,0);
  }
  // Namespace PIDs cannot identify host processes. Observe both worker and detached child stop writing.
  await new Promise(r=>setTimeout(r,200));const before=await readFile(join(f.work,'workspace/heartbeat'),'utf8');
  await new Promise(r=>setTimeout(r,150));assert.equal(await readFile(join(f.work,'workspace/heartbeat'),'utf8'),before);
 }finally{parent.kill('SIGKILL');await rm(f.root,{recursive:true,force:true});}
});
test('cancel terminates a running evaluation and reclaims its container', {skip:!dockerSupported,timeout:30000},async()=>{
 const f=await fixture();await writeFile(join(f.runtime,'src/runtime/worker.ts'),`import{spawn}from'node:child_process';process.send({type:'ready'});process.on('message',m=>{if(m.type==='run'){spawn('node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref();}});`);
 const candidate=new SandboxCandidate('container',f.runtime,f.work,()=>{});
 try{await candidate.ready;const running=assert.rejects(candidate.run('block'),/cancelled/);candidate.cancel();await running;await candidate.stop();assert.notEqual(spawnSync('docker',['inspect',`seeda-eval-${candidate.id}`]).status,0);}
 finally{await candidate.stop().catch(()=>{});await rm(f.root,{recursive:true,force:true});}
});
test('container guardian removes detached descendants after supervisor death', {skip:!dockerSupported,timeout:30000},async()=>{
 const f=await fixture();await writeFile(join(f.runtime,'src/runtime/worker.ts'),`import{spawn}from'node:child_process';spawn('node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref();process.send({type:'ready'});setInterval(()=>{},1000);`);
 const launcher=join(f.root,'launcher.mjs');
 await writeFile(launcher,`import{SandboxCandidate}from ${JSON.stringify('file://'+resolve('src/sandbox/candidate.ts'))};const c=new SandboxCandidate('container',${JSON.stringify(f.runtime)},${JSON.stringify(f.work)},()=>{});await c.ready;process.send(c.id);`);
 const parent=fork(launcher,[],{execArgv:['--experimental-strip-types'],stdio:['ignore','ignore','ignore','ipc']});
 try{
  const id=await new Promise<string>((r,j)=>{parent.once('message',m=>r(String(m)));parent.once('exit',()=>j(new Error('launcher failed')));});
  const exit=new Promise(r=>parent.once('exit',r));parent.kill('SIGKILL');await exit;
  let exists=true;for(let n=0;n<60&&exists;n++){exists=spawnSync('docker',['inspect',`seeda-eval-${id}`]).status===0;if(exists)await new Promise(r=>setTimeout(r,50));}
  assert.equal(exists,false);
 }finally{parent.kill('SIGKILL');await rm(f.root,{recursive:true,force:true});}
});
test('oversized candidate output is rejected and stopped', {skip:!processSupported,timeout:15000},async()=>{
 const f=await fixture();await writeFile(join(f.runtime,'src/runtime/worker.ts'),`process.stdout.write('x'.repeat(17*1024*1024));setInterval(()=>{},1000);`);
 const candidate=new SandboxCandidate('process',f.runtime,f.work,()=>{});
 try{await assert.rejects(candidate.ready,/oversized|output limit/);}finally{await candidate.stop().catch(()=>{});await rm(f.root,{recursive:true,force:true});}
});
test('unavailable container executable fails without process fallback', {timeout:15000},async()=>{
 const f=await fixture();await writeFile(join(f.runtime,'src/runtime/worker.ts'),"process.send({type:'ready'});");
 const path=process.env.PATH;process.env.PATH='';const candidate=new SandboxCandidate('container',f.runtime,f.work,()=>{});
 try{await assert.rejects(candidate.ready,/could not start|cleanup|exited/);}finally{await candidate.stop().catch(()=>{});process.env.PATH=path;await rm(f.root,{recursive:true,force:true});}
});
test('candidate management messages cannot reach the supervisor', {skip:!processSupported},async()=>{
 const f=await fixture();await writeFile(join(f.runtime,'src/runtime/worker.ts'),"process.send({type:'ready'});process.on('message',()=>process.send({type:'management',args:{operation:'promote'}}));");
 const candidate=new SandboxCandidate('process',f.runtime,f.work,()=>{});
 try{await assert.rejects(candidate.run('test'),/Invalid/);}finally{await candidate.stop().catch(()=>{});await rm(f.root,{recursive:true,force:true});}
});
test('guardian deadline terminates an unresponsive workload', {timeout:10000},async()=>{
 const child=fork(resolve('src/sandbox/guardian.mjs'),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
 let failure='';child.on('message',(message: {type:string;error?:string})=>{if(message.type==='failure')failure=message.error??'';});
 const exit=new Promise(r=>child.once('exit',r));
 child.send({type:'start',command:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{},timeoutMs:100});
 await exit;assert.match(failure,/timed out/);
});
