import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/core/agent.ts';
import { Session } from '../src/core/session.ts';
import { ContextTokens } from '../src/core/context.ts';

test('default 1M token budget allows input beyond the old character limit and reserves output', async t => {
 const cwd=await mkdtemp(join(tmpdir(),'seeda-token-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const session=await Session.open(join(cwd,'session.jsonl'),cwd);let calls=0;
 const agent=new Agent({cwd,session,artifactDir:cwd,tools:[],model:{async complete(){calls++;return {message:{role:'assistant' as const,content:'ok'},finishReason:'stop'};}}});
 await agent.run('x'.repeat(200_000));assert.equal(calls,1);
 assert.equal((agent as unknown as {inputBudget:number}).inputBudget,995_904);
});
test('provider prompt usage calibrates tokens, new content is estimated, reset drops stale usage',()=>{
 const meter=new ContextTokens([]);const history=[{role:'user' as const,content:'中文 mixed text'}];
 meter.record('system',history,700_000);assert.equal(meter.estimate('system',history),700_000);
 assert.ok(meter.estimate('system',[...history,{role:'user',content:'new content'}])>700_000);
 meter.reset();assert.ok(meter.estimate('system',history)<700_000);
});
