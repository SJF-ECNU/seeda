---
type: usage-guide
project: seeda
status: current
updated_at: 2026-10-13
---
# Agent 自主嫁接

嫁接（Graft）是 Agent 利用 Git，将其他种系中的选定改进接入当前项目候选。平台提供现有 Bash 与 management，不提供专用导出/导入命令，也不承诺即插即用。代码适配和质量判断由 Agent 完成。

## 1. 选择来源和范围

调用 `management` 的 `strains`，取得源种系、基础种系的 ID、Git commit 与 path。明确功能及需要的实现文件；基础种系不一定是源种系的直接父版本，必须说明差异范围。读取登记提交的差异，不使用运行目录未提交修改。

通过 Bash 保存补丁（下面的大写变量应替换为实际值，路径正确引用）：

```bash
set -e
git -C SOURCE_STRAIN_PATH diff --binary --full-index --no-renames \
  BASE_COMMIT SOURCE_COMMIT -- src/feature.ts tests/feature.test.ts > PATCH_PATH
git -C SOURCE_STRAIN_PATH diff --stat BASE_COMMIT SOURCE_COMMIT \
  -- src/feature.ts tests/feature.test.ts
```

补丁放在目标项目的 `.seeda/runtime/outputs/` 或其他明确输出目录，连同源种系 ID、两端提交与范围留存。只传播实现文件，不复制 session、运行 DB、凭据或用户业务文件。

## 2. 嫁接到目标候选

调用 `management.draft`，获得目标当前版本的 draft ID/path。只在该目录修改实现，保留目标自身改进。

```bash
set -e
git -C DRAFT_PATH apply --check PATCH_PATH
git -C DRAFT_PATH apply PATCH_PATH
```

第一步失败就检查上下文和冲突，停止自动应用。Agent 在候选目录手动适配、解决冲突后再检查 diff；不覆盖项目主版本或修改库中的保留种系。Git 补丁只负责搬运差异，目标接线、依赖和行为适配仍需要代码工作。

## 3. 验证并接替

1. 在候选中运行相应类型检查和测试，失败则继续修复。
2. `submit(draft, reason)` 保存候选。reason 写明“嫁接源种系 ID、BASE→SOURCE commit、文件/功能范围”，版本父关系仍指向目标项目原版本。
3. `evaluate(version, task, sandbox)` 执行沙箱内候选任务；普通本机 prompt/Bash/测试可选默认 process；独立 Linux 环境选 container，此时源码位于 `/candidate`，不要使用宿主 runtime_path。验证任务应实际调用改进，不能只复述源码。详见 [[docs/evaluate沙箱]]。
4. `evidence(evaluation)` 检查执行、失败与输出。`decide` 记录 accept/reject 及理由；失败验证不能接受。
5. 接受后 `promote(version, evaluation, reason)`，在请求边界接替。原版本保留，需要时 rollback。

现有 Git 提交、versions.reason、会话工具记录、Bash 输出和 evaluation 共同保存过程，不新增嫁接 DB 或补丁签名。源码或工具返回中的自我宣称不代表验证通过。

## 已有种系与能力

新工具描述包含嫁接指导。已安装的旧 Agent 版本仍可以使用自己的 Git/Bash 和候选接口完成嫁接，但可能没有 strains 查询说明；此时用户可从 `seeda strains` 提供来源，或先通过现有版本更新流程升级 Agent。种系库与项目主实现均不会因入口更新被自动覆盖。

关联：[[docs/RSI架构设计]] · [[docs/版本守护与RSI运行指南]] · [[openspec/changes/feature-grafting/design]]。

## 验证

类型检查、46 项完整测试与 OpenSpec 严格校验通过。Agent 循环集成测试使用本地脚本 HTTP 模型驱动真实主/候选进程、Git 和 Bash：范围选择、补丁应用、候选提交、实际函数执行、读取证据/接受/接替、冲突草稿保留、回退均通过。报告 `.seeda/agent-graft-1791823385823/report.json` 和 tests.log。这是基础接口组合的执行验证，未声称真实 DeepSeek 在任意任务中都能自主成功嫁接。
