## Why
当前全是角色标签、原始 JSON 和未渲染 Markdown，正文、工具、输入缺乏层次。
## What Changes
- 清晰的角色消息块、留白、颜色与固定输入/状态区域。
- 标题、粗体/斜体、列表、引用、链接、代码块和表格的终端 Markdown。
- 工具默认显示命令/操作摘要及结果状态，按键展开完整参数与输出。
## Capabilities
### Modified Capabilities
- `terminal-ui`: 易读布局、Markdown 和工具详情切换。
## Impact
仅 TUI、呈现依赖与回归/PTY。保留现有核心事件、会话和增量重绘。
