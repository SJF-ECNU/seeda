import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BashTool } from '../src/tools/bash.ts';
import { Agent } from '../src/core/agent.ts';
import { Session } from '../src/core/session.ts';
test('Bash cleanup EPERM is contained and a failed command does not prevent another Agent turn', async t => {
 const cwd=await mkdtemp(join(tmpdir(),'seeda-command-fail-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const originalKill=process.kill;
 t.mock.method(process,'kill',(pid:number,signal?:number|NodeJS.Signals)=>{if(pid<0)throw Object.assign(new Error('not permitted'),{code:'EPERM'});return originalKill(pid,signal);});
 const bash=new BashTool();const result=await bash.execute({command:'exit 1'},{cwd,artifactDir:cwd,signal:new AbortController().signal});
 assert.equal((result as {status:string}).status,'failed');assert.match((result as {error:string}).error,/EPERM/);
 t.mock.restoreAll();const session=await Session.open(join(cwd,'session.jsonl'),cwd);let calls=0;
 const agent=new Agent({cwd,session,artifactDir:cwd,tools:[bash],model:{async complete(){calls++;return calls===1?{finishReason:'tool_calls',message:{role:'assistant' as const,content:null,tool_calls:[{id:'fail-test',type:'function' as const,function:{name:'bash',arguments:'{"command":"exit 1"}'}}]}}:{finishReason:'stop',message:{role:'assistant' as const,content:'continued'}};}}});
 assert.equal(await agent.run('run a failing test'),'continued');assert.equal(await agent.run('continue working'),'continued');
 const tool=session.messages.find(m=>m.role==='tool');assert.equal(JSON.parse(tool!.content!).exit_code,1);
});
