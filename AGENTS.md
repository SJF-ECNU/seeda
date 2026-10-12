## Project Memory

For meaningful repository work, use the repository-local `project-memory` Skill when the client supports repository Skills, and follow [the Project Memory protocol](project-memory/协议.md). If the client does not support Skills, follow the protocol directly.

- Start or resume from [Project Memory Home](project-memory/首页.md), then read the relevant workstream and its most recent linked worklog. Explore older related history from newest to oldest only when the current context is insufficient, and stop when enough information has been recovered.
- Project Memory, the documentation map, and the repository-local Skill follow the current Git checkout. After switching branches or commits, reload context from the current checkout instead of carrying forward cached state from the previous version.
- Verify inherited state against Git, current code and configuration, and the repository's active change specifications before relying on it.
- On completion, handoff, cancellation, or a durable blocker, perform the protocol's closeout flow. Ordinary questions and inconclusive exploration do not create worklogs.

## Information Placement

- Agent instruction files such as `AGENTS.md` and vendor-specific entry files contain only stable, repository-wide instructions that change how an agent should work.
- Code, configuration, architecture documents, runbooks, and change specifications remain the authoritative sources for detailed behavior and procedures.
- Before creating, moving, or superseding authoritative project documentation, follow [the documentation policy](docs/文档规范.md) and update the relevant entry under [Documentation Home](docs/首页.md). Keep transient progress in Project Memory instead of project documentation.
- Stable Project Memory notes summarize project purpose, current boundaries, development cautions, and environment or deployment information, with links to authoritative sources.
- `project-memory/工作流/` stores the current goal, verified progress, blockers, and next step for each bounded stream of work.
- `project-memory/工作记录/` stores append-only evidence for completed, blocked, cancelled, or handed-off work.
- Branch snapshots, documentation inventories, feature inventories, recent progress, deployment steps, environment values, test results, and historical conclusions do not belong in agent instruction files.

Only add instructions to an always-loaded agent file when they are stable, apply across most repository tasks, change agent behavior, and cannot be recovered cheaply through a conditional pointer.


## 用户工作规则

所有面向用户的输出末尾带上“喵～”。

代码开发前明确假设、取舍和可验证目标，使用 OpenSpec 规划任务。存在 `.codegraph/` 时先使用 CodeGraph MCP（或 `codegraph explore`）调查结构，无法满足时再有界阅读代码；不存在时跳过，不自动索引。

保持最小实现与局部修改，不顺手重构无关内容；完成后执行与变化相称的验证。

默认不新增 Hash、冻结 Contract、Baseline 或 Gate；只有明确具体失败场景，并逐项解释 Git、版本号、主键、事务、唯一约束、类型系统和普通测试为何不足时才允许加入。保留已有安全措施；Gate 仅用于不可逆操作、跨系统交互、安全边界或正式发布。前置检查不能替代实际执行与验证。

可按任务难度使用子代理；使用结束后关闭不再需要的子代理。

长时间异步任务且不需要中间输出时，空 `write_stdin` 轮询使用至少 180000 ms（优先 300000 ms），`functions.wait` 使用至少 180000 ms。嵌套等待的外层 exec 在宿主支持时比最长等待至少多 30000 ms；交互输入不受此限制。不要只为报告仍在运行而唤醒。
