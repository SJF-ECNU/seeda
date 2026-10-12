import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
const exec = promisify(execFile);
test('help/version/unknown options stay local with an existing supervisor socket and invalid network configuration', async t => {
  const root = await mkdtemp('/tmp/seeda-help-'); let connections = 0;
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(socket => { connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(join(root,'control.sock'),resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); server.close(); await rm(root,{recursive:true,force:true}); });
  const env = {...process.env,SEEDA_HOME:root,SEEDA_LIBRARY:join(root,'library'),DEEPSEEK_API_KEY:'',HTTPS_PROXY:'invalid-proxy'};
  const run = (...args:string[]) => exec(process.execPath,['--experimental-strip-types',resolve('src/cli.ts'),...args],{cwd:root,env,timeout:3000});
  for (const args of [['-h'],['--help'],['seed','--help'],['publish','--help']]) {
    const result=await run(...args); assert.match(result.stdout,/用法：seeda/); assert.match(result.stdout,/--intro FILE/); assert.equal(result.stderr,'');
  }
  assert.match((await run('--version')).stdout,/seeda \d+\.\d+\.\d+/);
  assert.match((await run('-v')).stdout,/seeda /);
  for (const args of [['--unknown'],['seed','--unknown'],['--']]) await assert.rejects(run(...args), error => { assert.equal((error as {code:number}).code,2); return true; });
  assert.equal(connections,0); assert.deepEqual(await readdir(root),['control.sock']);
});

test('-- treats help-looking text as an explicit prompt', async t => {
  const {createServer} = await import('node:http');
  const root=await mkdtemp('/tmp/seeda-literal-'); let prompt='';
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    prompt=JSON.parse(body).messages.at(-1).content;
    res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:{content:'literal handled'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
  t.after(async()=>{server.closeAllConnections();server.close();await rm(root,{recursive:true,force:true});});
  const result=await exec(process.execPath,['--experimental-strip-types',resolve('src/cli.ts'),'--','-h'],{cwd:root,env:{...process.env,SEEDA_MANAGED:'0',SEEDA_SYSTEM_PROXY:'0',DEEPSEEK_API_KEY:'test',DEEPSEEK_BASE_URL:`http://127.0.0.1:${address.port}`}});
  assert.equal(prompt,'-h');assert.match(result.stdout,/literal handled/);
});
