---
type: workstream
project: seeda
workstream: fix-tui-redraw
status: completed
---
# TUI 重绘修复
## 任务计划书
[[openspec/changes/fix-tui-redraw/design]]，执行清单 [[openspec/changes/fix-tui-redraw/tasks]]。
## 目标与结果
修复流式更新时整屏重复绘制。采用行缓存与绝对定位，普通刷新无换行、无整屏清除。25 项测试、类型检查、PTY 和 OpenSpec 校验通过。
## 阻塞与下一步
代码无阻塞；用户原有进程需要 /exit 后 npm start 重新加载。未直接验证当前 iTerm2 画面。
## 近期工作记录
[[project-memory/工作记录/2026/10/2026-10-12-TUI重绘修复]]
## 当前相关文档
[[docs/TUI前端实现与验证]]
