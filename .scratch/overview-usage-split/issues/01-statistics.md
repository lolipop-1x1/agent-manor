# 真正的轻量用量统计

Type: task
Status: resolved
Blocked by: none

## Context

[规格](../spec.md)。所有权 src/usage/、src/usage-contracts.ts 的 UsageStatistics 定义、对应用量测试。共享类型新增后立即发布给服务与页面实现者；不改总览文件。

## Acceptance

轻量聚合与完整报告的总量／日期／所选维度等价，未选维度、会话行及预览不构建；缓存有 view 身份，未知及费用语义保持。专项和类型检查通过。

## Answer

已增加 totals、trend、distribution 三种真实轻量聚合，结构化事实和持久汇总路径共用原筛选与累加规则，查询不构建完整报告、会话行或预览。缓存与在途身份包含视图，原报告及证据恢复继续兼容。五项专项及四十七项原用量回归通过；整合后的完整套件也已通过。冷准备仍保留独立用量页需要的有界预览，不宣称消除后台准备成本。

## Comments

已认领。

实现及整合验证已完成。
