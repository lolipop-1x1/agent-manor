import type { ModelPrice } from "../usage-contracts.js";

// 经官方文档核对的 API 快照；网络同身份条目优先，套餐目录保持其原始价格。
// 核对日期不作为历史生效时间，也不代表实际路由或账单。
const fetchedAt = "2026-10-11T00:00:00.000Z";
const tencentSource = "https://intl.cloud.tencent.com/zh/document/product/1300/78937";
export const officialApiPrices: ModelPrice[] = [
  { provider: "tencent", model: "hy4-preview", name: "Hy4 preview", canonicalModelId: "tencent/hy4-preview",
    input: 0.834, output: 2.501, cacheRead: 0.042, source: "bundled", fetchedAt, sourceUrl: tencentSource, priceBasis: "current_snapshot" },
  { provider: "tencent", model: "hy3", name: "Hy3", canonicalModelId: "tencent/hy3",
    input: 0.132, output: 0.528, cacheRead: 0.033, source: "bundled", fetchedAt, sourceUrl: tencentSource, priceBasis: "current_snapshot" },
  { provider: "openai", model: "gpt-5-codex", canonicalModelId: "openai/gpt-5-codex",
    input: 1.25, output: 10, cacheRead: 0.125, source: "bundled", fetchedAt,
    sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5-codex", priceBasis: "current_snapshot" },
];
