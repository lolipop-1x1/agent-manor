# 03 知识工作台与会话入口

Type: task
Status: resolved
Blocked by: 00

## Scope

web/features/knowledge/**、web/app/App.tsx、会话沉淀入口、知识中英文目录及注册；完整四屏交互与现有共享组件，按 implementation.md HTTP 契约。

规格：`docs/design/knowledge-library.md`。接口约定：`.scratch/knowledge-library/implementation.md`。用户已明确授权开发测试，直接 main；CLI 与 Skill 不在范围。

## Acceptance

通过完整方案中对应验收，记录实际检查和未验证边界，不以静态审查冒充真实运行。

## Answer

已实现知识库一级导航与四屏工作台：

- 四视图、关键词/可选语义搜索、项目/来源客户端/审阅/类型/标签/可用性/日期筛选、统一分页与 Markdown 阅读。
- 用户直接新建和编辑，保存待审或另行确认发布；并发冲突保留编辑，读取最新快照后重新核对。
- 审阅队列与差异、人工确认/拒绝、完整版本历史和差异（含审阅字段变更）、历史恢复形成待审新版本、废弃与恢复、有效期和已解决状态。
- 来源按当前核验状态提供精确会话跳转；变化/缺失时保留摘录与限制。
- 会话库整会话、当前轮次和选择轮次沉淀入口，范围预览、后台进度、暂停/继续/重试、失败与零产出区分、待审结果入口；历史任务从持久预览恢复范围。
- 生成模型与凭据、输出语言、推理强度、调用预算；Embedding 关闭/复用/独立与预览/构建/暂停；自动策略与预览；高级提示词重置和试抽取。
- 共享 Radix 筛选/项目/日期/帮助/分页、SelectionIndicator 和动效 token；窄屏侧栏使用 Radix Dialog 恢复焦点，审阅改为单栏切换。中英文目录完整，正文与来源保留原文。

验证：`npm run check:web`、`npm run check:i18n`、`node --import tsx --test tests/knowledge-ui.test.ts`（4 项）通过；`npm run build:web` 通过，仅报告现有大包提示；Impeccable detector 扫描 0 anti-patterns，字体阶梯建议已调整。

真实浏览器、真实对话和 Ollama 的端到端验证由主线程统一执行，本票不将静态检查描述为已完成浏览器验收。没有新增 CLI、Skill 或代码原型，没有提交。
