# 实施契约

用户已授权在 main 开发完整方案。所有实现者共用本工作区，按文件所有权并行；不创建开发分支或 PR，不回滚他人修改。功能真值为 `docs/design/knowledge-library.md`，共享类型为 `src/knowledge-contracts.ts`，静态视觉提案为 `.local/design/knowledge-library-20261018-v1/` 四张 PNG 和 README。

## 存储（01）

`src/knowledge/store.ts` 导出 `KnowledgeStore`，构造参数为数据库文件路径，不是目录。后台使用数据目录下 `knowledge/knowledge.sqlite`，不连接到可清除的会话索引。

- `create(draft: KnowledgeDraft, idempotencyKey?: string): KnowledgeDetail`
- `revise(id: string, input: KnowledgeRevisionInput, idempotencyKey?: string): KnowledgeDetail`
- `get(id: string, options?: {revisionId?: string; review?: KnowledgeReview | "all"; availability?: KnowledgeAvailability | "all"}): KnowledgeDetail`
- `list(query?: KnowledgeQuery): KnowledgeList`
- `revisions(id: string): KnowledgeRevision[]`
- `review(id: string, input: KnowledgeReviewInput): KnowledgeDetail`
- `setAvailability(id: string, input: {availability: "active" | "deprecated" | "superseded"; reason?: string}): KnowledgeDetail`
- `restore(id: string, revisionId: string, baseRevisionId: string, idempotencyKey?: string): KnowledgeDetail`
- `facets(): KnowledgeFacets`
- `getState<T>(key: string): T | undefined`, `setState(key: string, value: unknown): void`，`deleteState(key: string): void`
- `transaction<T>(operation: () => T): T`, `close(): void`

导出 `KnowledgeError`，字段 `code` 与可选 `messageDescriptor`。INVALID_INPUT / NOT_FOUND / CONFLICT 等稳定错误由路由转为已有服务错误。审阅、废弃属于独立 Web 管理端点，不接受提交者自报人工身份。构建任务可以通过 transaction 将候选、结果与覆盖一致保存。state 只保存有界任务与派生状态，不保存全量原始会话。

任务清理通过 `deleteState` 实际删除状态行并释放键数与字节配额；它参与外层事务且不删除知识、修订或来源证据。`setState(key, null)` 仍表示保存 JSON null，不等同于清理。

## 抽取（02）

`src/knowledge/manager.ts` 导出 `KnowledgeManager(home: string, store: KnowledgeStore, sources: KnowledgeSourceReader)`。只依赖共享来源接口，主线程负责接入现有 SessionStore。

- `settings(language?: "zh-CN" | "en"): Promise<KnowledgeSettings>`
- `saveSettings(input: KnowledgeSettingsInput): Promise<KnowledgeSettings>`
- `key(kind: "generation" | "embedding"): Promise<string | undefined>`
- `preview(scope: KnowledgeExtractionScope): Promise<KnowledgePreview>`
- `previewById(id: string): Promise<KnowledgePreview>`（恢复持久任务的原预览，过期列表中删除后仍可由保留任务读取）
- `start(previewId: string, idempotencyKey?: string): Promise<KnowledgeJob>`
- `status(): Promise<KnowledgeTaskStatus>`
- `job(id: string): Promise<KnowledgeJob>`
- `action(id: string, action: "pause" | "resume" | "retry"): Promise<KnowledgeJob>`
- `tryExtract(scope: KnowledgeExtractionScope, settings?: KnowledgeSettingsInput): Promise<KnowledgeTryResult>`
- `test(settings?: KnowledgeSettingsInput): Promise<{ok: boolean}>`
- `close(): Promise<void>`

配置凭据在本机独立 0600 文件保存，GET settings 不回传明文。先完善结构校验、来源归属、预算与请求重试。新任务固定配置；无价值、重复和失败分开处理。getState/setState 可用于恢复任务、已处理消息身份及内容哈希覆盖。相关来源被改写时不得静默继续。已有知识补充沿用旧语言，后台不能发布已审。

生成连接可显式配置 `reasoningEffort`（none/low/medium/high），未配置时不发送该供应商参数。`KnowledgeUsage` 的 input/output 合计由已知实测与剩余估算组成，同时保留两类分量、actualRequests 和 extract/merge/try/test 用途统计；无服务端 usage 时不宣称实测。任务的会话总数按原会话去重，全部目标分支完成才计为该会话完成，分支部分成功仍保留已提交结果。

## Web 与 HTTP（03、04）

前缀 `/api/v1/knowledge`，GET 读取，带 JSON 的 POST/PUT 写入。已有 `web/shared/api.ts` 承担错误处理。

- GET `/entries`（KnowledgeQuery 查询串），POST `/search`（`{mode:"keyword"|"semantic", ...KnowledgeQuery}`）→ KnowledgeList
- GET `/facets` → KnowledgeFacets
- POST `/entries`（`{...KnowledgeDraft, idempotencyKey?}`）→ KnowledgeDetail
- GET `/entries/:id?review=all&availability=all&revisionId=...` → KnowledgeDetail
- POST `/entries/:id/revisions`（KnowledgeRevisionInput + idempotencyKey）→ KnowledgeDetail
- GET `/entries/:id/revisions` → `{revisions: KnowledgeRevision[]}`
- GET `/entries/:id/revisions/:revisionId` → KnowledgeRevision
- POST `/entries/:id/reviews`（KnowledgeReviewInput）→ KnowledgeDetail
- POST `/entries/:id/availability`（availability/reason）→ KnowledgeDetail
- POST `/entries/:id/restore`（revisionId/baseRevisionId/idempotencyKey）→ KnowledgeDetail
- GET `/settings`，PUT `/settings` → KnowledgeSettings
- POST `/test`（可选 KnowledgeSettingsInput）→ `{ok:true}`
- POST `/extractions/preview`（`{scope}`）→ KnowledgePreview
- POST `/extractions`（previewId/idempotencyKey）→ KnowledgeJob
- GET `/extractions` → KnowledgeTaskStatus
- GET `/extractions/:id` 与 POST `/extractions/:id/pause|resume|retry` → KnowledgeJob
- POST `/prompts/try`（`{scope,settings?}`）→ KnowledgeTryResult
- GET `/index/status` → KnowledgeIndexStatus
- POST `/index/preview` → KnowledgeIndexPreview
- POST `/index/build`（previewId），POST `/index/pause|resume` → KnowledgeIndexStatus

来源状态在详情/历史读取时核验，前端跳转复用会话 hash 的 id/message/version/turn/branch/mode。会话库入口带 sessionId 和选中 turn 进入知识沉淀预览。前台管理写入沿用同源 Web 约束，普通实例 header 只允许 Agent 写入待审与查询，不能审阅发布。

## 并行文件边界

- 01：store.ts 与 store 单测。
- 02：knowledge/ 下除 store.ts、sources.ts、semantic.ts 的模型、配置和任务模块及单测。
- 03：web/features/knowledge、App.tsx、会话入口，知识 i18n 目录与注册。
- 主线程：sources.ts、semantic.ts、knowledge-routes.ts、服务注册、端到端与真实模型测试、公开文档和最终整合。

提交由主线程在整合和审查后统一处理。遇到接口不吻合先调整边界内实现并同步必要差异，不改动其他负责人的文件。
