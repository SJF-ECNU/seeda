---
type: worklog
project: seeda
workstream: macos-process-subprocess
status: completed
recorded_at: 2026-10-15T16:42:38.067424+08:00
timezone: Asia/Shanghai
agent: Codex
client: Codex desktop
model: unknown
session_id: unavailable
branch: main
commit: null
---
# macOS 默认 process 评测子进程修复

## 任务计划书
[[openspec/changes/macos-process-subprocess/design]]；全部步骤完成。

## 结果
修复此前默认 process 禁止 fork 导致 Bash 甚至 pwd 无法执行的缺口。默认值不变，不依赖 Docker，不自动降级。允许继承 Seatbelt 的子进程与同沙箱信号，保留越界文件/网络/socket/宿主信号和凭据限制。候选 PATH 支持自身 node_modules/.bin、当前 Node/npm 与已安装系统开发工具，不暴露整个用户目录。

新增约六十行系统 Python 薄包装，调用 libproc 与 sandbox_check 识别继承的内核权限，不接受候选 PID、父子树或环境变量作为归属依据。`.host-only` 空文件禁止候选读写/删除；宿主启动前须可读取工作目录与该文件，桥接进程实际查询匹配后才导入候选。回收先冻结、重新扫描并终止后代，确认结束；超过三秒或查询失败会报错。系统 Python 3 不可用时失败，不绕过隔离。无第三方 SDK 或代码复制。

## 改动
- [候选启动](../../../../src/sandbox/candidate.ts)、[桥接](../../../../src/sandbox/bridge.mjs)、[guardian](../../../../src/sandbox/guardian.mjs)、[macOS 回收](../../../../src/sandbox/macos-cleanup.py)：受限子进程、内核验证与回收。
- [工具描述](../../../../src/runtime/worker.ts)：去掉 macOS 不支持子进程的旧说明，说明本机/独立 Linux 选择。
- [沙箱回归](../../../../tests/sandbox.test.ts)：子进程权限、工具链、正常退出/reparented 后代、取消/超时/宿主 SIGKILL、其他沙箱存活与验证失败前不加载候选。
- [runtime 回归](../../../../tests/runtime.test.ts)：原 Bash 评测不再显式 container，实际验证默认 process。
- [core 超时断言](../../../../tests/core.test.ts)：仅补充失败时原始返回值，不改超时逻辑或阈值。

## 文档关系
### 参考文档
- [[openspec/changes/native-evaluation-sandbox/design]]：保留原有强制隔离与单候选边界。
- [[docs/evaluate沙箱]]：原能力缺口与宿主/种系边界。
### 文档产物
- 新建 [[openspec/changes/macos-process-subprocess/proposal]]、[[openspec/changes/macos-process-subprocess/design]]、[[openspec/changes/macos-process-subprocess/tasks]]、[[openspec/changes/macos-process-subprocess/specs/process-sandbox/spec]]：本次计划及验收。
- 更新 [[README]]、[[docs/evaluate沙箱]]、[[docs/版本守护与RSI运行指南]]、[[docs/Agent嫁接流程]]：修复旧单进程说明，明确系统 Python 和工具路径。
- 更新 [[openspec/changes/native-evaluation-sandbox/design]]、[[docs/索引/架构与设计]]：当前设计与入口。
- 更新 [[project-memory/开发与运维注意事项]]、[[project-memory/工作流/原生evaluate沙箱]]、[[project-memory/首页]]：持久边界与接续。

## 验证
- 原禁止 fork 规则对照：spawn Bash 返回 EPERM/status null；新规则 pwd 返回0并输出实际工作目录。
- npm run check 通过；最新沙箱专项15/15通过；最终 npm test 107/107通过，无跳过。
- 实际 Bash 运行 pwd、node --version、tsc --version、npm --version、git init/status、node --test，退出0；默认 Supervisor evaluate 运行 Bash 成功。
- 子进程越界读写/宿主信号拒绝；现有 TCP/Unix socket 与占位 Key 检查继续通过；`.host-only` 不可读取或删除。
- 正常候选退出、中间父进程退出、独立后台进程、取消、短 guardian 超时和宿主 SIGKILL 后心跳停止；另一个沙箱继续写心跳，宿主存活。权限不匹配时尚未加载候选代码即失败。
- 初次完整回归一次既有50ms Bash超时用例返回failed；单独重跑和最终完整107项通过。未修改 Bash 实现或放宽测试，仅保留失败详情便于后续复现。
- 先前尝试沙箱内全进程信号会暂停清理进程自身，因此未采用，探测进程已终止。后续全部验证使用正式宿主侧回收。
- OpenSpec strict、链接与 diff 检查通过。最终日志保存在 .seeda/macos-process-subprocess/tests.log。

## 范围与下一步
源码尚未提交；没有推送、发布种系、切默认或重启既有 Supervisor。共享工作树中的网关/部署/可视化等其他改动保持原状。实际已运行宿主需按正常更新/重启流程加载本次修复；旧种系介绍仍是其发布时间的说明。
