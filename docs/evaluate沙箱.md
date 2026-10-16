---
type: implementation-guide
project: seeda
status: current
---
# evaluate 沙箱

所有实际 evaluate 都由宿主启动沙箱，模型选择 `process` 或 `container`；省略默认 `process`。`none`、未知后端、后端无法启动均明确失败，不退回无沙箱执行。主实例与其他 Bash 调用不受此改动影响。

```bash
npm run manage -- evaluate VERSION_ID '用固定输入验证新 prompt 的回答' process
npm run manage -- evaluate VERSION_ID '在 /candidate 检查代码并运行测试' container
```

Agent management 同样使用 `{operation: "evaluate", version: "...", task: "...", sandbox: "container"}`。普通本机 shell/测试任务可用默认 process；需要独立 Linux 环境或依赖时选择容器，不根据改动行数自动分类。

## 两种选择

| 后端 | 环境与用途 | 依赖与限制 |
| --- | --- | --- |
| process / macOS | Seatbelt，保留当前 Node 与候选依赖；适合 prompt、Bash、Node/TypeScript 测试和 Git | 无需 Docker；需要系统 Python 3 与内核沙箱查询；子进程继承文件、网络和信号限制 |
| process / Linux | Bubblewrap，独立 PID/网络等 namespace，显式绑定候选和系统运行文件 | 需要 bwrap 与允许创建 namespace 的宿主；缺失或被禁止时失败 |
| container | Node 24 Debian Linux 一次性容器；适合 Bash、独立依赖和环境变更 | 需要 Docker daemon；使用 node:24-bookworm-slim；不验证 macOS 专属行为 |

容器在准备阶段单独运行 `npm ci --ignore-scripts`，不复用 macOS node_modules；准备阶段允许网络下载依赖，只挂载 package/锁文件与隔离依赖目录，不传模型凭据。评测阶段断网，非 root、只读根、移除 capabilities，限制 2 CPU、1 GiB 内存、128 PID，临时文件系统 256 MiB。候选源码位于 `/candidate`，可写工作目录为 `/evaluation/workspace`。依赖安装脚本不会自动执行；任务可在可写 workspace 内自行准备其他依赖，但评测阶段无任意下载能力。

## 边界与回收

实现由 seeda 自行编写，直接调用 OS/容器原语，没有引入第三方 sandbox SDK、服务平台或插件框架。宿主启动器、候选通信适配、guardian 与 macOS 回收薄包装位于 src/sandbox；这些宿主文件不进入 Agent 进化快照。候选的现有 worker IPC 接口由沙箱内适配器转换，因此无需改写已保存候选的 worker 源码。

候选只读自身运行目录和必要系统文件；可写独立 HOME、workspace、session、outputs 和临时目录。真实项目、state.db、控制 socket、正式会话与宿主凭据不可读写。产物位于 `evaluations/<id>/sandbox/`，最终 `result.json` 位于该可写区域之外，由宿主在停止沙箱后写入，包含实际后端和失败原因。

模型推理通过标准输入输出转到宿主固定的 DeepSeek Chat Completions 地址。宿主自行加凭据，拒绝 HTTP 重定向，不接受候选指定的 URL、headers 或任意代理请求。每次 evaluate 最多 64 次模型请求，请求和响应分别最多 4 MiB；模型响应缓冲后交回候选，因此评测文本不会实时逐 token 展示。仍沿用宿主已有代理配置。

候选通信总输出最多 16 MiB，未终止单行最多 8 MiB；畸形输出、管理消息与超量输出失败。候选上报的 PID 不会被当作宿主信号目标。macOS guardian 通过系统 Python 3 调用内核 sandbox_check 和 libproc，依据继承的权限识别后代；受保护的空文件 `.host-only` 为该评测提供额外只允许宿主读取的路径。启动前检查查询能力，实际权限验证完成后才加载候选；先冻结后终止并复查，覆盖 detached/reparented 后代，也不会选择权限不同的宿主或其他评测进程。候选无法删除该识别文件；此文件不存放凭据。缺少系统 Python 3（通常由 Command Line Tools 提供）或查询不匹配时明确失败。独立 guardian 只操作自己创建的进程或容器；宿主断开、候选取消或超时都会触发回收。容器删除失败会报告失败，不把未回收的运行称为完成。

进程后端不承诺与容器等价的 CPU/内存/PID 限额；可写产物目录目前没有硬磁盘配额。普通容器也不是 VM 级隔离。候选回答、测试报告和日志仍是候选产物，质量判断继续由现有 evidence→decide→promote 流程完成。

## 验证与部署范围

`tests/sandbox.test.ts` 真实执行 macOS Seatbelt 与 Docker，并以本地 HTTP 服务模拟模型；覆盖越界读写、符号链接、TCP/Unix socket、宿主 PID、凭据不透传、取消、宿主被杀、后台容器子进程、超量输出、无后端和超时。Linux Bubblewrap 在临时 Node 24 Debian Linux 环境中通过 8 项适用测试，3 项 Docker 测试因未连接 daemon 跳过。外层测试容器单独开启 privileged 以允许嵌套 namespace；内部沙箱仍移除全部 capabilities，运行容器后端不使用 privileged。普通受限容器下 mount proc 被拒绝的失败路径也已观察，未降级。这不代表所有 Linux 内核/发行版均已验证。

本次只修改源码与文档，不重启已有守护、不发布种系、不迁移现有项目。运行中的守护保留启动时的宿主代码，使用新实现需要正常停止并用更新后的安装重新启动。旧主 Agent 的工具描述可能没有 sandbox 字段；可通过新版管理 CLI 显式选择，或按原升级流程更新 Agent 工具描述。

相关设计：[[openspec/changes/native-evaluation-sandbox/design]]；运行流程：[[docs/版本守护与RSI运行指南]]。

## 基础版本后续更新
当前工作树已补齐结构化执行反馈、evaluate有界摘要、显式acceptReason合并接替和宿主执行接入。旧操作及隔离/回退仍保留，已有种系不会自动升级。细节与实测边界见 [[docs/基础版本最小改造与验证]]。
