---
type: worklog
project: seeda
workstream: slash-command-preview
status: completed
recorded_at: 2026-10-12T15:18:05.094670+00:00
started_at: unknown
completed_at: 2026-10-12T15:18:05.094670+00:00
timezone: Asia/Shanghai
agent: Codex
client: Codex desktop
model: unknown
session_id: unavailable
branch: master
commit: null
---
# 输入 / 时预览命令
## 任务计划书
[[openspec/changes/slash-command-preview/design]]，推进全部步骤 [[openspec/changes/slash-command-preview/tasks]]。
## 实现
新增 src/tui/commands.ts 静态已有命令表和匹配/键盘动作；state 保存选中项与收起状态；render 在历史区底部展示至多六行选项，页脚显示操作。terminal 复用原 submit/close，参数命令先补全而不执行。CLI 标识直接模式，只显示可用 /exit。核心、运行协议、守护和持久会话未改。
## 验证
类型检查、44 项回归、OpenSpec 严格验证通过。新增四项测试覆盖筛选、直接模式、上下循环、Tab、Enter 参数、Esc、窄屏/短屏与增量重绘。扩展现有 scripts/session-pty-smoke.py，默认 npm start 实际 PTY、本地 HTTP 模型报告 `.seeda/session-pty-1791818231261/report.json`。预览/补全不会产生模型请求，随后会话新建、恢复与摘要继续正常，termios 恢复。未调用真实 DeepSeek；未操作用户 iTerm2。
## 文档关系
### 参考文档
- [[docs/TUI前端实现与验证]]：固定输入与增量重绘。
- [[openspec/changes/session-controls/design]]：已有命令与前端职责。
### 文档产物
- 新建 [[openspec/changes/slash-command-preview/proposal]]、[[openspec/changes/slash-command-preview/design]]、[[openspec/changes/slash-command-preview/tasks]]、[[openspec/changes/slash-command-preview/specs/terminal-ui/spec]]。
- 更新 [[README]] 与 [[docs/TUI前端实现与验证]]：命令预览操作和验证。
## 下一步
用户 /exit 后 npm start 重开前端即可，无需升级后台版本。没有 ID 参数动态补全、命令搜索或新命令接口。
