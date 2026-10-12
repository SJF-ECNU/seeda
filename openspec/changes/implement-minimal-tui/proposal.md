## Why

核心与接入已经独立可用，现有简单驱动在流式输出时缺少稳定输入区和工具状态。接入最小 TUI，让用户连续对话而不把界面逻辑放进执行核心。

## What Changes

- 新增独立 TUI 状态与终端适配，订阅现有 AgentEvent。
- 支持用户输入、流式输出、工具运行／完成／失败、取消、基本历史滚动和缩放。
- 交互终端默认 TUI；单次命令与非 TTY 保留普通输出。
- 保持现有核心、模型、工具与 session 行为，不增加版本或守护功能。

## Capabilities

### New Capabilities
- `terminal-ui`: 独立终端交互和核心事件展示。

### Modified Capabilities
无。

## Impact

修改 src/cli.ts 接线，新增 src/tui 与测试。只增加 string-width 字符宽度工具，不使用模型／Agent SDK。复用已有 DeepSeek 凭据配置。
