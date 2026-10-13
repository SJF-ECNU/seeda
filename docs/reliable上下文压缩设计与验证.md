---
type: implementation-report
status: current
updated_at: 2026-10-13
---
# reliable 上下文压缩设计与验证

## 行为

每次普通模型请求前检查占用；达到配置总窗口85%时自动压缩，阈值同时不超过预留输出后的输入额度。默认窗口1M，触发点850000 token；较小模型应通过AgentOptions.maxContextTokens配置实际容量，尚未自动识别模型窗口。

摘要保留目标、约束、进展、决策、失败、引用与下一步。待压缩历史按实际序列化后的请求估算分批，前一批摘要带入下一批；过大工具输出可在摘要材料中分段，原工具协议记录不拆改。有效上下文保留当前用户指令与预算内的近期完整工具往返，最新工具输出过大时也可进入摘要。所有批次成功并校验最终上下文后才写入压缩记录。失败、取消、截断或过大摘要不部分替换有效上下文；原始会话始终保留。

## Codex 学习来源与差异

阅读官方Codex源码提交6fbfc352cafb50332d62dbdc8720cb5d7fe3b7c7的本地压缩：接续摘要、保留近期用户信息、成功后替换历史；本地摘要超窗时移除最旧条目重试。本实现保留前述接续和失败保护，改用有界滚动摘要而非删除旧材料。85%是本项目用户指定，不宣称Codex默认也是85%。

- [Codex本地压缩源码](https://github.com/openai/codex/blob/6fbfc352cafb50332d62dbdc8720cb5d7fe3b7c7/codex-rs/core/src/compact.rs)
- [Codex摘要提示](https://github.com/openai/codex/blob/6fbfc352cafb50332d62dbdc8720cb5d7fe3b7c7/codex-rs/prompts/templates/compact/prompt.md)
- [OpenAI官方Compaction说明](https://developers.openai.com/api/docs/guides/compaction)：原生压缩项依赖专用接口；当前Chat Completions实现未接入该能力。

## 本次验证

- 当前仓库类型检查与77项回归通过；reliable候选类型检查与43项回归通过。
- 8项新增测试覆盖85%提前触发、阈值相等、分批连续摘要、超长工具输出、原始记录与重载、失败取消保护、连续手动压缩及当前指令保留。
- 真实deepseek-flash、小窗口6000 token、输出额度1024：4批摘要输入实测3348/3330/3333/1931 token；普通接续输入545 token。回答正确保留ORCHID-731、禁止修改测试文件和验证恢复任务；重载一致。耗时约11秒。
- 发布后的核心文件与候选逐字一致，发布包8项针对性测试通过。

验证使用合成历史及指定事实，不能证明任意长摘要均无信息损失；未实发百万token，未验证全部模型。UTF8估算仍存在误差。超大当前用户指令或系统指令本身无法容纳时，安全报错而非丢弃指令。

## 可用版本

本地新增种系：seeda-agent-reliable-compact85，ID ee5807a8-9e0e-4433-86e8-953991693b47，保存提交e97f99e2b38137446314ddd169627ce0bf85e9b3。基于reliable 837985b，在独立副本完成实现；副本提交3328fc3，播种保存过程生成独立实现提交，来源写入介绍。当前发布目录的parent_id为null，不据此声称平台父链已关联。

新项目可显式运行 `seeda seed seeda-agent-reliable-compact85`。原reliable、全局默认和已有运行实例没有切换；已有实例需要独立验证并接替才能获得改动。

相关：[[openspec/changes/reliable-context-compaction/design]]、[[docs/版本守护与RSI运行指南]]。
