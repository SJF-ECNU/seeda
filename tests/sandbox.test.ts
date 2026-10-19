import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { spawnSync, fork } from 'node:child_process';
import { SandboxCandidate, sandboxBackend, macProfile } from '../src/sandbox/candidate.ts';

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
import {readFileSync,writeFileSync,symlinkSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {Socket} from 'node:net';
process.send({type:'ready'});
process.on('message',async m=>{
 if(m.type!=='run')return;
 const input=JSON.parse(m.input), cwd=process.argv[2];
 const results={home:process.env.HOME,tmp:process.env.TMPDIR,temp:process.env.TEMP,tmpAlias:process.env.TMP,cwd};
 for(const op of ['read','write','symlink','signal','markerRead','markerRemove']){
  try{if(op==='markerRead')readFileSync(cwd+'/../.host-only');if(op==='markerRemove')unlinkSync(cwd+'/../.host-only');if(op==='read')readFileSync(input.secret);if(op==='write')writeFileSync(input.secret,'bad');if(op==='symlink'){symlinkSync(input.secret,cwd+'/link');readFileSync(cwd+'/link');}if(op==='signal')process.kill(input.pid,0);results[op]='ALLOWED';}catch{results[op]='blocked';}
 }
 results.key=process.env.DEEPSEEK_API_KEY;
 writeFileSync(cwd+'/ok.txt','sandbox');
 results.fork=spawnSync('/bin/sh',['-c','echo child'],{encoding:'utf8'}).status;
 const childCode="const fs=require('fs'),out={};for(const op of ['read','write','signal']){try{if(op==='read')fs.readFileSync(process.argv[1]);if(op==='write')fs.writeFileSync(process.argv[1],'bad');if(op==='signal')process.kill(Number(process.argv[2]),0);out[op]='ALLOWED';}catch{out[op]='blocked';}}console.log(JSON.stringify(out));";
 results.child=JSON.parse(spawnSync(process.execPath,['-e',childCode,input.secret,String(input.pid)],{encoding:'utf8'}).stdout);
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
  assert.equal(answer.home,answer.cwd);assert.equal(answer.tmp,answer.cwd+'/.seeda-tmp');assert.equal(answer.temp,answer.tmp);assert.equal(answer.tmpAlias,answer.tmp);
  assert.equal(answer.read,'blocked');assert.equal(answer.write,'blocked');assert.equal(answer.symlink,'blocked');assert.equal(answer.signal,'blocked');assert.equal(answer.network,'blocked');assert.equal(answer.socket,'blocked');
  assert.equal(answer.markerRead,'blocked');assert.equal(answer.markerRemove,'blocked');assert.equal(answer.key,'sandbox-host-broker');assert.equal(answer.model,'model-ok');assert.equal(calls,1);
  assert.equal(answer.fork,0);assert.deepEqual(answer.child,{read:'blocked',write:'blocked',signal:'blocked'});
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
 const f=await fixture();await writeFile(join(f.runtime,'src/runtime/worker.ts'),`import{writeFileSync}from'node:fs';import{spawn}from'node:child_process';const cwd=process.argv[2];writeFileSync(cwd+'/pid',String(process.pid));spawn(process.execPath,['-e',\`const fs=require('fs');setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),10)\`,cwd+'/heartbeat'],{detached:true,stdio:'ignore'}).unref();setInterval(()=>writeFileSync(cwd+'/heartbeat',String(Date.now())),10);`);
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
test('macOS process runs Bash, Node tests, TypeScript, npm and Git without Docker', {skip:process.platform!=='darwin',timeout:20000},async t=>{
 const f=await fixture();let calls=0;const events: {type:string;result?:{exit_code:number;output:string}}[]=[];
 const command="set -e; pwd; node --version; tsc --version; npm --version; git init -q .; git status --short; printf 'import {test} from \"node:test\";test(\"child test\",()=>{});' > child.test.mjs; node --test child.test.mjs";
 const server=createServer(async(req,res)=>{for await(const _ of req){};const delta=calls++===0?{tool_calls:[{index:0,id:'coding-check',type:'function',function:{name:'bash',arguments:JSON.stringify({command})}}]}:{content:'coding tools verified'};res.setHeader('Content-Type','text/event-stream');res.end(`data: ${JSON.stringify({choices:[{delta,finish_reason:calls===1?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
 const previous={DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY,DEEPSEEK_BASE_URL:process.env.DEEPSEEK_BASE_URL,SEEDA_SYSTEM_PROXY:process.env.SEEDA_SYSTEM_PROXY};
 process.env.DEEPSEEK_API_KEY='local-tools-check';process.env.DEEPSEEK_BASE_URL=`http://127.0.0.1:${address.port}`;process.env.SEEDA_SYSTEM_PROXY='0';
 const candidate=new SandboxCandidate('process',resolve('.'),f.work,event=>events.push(event as typeof events[number]));
 t.after(async()=>{await candidate.stop().catch(()=>{});server.closeAllConnections();server.close();await rm(f.root,{recursive:true,force:true});for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 assert.equal(await candidate.run('Run the coding checks'),'coding tools verified');
 const result=events.find(e=>e.type==='tool_end')?.result;assert.equal(result?.exit_code,0,JSON.stringify(result));assert.match(result!.output,/child test/);assert.equal(calls,2);
});
test('macOS cleanup reclaims reparented children without touching another sandbox', {skip:process.platform!=='darwin',timeout:20000},async()=>{
 const f=await fixture();
 await writeFile(join(f.runtime,'src/runtime/worker.ts'),`import{spawnSync}from'node:child_process';import{writeFileSync}from'node:fs';const work=process.argv[2];process.send({type:'ready'});process.on('message',m=>{const code="const{spawn}=require('child_process');const c=spawn(process.execPath,['-e',\\\"const fs=require('fs');setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),10)\\\",process.argv[1]],{detached:true,stdio:'ignore'});c.unref();";const p=spawnSync(process.execPath,['-e',code,work+'/beat']);if(p.status!==0)throw new Error(String(p.stderr));process.send({type:'result',answer:'spawned'});if(m.input==='exit')setTimeout(()=>process.exit(0),50);});setInterval(()=>writeFileSync(work+'/root-beat',String(Date.now())),10);`);
 const a=new SandboxCandidate('process',f.runtime,join(f.root,'a'),()=>{});const b=new SandboxCandidate('process',f.runtime,join(f.root,'b'),()=>{});
 try{
  assert.equal(await a.run('exit'),'spawned');assert.equal(await b.run('start'),'spawned');await new Promise(r=>setTimeout(r,100));
  await new Promise(r=>setTimeout(r,150));const before=await readFile(join(f.root,'a/workspace/beat'),'utf8');const other=await readFile(join(f.root,'b/workspace/beat'),'utf8');
  await new Promise(r=>setTimeout(r,150));assert.equal(await readFile(join(f.root,'a/workspace/beat'),'utf8'),before);assert.notEqual(await readFile(join(f.root,'b/workspace/beat'),'utf8'),other);
  process.kill(process.pid,0);
 }finally{await a.stop().catch(()=>{});await b.stop().catch(()=>{});await rm(f.root,{recursive:true,force:true});}
});
test('macOS cancellation and guardian deadline reclaim detached children', {skip:process.platform!=='darwin',timeout:20000},async()=>{
 const f=await fixture();
 const childCode="const fs=require('fs');setInterval(()=>fs.writeFileSync(process.argv[1],String(Date.now())),10)";
 await writeFile(join(f.runtime,'src/runtime/worker.ts'),`import{spawn}from'node:child_process';const work=process.argv[2];spawn(process.execPath,['-e',${JSON.stringify(childCode)},work+'/beat'],{detached:true,stdio:'ignore'}).unref();process.send({type:'ready'});setInterval(()=>{},1000);`);
 const candidate=new SandboxCandidate('process',f.runtime,f.work,()=>{});
 const stoppedWriting=async(path:string)=>{const before=await readFile(path,'utf8');await new Promise(r=>setTimeout(r,120));assert.equal(await readFile(path,'utf8'),before);};
 try{
  await candidate.ready;await new Promise(r=>setTimeout(r,100));const running=assert.rejects(candidate.run('block'),/cancelled/);candidate.cancel();await running;await candidate.stop();await stoppedWriting(join(f.work,'workspace/beat'));
  // Exercise the same host guardian with a short deadline, without waiting 120 seconds.
  const work=join(f.root,'timeout');await mkdir(work);await writeFile(join(work,'.host-only'),'');const{realpath}=await import('node:fs/promises');const canonical=await realpath(work);const runtime=await realpath(f.runtime);
  const guardian=fork(resolve('src/sandbox/guardian.mjs'),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
  let failure='';guardian.on('message',(m:{type:string;error?:string})=>{if(m.type==='failure')failure=m.error??'';});const exit=new Promise(r=>guardian.once('exit',r));
  guardian.send({type:'start',command:'/usr/bin/sandbox-exec',args:['-p',macProfile(runtime,canonical),process.execPath,resolve('src/sandbox/bridge.mjs'),join(runtime,'src/runtime/worker.ts'),canonical],env:{PATH:'/usr/bin:/bin',SEEDA_SANDBOX_VERIFY:'1'},macCleanup:[canonical,join(canonical,'.host-only')],timeoutMs:500});
  await exit;assert.match(failure,/timed out/);await stoppedWriting(join(work,'beat'));process.kill(process.pid,0);
 }finally{await candidate.stop().catch(()=>{});await rm(f.root,{recursive:true,force:true});}
});
test('macOS refuses candidate loading when kernel ownership cannot be verified', {skip:process.platform!=='darwin',timeout:10000},async()=>{
 const f=await fixture();await mkdir(f.work);await writeFile(join(f.work,'.host-only'),'');
 await writeFile(join(f.runtime,'src/runtime/worker.ts'),`import{writeFileSync}from'node:fs';writeFileSync(process.argv[2]+'/loaded','unsafe');setInterval(()=>{},1000);`);
 const{realpath}=await import('node:fs/promises');const work=await realpath(f.work);const runtime=await realpath(f.runtime);
 // Simulate an unsupported/incorrect policy. Only the trusted bridge can run.
 const denied=`(deny file-read* file-write* (literal ${JSON.stringify(join(work,'.host-only'))}))`;
 const profile=macProfile(runtime,work).replace(denied,'');assert.ok(!profile.includes('.host-only'));
 const guardian=fork(resolve('src/sandbox/guardian.mjs'),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
 let failure='';guardian.on('message',(m:{type:string;error?:string})=>{if(m.type==='failure')failure=m.error??'';});const exit=new Promise(r=>guardian.once('exit',r));
 guardian.send({type:'start',command:'/usr/bin/sandbox-exec',args:['-p',profile,process.execPath,resolve('src/sandbox/bridge.mjs'),join(runtime,'src/runtime/worker.ts'),work],env:{SEEDA_SANDBOX_VERIFY:'1'},macCleanup:[work,join(work,'.host-only')],timeoutMs:3000});
 try{await exit;assert.match(failure,/Cannot verify/);await assert.rejects(readFile(join(work,'loaded')));process.kill(process.pid,0);}
 finally{guardian.kill('SIGKILL');await rm(f.root,{recursive:true,force:true});}
});

for (const timeoutMs of [500, null]) {
 test(`candidate budget ${timeoutMs ?? 'unset'} keeps termination and cleanup`, {skip:!processSupported,timeout:12000}, async()=>{
  const f=await fixture();
  await writeFile(join(f.runtime,'src/runtime/worker.ts'), `import{writeFileSync}from'node:fs';process.send({type:'ready'});process.on('message',m=>{if(m.type==='run'){writeFileSync(process.argv[2]+'/pid',String(process.pid));setInterval(()=>{},50);}});`);
  const candidate=new SandboxCandidate('process',f.runtime,f.work,()=>{}, timeoutMs===null ? null : {timeoutMs,maxModelCalls:64});
  try {
   await candidate.ready;
   const running=assert.rejects(candidate.run('wait'), timeoutMs===null ? /cancelled/ : /timed out/);
   if(timeoutMs===null){await new Promise(r=>setTimeout(r,800));candidate.cancel();}
   await running;await candidate.stop().catch(error=>{if(timeoutMs===null)throw error;assert.match(error.message,/timed out/);});
   const pid=Number(await readFile(join(f.work,'workspace/pid'),'utf8'));
   if(process.platform==='darwin')assert.throws(()=>process.kill(pid,0));
  } finally {await candidate.stop().catch(()=>{});await rm(f.root,{recursive:true,force:true});}
 });
}

test('unbudgeted sandbox accepts cumulative output above 16 MiB but rejects oversized messages', {skip:!processSupported,timeout:20000},async()=>{
 for(const oversized of [false,true]){
  const f=await fixture();let events=0;
  await writeFile(join(f.runtime,'src/runtime/worker.ts'), `process.send({type:'ready'});process.on('message',m=>{if(m.type!=='run')return;if(${oversized})process.stdout.write('x'.repeat(9*1024*1024));else{for(let n=0;n<17000;n++)process.send({type:'event',event:{type:'text',text:'x'.repeat(1024)}});process.send({type:'result',answer:'streamed'});}});`);
  const candidate=new SandboxCandidate('process',f.runtime,f.work,()=>{events++;},null);
  try {
   if(oversized)await assert.rejects(candidate.run('output'),/oversized|output limit/);
   else{assert.equal(await candidate.run('output'),'streamed');assert.equal(events,17000);}
  }finally{await candidate.stop().catch(()=>{});await rm(f.root,{recursive:true,force:true});}
 }
});

test('process sandbox supports Python multiprocessing without granting other semaphore namespaces', { skip: process.platform !== 'darwin', timeout: 15000 }, async t => {
  const f = await fixture();
  await writeFile(join(f.runtime, 'src/runtime/worker.ts'), `
import {spawnSync} from 'node:child_process';
process.send({type:'ready'});
process.on('message',m=>{if(m.type!=='run')return;
const p=spawnSync('/Applications/Xcode.app/Contents/Developer/usr/bin/python3',['-c',\`import multiprocessing as m
import _multiprocessing
lock=m.get_context('spawn').Lock()
assert lock.acquire(False)
lock.release()
from pathlib import Path
import os,tempfile
root=Path(os.environ['HOME']).resolve()
assert root.name == 'workspace'
assert all(Path(os.environ[k]).resolve() == root/'.seeda-tmp' for k in ('TMPDIR','TMP','TEMP'))
with tempfile.TemporaryDirectory() as td:
 current=Path(td).resolve()
 assert root in current.parents
 while current != root:
  list(current.iterdir())
  current=current.parent
p=Path(os.environ['TMPDIR'])/'pool_probe.py'
p.write_text(chr(10).join(["import multiprocessing as m", "def square(x):return x*x", "if __name__ == '__main__':", " for method in ('spawn','fork'):", "  with m.get_context(method).Pool(2) as pool: assert pool.map(square,[2,3])==[4,9]"]))
import subprocess,sys
subprocess.run([sys.executable,str(p)],check=True)
try: _multiprocessing.SemLock(0,1,1,'/foreign-seeda-test',True)
except PermissionError: pass
else: raise AssertionError('foreign namespace allowed')
print('multiprocessing-ready')\`],{encoding:'utf8'});
process.send({type:'result',answer:JSON.stringify({code:p.status,out:p.stdout,err:p.stderr})});});`);
  const candidate = new SandboxCandidate('process', f.runtime, f.work, () => {});
  t.after(async () => { await candidate.stop(); await rm(f.root, {recursive:true,force:true}); });
  const result=JSON.parse(await candidate.run('probe'));
  assert.equal(result.code,0,result.err);assert.match(result.out,/multiprocessing-ready/);
});
