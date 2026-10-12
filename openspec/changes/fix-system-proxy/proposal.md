## Why

用户普通 npm start 的 TUI 显示 fetch failed。macOS 有系统代理但进程未继承 HTTP(S)_PROXY，此前仅显式传代理实测成功，没有覆盖默认启动。

## What Changes

- 启动入口优先使用显式代理环境，否则读取 macOS 静态 HTTP(S) 系统代理。
- 使用 Node 原生 setGlobalProxyFromEnv，不修改系统或增加 SDK。
- 保留代理例外，增加安全的网络错误提示。
- 无显式代理的真实 TUI 验证及自动回归。

## Capabilities

### New Capabilities
- `network-startup`: 本机代理解析与默认启动联网。

### Modified Capabilities
无。

## Impact

仅启动接线、网络设置 helper、模型错误提示、测试和文档。Node 最低版本为支持该原生 API 的 24.14。
