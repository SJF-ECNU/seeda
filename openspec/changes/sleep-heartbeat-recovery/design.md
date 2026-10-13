# 睡眠后心跳误判修复
workstream: sleep-heartbeat-recovery

证据：instances历史SIGKILL结束时间与macOS DarkWake/Wake同秒；父进程每秒检查Date.now-lastHeartbeat>6秒立即杀worker，系统睡眠后父先恢复即可误判。不能从旧记录区分kill源，历史原因以高度吻合推断描述。

修复：心跳使用单调时钟；若守护检查间隔超过6秒，重设观测起点，给worker一个正常心跳窗口。ready也重设起点。真正失联保持6秒阈值；不删除杀进程/重试/回退措施。启动15秒与停止2.5秒策略保留；kill原因记录startup timeout/heartbeat timeout，否则保留退出码信号。

验证：真实fork worker配合受控时钟/监测定时器模拟父进程暂停；验证唤醒先检查不会杀，收到心跳可继续，真正无心跳仍杀且原因明确。完整回归后只重启当前项目守护使运行管理修复生效，不改保存Agent版本或会话。

步骤见tasks；未决：真实合盖重开长期验证本轮不主动让用户设备睡眠。

结果：受控暂停60秒真实worker测试通过；类型/54项完整回归/严格校验通过。首次完整回归遇到既有Bash kill EPERM，保留日志 /tmp/seeda-heartbeat-full.log，重跑成功 /tmp/seeda-heartbeat-full-retry.log。当前项目守护已重启加载修改并实际PTY就绪；未主动让设备睡眠，真实长期合盖恢复仍待观察。
