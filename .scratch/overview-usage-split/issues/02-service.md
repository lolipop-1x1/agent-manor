# 总览用量分区与按需服务

Type: task
Status: resolved
Blocked by: 01

## Context

[规格](../spec.md)。所有权 src/overview/、src/overview-contracts.ts、overview 路由／输入及对应测试；不改用量模块或页面。共享类型与轻量方法按接口约定发布。

## Acceptance

默认 usage 只有趋势／组成；分布与排行只查所选维度；基础委派计数与详细委派分离；facets 独立；快照、缓存、未知及兼容路径通过。

## Answer

- 默认六分区保持；usage 使用 trend 轻量统计，core 使用 totals 与窄事实日期聚合。
- distribution 与 ranking 仅请求指定维度；响应与缓存身份包含 dimension。
- core 返回五项 delegationSummary；完整请求与 Token 分摊仅由 delegation 分区计算。
- facets 独立读取会话元数据与原始模型窄 SQL；兼容 report 保持原形状、规则与独立用量入口。
- 默认及排行调用隔离、旧缓存淘汰、维度错配拒绝、四时区 oracle 与合成 HTTP 专项通过；真实历史差分与完整测试由整合任务执行。

## Comments

已认领。
