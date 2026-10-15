# Why
macOS 默认 process 沙箱禁止 fork，普通 evaluate 连 pwd/Bash 都无法运行。保留默认 process 和现有隔离边界，恢复日常编码评测能力。
# What Changes
允许继承 Seatbelt 的子进程；宿主以实际内核权限识别并回收后代，清理进程位于候选沙箱之外且不接受候选上报 PID。覆盖取消、超时、宿主退出和脱离进程组的后代。自行实现最小包装，不引入 SDK、Docker 依赖或自动后端切换。
# Impact
src/sandbox、相关回归、工具描述与当前使用文档。其他并行网关改动、已有服务和种系发布不在本次范围。
