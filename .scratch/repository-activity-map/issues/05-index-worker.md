# SQLite 索引、增量分析与完整版本发布

Type: task
Status: resolved
Blocked by: 03, 04

## Scope

责任文件：src/index/、src/worker.ts、tests/index*.test.ts。
SQLite WAL、迁移、仓库登记、手动关联、来源缓存／内容变化检查、长期单 Worker 串行刷新、任务状态、完整事务发布、失败保留上版、清缓存重建。

## Acceptance

追加续读与后补结果；截断／替换／规则变化重算受影响来源；不变来源与文件对应复用。缺失来源排除新版并保留原因／上版；移动不增活动；临时读取失败不当缺失。重复导入、清缓存重建一致；查询绑定版本，失败不污染旧版。

## Comments

- 2026-10-03：采用已确认首版规格，自行实现。

## Answer

- SQLite 索引、增量分析与长期 Worker 提交：`9be564c59c83cb5c16dbca0cad3a80e631e3b0c8`；独立分支以 `--no-ff` 合并，合并提交：`d010615ecc9262125c063c2027cf383ad4c5c737`。已有解析规则版本内容自动合并，未产生额外差异。
- `npm run check:server`、`npm run build:server`、`npm test`（72/72，包含新增历史兼容测试及 12 项索引／Worker 测试）和合并差异 `git diff --check` 均通过。
- 验证覆盖 WAL／迁移、完整版本与手动关联、解析及对应复用、跨轮后补与完整记录边界、来源移动／缺失／恢复、临时读取失败、事务发布回滚、长期 Worker 串行与停止后保留旧版。索引接口已核对；真实本机服务／CLI／Web 端到端验收留到后续集成阶段。
