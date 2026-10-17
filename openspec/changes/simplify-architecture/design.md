# 整体架构最小优化
workstream: simplify-architecture

## 目标与假设
先提交已验证的截断反馈、崩溃恢复及Supervisor简化，再进行架构优化。保留工作树其他平台/种系库修改，不发布、不推送、不改默认、不启动实验。保持现有用户行为、权限、预算、取消、沙箱和版本接替。

## 调查与取舍
CodeGraph和有界源码调查：核心Agent直接依赖tools/RuntimeRecordsTool；CLI和worker重复环境模型构造；Supervisor.connection同时负责分帧/回包和业务分派。最大核心运行文件不足400行，没有理由引入微服务、Router注册表、依赖注入框架或更多守护层。context.ts约155行，暂不拆分；故障恢复与主动切换保留各自语义。

## 实现
1. 将RuntimeRecordsTool原样移至core/runtime-records-tool.ts，内部引用随之更新。默认安装仍由Agent负责，implementationDirectory层级不变。src/index公开API不变，旧版本文件树不改写；不增加兼容框架。
2. Supervisor新增私有dispatch(request,onEvent)，connection只管理socket、JSON行、大小限制和结果关联。保持每条请求独立异步分派，让cancel在run进行时到达。原有网关操作仅随代码原样移动，不改变其规则。
3. DeepSeekModel增加fromEnvironment(onRetry)静态构造方法，CLI和worker共用。显式构造器仍用于自定义模型配置，网络配置和入口事件处理各归原入口。放在model目录以保证agentOnly快照保留。

## 验证
执行清单见[[openspec/changes/simplify-architecture/tasks]]。先在Node24.18独立依赖源码上验证待提交版本；优化后类型检查、现有全套serial回归、正式sandboxed stage/Meter八场景。补实际socket分片/连包/长请求取消/事件归属/坏帧和模型环境构造HTTP验证，检查执行结果。完整回归仍覆盖候选原生验证、显式接受、实际接替加载与产物；全部隔离且仅本地固定模型。不用机制验证冒充自主能力收益。

## 未决项
无。共享工作树仅提交已核对的相关差异。Node26动态库兼容不在本次范围，不放宽沙箱权限。
