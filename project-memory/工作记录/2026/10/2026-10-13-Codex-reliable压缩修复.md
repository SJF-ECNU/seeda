---
type: worklog
workstream: reliable-context-compaction
status: completed
recorded_at: 2026-10-13
timezone: Asia/Shanghai
agent: Codex
client: Codex desktop
model: unknown
session_id: unavailable
branch: main
commit: null
---
# reliable 压缩修复

## 任务计划书
[[openspec/changes/reliable-context-compaction/design]]；完成全部执行步骤。

## 结果与改动

用户授权85%自动触发并学习Codex。读官方源码6fbfc35；主源码与独立reliable副本修改src/core/agent.ts、src/core/context.ts及压缩测试。保留工具协议与原始会话、原取消和失败保护。副本/Users/shjf/work/seeda-reliable-compaction，codex/reliable-compaction分支提交3328fc3。

主源码77项、候选43项、类型检查通过；发布后核心cmp一致及8项压缩测试通过。首轮主回归出现Bash时序失败及旧压缩测试夹具未包含近期用户指令，Bash有界重跑和最终全量回归均通过；压缩夹具改为带近期任务的多批场景。

真实deepseek-flash在6000窗口模拟配置中完成4批摘要和继续回答，保留三个指定事实，重载一致。报告在项目.seeda/compaction-check/live-report.json；只含合成材料与使用量，不含凭据。百万token及多模型质量未验证。

保存本地种系seeda-agent-reliable-compact85，ID ee5807a8-9e0e-4433-86e8-953991693b47，提交e97f99e2b38137446314ddd169627ce0bf85e9b3。初始化使用独立/tmp/seeda-compact85-runtime，未替换活跃数据库或启动守护；发布parent_id为null，来源通过介绍追溯。默认和原reliable未改，运行实例未升级。

## 文档关系
### 参考文档
- [[project-memory/工作记录/2026/10/2026-10-13-Codex-reliable压缩检查]] — 已复现边界与修复范围。
### 文档产物
- 新建 — [[docs/reliable上下文压缩设计与验证]] — 来源、行为、版本与验证边界。
- 更新 — [[docs/首页]]、[[docs/索引/架构与设计]] — 文档入口。
- 新建 — [[openspec/changes/reliable-context-compaction/proposal]]、[[openspec/changes/reliable-context-compaction/design]]、[[openspec/changes/reliable-context-compaction/tasks]]、[[openspec/changes/reliable-context-compaction/specs/reliable-compaction/spec]] — 范围与验证。

## 剩余与下一步

模型容量仍通过既有AgentOptions配置，默认1M；估算不是精确tokenizer。当前项目和其他已播种实例尚未切换，新项目可选择新种系，现有项目按原机制验证接替。
