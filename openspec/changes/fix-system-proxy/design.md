## Context

截图显示请求失败且界面可继续输入。本机 scutil 登记 127.0.0.1:7890，当前进程没有代理环境变量。历史实测使用显式代理。

## Goals / Non-Goals

目标：默认 CLI/TUI 采用已有系统代理；覆盖显式环境、禁用代理、例外和网络错误。不修改 iTerm、系统配置或凭据，不添加重试循环。

## Decisions

启动前配置 Node 原生 fetch 代理。环境中的显式代理或 NO_PROXY 规则优先；macOS 无显式 HTTP(S) 变量时查询 scutil。静态例外转换为 Node 支持的 NO_PROXY；PAC／SOCKS 不推测。SEEDA_SYSTEM_PROXY=0 关闭自动发现。网络错误仅显示安全错误码与建议，不包含响应体或 URL 凭据。

## Risks / Trade-offs

仅 macOS 静态 HTTP(S) 系统代理；跨平台仍使用环境代理或直连。原生 API 需要 Node 24.14+，更新 engines。配置是进程内代理 dispatcher，不写全局操作系统或环境文件。

## Migration Plan

运行类型、回归及本地 proxy 测试，再取消显式代理变量执行真实 DeepSeek TUI PTY，复现普通启动路径。

## Open Questions

无。
