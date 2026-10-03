# SQLite 索引、增量分析与完整版本发布

Type: task
Status: ready-for-agent
Blocked by: 03, 04

## Scope

责任文件：src/index/、src/worker.ts、tests/index*.test.ts。
SQLite WAL、迁移、仓库登记、手动关联、来源缓存／内容变化检查、长期单 Worker 串行刷新、任务状态、完整事务发布、失败保留上版、清缓存重建。

## Acceptance

追加续读与后补结果；截断／替换／规则变化重算受影响来源；不变来源与文件对应复用。缺失来源排除新版并保留原因／上版；移动不增活动；临时读取失败不当缺失。重复导入、清缓存重建一致；查询绑定版本，失败不污染旧版。

## Comments

- 2026-10-03：采用已确认首版规格，自行实现。
