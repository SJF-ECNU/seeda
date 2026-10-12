import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { VersionStore } from '../src/versions/store.ts';
import { Supervisor } from '../src/runtime/supervisor.ts';
import type { AgentEvent } from '../src/core/types.ts';

const resume = process.argv[2];
const root = resume ? resolve(resume) : resolve('.seeda', `rsi-live-${Date.now()}`); const cwd = join(root, 'project'); await mkdir(cwd, { recursive: true, mode: 0o700 });
const store = await VersionStore.open(join(root, 'state')); const supervisor = new Supervisor(store, cwd); const started = Date.now();
const events: AgentEvent[] = [];
try {
  const a = await store.initialize(resolve('.')); await supervisor.start();
  if (!resume) await supervisor.run(`这是一次限定范围的真实自我改进演练。必须实际执行所有步骤，不要只提出计划。
目标：Bash 工具目前不返回命令实际工作目录。给返回对象增加 cwd 字段，其值必须与该次命令真正使用的绝对目录相同，支持参数 cwd 的相对路径。这是观测能力改进；不得改动核心循环、守护、共享数据格式和模型配置。
先 management status，再 management draft 创建候选编辑目录。只在该目录修改 src/tools/bash.ts 和新 tests/bash-cwd.test.ts。测试用 Node 内置 node:test，在临时目录创建 child 子目录，直接调用该候选的 BashTool，command 为 pwd、cwd 为 child；断言 result.cwd 为 child 的绝对路径，且 result.output.trim() 与 result.cwd 一致。保存临时产物并在测试结束清理。
先创建测试，用 node --experimental-strip-types --test tests/bash-cwd.test.ts 运行并观察失败，再修改返回 cwd 的实现，再执行相同测试成功。Bash 命令 cwd 指向候选编辑目录，不能编辑正式运行目录或当前项目目录。
management submit 提交候选并说明原因。拿到 B 的 runtime_path 后，management evaluate 的 task 要求 B 用 Bash 执行 node --experimental-strip-types --test <B runtime_path>/tests/bash-cwd.test.ts，再在它自己的独立工作目录执行 pwd，通过工具返回 cwd 与 pwd 输出核对，并说明结果。B 的验证环境没有 management 工具。
随后 management evidence 读取该 evaluation，实际检查测试 PASS、工具返回 cwd 和任务结果。只有证据符合目标，才能 management decide accept（给具体理由），然后 management promote（version、evaluation、reason），并结束本次请求让切换生效。不要手动 select 或跳过验证。`, event => { events.push(event); if (event.type === 'tool_start') console.log(JSON.stringify({ tool: event.call.function.name })); });
  if (store.state().current_version === a.id) {
    const accepted = store.db.prepare("SELECT id,candidate_version FROM evaluations WHERE source_version=? AND decision='accept' AND status='completed' ORDER BY rowid DESC LIMIT 1").get(a.id) as { id: string; candidate_version: string } | undefined;
    assert.ok(accepted, 'A must independently accept before promotion');
    await supervisor.run(`你已根据实际证据接受候选 ${accepted.candidate_version}，evaluation ${accepted.id}。现在完成后续接替：如需可再读 management evidence；用 management promote，version=${accepted.candidate_version}、evaluation=${accepted.id}、reason 为已验证的 Bash cwd 观测改进。不要使用手动 select，不要修改数据库。提交 promote 后结束请求，让守护在请求边界切换。`, event => events.push(event));
  }
  const bId = store.state().current_version!; assert.notEqual(bId, a.id);
  const b = store.version(bId); assert.equal(b.parent_id, a.id);
  const evaluation = store.db.prepare("SELECT * FROM evaluations WHERE candidate_version=? AND status='completed' AND decision='accept'").get(b.id) as { evidence_path: string } | undefined;
  assert.ok(evaluation, 'A must accept a real completed B evaluation');
  const evidence = JSON.parse(await readFile(evaluation.evidence_path, 'utf8'));
  const bashResults = evidence.events.filter((event: AgentEvent) => event.type === 'tool_end').map((event: { result: Record<string, unknown> }) => event.result);
  assert.ok(bashResults.some((result: Record<string, unknown>) => typeof result.cwd === 'string'), 'B must expose actual Bash cwd');
  assert.ok(bashResults.some((result: Record<string, unknown>) => result.exit_code === 0 && /pass 1/.test(String(result.output))), 'Candidate test must execute and pass');
  const before = (await readFile(join(root, 'state/sessions/main.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(before.some(item => item.type === 'message' && item.message.role === 'tool' && /AssertionError|ERR_ASSERTION|fail 1/.test(JSON.parse(item.message.content).output ?? '')), 'A must observe the pre-fix regression');
  await supervisor.run('请使用 Bash 执行 pwd，然后简短报告你实际运行的工作目录。', () => {});
  const main = (await readFile(join(root, 'state/sessions/main.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(main.some(item => item.type === 'request' && item.implementationVersion === b.id), 'B must serve a real primary request');
  await supervisor.select(a.id, 'manual', 'Live smoke rollback'); assert.equal(store.state().current_version, a.id);
  await supervisor.run('根据历史，用一句话说明刚才增加了什么，不执行工具。', () => {});
  const report = { status: 'passed', source: a.id, candidate: b.id, model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', actualAgentEdit: true, observedFailureThenPass: true, candidateIsolated: evidence.cwd !== cwd, agentAcceptedAndPromoted: true, servedAfterPromotion: true, rollbackAndResume: true, elapsedSeconds: (Date.now() - started) / 1000, evidenceDirectory: root };
  await writeFile(join(root, resume ? 'resume-report.json' : 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  const report = { status: 'failed', reason: error instanceof Error ? error.message : 'Live RSI smoke failed', evidenceDirectory: root };
  await writeFile(join(root, resume ? 'resume-report.json' : 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); process.exitCode = 1;
} finally { await supervisor.close(); store.close(); }
