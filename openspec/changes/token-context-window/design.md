# 1M token上下文
workstream: token-context-window
目标：默认窗口1,000,000 tokens，不把字符作为token。官方deepseek-flash窗口1M。上下文是输入与输出预算，保留模型配置输出额度（默认4096）。
方案：新增maxContextTokens默认1M；旧maxContextChars仅显式调用兼容。请求实际prompt usage用于下次计量，新增内容用UTF8字节/3估算，首次同样估算，不能宣称精确tokenizer。压缩前后校验用相同计量；上下文变化/摘要后重置测量；工具定义计入。TUI优先实际promptTokens/1M，旧版本指标注明字符。
步骤：候选与仓库核心实现；token边界/usage和核心回归；当前进化项目候选完整验证并select；默认模板保存更新；留档。保留当前进化功能，禁止替换活跃DB。
未决：不发送百万token付费请求；精确tokenizer未接入，未知内容估算可能误差。
