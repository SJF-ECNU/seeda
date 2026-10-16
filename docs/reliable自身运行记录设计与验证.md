---
type: implementation-report
status: current
updated_at: 2026-10-14
---

# reliable 自身运行记录

## 能力与边界

新增 `runtime_records` 只读工具，让 Agent 查询当前会话的真实运行事实，而不是依赖人类转述看板。默认返回最近5个任务，最多20个；每任务保留最近20次调用明细和任务内累计计数。

内容包括实现版本与目录、可用工具、起止时间及任务耗时、任务结束状态和安全原因、模型请求的结果/耗时/实际usage、工具状态/退出码/耗时及输出是否截断。非零退出即使工具报告completed仍记为失败。只返回白名单计量字段，不复制命令、输出正文、任意错误文本、reasoning或凭据；原始会话和工具日志沿用已有保存方式。

基于既有 session JSONL，新增runtime条目，扩展request/end时间字段。压缩只改变模型上下文，不删除运行事实；重载后恢复。老会话没有计量时 `measured=false`，计数和耗时未知；不是0次调用。未返回usage的消耗未知，返回的usage是已观测部分而非完整账单。provider内部重试不计为单独Agent请求，突发进程死亡只显示未闭合记录，不能诊断原因。

上次任务结束状态及安全原因在下一请求的系统上下文中可见。工具不自动建议改造，不要求必须更新自身，不把观察等同诊断。Agent是否主动查询或改造还需实际长期观察。

计量写入失败不改变原有执行结果，`recordingComplete=false`说明记录有缺口，并通过后续成功写入的request/end保留此状态。原始会话必要写入仍遵循原来的失败行为；不承诺磁盘失效下继续可靠执行。

## 指令来源记录

当前源码还会在每次请求及压缩记录实际读取的自身指令、通用记忆、项目规则和Skill来源，runtime_records的run.instructions可查询路径、loaded和源文件字符数，不包含正文。旧会话没有该字段表示未知；既有已发布种系不会自动升级。详见 [[docs/自身指令与项目规则]]。

## 使用

新种系名称：`seeda-agent-reliable-runtime-records`。

```sh
# 在未播种的新项目中执行
seeda seed seeda-agent-reliable-runtime-records
seeda
```

模型工具调用：`runtime_records {"limit":5}`，仅支持limit，不接受路径、其他会话或实例参数。工具由Agent核心统一提供，直接模式及托管主/候选均可查看各自当前会话；具体管理工具权限沿用原设计。

已有项目不重新播种，升级需通过既有候选验证与接替流程。现有全局默认及竞技场未切换，用户暂停仍有效。

## 版本与交付

父种系：`seeda-agent-reliable-compact85` / `ee5807a8-9e0e-4433-86e8-953991693b47`。
新种系 ID：`abd90e0a-2bcf-4ac6-94ef-fa943cab0f40`。
种系提交：`581a904ce561542d782575dcb92711527820cdf0`。
独立候选源码目录：`/Users/shjf/work/seeda-reliable-runtime-records`，源码提交 `118bb97`。
本地源码包：`.seeda/releases/seeda-agent-reliable-runtime-records.tar.gz`，39924字节。基于发布的Git提交导出，检查无node_modules、环境文件、运行数据库或会话。只发布本机种系，不推送GitHub或切换默认。

## 验证

- 主源码类型检查及最终完整83项回归通过；候选类型及49项回归通过。
- 新增6项回归：长度失败在下次可见、真实Bash非零/超时、取消与未知用量、旧记录与只读查询、有界历史与压缩重载、计量写入失败及覆盖缺口重载。
- 压缩边界测试按新增工具的真实定义占用计算材料大小，保留85%上下边界验证。
- 主源码并行回归期间两次未改动的Bash超时测试失败；单独复测及随后无并行候选负载的完整测试通过。未修改该Bash实现，失败记录保留于本轮工具证据，不把暂时通过视为证明高负载稳定性。
- 真实deepseek-flash调用新工具，读取本地故障注入的length与exit7，报告未知用量；真实请求usage已持久化。注入不是声称提供商真实产生了长度失败。证据：`.seeda/runtime-records-smoke-1791922921504/`。
- 实际播种新项目，托管DeepSeek调用新工具，返回版本4d7bbcb5-4676-440d-95f5-c77ff1bb8f54的实现目录与bash/management/web_fetch/web_search/runtime_records；临时实例正常停服，socket已移除、active instances为0。证据：`.seeda/runtime-records-probe/`。

计划：[[openspec/changes/reliable-runtime-records/design]]。前序压缩修复：[[docs/reliable上下文压缩设计与验证]]。

## 后续默认切换

用户授权后，本机全局默认已改为 `seeda-agent-reliable-runtime-records` / `abd90e0a-2bcf-4ac6-94ef-fa943cab0f40`。新项目默认播种该版本；已有项目和暂停中的竞技场不自动更新。上文“默认未切换”描述本地发布时的验证状态。
