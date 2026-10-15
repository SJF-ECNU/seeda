# macOS process 子进程支持
workstream: macos-process-subprocess

## 假设与目标
默认 process 不变；候选可以运行 Bash、Node、tsc、测试与 Git 可执行文件；读写/网络/socket/长期凭据边界不变。系统运行文件与候选依赖决定可用工具，不把整个用户工具目录加入白名单。

## 最小方案
自行实现一个 macOS 系统 Python 薄包装，通过 libproc 枚举进程、sandbox_check 查询内核继承权限；不使用进程树轮询、候选上报 PID 或第三方 SDK。用当前评测的可读工作目录与受保护空文件 `.host-only` 的拒读权限识别归属。该文件禁止候选读写/删除；宿主启动前验证自己不匹配此权限组合，并在加载候选前实际验证候选进程匹配，否则拒绝运行。
现有 guardian 在正常退出、取消、超时或宿主断开后，先冻结匹配后代，再扫描纳入并发 fork 后代、终止并确认消失；每次信号前重新验证权限归属。即使子进程 setsid、脱离原进程组或父进程已退出，也保留相同 Seatbelt 权限。进程权限查询失败或三秒内未回收完成会报告失败。
允许 process-fork 和 signal(target same-sandbox)，保持宿主信号、网络和目录越界拒绝。加入候选 node_modules/.bin、当前 Node 的 npm 包与已安装系统开发工具路径，以支持本机工具链；不暴露整个用户工具目录。Linux/容器行为不变，默认仍为 process。

## 取舍与验证
最初尝试沙箱内清理进程和全进程信号，但实际探测会暂停清理进程自身，因此放弃该实现，未作为正式回收路径。当前方案增加约六十行系统 Python，仅使用系统库；macOS 系统 Python 3 或查询能力不可用时明确失败，不退回无隔离或 Docker。
验证包括旧 fork 禁止规则复现 EPERM、实际 Bash/Node/tsc/npm/Git、子进程越界拒绝、protected marker 不可删除、宿主/其他沙箱存活、正常/取消/超时/宿主被杀时 detached 与 reparented 后代停止。模型只用本地 HTTP 模拟，真实 OS/进程执行。

## 步骤
唯一清单见 [[openspec/changes/macos-process-subprocess/tasks]]。当前工作树另有网关未提交改动，只修改本任务范围。

## 结果
类型检查、15 项沙箱专项与 107 项完整回归通过；默认 evaluate 已实际执行 Bash。旧禁止 fork 规则对照返回 EPERM，新规则 pwd 退出 0。尚未提交、发布新种系或重启现有服务。
