---
type: worklog
project: seeda
workstream: latest-default-strain
status: completed
recorded_at: 2026-10-15T15:34:52.425793+08:00
timezone: Asia/Shanghai
agent: Codex
client: Codex desktop
model: unknown
session_id: unavailable
branch: main
commit: 9118fe668a00fb89e9e22bc0053f78341369fadb
---
# sandbox 提交推送与默认种系完成

## 任务计划书
[[project-memory/任务计划/最新默认种系]] 的2026-10-15续次步骤全部完成；实现计划为 [[openspec/changes/native-evaluation-sandbox/design]]。

## 结果
- scoped提交9118fe6已推送origin/main，未混入竞技场、集群或可视化文档等其他任务。共用索引只暂存本次sandbox入口，其他内容保留工作树。
- GitHub CI38699327105成功：[CI](https://github.com/SJF-ECNU/seeda/actions/runs/38699327105)。补CI安装Bubblewrap及必要的专属AppArmor userns许可，未全局关闭宿主限制。GitHub原生Linux测试通过，不再仅依赖嵌套容器验证。
- 从已提交源码git archive构建独立发布候选，保留原默认runtime-records祖先。新种系seeda-agent-reliable-sandbox，ID d15b3002-bcf8-4155-a58f-123dfb19f9db，提交47c74892d23431b4032e67056fd7dc1526109724，父ID abd90e0a-2bcf-4ac6-94ef-fa943cab0f40，source_version 30e3b134-baed-4a3b-afec-97891eaea676。
- 种系运行npm run check和46项npm test通过后，使用已有CLI切为本机全局默认。历史种系保留，不覆盖已有项目。
- 已安装seeda链接本仓库，因此新项目使用新版宿主沙箱；Agent-only种系自身不携带宿主沙箱代码，跨机器仍须更新宿主安装。

## 验证
新临时项目运行不指定名称的seeda seed，实际origin和输出均为新种系；worker、Agent、runtime-records文件与发布候选逐字节匹配。启动临时项目Supervisor、提交临时候选后，默认process evaluate实际完成，模型为本地HTTP模拟。停止临时Supervisor并清理临时项目。最初macOS系统临时目录过长导致Unix socket EINVAL，改用短/tmp路径完成验证；未修改无关socket实现。

本地证据.seeda/sandbox-release/publication.json与verification.json；无真实付费模型调用、无现有主实例切换或竞技场重启。源码检查与执行证据见实现记录。

## 文档关系
### 参考文档
- [[docs/种系选择与发布]]：发布与默认语义。
- [[docs/evaluate沙箱]]：后端及宿主/种系边界。
- [[project-memory/工作记录/2026/10/2026-10-15-Codex-evaluate沙箱实现与验证]]：实现验证。
### 文档产物
- 更新 [[project-memory/任务计划/最新默认种系]]：追加本次发布步骤与验证。
- 更新 [[project-memory/工作流/最新默认种系]]：替换过期的当前默认摘要，保留历史链接。
- 更新 [[project-memory/工作流/原生evaluate沙箱]]：追加本次交付结果与默认入口。

## 下一步
新项目正常播种；既有项目如需升级另走显式验证接替。本次不进行全机部署或已有服务重启。
