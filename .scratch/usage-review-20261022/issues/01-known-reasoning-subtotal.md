# 已知推理 Token 未计入部分费用小计

Type: task
Status: resolved
Priority: P2

## 触发条件

模型具有不同的普通输出与推理单价；请求缺少总输出 Token，但保存了推理 Token。来源适配器允许独立保留这两项的缺失状态，例如 Gemini。

## 复现

使用合成模型，普通输入和输出单价均为 1，推理单价为 5，单位为每百万 Token。输入为 0，总输出未记录，推理为 1,000,000。

`createPricingEstimator()` 返回 `amount: 0`、`coverage: partial`、`reason: tokens_missing`。输入也缺失时返回 `amount: null`、`coverage: missing`。

## 预期

已知推理桶至少构成 5 美元小计，总输出未知仍保持部分覆盖。符合 `docs/design/usage-statistics.md` 的已知桶小计约定，不将未知普通输出补零。

## 位置

- `src/usage/pricing.ts:104-109`：仅在总输出与推理均已知时计算推理桶。
- `src/history/adapters/gemini.ts:76-78`：保留推理已知而总输出未知的输入组合。

## 验证边界

使用实际计价函数与人工合成数据复现；未核查真实历史中此字段组合的出现比例。

## 修复

总输出未知时独立计入有效推理分项，保留部分覆盖；完整输出仍只计一次，冲突分项继续限制估价。价格规则版本更新为 8，使旧费用汇总失效。新增回归先复现 `0 != 5`，再覆盖缺输入、已知零值、完整输出及冲突分项。
