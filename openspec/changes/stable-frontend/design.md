# 稳定前端与进化执行分离
workstream: stable-frontend
单一源码包，CLI/TUI、守护/版本/种系管理稳定安装；worker/core/model/tools可随项目实现版本切换。全局npm link指向稳定src/cli.ts，移除机器上的动态版本薄壳（npm link替换为稳定安装）。保留输入/取消/事件接口，不增协议框架。
新保存源码排除src/cli.ts、cli-arguments.ts、tui、versions、strains以及runtime管理代码，保留runtime/worker.ts和protocol.ts（必要的执行协议）；剩余src扩展保留。测试仅保留不引用被排除模块的Agent测试；包和Skill保留。旧快照仍可被稳定守护运行；draft来自旧快照时submit清理管理层文件，Agent改动仍保存。发布全局库也过滤旧快照，不改变旧记录。
验证：坏掉的候选CLI不影响稳定入口；新保存不包含前端/守护，旧版本兼容；同一连接在select后仍可执行；类型/完整回归；实际全局安装并两个项目连接，保留会话。当前1M token改动保留。
步骤见tasks。前端与守护更新需安装/显式重启，Agent promote不更新它们。

完成证据：57项安装层完整回归、33项收窄后进化Agent回归、类型和严格OpenSpec通过。坏版本CLI不影响稳定入口、select后同一连接可查询新版本、发布不复制未保存内容。实际两个项目都running且会话保留；新默认seeda-agent-stable播种不含CLI并保留Web工具。首次回归遇到既有Bash EPERM以及发布错误使用runtime未提交内容；后者已修复为读取保存Git提交，完整重跑通过。

补充：执行包名seeda-agent（不复用安装层seeda），无bin，避免在Agent目录npm link覆盖稳定安装；针对性分离测试再次通过。最终运行版本见.seeda/frontend-separation/final-report.json。

本机全面应用：扫描用户目录中的state.db与实际守护/全局命令，确认两个项目运行库及旧全局运行库三处；排除测试归档与其他产品DB。三处守护统一稳定安装源码，Agent保持各自实现，仅旧全局库新增执行边界快照；会话和消息数不变。全局唯一seeda安装完成npm link。证据.seeda/frontend-separation/computer-deployment.json。
