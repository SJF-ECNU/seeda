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
已自行实现约 300 行最小沙箱包装，无新增 sandbox SDK 或运行时依赖。evaluate 默认 process，可显式 container；none/后端不可用不降级。候选不接收长期模型凭据，不以候选自报 PID 控制宿主。

## 最新结果
类型检查、95 项完整测试、OpenSpec 严格校验通过；11 项沙箱测试真实运行 macOS Seatbelt 和 Docker。Linux Bubblewrap 在允许 namespace 的临时 Linux 容器通过 8 项适用测试，3 项 Docker 测试跳过。评测、证据、接受和接替链路通过本地模拟模型及真实进程验证。

## 阻塞
无。限制：macOS process 单进程，不支持 Bash；进程资源限制弱于容器，产物目录无硬磁盘配额。Linux 宿主必须允许 namespace。

## 下一步
如需用于现有项目，按正常安装/重启流程启用新宿主实现；本次未重启或升级已有服务/种系。使用见 [[docs/evaluate沙箱]]。

## 近期工作记录
- [[project-memory/工作记录/2026/10/2026-10-15-Codex-evaluate沙箱实现与验证]]
- [[project-memory/工作记录/2026/10/2026-10-15-Codex-evaluate沙箱实现准备]]

## 当前相关文档
- [[openspec/changes/native-evaluation-sandbox/proposal]]
- [[openspec/changes/native-evaluation-sandbox/design]]
- [[openspec/changes/native-evaluation-sandbox/specs/evaluation-sandbox/spec]]

- [[docs/evaluate沙箱]]
