# 版本、守护与最小 RSI
workstream: implement-managed-runtime

## 范围与假设
单机、单主、最多单候选，可信本地任务。目录隔离不是权限沙箱。管理进程不自我更新、不迁移共享数据。质量判断由 Agent 留下证据和理由。

当前用户仓库无提交。初始化把允许的实现文件复制到数据根的专用 Git 库形成首个提交，不替用户提交工作树；后续候选使用该库的 detached worktree。依赖按每个版本 npm ci 独立安装。数据根默认 ~/.local/share/seeda，socket、SQLite、会话、版本环境在版本之外。

## 方案
版本存储使用 node:sqlite、主外键与事务，登记版本父关系、评价、实例、切换和单行运行选择。守护是单写者；socket 地址占用拒绝第二管理进程。worker 通过 IPC ready、heartbeat、event、result，断连取消并退出。正式请求始终只发给当前主实例，不自动重放故障任务。

切换持久化意图，忙碌时等待请求结束，先停止旧会话写入者，再启动新 worker 加载同一会话。新 worker ready 后事务改变当前/previous；失败重新启动原版本。选择先写意图再启动，管理进程重启放弃未完成切换并从已提交 current 恢复。worker 父 IPC 断开退出，防止残留旧实例继续运行。

A 可调用 management 工具创建编辑目录、提交候选、在独立工作目录与 session 运行 B、查看证据、记录评价、请求接替或回退。候选不提供 management 工具、不继承正式服务配置；模型凭据仅通过环境传入。验证结果包括状态、回答、事件与独立 session，失败和取消保存。接替要求当前 A 对当前 B 的实际完成验证记录 accept 与理由；手动选择不判断质量。

## 验证
见 [[openspec/changes/implement-managed-runtime/tasks]]。真实 Git/依赖、SQLite 重开、实际子进程崩溃/失联/父退出、请求边界、A/B 目录隔离及模型驱动改进都须实测，不能只检查状态变量。
