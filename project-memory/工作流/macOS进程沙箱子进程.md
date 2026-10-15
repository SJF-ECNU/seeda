---
type: workstream
workstream: macos-process-subprocess
status: completed
---
# macOS 进程沙箱子进程
## 任务计划书
[[openspec/changes/macos-process-subprocess/design]]，清单 [[openspec/changes/macos-process-subprocess/tasks]]。
## 结果
默认 process 可执行 Bash、Node/TypeScript 测试、npm 与 Git，仍限制目录、网络/socket、长期凭据及宿主信号。新增系统 Python 薄包装，以内核权限识别和回收 detached/reparented 后代；受保护空文件识别权限组合，实际验证后才加载候选。系统 Python 3 或查询不支持时启动失败，不退回无隔离或 Docker。
## 验证
类型、沙箱15项与完整107项测试通过。默认 evaluate 真实执行 Bash；取消/超时/宿主退出和后台回收、独立宿主及另一个沙箱存活均实测。模型为本地HTTP模拟。
## 边界与下一步
源码 1d75849 已推送 main，Linux CI 38712864697 成功。本机默认改为 seeda-agent-reliable-sandbox-subprocess，ID 74ce2756-ae2e-451d-a05b-74804b14652f，种系提交 f1a3f0617c3736e0dc1c71762864c5595074518c，父种系 d15b3002-bcf8-4155-a58f-123dfb19f9db。已提交源码类型与99项测试通过，种系类型与46项测试通过。实际无参数 seed 与关键文件逐字节比较通过，默认 process evaluate 成功执行 Bash、Node、tsc、npm、git 和 node --test。模型使用本地HTTP模拟。证据 .seeda/macos-sandbox-release/{publication,verification}.json。未升级既有项目、未重启现有服务；宿主沙箱修复需新版 seeda 安装，本机全局 CLI 已链接此仓库。 工作树另有网关等改动，保持原状。使用见 [[docs/evaluate沙箱]]。
## 近期记录
[[project-memory/工作记录/2026/10/2026-10-15-Codex-macOS沙箱修复发布与默认种系]]
[[project-memory/工作记录/2026/10/2026-10-15-Codex-macOSprocess子进程修复]]
