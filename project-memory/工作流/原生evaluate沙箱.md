---
type: workstream
project: seeda
workstream: native-evaluation-sandbox
status: completed
owner: Codex
---
# 原生 evaluate 沙箱

## 任务计划书
[[openspec/changes/native-evaluation-sandbox/design]]，唯一清单 [[openspec/changes/native-evaluation-sandbox/tasks]]。

## 目标
所有实际 evaluate 必须进入 sandbox，模型选择 process/container；轻量评测无需 Docker，不允许 none 或无隔离回退。

## 当前状态
已自行实现最小沙箱包装，无第三方 sandbox SDK；macOS 后代回收使用系统 Python 3 和内核查询。evaluate 默认 process，可显式 container；none/后端不可用不降级。候选不接收长期模型凭据，不以候选自报 PID 控制宿主。

## 最新结果
本次子进程修复类型检查、15 项沙箱专项和107项完整回归通过；详见 [[project-memory/工作流/macOS进程沙箱子进程]]。以下初版验证与发布信息保留为对应时点证据。

类型检查、95 项完整测试、OpenSpec 严格校验通过；11 项沙箱测试真实运行 macOS Seatbelt 和 Docker。Linux Bubblewrap 在允许 namespace 的临时 Linux 容器通过 8 项适用测试，3 项 Docker 测试跳过。评测、证据、接受和接替链路通过本地模拟模型及真实进程验证。

## 阻塞
无。macOS process 已支持受限 Bash/测试子进程，回收需要系统 Python 3；进程资源限制弱于容器，产物目录无硬磁盘配额。Linux 宿主必须允许 namespace。

## 下一步
如需用于现有项目，按正常安装/重启流程启用新宿主实现；本次未重启或升级已有服务/种系。使用见 [[docs/evaluate沙箱]]。

## 近期工作记录
- [[project-memory/工作记录/2026/10/2026-10-15-Codex-macOSprocess子进程修复]]
- [[project-memory/工作记录/2026/10/2026-10-15-Codex-evaluate沙箱实现与验证]]
- [[project-memory/工作记录/2026/10/2026-10-15-Codex-evaluate沙箱实现准备]]

## 当前相关文档
- [[openspec/changes/native-evaluation-sandbox/proposal]]
- [[openspec/changes/native-evaluation-sandbox/design]]
- [[openspec/changes/native-evaluation-sandbox/specs/evaluation-sandbox/spec]]

- [[docs/evaluate沙箱]]

## 提交与默认种系

源码9118fe6已推送main，CI成功；本机全局默认seeda-agent-reliable-sandbox，新项目默认seed和实际process evaluate已验证。详见 [[project-memory/工作记录/2026/10/2026-10-15-Codex-sandbox提交推送与默认种系]]。
