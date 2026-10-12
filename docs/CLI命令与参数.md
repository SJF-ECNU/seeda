---
type: reference
status: current
---
# CLI 命令与参数

无参数 `seeda` 进入 TUI；新项目先选择种系。所有命令名区分大小写。任务必须显式使用 `seeda run "任务"` 或 `seeda -- "任务"`；未知命令不会送给模型。通过 npm 执行任务为 `npm start -- run "任务"`。

| 命令 | 参数与用途 |
|---|---|
| `-h`、`--help`、`help` | 本地帮助；子命令 `--help` 也显示完整帮助 |
| `-v`、`--version` | 安装入口的包版本，不表示当前项目种系版本 |
| `run TEXT...` | 单次任务；字面短横线参数使用 `run -- TEXT...` |
| `-- TEXT...` | 单次字面任务，包括 `stop`、`/new`、`-h` 等文本 |
| `strains` | 列举种系；重定向输出 JSON |
| `strains default NAME` | 设置未来播种默认种系 |
| `seed [NAME或ID]` | 显式选择播种；无参数 TTY 打开选择器，非 TTY 用默认 |
| `publish NAME [VERSION] --intro FILE` | 发布保存版本；可用 `--intro=FILE`，选项可放在位置参数前后 |
| `init [SOURCE]` | 从源码目录显式初始化运行版本 |
| `serve [PROJECT]` | 前台运行守护 |
| `status`、`draft`、`stop` | 查询状态、创建候选、停止现有守护 |
| `submit DRAFT REASON` | 保存候选改动 |
| `evaluate VERSION TASK` | 启动候选验证任务；这是明确的验证操作 |
| `evidence EVALUATION` | 查询验证证据 |
| `decide EVALUATION accept或reject REASON` | 记录质量判断 |
| `promote VERSION EVALUATION REASON` | 根据已接受验证接替主版本 |
| `rollback REASON` | 回退主版本 |
| `select VERSION` | 显式切换主版本 |

包含空格的 TASK、REASON 或路径必须用 shell 引号。发布介绍 JSON 必须包含非空字符串 `summary`、`improvements`、`scenarios`、`limitations`、`validation`；模板见 [[docs/种系选择与发布]]。发布采用保存的 Git 版本，见 [[docs/版本守护与RSI运行指南]]。

入口和旧 `npm run manage -- COMMAND` 复用参数检查：缺少、空白、多余位置参数、未知选项、重复 `--intro`、未知命令均退出 2。帮助优先于子命令执行；不会打开运行库、连接守护或请求模型。文件不存在、介绍 JSON 错误、重复名称、重复播种或连接失败退出 1；选择器取消退出 130。命令失败不会转为任务。

托管 TUI/普通交互支持 `/new`、`/sessions`、`/resume ID`、`/compact`、`/versions`、`/use ID`、`/rollback`、`/exit`。未知 slash 或错误参数不请求模型；直接模式不支持托管控制命令。需要把 slash 当任务文本时使用明确的 `run` 或 `--`。交互详情见 [[docs/TUI前端实现与验证]]。

参数与路由回归见 [cli-audit.test.ts](../tests/cli-audit.test.ts)：运行安装后的 `seeda` 在临时种系库与项目中真实播种、发布、设置默认，控制操作模型请求为 0；本地 HTTP 对照中两个明确任务产生两次请求。管理命令使用临时 socket 验证完整参数映射，不操作用户现有守护。此验证不代表真实提供商结果质量。
