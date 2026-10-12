# GitHub 开源发布
workstream: github-open-source

目标：以当前已登录 SJF-ECNU 账号创建公开 seeda 仓库，MIT，完整保留源码、规范和中文设计文档。用户已明确授权公开发布。

先完成 README/安装说明/license/环境示例/CI，再核对待提交内容无凭据、运行库、node_modules。不把个人环境绝对路径作为安装步骤；内部历史文档保留作背景。使用用户明确选定的概念与架构两图，其他草稿保留本地但不发布；正文说明图为概览，具体接口以指南和代码为准。

验证：Node24 类型和完整测试；npm link 后实际 help/version；OpenSpec严格校验；提交内容检查；创建前查询同名仓库，404才新建；推送后核验公开性与MIT识别并观察CI。

步骤与状态见 tasks.md。未决：GitHub同名仓库是否可用，以实时查询为准。
