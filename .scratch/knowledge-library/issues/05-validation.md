# 05 模型实测与浏览器验收

Type: task
Status: resolved
Blocked by: 02, 03, 04

## Scope

全量类型/单元/构建/公开检查；隔离合成浏览器与本机 Ollama 真实会话测试。真实内容只写 .local，公开记录只保留方法、结论与边界。

规格：`docs/design/knowledge-library.md`。接口约定：`.scratch/knowledge-library/implementation.md`。用户已明确授权开发测试，直接 main；CLI 与 Skill 不在范围。

## Acceptance

通过完整方案中对应验收，记录实际检查和未验证边界，不以静态审查冒充真实运行。

## Answer

最终类型/国际化检查、构建与公开内容检查通过；默认并发全量测试 1,580/1,580，知识专项 57/57，真实 Chrome 30 项交互通过且无未处理页面错误。包外安装实际验证原生 SQLite、CLI、Worker、Web 与 Skill 交付。实际会话三个窗口仅在隔离库使用，本地 3B/4B/7B 模型暴露结构、语言和质量边界；7B 完成技术讨论候选、人工修正、历史、检索、来源与废弃闭环。合成技术输入的真实本地模型四种中英组合及普通致谢零产出完成。没有以元数据代替语言核读或以条目数量证明有用性，详见 docs/validation/knowledge-library.md。
