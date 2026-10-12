import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,readdir,rm,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {createServer as createSocketServer} from 'node:net';
import {parseArgs} from '../src/cli-arguments.ts';
const exec=promisify(execFile);
test('all supervisor commands reach management RPC with their arguments, never run',async t=>{
 const root=await mkdtemp('/tmp/seeda-routes-');t.after(()=>rm(root,{recursive:true,force:true}));
 const received:unknown[]=[];const server=createSocketServer(socket=>{socket.setEncoding('utf8');let buffer='';socket.on('data',chunk=>{buffer+=chunk;let end:number;while((end=buffer.indexOf('\n'))>=0){const request=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);received.push({operation:request.operation,args:request.args});socket.write(JSON.stringify({id:request.id,result:{ok:true}})+'\n');}});});
 await new Promise<void>(r=>server.listen(join(root,'control.sock'),r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const cases:[string[],unknown][]=[
  [['status'],{operation:'manage',args:{operation:'status'}}],
  [['draft'],{operation:'manage',args:{operation:'draft'}}],
  [['submit','draft-id','reason'],{operation:'manage',args:{operation:'submit',draft:'draft-id',reason:'reason'}}],
  [['evaluate','version-id','task'],{operation:'manage',args:{operation:'evaluate',version:'version-id',task:'task'}}],
  [['evidence','eval-id'],{operation:'manage',args:{operation:'evidence',evaluation:'eval-id'}}],
  [['decide','eval-id','accept','reason'],{operation:'manage',args:{operation:'decide',evaluation:'eval-id',decision:'accept',reason:'reason'}}],
  [['promote','version-id','eval-id','reason'],{operation:'manage',args:{operation:'promote',version:'version-id',evaluation:'eval-id',reason:'reason'}}],
  [['rollback','reason'],{operation:'manage',args:{operation:'rollback',reason:'reason'}}],
  [['select','version-id'],{operation:'select',args:{version:'version-id'}}],
  [['stop'],{operation:'stop',args:undefined}]
 ];
 for(const [args,expected]of cases){await exec('seeda',args,{cwd:root,env:{...process.env,SEEDA_HOME:root,DEEPSEEK_API_KEY:''},timeout:3000});assert.deepEqual(received.at(-1),expected);}
 assert.equal(received.length,cases.length);
});
test('strict CLI rejects control typos and malformed arguments before resources are opened',async t=>{
 const root=await mkdtemp('/tmp/seeda-audit-errors-'); t.after(()=>rm(root,{recursive:true,force:true}));
 const env={...process.env,SEEDA_HOME:join(root,'state'),SEEDA_LIBRARY:join(root,'library'),DEEPSEEK_API_KEY:''};
 const invalid=[['publsih'],['version'],['help','extra'],['status','extra'],['stop','extra'],['strains','oops'],['strains','default'],['seed','origin','extra'],['publish'],['publish','name'],['publish','name','--intro'],['publish','name','--intro','one','--intro','two'],['publish','name','version','extra','--intro','one'],['/use'],['/new','extra'],['/unknown'],['run'],['run',''],['run','--unknown'],['decide','eval','maybe','reason'],['submit','draft'],['evaluate','version'],['promote','version','eval']];
 for(const args of invalid){ await assert.rejects(exec(resolve('src/cli.ts'),args,{cwd:root,env,timeout:3000}),error=>{assert.equal((error as {code:number}).code,2,args.join(' '));return true;}); }
 for(const args of [['seed','a','b'],['not-command'],['publish','name','--intro']]) await assert.rejects(exec(process.execPath,['--experimental-strip-types',resolve('src/runtime/cli.ts'),...args],{cwd:root,env}),error=>{assert.equal((error as {code:number}).code,2);return true;});
 assert.deepEqual(await readdir(root),[]);
 assert.deepEqual(parseArgs(['publish','--intro=info.json','name','version']).args,['publish','name','version','--intro','info.json']);
});
test('installed CLI help/version/seeding/publication are real local controls, only run reaches model', {timeout:60000},async t=>{
 const root=await mkdtemp('/tmp/seeda-cli-audit-');const project=join(root,'project');await mkdir(project);
 const artifact=resolve('.seeda',`cli-audit-${Date.now()}`);await mkdir(artifact,{recursive:true});
 let requests=0;const model=createServer(async(req,res)=>{requests++;let text='';for await(const chunk of req)text+=chunk;const user=JSON.parse(text).messages.at(-1).content;res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:{content:user},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');});
 await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));const address=model.address();assert.ok(address&&typeof address!=='string');
 const env:NodeJS.ProcessEnv={...process.env,SEEDA_HOME:join(root,'state'),SEEDA_LIBRARY:join(root,'library'),DEEPSEEK_API_KEY:'',SEEDA_SYSTEM_PROXY:'0',DEEPSEEK_BASE_URL:`http://127.0.0.1:${address.port}`};
 const run=(...args:string[])=>exec('seeda',args,{cwd:project,env,timeout:20000});
 t.after(async()=>{model.closeAllConnections();model.close();await rm(root,{recursive:true,force:true});});
 const operations:string[]=[];
 for(const flag of ['-h','--help','-v','--version']) {const result=await run(flag);assert.equal(result.stderr,'');operations.push(flag);}
 for(const cmd of ['seed','publish','strains','status','submit','evaluate','promote','stop'])assert.match((await run(cmd,'--help')).stdout,/用法：seeda/);
 const strains=JSON.parse((await run('strains')).stdout);assert.equal(strains[0].name,'origin');
 const seeded=JSON.parse((await run('seed','origin')).stdout);operations.push('seed origin');
 const intro=join(root,'intro.json');await writeFile(intro,JSON.stringify({summary:'CLI验证样例',improvements:'用于控制命令实测',scenarios:'本地CLI测试',limitations:'测试种系，无功能质量声明',validation:'本地命令执行验证，未调用真实模型'}));
 const published=JSON.parse((await run('publish','audit-strain','--intro',intro)).stdout);operations.push('publish with intro');assert.equal(published.source_version,seeded.version.id);
 await run('strains','default','audit-strain');operations.push('strains default');
 await assert.rejects(run('seed','origin'),/already seeded/);
 await assert.rejects(run('publish','audit-strain','--intro',intro),/already exists/);
 await assert.rejects(run('publish','bad-json','--intro',join(root,'missing.json')),/ENOENT/);
 await writeFile(intro,'{bad');await assert.rejects(run('publish','bad-json','--intro',intro));
 const stateLibrary=JSON.parse((await run('strains')).stdout);assert.equal(stateLibrary.length,2);assert.equal(stateLibrary.find((row:{name:string})=>row.name==='audit-strain').is_default,true);
 assert.equal(requests,0);await assert.rejects(readFile(join(root,'state/sessions/main.jsonl')),/ENOENT/);
 env.SEEDA_MANAGED='0';env.DEEPSEEK_API_KEY='local-test';env.SEEDA_SESSION=join(root,'task.jsonl');
 assert.match((await run('run','explicit task')).stdout,/explicit task/);assert.equal(requests,1);
 assert.match((await run('--','stop')).stdout,/stop/);assert.equal(requests,2);
 await writeFile(join(artifact,'report.json'),JSON.stringify({status:'passed',operations,control_model_requests:0,explicit_task_requests:requests},null,2));
});
