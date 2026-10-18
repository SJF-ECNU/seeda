import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { VersionStore } from '../src/versions/store.ts';
import { Supervisor } from '../src/runtime/supervisor.ts';
import type { AgentEvent } from '../src/core/types.ts';

// One normal request, no learning stages or host-directed management operations.
const root = resolve(process.argv[2]);
const cwd = join(root, 'project'); await mkdir(cwd, { recursive: true });
for (const dir of ['a', 'b']) await mkdir(join(cwd, dir));
await writeFile(join(cwd, 'original.txt'), 'preserve');
const store = await VersionStore.open(join(root, 'state'));
const supervisor = new Supervisor(store, cwd, { kind: 'local' }, {}, null);
const events: AgentEvent[] = []; const started = Date.now();
const report: Record<string, unknown> = { status: 'failed', root, scope: 'single real-model feature task; not ALE or proof of general autonomous improvement' };
process.on('SIGTERM', () => supervisor.cancel());
process.on('SIGINT', () => supervisor.cancel());
try {
  const initial = await store.initialize(resolve('.')); await supervisor.start();
  const prompt = `完成这个命令审计任务：让你当前的 Bash 工具返回 resolved_cwd 字段，准确反映该命令实际执行的绝对目录，兼容相对 cwd。目标是改进实际工具返回能力，而不是只在项目里打印一个同名字符串。项目已有 a、b 两个子目录和 original.txt。完成能力改进后，在本次任务中分别用相对 cwd=a 和绝对 cwd=${join(cwd, 'b')} 执行 pwd，用真实工具结果核对 resolved_cwd 与 pwd 输出一致，再写 audit.json 记录两个结果。original.txt 必须保留原内容。你可以使用现有工作和自身版本工具自主安排步骤，已有隔离验证与显式接受规则不变。不要修改运行中的版本目录、控制数据库、权限或凭据，不发布全局版本，不结束任务后等待另一条消息才能继续。最终只报告实际完成内容与证据。`;
  await writeFile(join(root, 'prompt.txt'), prompt);
  const answer = await supervisor.run(prompt, event => { events.push(event); if (event.type === 'tool_start') console.log(JSON.stringify({ event: event.type, tool: event.call.function.name })); });
  const current = store.state().current_version!;
  const records = (await readFile(join(store.root, 'sessions/main.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const results = events.filter(event => event.type === 'tool_end' && event.call.function.name === 'bash').map(event => (event as any).result);
  assert.notEqual(current, initial.id, 'real Agent must accept and load changed executable code');
  assert.ok(store.db.prepare("SELECT id FROM switches WHERE to_version=? AND kind='quality' AND state='completed'").get(current));
  assert.equal(records.filter(r => r.type === 'message' && r.message.role === 'user').length, 1);
  assert.ok(records.some(r => r.type === 'request' && r.implementationVersion === current));
  assert.equal(events.filter(e => e.type === 'end').length, 1);
  for (const dir of ['a', 'b']) assert.ok(results.some(r => r.exit_code === 0 && r.resolved_cwd === join(cwd, dir) && r.output.trim() === r.resolved_cwd), `actual tool result for ${dir}`);
  assert.equal(await readFile(join(cwd, 'original.txt'), 'utf8'), 'preserve');
  JSON.parse(await readFile(join(cwd, 'audit.json'), 'utf8'));
  Object.assign(report, { status: 'passed', initial: initial.id, current, answer, singleTask: true, actualCodeBehavior: true });
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
  await supervisor.close();
  Object.assign(report, { wall_seconds: (Date.now() - started) / 1000, switches: store.db.prepare('SELECT * FROM switches').all(), evaluations: store.db.prepare('SELECT * FROM evaluations').all(), cost_usd: null });
  await writeFile(join(root, 'events.json'), JSON.stringify(events, null, 2));
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  store.close(); console.log(JSON.stringify({ status: report.status, root, error: report.error }));
}
