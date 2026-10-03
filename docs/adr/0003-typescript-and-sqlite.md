---
status: accepted
date: 2026-10-03
---

# 使用 TypeScript、Node.js 与本地 SQLite

AgentManor 自行开发代码活动分析核心，不 fork 或移植竞品源码；后台、CLI 和 Web 使用 TypeScript，后台与 CLI 在 Node.js 上运行，分析索引保存到本地 SQLite。用户允许依赖运行时，因此优先集中语言与数据契约的维护，选择 TypeScript 全栈，接受 Node.js 安装要求；没有采用 Go 后台加 TypeScript Web 的双语言路线。

SQLite 为结构化证据、范围对应和增量状态提供事务与筛选查询，同时不要求用户运行独立数据库服务。相比 JSON 索引，需要维护表结构与迁移，但更贴合多维查询和刷新一致性需求；索引仍然可由只读历史和当前仓库重建。

耗时分析从查询服务主线程分离。具体 Worker 组织、数据库驱动、Web 框架和匹配算法在后续技术讨论中确定；本决定不声称 Node.js、SQLite 或任一候选库已经完成实际性能与发布验证。后台生命周期与产品口径继续遵循 [ADR 0002](0002-local-analysis-service.md) 和 [首版规格](../../.scratch/repository-activity-map/spec.md)。
