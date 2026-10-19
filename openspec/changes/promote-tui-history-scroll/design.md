# TUI 历史滚动同步

workstream: promote-tui-history-scroll

## 范围与假设
来源为教材预处理 .seeda/runtime/repository 的未提交 TUI 改动；全局命令解析到 multiprocess-1bf7954b96e9，四个源码/测试文件与来源一致。只推广该差异，保留其他工作树改动。

## 方案与验证
使用现有渲染缓存和键盘事件；DECSET 1007 依赖终端支持，无需捕获鼠标。同步三个前端文件、测试与说明；执行类型检查、TUI/Markdown/命令回归和真实 PTY；仅提交本次差异，推送 main 并核对远端。

## 未决项
无。终端滚轮兼容性依赖终端设置，键盘滚动始终可用。
