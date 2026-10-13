---
type: worklog
workstream: reliable-compaction-audit
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
# reliable 上下文压缩检查

## 任务计划书
[[project-memory/任务计划/reliable上下文压缩检查]]，完成只读实现核对、已有回归及临时隔离模拟。

## 结果

目标：发布种系 seeda-agent-reliable，ID 9a60d502-eebc-4f15-8e66-bec58bf41e5e，提交 837985b36a530a9dd3b05ca283e1a9940901c632。不等同于所有已播种实例的当前实现。

发布包 npm test：35/35 通过。临时目录加载发布包实际 Agent/Session/compactContext，模拟模型验证：自动 token 压缩后继续运行、完整工具调用与结果保留、原始日志保留、重载上下文一致、手动压缩、摘要截断与过大时保留原上下文、无早期对话时手动不压缩，全部通过。临时目录已清理。

边界复现：历史包含 12000 字符早期输入，在模拟输入预算 2000 token 下触发自动压缩，实际构建的摘要请求估算为4103 token，模型拒绝后原上下文保留。实现将早期历史整体 JSON.stringify 后一次性送摘要模型，没有摘要请求大小控制或分段处理。这证明特大历史可导致压缩失败，不证明常规长会话一定失败。默认窗口硬编码为100万 token，worker 未按模型容量传入覆盖参数；较小窗口模型有触发过晚风险。

## 改动与验证边界

无应用代码、种系、模型配置、运行实例修改。无真实模型摘要质量检查，未向线上模型发送百万 token；模型拒绝为本地模拟。当前运行会话是否触发过压缩未调查。

## 文档关系

### 参考文档
无；核心证据是发布包 src/core/context.ts、src/core/agent.ts、src/core/session.ts 和实际命令结果。

### 文档产物
- 新建 — [[project-memory/任务计划/reliable上下文压缩检查]] — 只读检查范围与步骤。

## 下一步
如需修复，按 OpenSpec 规划模型窗口配置与超长摘要处理，并继续保留已有失败保护；本次用户请求仅为检查。
