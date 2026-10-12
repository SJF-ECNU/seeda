---
type: task-plan
project: seeda
workstream: rsi-architecture
status: completed
---

# RSI 架构设计任务计划

关联工作流：[[project-memory/工作流/RSI架构设计]]。

## 目标与范围

根据本次讨论整合核心理念、最小循环、Git 与 SQLite、守护进程、A/B 验证和主角色切换，形成完整架构文档并明确首版必须实现的范围。本次只编写设计，不实现应用代码；实现阶段使用 OpenSpec。

## 方案与验证步骤

| 步骤 | 通过标准 | 状态 |
| --- | --- | --- |
| 核对讨论与既有蓝本 | 区分用户确认、设计建议与未决项 | completed |
| 编写架构和首版范围 | 覆盖组件、数据、流程、异常恢复、验收 | completed |
| 一致性检查和接续 | 链接有效；职责、切换和恢复无互相矛盾；更新导航与记录 | completed |

## 本次补充步骤

| 步骤 | 通过标准 | 状态 |
| --- | --- | --- |
| 明确小核心与三类接口 | 区分增量 I 和后续管理接口，不建立插件平台 | completed |
| 明确最小 session 与可选 Project Memory | 文件、数据库与 Skill 的职责一致 | completed |
| 补齐实施顺序与验收 | 可进入增量 I，未实现项不写成已通过 | completed |

## 未决项

运行语言、模型接入、进程通信实现及存活检测参数在代码实现前确定。它们不阻塞本次文档。

## 验收证据与下一步

[[project-memory/工作记录/2026/10/2026-10-12-203029-Codex-RSI架构设计]]：设计和文档检查完成，运行验收尚未执行。下一步确定语言与模型，用 OpenSpec 规划增量 I。

## 本次补充验收

[[project-memory/工作记录/2026/10/2026-10-12-203618-Codex-接口与Session边界完善]]：三类接口、session-only 记忆、可选 Project Memory 和增量 I 实施顺序已补齐。代码与运行验证尚未开始。

## 技术选择更新

TypeScript 与 TUI 已由用户确定；不使用 Agent SDK，模型接入自行实现。见 [[project-memory/工作记录/2026/10/2026-10-12-204023-Codex-TypeScript与TUI选型]]。后续确定运行时、TUI 渲染和模型端点。
