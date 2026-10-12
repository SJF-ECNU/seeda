# 种系选择与介绍
workstream: strain-selection

SQLite 独立设置表保存默认种系 ID，介绍表保存五个非空文本字段 summary/improvements/scenarios/limitations/validation。发布必填，验证情况是发布者提供的说明，不冒充平台认证。来源/提交/时间自动记录；旧种系可读，缺介绍明确展示。

strains 在交互终端显示默认标识、名称、简介和ID，重定向保留结构化 JSON。strains default NAME 设置默认。seed NAME 直接播种；seed 无参数在 TTY 中打开选择器，默认项预选，可输入搜索、上下选择、Enter确认、Esc/Ctrl+C取消，展示选中介绍；非TTY采用已设默认。首次无参数 seeda 同样展示选择器，然后启动；已有项目不显示或改变起点。带任务参数的自动启动采用默认，不增加阻塞问题。

选择器复用列宽/安全文本/增量绘制，raw/alternate screen 在成功、取消、失败后恢复。初始化保持现有项目事务。CLI publish NAME [VERSION] --intro FILE 读取标准JSON；Agent management.publish 必须带 introduction 对象。执行步骤见 tasks.md。
