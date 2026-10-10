# 全局请求聚合与一致筛选

Type: task
Status: resolved
Blocked by: 02

## 所有权与范围

`src/usage/analytics.ts`、`src/sessions/store.ts` 中新增全局只读请求读取、`tests/usage-analytics.test.ts`。公共类型见 `src/usage-contracts.ts`。不修改服务器、价格服务、前端或国际化目录。

## 工作

依据 [规格](../spec.md) 完整实现过滤、时间桶、组成、分组、明细分页、排序、缺失覆盖。增加 `SessionStore.usageSource(version?: string): UsageSource`，批量读取已发布版本的有效会话与非复制请求，不逐会话读取画像或正文，复用已有复制/身份规则，避免 N+1 查父关系。

导出 `buildUsageReport(source: UsageSource, query: UsageQuery, pricing: PricingStatus, estimate: (usage: SessionUsage, client?: string) => RequestCost): UsageReport`。价格模块正在并行实现，可用注入估价函数测试；字段和接口变更先沟通。

## 验收

跨天/时区、多模型、复制、主子各计一次、未知项目/模型/时间、全部多选及排除、类型、覆盖、会话数值阈值、全图/分组/明细一致、分页不变总量、版本错误。合成历史，未记录不零填；必须保留缺时间独立统计和没有用量的会话检查入口。

## Comments

- 可先完成聚合骨架与合成测试，最终以 02 接口集成。直接在 main 工作，不创建分支或提交。

## Answer

- `src/sessions/store.ts` 的 `usageSource` 在单个读取事务中确定发布版本、批量读取有效会话及父子关系和非复制请求，不读取消息正文或逐会话画像。
- `src/usage/analytics.ts` 使用统一请求集合完成多选／排除、主子与会话类型、用量与定价覆盖、会话范围数值阈值、稳定排序、趋势、每日热图、分组及会话分页。缺时间记录保留独立小计，无用量会话保留检查入口，二者不补造日期或请求。
- 日／周／月与小时空桶均保留；小时以实际时区偏移区分重复小时，覆盖夏令时跳时、回拨及半小时变化。Token 只累计归一化输入与输出的已记录小计，缓存与推理不重复加入，缓存比例采用相同可计算请求集合。
- 主响应每会话最多 12 条证据，并说明完整数量和截断状态；`buildUsageRequestPage` 在相同固定版本和筛选下提供全部后续请求分页，图表聚合不受证据或会话分页影响。
- `tests/usage-analytics.test.ts` 的 13 项回归通过，包含 13 万条单会话记录；与既有会话存储、用量 HTTP 和输入校验测试合计 65 项通过。服务器类型检查和空白检查通过。真实页面及全量回归由集成任务继续验收。
