## Why

seeda 已确定五个职责部分，当前还没有可执行循环。先实现不依赖 TUI 的核心、原生 DeepSeek 接入与 Bash，验证真实编程闭环。

## What Changes

- 架构按 TUI、Agent 核心、模型与工具接入、版本与成长、守护与运行拆分。
- 使用 TypeScript / Node.js；不引入模型或 Agent SDK。
- 实现原生 Chat Completions SSE、DeepSeek V4.1 Flash（API 名 deepseek-flash）。
- 实现顺序工具循环、Bash 取消和超时、session JSONL、Skill 和上下文压缩。
- 提供简单终端驱动用于实测，不建设 TUI、数据库或守护。

## Capabilities

### New Capabilities
- `agent-core`: 独立核心循环、模型协议、Bash、session 与上下文的首轮行为。

### Modified Capabilities
无。

## Impact

新增 src/、tests/、package.json、TypeScript 配置；只有开发依赖，无生产 SDK。真实调用使用已有 DEEPSEEK_API_KEY，密钥不进入源码或 session。版本和守护在后续变更实现。
