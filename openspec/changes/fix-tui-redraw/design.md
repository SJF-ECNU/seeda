# TUI 重绘修复
workstream: fix-tui-redraw

假设截图重复来自整屏刷新；会话中重复输入保留，不能按文本去重。
采用行缓存与绝对光标定位，不在每次输出时清屏或输出换行。
缩放时清空一次并重建缓存；正常帧只更新变化行。
执行及验证见 [[openspec/changes/fix-tui-redraw/tasks]]。
