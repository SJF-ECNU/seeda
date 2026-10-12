---
type: implementation-report
project: seeda
status: current
updated_at: 2026-10-12
---

# 最小 TUI 前端实现与验证

## 功能与职责

五部分中的 TUI 前端已实现。它只展示、编辑输入和提交用户动作，通过现有 Agent.run、cancel、onEvent 接入；不直接调用模型、不执行工具、不写 session。

| 文件 | 职责 |
| --- | --- |
| [state.ts](../src/tui/state.ts) | 展示状态、消息历史、流式文本合并、工具 call id 状态、提交与取消 |
| [render.ts](../src/tui/render.ts) | 消息分区、工具摘要、输入窗口与历史视口 |
| [markdown.ts](../src/tui/markdown.ts) | Markdown token 的终端样式、列表、代码块和表格 |
| [text.ts](../src/tui/text.ts) | 中文／emoji 列宽、折行和外部控制字符清理 |
| [commands.ts](../src/tui/commands.ts) | 已有命令预览、前缀筛选、选择与补全 |
| [terminal.ts](../src/tui/terminal.ts) | raw 输入、按键、重画、resize、退出清理 |
| [cli.ts](../src/cli.ts) | 组装现有核心，选择 TUI 或普通输出 |

使用 Node 原生输入和 ANSI alternate screen，使用 string-width 字符宽度工具和 marked Markdown lexer。这是终端基础工具，不是 Agent SDK。现有 src/core、src/model、src/tools 和 session 格式没有为 TUI 改动。

## 使用

环境中已有 DEEPSEEK_API_KEY 时：

```bash
npm start
```

交互终端无 prompt 参数时默认 TUI；带参数运行仍是单次普通输出：

```bash
npm start -- run "读取当前项目并说明结构"
```

非 TTY 不使用 raw mode 或终端控制序列，行输入排队处理。配置、代理和 session 与 [[docs/Agent核心实现与验证]] 相同。启动会展示已有用户／助手／工具消息，但不会重放工具或由界面写入会话。

| 操作 | 行为 |
| --- | --- |
| Enter | 空闲时发送；忙碌时不重复提交，保留草稿 |
| Ctrl+C | 忙碌时请求核心取消；空闲时退出 |
| /exit | 空闲时退出 |
| Ctrl+D | 关闭界面，运行中先请求取消 |
| 左右／Home／End | 单行输入编辑 |
| Backspace／Delete | 删除一个显示字符；保留 emoji grapheme 边界 |
| Ctrl+U | 清空输入 |
| PageUp／PageDown | 浏览对话历史 |
| Ctrl+O | 展开／收起工具参数和记录的输出；旧工具可先 PageUp 浏览 |

界面显示就绪、正在思考、正在执行、已取消和请求失败，等待请求收尾时明确显示正在收尾。工具行按 call id 更新，默认显示简洁的命令/操作摘要及退出码，成功绿色、错误红色，详细参数和输出按 Ctrl+O 查看；长输出保留核心提供的文件路径。

Ctrl+C 请求取消后，由核心发出的结束事件确定结果，界面不自行宣布工具已取消或成功。模型与工具中的终端控制序列在显示前清理，不能被当作清屏或剪贴板指令执行。

## 验证

- npm run check 通过。
- npm test：24 项通过，包含原有 17 项核心回归及 7 项 TUI／CLI 测试。
- OpenSpec implement-minimal-tui 严格校验通过。
- 本地真实 PTY＋现有核心＋实际 Bash：中文与 emoji 输入、增量流式文本、工具开始完成、忙碌输入不重复提交、取消、错误后可输入、resize、滚动、退出终端恢复均通过。
- 真实 DeepSeek V4.1 Flash：通过 TUI 输入任务，模型调用 Bash 输出 tui-live-ok，界面呈现完成状态与回答；session 中实际结果退出码为 0，正常退出后 termios 与屏幕模式恢复。

本地安全摘要：[PTY report](../.seeda/tui-pty-1791810649575/report.json)、[DeepSeek report](../.seeda/tui-live-1791810649958/report.json)。它们在被 Git 忽略的本地运行目录，不自动传播；可重新执行：

```bash
python3 scripts/tui-pty-smoke.py
python3 scripts/tui-pty-smoke.py --live
```

后者真实调用模型并产生费用，复用已有环境凭据。网络需要代理时仅对该进程设置 HTTPS_PROXY，不修改系统设置。

## 发现与修复

初次 PTY 演练发现关闭界面后 stdin 可保持活动，修复为释放界面监听并暂停输入。演练程序还需持续读取 PTY，等待屏幕恢复标记后再等待进程退出，避免 stdout 缓冲导致假性退出超时。失败运行目录保留，最后演练确认进程正常结束、termios 完全恢复。

## 当前范围

当前支持单行输入、Markdown 终端排版与工具详情，仍不做多行编辑、复杂粘贴、主题框架、搜索或多会话界面。最小终端为 16 列×6 行，过小提示 resize；字体和终端对 emoji 的展示仍可能有差异。

前端测试与真实样例不代表所有终端平台都已验证；本次是 macOS 本地 PTY。版本选择、SQLite、守护和 A/B 不在此次范围。

关联：[[docs/RSI架构设计]] · [[openspec/changes/implement-minimal-tui/design]] · [[openspec/changes/implement-minimal-tui/tasks]] · [[project-memory/工作流/TUI前端实现]]。

## 重绘修复（2026-10-12）

普通更新改为行缓存比较与绝对光标定位，只重写变化行，不清空整屏或输出换行；窗口尺寸变化时清屏一次并重建布局。保留完整会话和相同文本的真实重复输入。

类型检查、25 项测试及 PTY 交互验证通过，覆盖 100 次中文/emoji 增量更新、宽度、缩放、真实 Bash、取消与错误恢复。证据：`.seeda/tui-pty-1791811265859/report.json`。尚未直接操作用户当前 iTerm2 会话；现有进程需要退出重启后加载修复。

## 托管接入

默认 CLI 自动连接或启动守护，复用同一核心事件，通过 RuntimeClient 发输入和取消；会话由 worker 保存。支持 /versions、/use 和 /rollback。托管启动与验证见 [[docs/版本守护与RSI运行指南]]。

## 展示优化（2026-10-12）

采用有留白的消息块、青色助手标识、绿色用户/成功状态、固定输入与状态区。忙碌时有轻量 spinner；正常刷新仍只更新变化行。正文支持标题、粗体、斜体、删除线、行内代码、有序/无序与任务列表、引用、链接、代码块、GFM 表格。窄屏表格转为字段行，未闭合代码块可以流式展示；NO_COLOR 禁用颜色但保留结构。代码块保留缩进并标记语言，不声称具备完整语法高亮。图片显示说明，不下载图片；HTML 按文本显示，不执行。

显示源先剥离外部终端控制字符，只由本地生成固定 SGR；无 OSC 链接或剪贴板行为。工具默认隐藏原始 JSON，Ctrl+O 显示原始参数、输出或结构化结果，展示不改变会话。

参考官方 [Codex](https://github.com/openai/codex)、[OpenCode TUI](https://opencode.ai/docs/tui/)、[Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode) 的对话与工具详情交互方向；Markdown 解析采用 [marked](https://github.com/markedjs/marked)，只用 lexer，不生成 HTML，不接入任何 Agent SDK。

类型检查、36 项测试与 OpenSpec 严格校验通过。实际 PTY 覆盖 Markdown、工具详情展开、取消/草稿、缩放、滚动、退出恢复：`.seeda/tui-pty-1791814885357/report.json`。默认 npm start 经真实 DeepSeek、Bash 与新版 TUI 路径通过：`.seeda/tui-live-1791815076846/report.json`。

布局预览来自实际 layout 函数的确定性样例：运行 `node --experimental-strip-types scripts/tui-preview.ts` 生成 `.seeda/tui-presentation-preview/layout.json`。本次预览图在 `.seeda/tui-presentation-preview/preview.png`，是样例渲染图，不是用户现有 iTerm2 窗口截图。重开 npm start 即加载新版前端，已有后台 Agent 不必停止。

## 会话控制

默认托管前端支持 `/new`、`/sessions`、`/resume <完整ID>`、`/compact`。顶部显示当前会话短 ID，空页面提示命令。守护向所有连接前端广播会话历史，前端替换旧显示并保留尚未发送的草稿。命令由 CLI 路由，不作为用户任务发给模型，也不写入持久对话。会话切换在主进程空闲时执行，摘要由 Agent 核心执行；原始对话仍可查看。直接模式仍用 SEEDA_SESSION 指定文件，不提供会话切换命令。

会话控制验证：类型检查、40 项回归和 OpenSpec 严格校验通过；实际默认启动/TUI/守护、本地 HTTP 模型的交互报告为 `.seeda/session-pty-1791817621368/report.json`。覆盖两轮对话、主动摘要、新建、列表、恢复、前端重开及终端恢复。测试另验证守护重启、版本切换/回退、陈旧前端拒绝和旧 worker 能力提示；本次未调用真实 DeepSeek，也未改用户已有运行版本。

## Slash 命令预览

空闲时输入 `/`，输入区上方展示已有命令与中文说明；继续输入按前缀筛选。↑↓ 循环选择，Tab 补全，Enter 执行无参数命令。`/resume`、`/use` 只补全命令和空格，填写完整 ID 后 Enter 执行。Esc 收起，编辑后重新出现；参数输入期间和执行任务期间隐藏。直接模式只显示可用的 `/exit`。

列表最多六行，选中项始终可见；短屏自动缩短，输入/状态区保持固定。仅复用现有固定 ANSI 样式与增量绘制，不修改核心、守护或持久记录。重开前端 `npm start` 即加载，无需升级后台版本。

类型检查、44 项测试与 OpenSpec 严格校验通过。实际 PTY 验证 `/` 列表、下键与 Tab、Enter 等待参数，随后继续完整会话控制；本地 HTTP 模型仍仅收到两轮对话与一次摘要。报告 `.seeda/session-pty-1791818231261/report.json`，没有调用真实 DeepSeek 或操作用户当前 iTerm2 窗口。
