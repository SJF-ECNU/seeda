# CLI 命令审查
无参数仍 TUI。任务改为 seeda run TEXT 或 seeda -- TEXT，未知命令退出2，避免猜测任务。管理命令统一校验数量、非空值、未知/重复选项；publish 接受 --intro FILE/--intro=FILE，规范化后供既有执行器使用。runtime CLI 复用校验（内部 auto-serve 只该入口可用），校验先于 cwd/DB/socket。help/version 本地退出。
已知 slash 命令可在 CLI/TUI 使用，缺参数、多余参数与未知 slash 不发给模型。明确 run/-- 可以发送字面 slash 文本。业务错误退出1，不把错误转为模型任务。
实测用独立运行库与种系库、本地HTTP计数器；控制操作零模型请求，明确任务才增加请求。保留正常任务、初始选择与旧管理入口兼容；旧隐式任务语法明确更新文档和测试。见 tasks.md。

验证：类型检查、53项完整回归、OpenSpec严格校验通过。实际安装入口控制实测报告 `.seeda/cli-audit-1791825412304/report.json`；控制模型请求0，明确任务2次。10类管理命令经真实入口连接隔离socket验证参数映射。
