---
type: implementation-report
project: seeda
status: current
updated_at: 2026-10-12
---

# Agent 核心实现与验证

## 当前交付

已实现五部分中的 Agent 核心与模型／工具接入，界面无关。本页保留首轮普通终端驱动的验证说明；当前交互入口已接最小 TUI。最小 TUI 已另行接入，见 [[docs/TUI前端实现与验证]]；版本管理、SQLite、守护和 A/B 尚未实现。

| 文件 | 职责 |
| --- | --- |
| [agent.ts](../src/core/agent.ts) | 循环、顺序工具执行、取消、事件；前端回调失败不改变执行结果 |
| [session.ts](../src/core/session.ts) | JSONL、请求版本、消息、调用状态、恢复与中断尾部保留 |
| [context.ts](../src/core/context.ts) | 项目规则、可选 Skill 目录、完整工具往返边界上的压缩 |
| [deepseek.ts](../src/model/deepseek.ts) | 原生 fetch/SSE、UTF-8 分帧、工具片段聚合、reasoning_content 保留 |
| [bash.ts](../src/tools/bash.ts) | 非交互进程、cwd、超时／取消、进程组清理、输出限长与完整产物 |
| [index.ts](../src/index.ts) | 核心导出，供未来 TUI 和守护调用 |
| [cli.ts](../src/cli.ts) | 简单终端驱动 |

没有生产依赖，没有模型 SDK、Agent SDK 或 Agent 框架。开发依赖为 TypeScript 和 Node 类型；本机使用 Node.js 24.18.0。首个模型是 DeepSeek V4.1 Flash，API slug 为 deepseek-flash。

## 运行

安装与检查：

```bash
npm install
npm run check
npm test
```

已有环境变量 DEEPSEEK_API_KEY 时可运行：

```bash
npm start
npm start -- run "读取当前项目并说明它的结构"
```

配置只通过环境读取，不读取或写入任何凭据文件：

| 变量 | 默认及用途 |
| --- | --- |
| DEEPSEEK_API_KEY | 必需，只进入 HTTP Authorization |
| DEEPSEEK_BASE_URL | https://api.deepseek.com；接入层追加 /chat/completions |
| DEEPSEEK_MODEL | deepseek-flash |
| SEEDA_THINKING | 默认关闭；1 开启 thinking |
| SEEDA_SESSION | 当前项目 .seeda/session.jsonl |
| SEEDA_VERSION | session 请求记录中的实现版本，默认 0.1.0 |

Bash 默认 30 秒，可以传 timeout（秒）；最大允许 3600 秒。每次 shell 独立，cd/export 不跨调用保留。后台进程不支持；shell 退出时清理所属后台子进程。模型请求默认 120 秒，失败不自动重试副作用命令。

session 与完整输出保存在本地 .seeda/，已被 Git 忽略。核心库调用者自行指定 cwd、session 与输出目录。一个实例只运行一个请求；首版不支持多个进程共同写同一 session。

Node 驱动开启环境代理支持，但不会自动读取 macOS 系统代理。必要时为单次进程显式传入 HTTPS_PROXY。本次实测使用本机已存在的 127.0.0.1:7890 代理，没有改变系统代理或在配置中保存代理地址。

```bash
npm run smoke:live
```

该命令在 .seeda/ 创建临时项目，真实调用已配置的模型，保留测试和会话证据。它会产生模型调用费用，属于真实运行验证，不是单元测试。

## 验证结果

- 类型检查通过。
- 17 项自动测试通过，覆盖实际文件修改与失败修复、参数错误、未知工具、截断、超时取消、进程树、长输出、session 恢复、压缩、可选 Skill、SSE 和前端观察者异常。
- OpenSpec 严格校验通过：implement-agent-core。
- DeepSeek V4.1 Flash 真实实测通过：读取 Skill 正文，执行失败测试，只修改 sum.cjs，执行相同测试通过，重新加载 session 后继续对话。共 5 次工具调用，模型与工具过程及重新对话共 6.63 秒；这只是本次样例耗时，不是性能保证。

真实实测的安全摘要为 [report.json](../.seeda/smoke-1791809729076/report.json)。本地目录不会随 Git 自动传播；在别的机器上运行 smoke:live 重建证据。文档只保存结论，不复制模型原始输出、工具长输出或凭据。

## 失败和修正记录

1. 首次真实请求直连失败，安全诊断确认 DNS／连接超时，未进入模型交互。改为单次进程使用现有系统代理后连通。
2. 第二次模型已完成修复，但验收脚本只接受 shell 非零退出码；模型命令在测试后打印 exit=1，shell 最终返回 0。修改验收为检查实际断言失败证据，并保留最终独立运行测试的检查。
3. 压缩测试原先假设保留历史恰好从某个固定位置开始；修正为检查工具调用与结果的对应关系。

失败目录保留在本地 .seeda/，没有覆盖失败后伪称第一次就成功。

## 证据边界与当前限制

真实模型验证了循环、Bash、Skill 正文使用和 session 继续对话。压缩、thinking 字段往返、取消与超时主要通过本地模型服务器或模拟模型加实际进程测试验证；没有声称这些全部经过生产模型实测。

上下文当前按字符预算估算，不是精确 tokenizer。Skill 只发现项目目录下一级文件夹，frontmatter 暂支持单行 name 与 description。session 不提供多进程并发写入或恰好一次执行；未知结果由后续模型检查现场，不能自动重放。目录分离不是权限沙箱。

下一步先接 TUI 前端，复用 Agent 的输入、取消与事件；版本与成长、守护与运行按架构后续增量实现。thinking 与压缩如成为下一阶段正式使用路径，补对应真实模型验证。

## 关联

[[docs/RSI架构设计]] · [[openspec/changes/implement-agent-core/design]] · [[openspec/changes/implement-agent-core/tasks]] · [[project-memory/工作流/Agent核心实现]]

## 后续界面进展

TUI 已通过独立变更接入，本文的 17 项测试为首轮历史结果；当前总回归数为 24。TUI 操作和新证据以 [[docs/TUI前端实现与验证]] 为准。

## 网络启动补充

当前 Node 最低版本 24.14。macOS 无显式 HTTP(S) 代理变量时发现已有静态系统代理；显式代理优先，SEEDA_SYSTEM_PROXY=0 关闭自动发现。只在进程内配置原生网络，不修改系统配置或凭据。网络测试包含实际本地 HTTP CONNECT 代理与真实无显式代理托管 TUI 验证；见 [[docs/版本守护与RSI运行指南]]。
