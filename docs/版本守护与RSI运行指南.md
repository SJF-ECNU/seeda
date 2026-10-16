---
type: implementation-guide
project: seeda
status: current
updated_at: 2026-10-13
---

# 版本、守护与 RSI 运行指南

本指南描述已实现的最小运行管理。完整设计见 [[docs/RSI架构设计]]，执行清单见 [[openspec/changes/implement-managed-runtime/tasks]]。

## 启动

需要 Node.js 24.14+、Git、npm；DeepSeek 凭据从现有 `DEEPSEEK_API_KEY` 环境变量传给守护，不能写入版本或数据库。

在 seeda 仓库执行 `npm start` 即可。默认 CLI 自动连接同项目的已有守护；不存在时自动初始化专用 Git/SQLite、安装版本依赖、启动后台守护并等待主 Agent ready，再进入 TUI。首次依赖安装需要等待。启动失败报告日志路径，不会退回直接模式；现有其他项目的守护也不会被接管。

在其他工作项目中使用同一 CLI：

```bash
cd /绝对路径/工作项目
node --experimental-strip-types /Users/shjf/work/seeda/src/cli.ts
```

默认数据根为项目 `.seeda/runtime/`，不同项目天然拥有独立守护与成长历史。`SEEDA_HOME` 保留显式覆盖，用于旧运行库或特殊布局；同一个覆盖根仍只服务一个项目。首次只导入允许的实现文件，不替用户工作树提交。后续启动保留 SQLite 当前版本选择，不自动用开发工作树覆盖已经成长的版本。

TUI 中 `/versions` 查看版本，`/use 完整版本ID` 选择版本，`/rollback` 回到上一版本。`/exit` 仅退出前端，后台守护与主会话保留；再次 `npm start` 直接复用。`npm run manage -- stop` 停止守护，下一次 `npm start` 会自动恢复启动。启动日志为数据根中的 startup-*.log。没有操作系统开机自启动配置。

`npm run start:direct` 或 `SEEDA_MANAGED=0` 可显式直接运行原核心，不启用 RSI 管理。`npm run start:managed` 是默认启动别名。传统 `manage init` / `manage serve 项目绝对路径` 仍保留用于手动管理，不再是日常启动前置步骤。

## 五部分接线

| 部分 | 源码 | 职责 |
| --- | --- | --- |
| TUI | src/tui、src/cli.ts | 展示、输入和取消；托管模式把动作发送到 socket |
| 核心 | src/core | 原有 run/cancel、工具循环、会话与上下文 |
| 模型与工具 | src/model、src/tools | 原生 DeepSeek、Bash；Bash 向守护报告所属进程组供异常清理 |
| 版本与成长 | src/versions/store.ts | 专用 Git、独立依赖、SQLite 成长与运行记录 |
| 守护 | src/runtime | socket 路由、worker IPC、ready/心跳、候选验证、切换和回退 |

守护保持原启动代码，不随 Agent 候选接替。每个 Agent 从登记版本的 `src/runtime/worker.ts` 启动；前端复用 text/tool/end 事件。管理状态没有质量评分，质量结论来自 Agent。

## 数据与版本

数据根保存 `repository/`、`versions/`、`drafts/`、`state.db`、`sessions/main.jsonl`、`evaluations/` 和 `outputs/`。根目录限制为当前用户，socket 和会话文件同样限制读写。主实例凭据通过环境变量提供；evaluate 候选不继承真实 HOME、API Key 或代理配置，模型调用经宿主固定出口完成。候选从代码加载前进入系统沙箱或容器；详见 [[docs/evaluate沙箱]]。

首次导入只包含实现代码、测试、脚本、Skill、AGENTS.md、README、package/锁文件和 tsconfig，不导入 `.env`、用户 session 或运行产物。候选提交同样采用这些路径，普通用户项目改动不进入引擎版本库。

自身指令和通用记忆随版本的 `.agents/self/INSTRUCTIONS.md`、`.agents/self/MEMORY.md` 加载，项目规则仍取自任务cwd，切换不覆盖项目AGENTS.md。文件缺失、候选隔离及真实加载记录见 [[docs/自身指令与项目规则]]。

每个版本保存 Git commit 和保留引用，使用独立 detached worktree；依赖通过 `npm ci --ignore-scripts` 安装到自己的目录。切换已保留版本无需重新安装。需要依赖安装脚本的未来改动不在当前自动安装范围内。

SQLite 保存 versions、drafts、evaluations、instances、runtime_state、switches。版本父关系与当前/previous 指针可查询，验证失败、取消、拒绝和中断均保留。数据库由守护写入，Agent 通过管理工具请求操作。启动期间用现有 SQLite 写事务串行建立 socket 所有权，同时启动的第二管理进程被拒绝。

## A/B 自我改进

主 Agent 可用 `management` 工具执行：

1. `status` 查看当前版本、历史与评价；`draft` 从当前版本产生候选编辑目录。
2. 用 Bash 在该编辑目录修改实现和测试；先复现失败，再验证改动。
3. `submit` 传 draft 和 reason，形成 Git 提交、独立依赖和候选版本 B。
4. `evaluate` 传 version、task 和可选 sandbox（process/container，默认 process），由 B 在沙箱内的独立工作目录及会话中执行真实任务。主 A 仍存活，另一个前端请求可在 A 空闲时执行。一次最多运行一个候选验证；验证任务需要在独立目录准备自己的测试输入。
5. `evidence` 获取原始验证记录。A 用 `decide` 传 evaluation、accept/reject 和具体 reason；只有完成的验证能记录 accept。
6. `promote` 传 version、evaluation 和 reason；当前 A 对该 B 的接受记录满足生命周期条件后，守护在请求边界接替。A 也可用 `rollback` 和 reason 请求质量回退。

候选没有 management 工具；默认 process 支持继承隔离的 Bash 和测试子进程，需要独立 Linux 环境与依赖时选择 container。候选验证历史不复制到正式用户会话。候选使用与主版本相同的模型连接配置，评价不是模型或参数差异造成的效果声明。

相同操作也可通过管理 CLI 运行，用于手动检查和演练：

```bash
npm run manage -- status
npm run manage -- draft
npm run manage -- submit DRAFT_ID '修改原因'
npm run manage -- evaluate VERSION_ID '轻量 prompt 验证任务' process
npm run manage -- evaluate VERSION_ID '在 /candidate 中检查实现并运行测试' container
npm run manage -- evidence EVALUATION_ID
npm run manage -- decide EVALUATION_ID accept '具体证据与理由'
npm run manage -- promote VERSION_ID EVALUATION_ID '接替原因'
npm run manage -- select VERSION_ID
```

模型可能停止在改动、评价或建议阶段；只有已记录的 promote 和完成的 switches 记录才表示接替发生。可以在下一请求继续未完成的成长步骤，不把回答中的自我宣称当成版本切换。

## 存活、取消与恢复

worker 初始化后报告 ready，每秒心跳；启动上限 15 秒，连续 6 秒未收到心跳则终止失联 worker。正常异步模型等待不阻塞心跳。evaluate 整体上限 120 秒（含容器依赖准备）；候选取消或超时直接终止沙箱并回收。独立 guardian 在宿主退出时继续清理候选，不信任候选上报的 PID。

当前进程意外退出时，守护先清理已登记的 Bash 进程组，再启动 previous；没有 previous 时重启 current。故障连续重试最多三次，仍不可恢复则标记 failed，避免无限崩溃循环。正常完成一个用户请求后清零次数。

切换先持久化意图，阻止新输入并等待当前请求结束。为保证正式 session 只有一个写入者，先停止 A，再启动 B 加载同一 session；B ready 后事务更新 current/previous 和成功记录。B 无法启动则重新启动 A，并保存失败切换。这个实现允许短暂停顿。

管理进程断开 IPC 后 worker 会取消任务并退出，超时清理；守护被终止后重新 `serve` 会放弃未完成意图、标记中断实例与验证，再按已提交 current 启动。current 已提交 B 时恢复 B，无法启动则恢复 previous。正式任务不自动重放；未保存结果的工具恢复为 unknown，由智能体检查现场。

版本回退不会撤销用户文件或外部业务副作用。当前守护没有操作系统自动启动配置，也不自动升级守护或迁移共享数据；它保护 Agent 子进程存活，自身停服后由用户重新启动并恢复状态。

## 验证与证据

运行 `npm run check` 与 `npm test`。新增实测覆盖：Git/独立依赖、SQLite 重开、真实 A/B 并行、验证失败与取消、忙碌交接、B 初始化失败、主实例 SIGKILL、心跳失联 SIGSTOP、Bash 进程组清理、管理进程 SIGKILL、未完成切换及已提交切换的重启恢复。

`python3 scripts/tui-pty-smoke.py --auto` 通过真实守护、socket、DeepSeek、Bash 和 TUI 做 PTY 演练，正常退出恢复终端。默认 npm start 冷启动、真实对话与版本列表交互的记录位于 `.seeda/tui-live-1791813736931/report.json`。

`node --experimental-strip-types scripts/rsi-live-smoke.ts` 让真实 A 增加 Bash 实际 cwd 观测字段、创建回归测试、提交 B、运行独立候选验证、评价和接替，随后验证 B 服务及手动回退。失败原始运行保留，必要时传原证据目录继续已接受但未接替的版本；续跑报告独立保存为 resume-report.json，不覆盖原失败报告。最终实际结果以报告和只追加工作记录为准。

真实 RSI 验证已完成：`.seeda/rsi-live-1791812033030/resume-report.json`，包含实际代码改动、失败后通过、独立 B 验证、A 接受与续接请求中的 promote、B 服务新请求以及回退续接。原 `report.json` 保留为失败记录，不将模型停在接受阶段算成完整完成。

## 多会话与主动压缩

`/new` 新建 UUID 会话；`/sessions` 查询；`/resume <完整ID>` 恢复（初始 ID 为 `main`）；`/compact` 主动摘要。数据根 `sessions/<id>.jsonl` 保存各自原始历史及压缩记录，SQLite `session_selection` 保存当前选择。版本选择、回退与故障恢复都继续当前会话。会话切换先停止旧写入者，新进程 ready 后才保存新选择；失败恢复旧会话，不重放任务。任务或候选验证运行时拒绝切换。摘要保留最近一轮，工具调用与结果成组保存；失败或取消不替换原上下文。

### 已安装版本升级

前端、守护和保留的 Agent 版本是三个独立运行实体。更新仓库不会自动覆盖保留版本。

1. 当前 TUI `/exit`，执行 `npm run manage -- stop`，然后 `npm start` 启动新版守护与前端，保留原数据根。
2. `npm run manage -- draft` 返回新的候选 `id` 和 `path`。将本仓库当前 `src/` 内容复制到该候选目录的 `src/`（只复制实现源码，不复制 .seeda、环境文件或会话）。
3. `npm run manage -- submit <draft-id> "添加会话控制与主动压缩"` 保存为新版本。
4. 使用 `/use <返回的完整版本ID>`（或 `npm run manage -- select <版本ID>`）主动选择新版。旧版本继续可用，`/rollback` 可恢复。

这是用户主动版本选择；Agent 自行提拔仍走已有 evaluate → evidence → decide → promote 过程。回退到缺少 compact 能力的旧版本时，`/compact` 明确报不支持，不会挂起或假称成功。直接模式的会话文件仍由 SEEDA_SESSION 指定，托管会话命令不适用于它。

会话控制验证：类型检查、40 项回归和 OpenSpec 严格校验通过；实际默认启动/TUI/守护、本地 HTTP 模型的交互报告为 `.seeda/session-pty-1791817621368/report.json`。覆盖两轮对话、主动摘要、新建、列表、恢复、前端重开及终端恢复。测试另验证守护重启、版本切换/回退、陈旧前端拒绝和旧 worker 能力提示；本次未调用真实 DeepSeek，也未改用户已有运行版本。


## 全局种系库和项目播种

在安装入口源码所在仓库运行 `npm link` 可注册 `seeda`；进入目标项目后，`seeda strains` 列举种系，`seeda seed 名称或完整ID` 选择起点，`seeda` 启动项目实例。也可用 node 直接运行通用 src/cli.ts；在 seeda 仓库自身执行 `npm run manage -- strains`、`seed`、`publish` 等价。未主动 seed 时首次交互启动展示种系选择器，非交互启动采用全局默认（未设置时为 origin）。

全局 `SEEDA_LIBRARY` 默认 `~/.local/share/seeda/strains-library`，包含 Git repository、strains checkout 与 catalog.db；catalog 登记名称、ID、提交、父种系、来源项目/版本和说明。origin 首次保存通用实现，以后不自动更新。播种始终从登记提交创建临时 checkout 后复制，目录中的未提交修改不会改变播种实现。

项目默认运行库 `.seeda/runtime/` 包含原有专用 Git、版本依赖、SQLite 与全部成长/会话记录。新 seed_origin 单行表保存所选种系 ID、名称、Git commit，status 也返回该来源。后续演进仍使用项目 versions 的父关系，不需要全局库才能继续运行。已有实现拒绝重新 seed；未知种系报错，历史不覆盖。

`seeda publish 新名称 [完整本地版本ID]` 将项目已登记提交发布到全局库，省略 ID 取当前版本；新版发布同时需要 --intro FILE，见 [[docs/种系选择与发布]]。名称为最多 64 个小写字母、数字、连字符且以字母开头，重复名称拒绝。发布忽略运行 worktree 未提交修改，不传播业务目录、.env、会话或运行 DB；它保存实现，不自动作质量判断或替换项目主实例。Agent management 可调用 `strains` 和 `publish(name, version?)`，既有 RSI 评价与接替机制继续使用。

项目定位从真实 cwd 向上查找最近已有运行库或 `.git`，支持 Git worktree `.git` 文件；无标记时使用 cwd。各项目独立 socket/守护，可并行运行。显式 SEEDA_HOME 仍保持单项目绑定。

旧默认 `~/.local/share/seeda` 不自动搬迁、不删除；继续旧状态使用 `SEEDA_HOME="$HOME/.local/share/seeda"` 运行新版入口。要停旧守护同样带这个变量调用 manage stop。未设置该变量的新启动采用项目本地库，这是新的默认行为。初始化与发布不需要模型凭据；运行 Agent 仍需要原有模型配置。

嫁接 Graft 由 Agent 使用现有 Git/Bash 与候选管理完成，详见 [[docs/Agent嫁接流程]]。跨机器同步、种系删除/改名和自动发布策略仍未实现。

种系库与播种验证（2026-10-13）：类型检查、45 项回归和 OpenSpec 严格校验通过，多项目实际进程/本地 HTTP 模型验证见 `.seeda/project-seeding-1791822424966/report.json` 与 tests.log。默认启动及 TUI 会话命令、slash 预览实测见 `.seeda/session-pty-1791822293972/report.json`。本轮没有替换用户已有运行版本、迁移旧库、注册全局命令或调用真实 DeepSeek。

嫁接流程沿用 strains、draft、submit、evaluate、evidence、decide、promote、rollback。平台没有 graft-export/graft-import 命令或专用嫁接表；Git 补丁由 Agent 的 Bash 操作生成和应用。

种系选择和默认设置、标准介绍发布见 [[docs/种系选择与发布]]。既有项目保留自己的播种来源与版本选择，默认变化不会覆盖它们。

## 睡眠与心跳恢复

守护监测自身执行间隔：电脑睡眠或守护长时间暂停后，重新给予 worker 一个 6 秒心跳观察窗口，避免先唤醒的守护把健康 worker 误判为失联。正常监测下持续缺失心跳仍会终止 worker 并执行既有恢复；ready 时也重置观察起点。间隔采用单调时钟。

instances.reason 区分 `Worker heartbeat timed out`、`Worker startup timed out` 与外部退出的信号/退出码。旧记录只有 SIGKILL，不能单凭它确定历史终止来源。管理源码更新后需停止并重开守护，保存的 Agent 实现与会话不需覆盖。

## 前端独立更新

全局命令始终使用安装目录的CLI/TUI/守护；select和promote只切换Agent worker。新保存和发布的种系排除前端与外部管理代码；旧快照兼容，不从版本目录启动其CLI。安装更新可使用仓库npm link；守护管理代码变更需seeda stop后重开。前端保持同一socket连接即可观察新主实例，无需跟随Agent更新全局入口。
