# Supervisor局部简化
workstream: simplify-supervisor

目标：减少必须同步的状态和重复执行代码，保持行为。范围是刚修改的恢复/主worker生命周期，不重构平台、候选沙箱、版本存储或实验编排。

1. recovery Promise为是否恢复的唯一来源，删除recovering布尔镜像。
2. 活跃请求由其事件回调存在性表示，删除activeRequest布尔镜像；取消标志仍独立保留，覆盖重启间隙。
3. 用一个私有startPrimary创建主worker并等待ready。调用调查确认Supervisor.worker只有primary调用；候选仍由SandboxCandidate创建，WorkerProcess及沙箱自身角色/执行隔离检查保留。主实例回调仍核对实例身份。
4. 恢复目标以明确的顺序列表表达，移除嵌套三元；不合并主动切换与崩溃恢复两个语义不同的策略。closed检查在异步等待前后保留，消除同步连续重复检查。

不新增Hash、冻结协议、Gate、状态机框架或扩展配置。原请求、取消、日志、未知工具、同版本优先、previous、native evaluate及显式接受完全保留。测试不改期望来迎合重构。

步骤和状态见[[openspec/changes/simplify-supervisor/tasks]]。验收：现有151项完整serial回归和正式sandboxed stage/Meter八场景；类型、OpenSpec strict、真实命令退出码与产物。对比本轮改动前源码，避免将上轮未提交差异算成本轮简化。全部隔离、本地固定模型，保留此前记录；不发布、改默认或启动正式实验。
