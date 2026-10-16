## Why

regex-chess候选修改了实现目录AGENTS.md并接替，但主运行只读取任务cwd/AGENTS.md。候选在实现目录手动检验产生误判，需要从架构上分离自身和项目指令并记录实际读取来源。

## What Changes

- 实现版本内.agents/self的自身指令和通用记忆自动加载，项目规则保持cwd来源。
- 请求和压缩记录来源元数据，不保存正文；旧文件/会话兼容。
- 用真实主/候选模型请求验证接替、会话切换与回退，移除实验复制项目规则的临时接线。

## Capabilities

### New Capabilities
- `instruction-loading`: versioned self context independently composed with workspace rules.

### Modified Capabilities

## Impact

核心上下文、Agent请求/压缩、session运行元数据与文档；既有.agents快照足够。模型、权限、评分、候选沙箱、守护生命周期不变。
