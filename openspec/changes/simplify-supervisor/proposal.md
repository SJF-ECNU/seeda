# Why
最近恢复实现增加了可由其他状态直接推导的布尔标记，主worker创建/ready在多路径重复；增加维护分支但不提供独立行为。
# What Changes
在现有Supervisor内部合并重复状态，统一主worker启动；明确重试顺序，保留所有预算和安全行为。不新增类、框架、配置或守护层。
# Impact
仅src/runtime/supervisor.ts；现有回归和正式stage故障注入验证行为不变，不发布或启动实验。
