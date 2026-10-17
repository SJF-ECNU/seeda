# Terminal-Bench 分层可靠验证补丁

实验专属部署、公开反馈边界与行为验证放在此处，不进入 Agent 核心。

`harness.patch` 对应本地 tb-effective-evolution 实验框架的本次差异；基于此前保留的实验源码使用 `git apply --unidiff-zero` 应用；先用 `--check` 核对。该框架当前独立保存于 `/Users/shjf/work/tb-effective-evolution`，不是此仓库的运行依赖。补丁不含隐藏测试、参考答案、凭据或任务产物。`layered_flow_smoke.py` 使用既有正式 runner/Seatbelt/Docker/官方评分执行；`layered_model_probe.py` 是独立公开小任务。脚本沿用本机证据路径，不是开箱即用的第三方 Bench 安装器。

机制夹具覆盖有效失败反馈、draft/submit/native evaluate、正式配对、显式接受与接替、下一题实际版本加载/行为，以及执行和评分环境故障停止、留出禁止改版。固定模型不证明自主提升。两臂真实模型小样本均使用验证技能且通过独立检查，尚不支持新增指令有额外收益；候选该次耗时更高。

通用工具与使用说明见 [可靠验证 Skill](../../../.agents/skills/reliable-verification/SKILL.md)。正式运行的任务、计量、安全策略仍属于实验框架；本补丁没有增加资源额度。
