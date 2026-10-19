---
type: worklog
workstream: workbuddy-evolution
status: handed_off
timezone: Asia/Shanghai
agent: Codex
client: Codex desktop
model: unknown
session_id: 01a13f7f-ec48-77f2-8ee6-e6ed96371d06
branch: codex/workbuddy-capability-release
commit: 3254fab08a20e8b4c0c5bad1adcf2c77b0443243
---
# 候选能力发布默认与WorkBuddy新轮启动
## 任务计划书
[[openspec/changes/workbuddy-evolution/design]]，用户新授权提交发布设默认并重开，发布/启动完成，结束审计待运行结束。
## 发布与验证
干净独立worktree提交3254fab并推origin/main，GitHub CI39301596741成功。仅通用候选命令能力及相关临时目录修复进入核心；实验计量和独立容器适配归档experiments/workbuddy，未混入其他工作树功能。原开发目录无关修改保留。
源码完整串行169项：167通过、2跳过、0失败，typecheck通过；Node官方library镜像经public.ecr.aws补齐后，原生及容器沙箱测试均通过。最初DockerHub EOF保留。此前针对性23项全通过。
默认seeda-agent-candidate-capabilities，ID ed31ea08-697d-418a-814d-53628d64f13b，strain Git59b8e9ac139958e5a0cd2f42e80371ff43d693c9，父multiprocess保留。CLI指向 /Users/shjf/.local/share/seeda/releases/candidate-capabilities-3254fab08a20。真实全局CLI新项目播种、截断不执行及同版本崩溃恢复6本地fixture通过。发布种系runtime-022007-success真实浏览器→候选接受→completed接替→继续浏览器10本地fixture，v/f022008真实RST第6本地响应首停不进入下一题。安装发布阶段22计量/CLI本地fixture，供应商学习者0，Web裁判3次另计。源码host与发布strain所有src相同。官方准备0分是夹具不解题，不能说自主改进。
## 正式新轮
/Users/shjf/work/workbuddy-seeda-evolution/runs/1020-022143，PID40411/launcher40410/caffeinate40412。源码/配置/退出收据preparation/launch-source-1020-022143，startup-evidence.json证实首响应success完整usage3352tokens，thinking enabled/reasoning max；实际初始source与host均为发布默认strain路径，初始版本77659a07-1b26-4431-896c-076054f99090，Git4e9f775f8b7578f601735b579edc99e806d1d255，src与自身资产逐字节相同。运行版本不会被全局默认变化迁移。
Code/Web/Office/Security各2工作，继承自身不继承项目补丁；初始最终各4隔离固定留出。无累计预算，官方单题时限乘2。全部版本化自身代码/同模型参数可进化，已运行Supervisor不热换。Qwen3-vl-plus裁判覆盖默认、自定义runner/MacARM amd64，不是官方排名。
## 旧账与监测
旧WB1020-001730停止，574Agent尝试/573成功/1未知/51215886known tokens；17裁判263720tokens，5592.760秒。5有效分 .7692/.2/.8235/.9994/.6、5接替；Web2中断无分/留出未开始，全部记录保留不恢复。更早SWE全链由config.prior_records引用。
准备总账preparation/cost-rollup.json已包含此前修复与本次，74供应商477401known tokens1unknown，269计量本地fixture另列，另有6默认CLI和单元测试本地服务；不能把模拟tokens当真实费用，不能把旧pause/repair汇总重复加。全部失败重复保留。美元及开发编排费用未知。
terminal-bench已ACTIVE，正常运行及阶段变化安静；只读不改代码提示词配置产物自身版本、不发Agent消息、不主动重启补跑。执行/评分infra、模型传输或未知usage首停；只有确证未自动停才处理本轮所属进程容器，保留现场。有效产品失败继续，不补无效分0。结束核对评分、自改Git/accept/completed/实际加载与使用及留出收益，所有主候选裁判/工具成本和墙钟，核对真实退出/stop-receipt，汇总一次暂停，不自动下一轮。
## 参考文档
[[docs/evaluate沙箱]]、[[docs/种系选择与发布]]、[[openspec/changes/workbuddy-evolution/design]]
## 文档产物
更新[[docs/evaluate沙箱]]和[[docs/首页]]；新增experiments/workbuddy/README.md适配说明；更新同一OpenSpec及[[project-memory/环境与部署]]。外部发布证据preparation/capability-release-1020/release-readiness.json、startup-evidence.json与全部原始用量。
