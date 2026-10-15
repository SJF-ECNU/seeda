# Why
当前 evaluate 使用独立目录和候选进程，但没有操作系统权限隔离。候选加载时即能执行任意代码，目录隔离与隐藏 management 工具无法约束文件、网络、socket 和信号访问。

# What Changes
- evaluate 必须经过宿主控制的 sandbox，模型选择 process 或 container，不允许 none，也不静默退回无沙箱运行。
- 轻量评测使用本机进程沙箱，无需 Docker；需要独立 Linux 环境的评测可选择容器。
- 隔离从加载候选前生效，覆盖子进程；凭据、输入、输出和回收由宿主控制。
- 沿用现有评价、证据、decide/promote 语义，不增加数据库、Hash、Contract 或发布门禁。

# Impact
Supervisor.evaluate、候选执行/通信、management schema、管理 CLI、评测测试及使用文档。主实例执行与现有在线部署不在本次改动范围。
