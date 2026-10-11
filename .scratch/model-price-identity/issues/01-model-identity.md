# 标准模型身份与官方 API 基准

Type: task
Status: resolved

范围：目录身份导入、共享解析、经核对的官方价格兜底和费用规则版本。验证新模型、冲突、手动优先及 Token 不变。

## Answer

保存目录标准身份并纳入版本；只以同型号签名辅助选价，官方 API 优先，冲突不猜选，明确服务商可唯一消歧。手动覆盖与映射优先，旧费用汇总随规则版本失效。新增合成回归及完整真实索引回测通过，Token 与手动配置保持不变。实现见 [共享匹配](../../../src/usage/price-resolution.ts) 和 [官方快照](../../../src/usage/official-api-prices.ts)。
