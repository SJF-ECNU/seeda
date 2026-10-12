## Why
RSI 工具只在托管模式开放，手动 init/serve 再接前端让默认 Agent 无法成长。
## What Changes
默认 CLI/npm start 自动初始化并启动独立守护，等待主实例 ready 后接入；重复启动复用同项目守护。显式直接模式保留。
## Capabilities
### Modified Capabilities
- `managed-runtime`: 自动启动并连接默认主 Agent。
## Impact
CLI 启动与守护初始化；不改变核心循环或 RSI 评价语义。
