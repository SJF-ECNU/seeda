# reliable 上下文压缩
workstream: reliable-context-compaction

## 范围与来源
用户要求达到85%自动压缩并学习Codex。官方仓库研究提交6fbfc352cafb50332d62dbdc8720cb5d7fe3b7c7：core/src/compact.rs生成接续摘要、保留近期用户信息、成功后替换历史；本地摘要超窗会删最早历史重试。prompts/templates/compact/prompt.md强调进展、决策、约束、未完成事项与关键引用。官方Responses compact返回原生压缩项，不能直接用于当前Chat Completions。

保留接续摘要、近期用户指令、完整工具往返、失败保护与持久原记录。差异：不删除最旧内容；按请求预算逐批摘要，前一批摘要带入下一批。序列化材料过大时切分摘要材料，不拆有效上下文中的工具协议。每个摘要请求独立估算（不使用普通请求的usage校准），预留输出与请求余量；摘要过大或失败不替换session。以summary请求明确的数据片段标记防止片段被当成指令。

85%基于总窗口，取与输入预算较小值；在每次普通模型请求前判断。小窗口由既有AgentOptions.maxContextTokens显式设置；本次不增加模型自动识别。默认1M仍要求调用方匹配模型。

在当前源码实现，并在从发布reliable克隆的/Users/shjf/work/seeda-reliable-compaction验证同样核心改动；不更改种系库或活跃实例。保留两个目录各自原有身份与安全代码。

## 验证
85%前后边界、provider计量触发、多批超窗历史、单一超长工具结果、当前用户指令保留、摘要失败/取消/过大原context保留、session重载、完整回归和类型检查。真实模型测试如未执行必须注明，不称百万token已验证。
