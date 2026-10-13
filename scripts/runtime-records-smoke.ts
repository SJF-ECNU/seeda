import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureNetwork } from '../src/model/network.ts';

const source = resolve(process.argv[2] ?? '.');
const { Agent, Session, DeepSeekModel, BashTool } = await import(pathToFileURL(join(source, 'src/index.ts')).href);
const root = resolve('.seeda', `runtime-records-smoke-${Date.now()}`), cwd = join(root, 'project');
await mkdir(cwd, { recursive: true, mode: 0o700 });
const session = await Session.open(join(root, 'session.jsonl'), cwd);
let step = 0;
const options = { cwd, session, artifactDir: join(root, 'outputs'), tools: [new BashTool()] };
// Deliberate local fault injection; not a claim of provider-generated truncation.
await assert.rejects(new Agent({ ...options, model: { async complete() {
  if (!step++) return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'failure', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'exit 7' }) } }] }, finishReason: 'tool_calls' };
  return { message: { role: 'assistant', content: 'injected truncated response' }, finishReason: 'length' };
} } }).run('Run local fault-injection test'), /length/);
await configureNetwork();
const loaded = await Session.open(session.path, cwd);
const agent = new Agent({ ...options, session: loaded, model: new DeepSeekModel({ apiKey: process.env.DEEPSEEK_API_KEY ?? '', model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', baseUrl: process.env.DEEPSEEK_BASE_URL, maxTokens: 2048 }) });
const answer = await agent.run('请读取自己的运行记录，说明最近已结束任务的结束原因、工具失败，以及模型用量哪些已知哪些未知。只读查询，不执行Bash或修改文件。请区分记录中的事实和推断。');
const call = loaded.messages.findLast((m: any) => m.tool_calls?.some((c: any) => c.function.name === 'runtime_records'))?.tool_calls?.find((c: any) => c.function.name === 'runtime_records');
assert.ok(call, 'Real model must query the new tool');
const report = JSON.parse(loaded.messages.findLast((m: any) => m.role === 'tool' && m.tool_call_id === call.id)!.content!);
assert.equal(report.runs[0].reason, 'model_length');
assert.equal(report.runs[0].toolFailures, 1);
assert.equal(report.runs[0].usage, null);
assert.ok(loaded.runtime.recent().at(-1).usage.totalTokens > 0, 'Real model usage is persisted');
await writeFile(join(root, 'answer.txt'), answer);
await writeFile(join(root, 'report.json'), JSON.stringify({ status: 'passed', source, model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', faultSource: 'local scripted injection', realModelRead: true, observedToolExit: 7, usagePersisted: true, evidenceDirectory: root }, null, 2));
console.log(JSON.stringify({ status: 'passed', evidenceDirectory: root }));
