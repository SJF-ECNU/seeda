import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { VersionStore } from '../src/versions/store.ts';
import { Supervisor } from '../src/runtime/supervisor.ts';
import { RuntimeClient } from '../src/runtime/client.ts';
const exec = promisify(execFile);

test('saved full-source versions do not replace the running installation or frontend', async t => {
 const root = await mkdtemp(join(tmpdir(), 'seeda-front-')); const store = await VersionStore.open(join(root,'state'));
 const originalKey = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY='local-test';
 const supervisor = new Supervisor(store,root);let client:RuntimeClient|undefined;
 t.after(async()=>{client?.close();await supervisor.close();store.close();if(originalKey===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=originalKey;await rm(root,{recursive:true,force:true});});
 const a=await store.initialize(resolve('.'));
 for(const file of ['src/cli.ts','src/tui/state.ts','src/runtime/supervisor.ts','src/versions/store.ts'])assert.ok((await readFile(join(a.runtime_path,file))).length);
 const manifest=JSON.parse(await readFile(join(a.runtime_path,'package.json'),'utf8'));assert.deepEqual(manifest.bin,{seeda:'src/cli.ts'});assert.equal(manifest.name,'seeda');assert.ok(manifest.scripts.manage);
 // Saved implementation files cannot replace the already running installation.
 await writeFile(join(a.runtime_path,'src/cli.ts'),"throw new Error('BROKEN VERSION FRONTEND');");
 await supervisor.start(); client=await RuntimeClient.connect(supervisor.socketPath);
 const env={...process.env,SEEDA_HOME:store.root};
 assert.match((await exec('seeda',['status'],{cwd:root,env})).stdout,new RegExp(a.id));
 assert.match((await exec('seeda',['--help'],{cwd:root,env})).stdout,/用法：seeda/);
 const draft=await store.draft(a.id);
 await writeFile(join(draft.path,'src/cli.ts'),"throw new Error('CANDIDATE FRONTEND NOT INSTALLED');");
 const agentPath=join(draft.path,'src/core/agent.ts');await writeFile(agentPath,(await readFile(agentPath,'utf8'))+'\n// Candidate implementation change.\n');
 const b=await store.submit(draft.id,'Full implementation change');assert.match(await readFile(join(b.runtime_path,'src/cli.ts'),'utf8'),/CANDIDATE FRONTEND NOT INSTALLED/);
 await client.request('select',{version:b.id});const status=await client.request('manage',{operation:'status'}) as {current_version:string;phase:string};assert.equal(status.current_version,b.id);assert.equal(status.phase,'running');
 assert.match((await exec('seeda',['status'],{cwd:root,env})).stdout,new RegExp(b.id));
});
