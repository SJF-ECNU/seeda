# TUI 缓存全机发布
workstream: publish-tui-cache

## 目标与范围
将已存在的 b020fbf 发布至本机统一 seeda 安装并推送 origin/main。用户目录仅发现 Node v24.18.0 全局入口，其 npm link 指向本仓库；项目 Agent 快照不拥有 TUI。

## 假设与取舍
本次“全机”指本机所有项目共用的稳定 CLI/TUI，不发布到 npm 或更新 Docker Agent。复用现有源码链接安装，无需复制 TUI 到 Agent 快照，不重启后台工作。现有无关修改不纳入提交。

## 验证步骤
见 tasks.md：确认现有提交及安装、执行验证、刷新全局链接、记录并提交推送。

## 当前证据
b020fbf 已在 main，修改 src/tui/render.ts 和 tests/tui.test.ts。现有前端 PID 32038 启动于 13:35:15，晚于代码提交 13:33:58；实际入口指向本仓库。

## 验证结果
2026-10-15：npm run check 通过；TUI/前端分离针对性测试 13/13；全量串行回归 84/84；npm link 和 seeda --help 成功，OpenSpec 严格验证通过。1500 条合成记录、3019500 字符，首次 layout 2616.52 ms，100 次打字平均 2.95 ms、最大 31.19 ms。此为本机合成负载，非真实模型端到端耗时；首次加载仍需完整解析。

全局唯一入口为 ~/.nvm/versions/node/v24.18.0/bin/seeda，npm 包链接到 /Users/shjf/work/seeda。后台 Agent 与运行数据库未修改。
