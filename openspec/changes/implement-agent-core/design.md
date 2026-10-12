## Context

完整依据：[[docs/RSI架构设计]]。实现范围为五部分中的 Agent 核心与接入；TUI 后接。本机 Node.js 24.18 可运行 TypeScript，使用 tsc 做静态检查和 Node 原生 test runner。

## Goals / Non-Goals

目标：提供与界面无关的 Agent.run，真实模型→Bash→结果→模型循环，保存和恢复 session；验证取消、超时、长输出和错误。
非目标：TUI 渲染、SQLite、版本切换、守护、A/B、多提供商、SDK。

## Decisions

- model 接口接收消息、工具声明与 AbortSignal，返回完整响应。DeepSeek 用 fetch/SSE，先默认 non-thinking；启用 thinking 时保留 reasoning_content。API 名为 deepseek-flash，不把显示名称直接当 API slug。
- Bash 用 child_process.spawn，非交互独立进程；默认 cwd 固定，信号终止进程组；超长完整输出保存到 session 目录。
- 核心顺序执行工具，校验完整调用；只有 stop 才结束，截断和异常不执行参数。会话追加消息、工具开始与请求状态；未完成工具在加载时记 unknown，不重放。
- 上下文压缩只替换有效历史，不覆盖原始记录，不拆工具往返；Skill 按需读取，不强制 Project Memory。
- 简单终端驱动独立于核心，后续 TUI 订阅同样的事件。

## Risks / Trade-offs

目录约束不是安全沙箱；可信本地 Bash 有宿主权限。原生协议需要自行处理 UTF-8、SSE 分帧、结束标志和片段聚合，用本地 HTTP 服务器验证。数据库和 OS 进程不能保证命令恰好一次；未知结果返回给模型检查现场。

## Migration Plan

空仓库新增实现，不改历史。新增文件受正常 Git 管理，密钥和运行数据忽略。执行 npm run check、npm test、真实临时编程任务。失败保留证据，不伪称 TUI 或 RSI 已实现。

## Open Questions

暂无阻塞开发的问题；真实 DeepSeek 可用性以调用结果确认，TUI 库以后决定。
