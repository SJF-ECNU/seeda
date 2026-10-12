# 默认托管启动
workstream: default-managed-start

默认连接已有守护；不存在时 fork 当前管理入口为 detached 后台进程，输出写入数据根启动日志。守护在已有 SQLite 启动事务内初始化首次 Git/依赖，避免并发首次初始化。前端等待 running，再核对真实 cwd 后连接。启动失败有明确日志位置，不静默降级为直接模式。已有其他项目的守护不接管，用 SEEDA_HOME 选择独立数据根。

退出前端不停止守护，再次打开连接同一主实例和会话。首次版本安装可能需要等待；缺少凭据且没有现有守护时立即报错。直接模式显式 SEEDA_MANAGED=0 / npm run start:direct。start:managed 保留为默认入口别名。验证见 [[openspec/changes/default-managed-start/tasks]]。
