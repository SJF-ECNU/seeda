# 项目播种
workstream: project-seeding

全局库默认 ~/.local/share/seeda/strains-library，SEEDA_LIBRARY 可覆盖；保存 strains SQLite 目录（ID、名称、Git commit、说明、来源项目/版本、父种系）与独立 Git 仓库及种系 checkout。名称唯一，不覆盖；origin 首次从安装源码保存，以后不自动更新。发布从已登记项目版本的 Git commit fetch，忽略运行目录未提交修改，不复制会话、凭据或运行数据库。

项目定位优先当前/祖先已有 .seeda/runtime/state.db，或最近 Git 根（.git 文件也支持），无二者使用 cwd。运行根默认项目/.seeda/runtime，SEEDA_HOME 保留原有显式覆盖。项目 SQLite 增加播种来源表，选定种系的实现复制到项目独立 Git 与依赖；已有版本拒绝 seed，不替换主实例。自动启动未播种项目选 origin；已播种项目不需要全局库持续在线。初始化继续利用已有 BEGIN IMMEDIATE 串行化，来源和初始版本同时提交。

管理命令：strains 列表；seed [种系名称或完整ID]；publish <新名称> [本地版本ID]（省略取当前）。init <源码路径> 保留旧显式初始化兼容，推荐 seed。全局目录登记是主动发布，不自动认可质量；源项目已有验证仍由 Agent/用户负责。仅完整种系传播，不增加 Graft、插件框架、数据库替代物、Hash 或冻结契约。

验证：两个无 SEEDA_HOME 的项目从不同种系播种、同时服务，各自版本/会话/成长记录独立；子目录定位、未知种系、重复名称、重复播种不改数据、并发默认种系创建、已发布版本忽略未提交修改、停止重启和来源持久化。执行清单见 tasks.md。
