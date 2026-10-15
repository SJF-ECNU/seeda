# 原生 evaluate 沙箱
workstream: native-evaluation-sandbox
status: implemented

## 目标与范围
宿主确保每次实际 evaluate 都有沙箱；模型自由制定评测任务并选择 process 或 container。静态分析无需运行 evaluate。首版不做自动风险分类、云平台、调度集群、通用插件系统、gVisor/microVM，也不改变主实例权限或质量接受流程。

## 当前证据
- src/runtime/supervisor.ts 的 evaluate 创建 workspace、session 和 outputs，运行候选 WorkerProcess，120 秒后取消，并延迟强停。
- src/runtime/process.ts 使用 Node fork IPC；候选 process 消息中的 PID 被加入宿主 killGroup 集合。这不是可信的隔离控制来源，不能用于新候选执行器的宿主进程清理。
- 候选目前继承真实 HOME 和选定 API 凭据；禁止 management 不会阻止它直接访问宿主控制 socket 或文件。
- 未发现 .codegraph，按仓库规则跳过索引与 CodeGraph；上述结论来自有界源码阅读。

## 接口与兼容取舍
management evaluate 增加 sandbox 字段，取值 process/container；省略时使用 process，兼容既有调用形状，但仍强制隔离。显式 none、未知值与后端启动失败均报错。模型通过工具描述了解两种选择与不可用原因，不由候选控制策略。
CLI 保留 evaluate VERSION TASK，增加可选末尾 process/container 参数；两条入口共用宿主参数校验。实现时同步帮助与参数个数测试。
首版不让模型传任意挂载、容器运行参数、执行包装命令、宿主凭据路径或放宽安全策略。所选后端记录到现有 evidence JSON，不增加数据库列。

## 最小执行边界
增加只服务候选的 sandbox runner：prepare/start、run、cancel、stop 与结果收集。主实例继续使用现有 WorkerProcess，不为统一形式重构主服务。
候选入口、包装器、网络出口与清理由宿主控制；从加载候选模块之前启动隔离，不能只包装 Bash。候选运行时只读；独立 workspace、HOME、临时目录、session/outputs 可写，正式 state.db、control.sock、版本库元数据、主会话及用户凭据不可访问。
证据最终由宿主写入；任务产物与候选自报结果均是不可信输入，不能当成独立质量证明。沿用现有宿主 decide/promote 检查。

## 进程后端
macOS 使用 Seatbelt；Linux 使用 Bubblewrap 并结合网络/信号/进程隔离；其他系统首版明确不支持，不能假装执行成功。
用户进一步要求自行实现且极度简单：不引入 sandbox SDK，直接使用系统 Seatbelt/Bubblewrap 与 Docker CLI。实现只包含启动器、候选 IPC 适配和独立回收 guardian，约 300 行；不建设通用平台。文件读取采用必要路径白名单，不能只拒绝少数凭据目录。
只暴露实际 Node、候选依赖与必要系统运行文件，独立 HOME/TMP；处理 realpath、符号链接以及 /var 与 /private/var 别名。
macOS 初版禁止 fork 导致默认评测无法使用 Bash；已由 [[openspec/changes/macos-process-subprocess/design]] 修复为允许继承限制的子进程，并按内核权限识别回收，不依赖进程树或候选自报 PID。Linux 使用 PID namespace、只读根和显式可写目录，可运行子进程。进程后端不承诺容器等价的 CPU/内存限额；可写产物目录没有硬磁盘配额。

## 容器后端
使用 Docker CLI 执行一次性 Node Linux 容器；非 root、去除 capabilities、no-new-privileges、只读根目录、独立临时目录、CPU/内存/PID 限制；不启用 privileged/host network，不挂载 Docker socket 或宿主 HOME。
容器拥有独立 Linux 依赖：不能直接复用 macOS node_modules。准备候选与安装依赖也必须在受限环境中完成，不能在宿主运行候选安装脚本。基础镜像固定 node:24-bookworm-slim，首版不允许候选指定任意镜像或 Docker 参数。准备容器单独允许网络且不挂载候选源码/宿主凭据，运行容器完全断网。
宿主按自身创建的容器标识停止/删除；容器内 PID 不用于宿主 kill。

## 通信与凭据
现有 Node fork IPC 不能直接跨 docker exec/run 使用；实现候选专用的受控流式通信，不把控制 socket 暴露给候选。使用标准输入输出适配已保存 worker 的 process.send/message 接口，不改历史版本源码。总输出 16 MiB、单行缓冲 8 MiB，畸形消息明确失败。独立 guardian 通过宿主 IPC 转发输出与回收，候选无法访问该管理通道。
不信任候选 process/management 消息；宿主只操作自己创建的进程或容器。不接受候选自报 PID 作为宿主信号目标。
模型调用经过宿主控制的受限出口，优先用代理持有长期凭据；候选只获得本次调用能力。不得因复用已有 DeepSeekModel 就向候选透传宿主 env。默认拒绝其他外联，包括宿主/内网/元数据地址；任意 base URL/重定向不应成为通用转发。
首版只代理当前宿主模型的固定 Chat Completions 地址，拒绝 HTTP 重定向，忽略候选 headers/URL。候选只见占位 Key；宿主加真实凭据。每次评测最多 64 请求、请求/响应各 4 MiB；响应缓冲后交回候选，非实时 token 流。容器准备与评测共享整体 120 秒限制；没有额外独立准备计时字段。模型出口已用本地 fake-model 实测，不开放候选任意网络。

## 生命周期与失败
保留单候选、现有超时和取消语义；宿主记录启动失败、运行失败、超时或取消，均执行回收。候选沙箱不可用时返回可操作错误，不回退。
宿主正常退出、强制终止和重启均要验证：容器不能只依赖 docker CLI 退出即回收；本机进程不能只信任候选上报的进程列表。允许用已有 evaluation ID 命名和识别本任务资源，不增加自定义锁。
若后端不能可靠阻断独立后台进程残留，则该后端不能宣称已满足 evaluate 边界，须先解决或明确拒绝启动。

## 实施步骤与状态
唯一清单见 [[openspec/changes/native-evaluation-sandbox/tasks]]。实现和当前环境验收完成；使用与限制见 [[docs/evaluate沙箱]]。

## 本机能力探测（2026-10-15）
- sandbox-exec 存在，临时策略真实执行 shell：允许目录写入成功，目录外写入 Operation not permitted 且未创建文件。此探测只证明写策略生效，不证明完整读取/网络/信号/回收边界。
- Docker daemon 可访问，报告 linux/aarch64；本机已有 node:24-bookworm-slim 镜像。
- 未操作任何已有服务或在线 Agent，未调用付费模型。

## 实现验证（2026-10-15）
- npm run check 通过；npm test 95/95 通过，覆盖实际轻量 prompt evaluate、容器 Bash、嫁接、evidence/decide/promote 和故障恢复。
- tests/sandbox.test.ts 11/11：真实 macOS Seatbelt 与 Docker，模型由本地 HTTP 服务模拟；覆盖读写/符号链接/TCP/Unix socket/信号、凭据、伪造 PID、取消、超量输出、管理消息、后端不可用及超时。
- Linux 验证在临时 Node 24 Debian 容器中安装 Bubblewrap。外层常规容器不能 mount proc 时真实失败且未降级；为验证 namespace 功能，仅外层测试容器开启 privileged，不挂载宿主目录或 Docker socket。内部进程沙箱仍启用 unshare-all、cap-drop ALL、只读根和 die-with-parent，8 项适用测试通过，3 项 Docker 测试因未连接 daemon 跳过。此结果不代表所有 Linux 发行版/内核配置已覆盖，实际受限宿主可能拒绝启动。
- 首次发现容器回收后名称可能短暂仍可 inspect，guardian 增加有界删除确认；输出发送后直接退出会丢失最终错误，修正为 IPC 队列发送完成再退出。修复后真实测试通过。
- 没有调用付费提供商；没有重启已有守护、发布种系或迁移项目。
