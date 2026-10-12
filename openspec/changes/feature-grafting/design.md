# Agent 自主嫁接 Graft
workstream: feature-grafting

用户最终确认：以 Git 为基础，叫“嫁接”；只保留基础接口，Agent 自己完成。此前专用 JSON 导出/导入草案已撤销，对应代码、接口和 grafts 表均移除，不保留第二套工作流。

Agent 通过 management.strains 获取已登记种系及 commit/path，明确源种系、基础种系和文件范围。用 Bash 执行 Git diff（保存提交之间的 --binary --full-index --no-renames 差异），工件保存到项目自己的输出目录。源目录只用于读取 Git 对象，不修改保留实现。

management.draft 从目标当前版本建立编辑目录。Agent 先 git apply --check，再应用补丁；冲突在草稿解决，不覆盖主版本，不声称已完成。普通 Git 命令和测试负责适配，不提供插件接入、自动冲突解决或专用嫁接协议。管理工具描述提供此用法，不新增工具操作。

Agent 的 submit reason 记录源种系 ID、源/基础提交和范围；现有 Git 提交、版本父链、工具会话、输出文件和 evaluation 保存来源及结果，不新增嫁接数据库。submit 后 evaluate→evidence→decide→promote，沿用已有接受要求和请求边界切换。显式用户选版本语义不变。

验证使用实际进程/本地 HTTP 脚本模型：Agent 在已成长目标项目执行 Git/Bash，提交候选；候选实际 Bash 执行嫁接功能，源 Agent 检查证据、接受、提拔；重复应用触发冲突，保留草稿且主版本不变；回退保留目标原有改进。测试说明脚本模型不等同真实模型自主决策成功。执行清单见 tasks.md。
