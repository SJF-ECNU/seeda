---
type: worklog
project: seeda
workstream: native-evaluation-sandbox
status: completed
recorded_at: 2026-10-15T15:29:54.707310+08:00
started_at: unknown
completed_at: 2026-10-15T15:29:54.707310+08:00
timezone: Asia/Shanghai
agent: Codex
client: Codex desktop
model: unknown
session_id: unavailable
branch: main
commit: null
---
# evaluate 原生沙箱实现与验证

## 任务计划书
[[openspec/changes/native-evaluation-sandbox/design]]，完成 tasks 第 2–4 部分。用户追加要求：自行实现、避免抄袭、极度简单；未引入第三方 sandbox SDK 或新增依赖。

## 目标与结果
所有实际 evaluate 强制通过宿主 sandbox，模型选 process/container；默认 process，none/未知后端/后端失败不降级。轻量 prompt 在真实 macOS Seatbelt 中运行，无需 Docker；需要 Bash 时选择断网 Linux 容器。宿主代理固定模型出口，候选不持有长期 API Key；IPC 适配保留旧 worker 入口，候选 PID/管理消息不控制宿主。

实现约 300 行、三个小文件：启动与模型出口、沙箱内 IPC 适配、沙箱外 guardian 回收；不扩展平台。macOS 单进程是明确取舍，避免复杂后台进程追踪；Linux PID namespace 和容器支持子进程。源码层面已实现，不代表已有服务已部署。

## 改动
- [候选执行器](../../../../src/sandbox/candidate.ts)、[IPC 适配](../../../../src/sandbox/bridge.mjs)、[回收 guardian](../../../../src/sandbox/guardian.mjs)：自行实现两种后端、固定模型出口与回收。
- [Supervisor](../../../../src/runtime/supervisor.ts)：evaluate 进入沙箱，证据在候选可写区外由宿主写入；记录实际后端与错误。
- [worker 工具描述](../../../../src/runtime/worker.ts)、[管理 CLI](../../../../src/runtime/cli.ts)、[参数](../../../../src/cli-arguments.ts)：模型/CLI 显式选择，省略默认 process。
- [进化快照](../../../../src/versions/snapshot.ts)：排除宿主沙箱代码与关联集成测试，保留稳定宿主职责。
- [沙箱测试](../../../../tests/sandbox.test.ts)、[运行回归](../../../../tests/runtime.test.ts)、[嫁接回归](../../../../tests/agent-graft.test.ts)、[CLI 回归](../../../../tests/cli-audit.test.ts)：真实执行与边界验证。
- [真实 RSI 演练脚本](../../../../scripts/rsi-live-smoke.ts)：需 Bash 的评测显式 container，并使用容器内 /candidate 路径；本次没有调用真实付费模型运行该脚本。

## 文档关系
### 参考文档
- [[openspec/changes/native-evaluation-sandbox/design]]：本次唯一计划与已确认边界。
- [[project-memory/工作记录/2026/10/2026-10-15-Codex-evaluate沙箱实现准备]]：继承的准备工作与最小探测。
- [[docs/版本守护与RSI运行指南]]：保留原 evidence/decide/promote 与版本恢复语义。

### 文档产物
- 更新 [[openspec/changes/native-evaluation-sandbox/design]]：自行实现、macOS 单进程取舍、具体限额与实际证据。
- 更新 [[openspec/changes/native-evaluation-sandbox/tasks]]：按真实验证完成清单。
- 新建 [[docs/evaluate沙箱]]：使用、边界、资源限制、平台验证与启用范围。
- 更新 [[docs/CLI命令与参数]]、[[docs/版本守护与RSI运行指南]]、[[docs/Agent嫁接流程]]：参数、沙箱路径与当前行为。
- 更新 [[docs/首页]]、[[docs/索引/开发与使用]]、[[docs/索引/架构与设计]]：登记实现与使用入口。
- 更新 [[project-memory/开发与运维注意事项]]：持久边界与权威入口。

## 验证
- npm run check：通过；npm test：95/95 通过、无跳过。
- 更新后的沙箱专测：11/11 通过；真实 macOS Seatbelt 与 Docker，模型由本地 HTTP 服务模拟。
- 覆盖轻量 prompt 默认 process、容器 Bash、目录越界读写/符号链接、TCP/Unix socket、宿主信号、真实 Key 不透传、伪造 PID、管理消息、取消、超量输出、无后端与超时。
- 宿主被 SIGKILL 后，macOS 候选退出；Linux 验证以文件心跳停止证明 worker 与独立后台子进程均被回收，不拿 namespace PID 当宿主 PID。容器宿主被杀后容器和 detached 子进程消失。
- Linux：临时 Node 24 Debian 环境安装 bwrap，8 项适用测试通过，3 项 Docker 测试因不连接 daemon 跳过。常规外层容器 mount proc 被拒绝，真实失败未降级；单独为验证开启外层测试容器 privileged，未挂载宿主目录或 Docker socket，内部沙箱移除全部 capabilities。此结果不覆盖所有发行版/内核策略。
- OpenSpec strict、git diff --check 和文档链接检查通过。
- 测试未重启既有服务、未调用付费模型、未发布种系或切换默认版本。临时容器均以 --rm 运行，清理本次测试镜像和上下文，未清理其他服务/镜像。

## 失败与修正
最初只读路径白名单缺少根目录 literal，导致 macOS dyld 无法启动；补上根目录本身读取后恢复，未扩大子树权限。空依赖准备不产生 node_modules，补建并验证真实路径不重定向。容器移除与最终错误 IPC 出现时序问题，增加有界删除确认和发送完成后退出。旧嫁接样例使用宿主路径且默认进程执行 Bash，改为模型显式选择 container 和容器源码路径。Linux 空根原本可创建沙箱内兄弟文件，虽不改变宿主文件但不符合最小可写范围，补只读根与移除 capabilities 后边界测试通过。

## 限制与下一步
macOS process 不支持子进程/Bash；进程后端不保证容器等价 CPU/内存限制；可写产物目录无硬磁盘配额；模型响应缓冲转发。运行中的守护仍是原代码，使用新功能需按正常安装/重启流程启用；旧 Agent 工具描述可能需要更新或从新版 CLI 显式选择。相关限制已写入使用文档，本次无部署授权扩展。

## 引用
[[project-memory/工作流/原生evaluate沙箱]]
