# 清晰的终端对话
workstream: refine-tui-presentation

参考 Codex、OpenCode、Claude Code 的对话/执行/输入分区，采用青色主标识、柔和灰色结构、绿色成功、红色失败。文本正文保留终端字体和默认背景，不加入大面积边框。

助手正文由 marked lexer 解析为块与行内 token，自己绘制终端样式，不生成 HTML。Markdown 源和工具内容先清理所有外部控制字符；只使用本地固定 SGR 颜色。按 grapheme/显示列折行，未闭合流式代码块可继续展示，NO_COLOR 保留结构。窄屏表格改为字段行，保证正文可读。

工具条默认只显示状态、命令/操作摘要、退出码或错误，Ctrl+O 展开完整参数与有界原工具输出，原始内容/session 不改写。输入保持单行与草稿/取消行为。每次刷新仍使用行缓存与绝对定位，不清屏/换行滚动。

只实现当前显示需求，不开发主题框架、插件 UI 或新 Agent 引擎。执行清单 [[openspec/changes/refine-tui-presentation/tasks]]。
