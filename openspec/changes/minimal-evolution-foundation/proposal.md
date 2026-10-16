## Why

连续任务实验暴露出错误事实难以直接使用、自改管理操作冗长、任务环境接入依赖修改Agent源码的问题。基础版本应提供少量可组合能力，允许Agent自行提出改进；不内置固定复盘节奏或用接替次数衡量收益。

## What Changes

- 复用运行记录补齐结构化执行失败信息，区分运行结束与外部任务质量。
- 候选验证直接返回有界证据摘要，允许显式接受与接替合并调用，保留原有操作和全部检查。
- 从Bash中抽出本地/容器命令执行接入，由宿主选择环境，避免为评测修改进化源码。
- 方案后获用户授权开发，现已实现并完成实际验证；不发布或设默认，不恢复已暂停实验。

## Capabilities

### New Capabilities
- `foundation-execution-feedback`: structured execution facts without inferred task quality.
- `foundation-evolution-ergonomics`: fewer management round trips with unchanged acceptance conditions.
- `foundation-command-execution`: host-selected local/container execution for the same Agent version.

### Modified Capabilities

## Impact

预期局部涉及core运行事件与记录、management工具及Supervisor、Bash执行边界和runtime接线。复用Git/SQLite/JSONL及现有沙箱；不新增服务、进化调度器、数据库、插件框架、Hash、冻结Contract或审批Gate。实现范围以design.md为准。
