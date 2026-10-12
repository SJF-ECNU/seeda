## Why
已有可用核心与 TUI，缺少版本保存、独立存活恢复和 A/B 接替，不能运行完整最小 RSI。
## What Changes
- Git 独立版本与 SQLite 成长记录。
- 外部守护、Unix socket 前端路由、IPC worker、ready/心跳与故障回退。
- 单候选编辑、隔离验证、Agent 评价和请求边界接替。
## Capabilities
### New Capabilities
- `managed-runtime`: 版本、实例、验证与恢复。
## Impact
新增版本与运行模块；核心 run/cancel 不变，TUI 复用事件。保留直接运行方式。
