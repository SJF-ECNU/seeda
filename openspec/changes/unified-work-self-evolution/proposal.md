# Change: 同任务自主工作与自改接替
## Why
原生工具循环已有工作/自改入口，但运行中已批准接替要等整次请求结束；实验分阶段又限制自改入口。需直接使用原生循环并补安全接替续跑，避免学习编排。
## What Changes
- 支持有待切换版本时整批工具后正常让出，Supervisor安全接替并恢复同一任务。
- 保留既有隔离验证、显式接受、取消与恢复、日志计量；普通工作无强制反思。
- 正式实验不重启，旧实验源码记录保留。
## Impact
- Affected specs: unified-work-evolution
- Affected code: core agent, runtime worker/process/protocol/supervisor；完整路径测试。
