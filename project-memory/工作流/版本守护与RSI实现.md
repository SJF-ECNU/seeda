---
type: workstream
project: seeda
workstream: implement-managed-runtime
status: completed
---
# 版本守护与 RSI 实现
## 任务计划书
[[openspec/changes/implement-managed-runtime/design]]，唯一清单 [[openspec/changes/implement-managed-runtime/tasks]]。
## 当前结果
五部分的最小首版已经接通。专用 Git/独立依赖、SQLite、外部守护、socket/IPC、主候选隔离验证、评价、请求边界接替及存活回退均实现。类型及 29 项测试通过，真实 DeepSeek A 改 B、B 验证、A 接受后续接 promote、B 服务、回退续接通过。原失败证据保留。
## 阻塞与下一步
无代码阻塞。默认启动已由 [[project-memory/工作流/默认托管启动]] 改为自动后台守护，下一步直接 npm start。没有配置操作系统开机自启动。
## 近期记录
[[project-memory/工作记录/2026/10/2026-10-12-Codex-版本守护与RSI实现]]
## 当前文档
[[docs/版本守护与RSI运行指南]] · [[docs/RSI架构设计]]
