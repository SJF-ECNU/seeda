## Why
流式输出整屏清空并以换行重写，导致终端重复画面与滚动污染。
## What Changes
按行定位，仅重写变化行；缩放后重建可见区域，保留真实会话。
## Capabilities
### Modified Capabilities
- `terminal-ui`: 增量绘制与缩放恢复。
## Impact
只修改 TUI 绘制及回归验证，不改 Agent 执行或会话内容。
