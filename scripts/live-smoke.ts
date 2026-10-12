import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent, BashTool, DeepSeekModel, Session } from '../src/index.ts';

const root = resolve('.seeda', `smoke-${Date.now()}`);
const cwd = join(root, 'project');
await mkdir(cwd, { recursive: true, mode: 0o700 });
await mkdir(join(cwd, '.agents', 'skills', 'check-addition'), { recursive: true });
await writeFile(join(cwd, '.agents', 'skills', 'check-addition', 'SKILL.md'), '---\nname: check-addition\ndescription: Verify and fix the local addition function using the provided test\n---\nRead sum.cjs and check.cjs. Run node check.cjs before editing, preserve its failure evidence, change only sum.cjs, and run the same test afterward.\n');
await writeFile(join(cwd, 'sum.cjs'), 'module.exports = (a,b) => a-b;\n');
await writeFile(join(cwd, 'check.cjs'), "require('node:assert/strict').equal(require('./sum.cjs')(2,3),5); console.log('PASS');\n");
const sessionPath = join(root, 'session.jsonl');
const session = await Session.open(sessionPath, cwd);
const model = new DeepSeekModel({ apiKey: process.env.DEEPSEEK_API_KEY ?? '',
  baseUrl: process.env.DEEPSEEK_BASE_URL, model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', maxTokens: 2048 });
const events: string[] = [];
const options = { cwd, artifactDir: join(root, 'outputs'), model, session, tools: [new BashTool()],
  onEvent: (event: { type: string }) => { events.push(event.type); } };
const started = Date.now();
try {
  await new Agent(options).run('请按 check-addition Skill 完成任务，先读取 Skill 正文。项目包含 sum.cjs 和 check.cjs。请先用 Bash 读取这两个文件并运行 node check.cjs，观察失败；然后修复 sum.cjs，使测试通过，并实际重新执行测试。不要修改测试文件。');
  assert.ok(session.messages.some(m => m.tool_calls?.some(c => c.function.arguments.includes('SKILL.md'))), 'Skill body must actually be read');
  const results = session.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content!));
  assert.ok(results.some(r => r.exit_code !== 0 || /AssertionError|exit=1/.test(r.output ?? '')), 'Model must observe an actual failing test');
  assert.ok(results.some(r => r.exit_code === 0 && r.output.includes('PASS')), 'Model must observe a passing test after editing');
  const check = await promisify(execFile)('node', ['check.cjs'], { cwd });
  assert.match(check.stdout, /PASS/);
  assert.match(await readFile(join(cwd, 'check.cjs'), 'utf8'), /equal\(require\('\.\/sum.cjs'\)\(2,3\),5\)/);
  const restored = await Session.open(sessionPath, cwd);
  await new Agent({ ...options, session: restored }).run('根据刚才的记录，用一句话说明修复了什么，不需要再次执行命令。');
  const report = { status: 'passed', model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
    toolCalls: results.length, observedFailureAndSuccess: true, sessionResume: true, skillRead: true,
    elapsedSeconds: (Date.now() - started) / 1000, evidenceDirectory: root };
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  const report = { status: 'failed', reason: error instanceof Error ? error.message : 'Smoke test failed', evidenceDirectory: root };
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exitCode = 1;
}
