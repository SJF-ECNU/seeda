## Context

首轮核心已通过类型检查、17 项测试与真实 DeepSeek 验证。Agent.run、cancel、onEvent 与 session.messages 均可直接复用。此变更只实现五部分中的 TUI 前端。

## Goals / Non-Goals

目标：稳定输入区、历史对话、流式文本、工具状态、取消和异常反馈；启动时展示已有会话。
非目标：Markdown 复杂渲染、主题、插件 UI、多会话管理、模型调用逻辑、版本管理或守护。

## Decisions

- 使用 Node emitKeypressEvents/raw mode 与 ANSI alternate screen；输入、输出和 resize 生命周期单独管理。
- TUI 状态接收已有消息和事件，只保留展示数据；通过绑定的 run/cancel 调用核心，不直接读取数据库或写 session。
- string-width 只处理终端列宽；Intl.Segmenter 处理中文字／emoji 输入与折行。输出清理终端控制字符，模型／工具文本不能注入清屏指令。
- 一次运行一个请求，忙碌时 Enter 不提交第二任务，但保留输入草稿。Ctrl+C 忙碌时取消、空闲时退出；/exit 正常退出。
- 工具行按 call id 更新状态，不重复添加完成结果。回调只刷新界面，不执行工具。核心决定结果状态。
- PageUp/PageDown 浏览历史，resize 重画；退出恢复原始输入状态、光标与主屏幕。单次命令或重定向输出不启用 raw mode。

## Risks / Trade-offs

手写最小输入编辑器只支持单行输入，不实现复杂终端兼容框架。中文宽度按 string-width 与终端实测，字体差异仍可能影响 emoji 显示。保留本地 PTY 演练验证实际输入、取消、恢复和屏幕内容，而不是只跑状态测试。

## Migration Plan

现有 npm start 无参数且是 TTY 时启动 TUI；带 prompt 参数保持单次普通输出，非 TTY 支持行输入。配置和 session 路径不变。先跑类型与回归，再 PTY 模拟真实键盘和故障，最后实际 DeepSeek TUI 样例。

## Open Questions

无阻塞。高级 Markdown、粘贴和历史搜索以后按需求扩展。
