# 10 新建与记录分离、会话选择、任务详情、调宽、焦点、设置与 Beta

Type: task
Status: resolved

## Scope

新建与记录分离、会话选择、任务详情、调宽、焦点、设置与 Beta。实施与验收遵循 ../upgrade-contract.md。

## Answer

已实现：`page=new` 新建与 `page=tasks` 记录分离，`taskId` 深链详情；兼容旧会话沉淀链接。新建支持标题搜索、项目／客户端筛选与共享分页选择单会话，以及按条件批量选择。选择会话后自动预览，启动动作明确且不自动恢复旧任务。

记录列表展示标题、时间、状态和结果，详情分摘要／过程／结果。轮询摘要，按任务 ID 和更新时间加载完整事件；保留列表筛选、分页与返回滚动。旧事件／用量缺失明确表达，缓存明细显示覆盖请求数，预算和费用依据按需查看。

知识列表支持独立持久化拖动／键盘调宽，窄屏保持单栏。搜索复合框去掉输入内部重复焦点框，保留整体键盘高亮及其他控件焦点。设置两个凭据支持查看、隐藏、复制、清除，普通设置请求不取明文；查看不标记修改，离页／换 Tab／保存／隐藏清理读回明文，在途响应由版本号作废。设置 Tab 和区域标题字号调小，知识标题添加 Beta。

静态验证：`npm run check`（翻译、服务端、Web 类型）通过；`tests/knowledge-ui.test.ts` 11 项通过；拥有文件 `git diff --check` 通过。浏览器交互、视觉及真实小输入模型验收由集成任务统一执行。本任务未调用付费模型、未读取生产 Key、未提交。

主要文件：`web/features/knowledge/Knowledge.tsx`、`KnowledgeTasks.tsx`、`KnowledgeSessionPicker.tsx`、`KnowledgeSplit.tsx`、`KnowledgeSettings.tsx`、`SessionExtractButton.tsx`、`knowledge-model.ts`、`knowledge.css`，中英文 `knowledge.ts` 及 `tests/knowledge-ui.test.ts`。

集成反馈修复：分页页码独占可换行区域以约束窄屏宽度；常用筛选保持 112px 最小宽度并换行；嵌套对话框 Escape 阻断同一键传播到父层；新建、详情、设置和正文 Tab 增加稳定 ID 与面板 ARIA 关联；任务费用帮助明确只涵盖生成模型，Embedding 候选召回单独计入知识向量调用。针对性 Web 类型检查、11 项 UI 模型测试和 diff 检查再次通过。任务详情深链的完整事件读取逻辑在当前源代码及首轮构建中均已存在，事件缺失由集成继续核对。
