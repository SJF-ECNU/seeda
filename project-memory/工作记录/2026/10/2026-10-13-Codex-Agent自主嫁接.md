---
type: worklog
project: seeda
workstream: feature-grafting
status: completed
recorded_at: 2026-10-12T16:43:05.823506+00:00
timezone: Asia/Shanghai
agent: Codex
client: Codex desktop
model: unknown
session_id: unavailable
branch: master
commit: null
---
# 基于 Git 的 Agent 自主嫁接
## 任务计划书
[[openspec/changes/feature-grafting/design]]，推进全部步骤 [[openspec/changes/feature-grafting/tasks]]。
## 用户最终边界
用户先要求功能移植，随后讨论统一接口，最后决定以 Git 为基础、改名“嫁接”，并明确选择“只保留基础接口，Agent 自己完成嫁接”。因此撤销此前本轮新增的 JSON 工件、专用导出/导入 CLI/management 实现、grafts 表和专用测试；没有删除原有能力或用户运行数据。当前平台没有新嫁接接口。
## 最终实现
只改 runtime/worker 的管理工具用法描述：源/基础种系登记 commit、Bash Git diff/apply、只在 draft 修改、冲突适配、submit reason 来源、独立 evaluate/evidence/decide/promote。新建 tests/agent-graft.test.ts，通过现有管理接口和真实 Bash 展示该组合能力。Git/版本说明/会话/验证记录负责留存来源和结果。
## 验证与边界
类型检查、46 项完整回归、OpenSpec 严格校验通过。Agent 集成测试实际启动主/候选 worker，以本地脚本 HTTP 模型依次查询种系、建草稿、Bash diff/apply、submit、evaluate、evidence、decide 和 promote。候选 Bash 实际执行嫁接函数，目标原有改进保留，源无关功能未导入；重复应用触发 Git 冲突，草稿保留且主版本不变；rollback 恢复原目标版本。测试断言没有专用 graft_import 操作或 grafts 表。
证据 `.seeda/agent-graft-1791823385823/report.json`、tests.log，目标测试原始日志 /tmp/seeda-agent-graft.log。没有真实 DeepSeek 调用、用户主版本切换或全局 origin 更新。
第一轮当前范围完整回归出现既有 Bash 树清理 EPERM（前轮播种任务也观察过），未修改或削弱该安全措施；核心 15 项独立检查通过，随后默认完整回归 46 项全部通过。失败日志保留 /tmp/seeda-agent-graft-full.log。
## 文档关系
### 参考文档
- [[docs/RSI架构设计]]：种系及候选独立接替。
- [[docs/版本守护与RSI运行指南]]：现有管理接口和证据。
### 文档产物
- 新建 [[docs/Agent嫁接流程]]；更新 [[docs/索引/开发与使用]] 的导航。
- 更新 [[docs/RSI架构设计]]、[[docs/版本守护与RSI运行指南]]、[[README]]：最终 Git/Agent 边界及术语。
- 新建并按用户最终选择重写 [[openspec/changes/feature-grafting/proposal]]、[[openspec/changes/feature-grafting/design]]、[[openspec/changes/feature-grafting/tasks]]、[[openspec/changes/feature-grafting/specs/feature-grafting/spec]]。
- 更新 [[project-memory/项目概览]]：自主嫁接能力。
## 下一步
真实任务由用户提供源种系、基础种系和功能目标，Agent 自行实现适配与验证。平台不承诺即插即用，不提供自动冲突解决或新插件接口。新的工具用法描述需要对应运行实现包含该描述；旧种系保留，基础 Git/Bash 与候选管理仍可完成操作。
