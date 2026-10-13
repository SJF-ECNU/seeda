import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DeepSeekModel } from '../src/model/deepseek.ts';
const complete = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

test('real model retries 503 and per-attempt timeout, but never 401 or already streamed text', async t => {
 let scenario='503';let requests=0;
 const http=createServer((req,res)=>{requests++;res.setHeader('Content-Type','text/event-stream');
  if(scenario==='503'&&requests===1){res.statusCode=503;res.end();}
  else if(scenario==='timeout'&&requests===1){setTimeout(()=>res.end(complete),100);}
  else if(scenario==='401'){res.statusCode=401;res.end();}
  else if(scenario==='partial'){res.end('data: {"choices":[{"delta":{"content":"part"}}]}\n\n');}
  else res.end(complete);
 });
 await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const address=http.address();assert.ok(address&&typeof address!=='string');
 t.after(()=>{http.closeAllConnections();http.close();});
 const model=new DeepSeekModel({apiKey:'local-test',baseUrl:`http://127.0.0.1:${address.port}`,timeoutMs:30,retry:{baseDelayMs:1}});
 assert.equal((await model.complete([],[],new AbortController().signal)).message.content,'ok');assert.equal(requests,2);
 scenario='timeout';requests=0;assert.equal((await model.complete([],[],new AbortController().signal)).message.content,'ok');assert.equal(requests,2);
 scenario='401';requests=0;await assert.rejects(model.complete([],[],new AbortController().signal),/401/);assert.equal(requests,1);
 scenario='partial';requests=0;let text='';await assert.rejects(model.complete([],[],new AbortController().signal,s=>{text+=s;}),/interrupted/);assert.equal(requests,1);assert.equal(text,'part');
});
