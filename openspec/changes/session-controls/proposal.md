# Why
用户需要在长对话中主动新建、选择会话和压缩上下文，现有托管运行只使用 main.jsonl。
# What Changes
增加 /new、/sessions、/resume <id>、/compact。守护进程保存当前会话，核心负责可取消的摘要；TUI 只发命令并刷新显示。
# Impact
核心压缩、运行协议、托管会话选择、CLI/TUI 展示与使用文档。
