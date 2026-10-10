import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parsePriceCatalog, priceContentVersion, priceSourceUrl } from "../src/usage/price-catalog.ts";

// 使用 node --import tsx scripts/update-usage-prices.mjs 更新可审阅的随包快照。
const fetchedAt = new Date().toISOString();
const response = await fetch(priceSourceUrl, { signal: AbortSignal.timeout(30_000), redirect: "error", credentials: "omit" });
if (!response.ok) throw new Error(`价格目录返回 HTTP ${response.status}`);
const snapshot = parsePriceCatalog(await response.json(), fetchedAt, "bundled");
let localDenylist = "";
try { localDenylist = await readFile(new URL("../.local/public-denylist.txt", import.meta.url), "utf8"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const forbidden = `${localDenylist}\n${process.env.AGENT_MANOR_PUBLIC_DENYLIST ?? ""}`.split(/\r?\n/)
  .map(value => value.trim().toLowerCase()).filter(value => value && !value.startsWith("#"));
const originalCount = snapshot.prices.length;
// 随包数据与源码遵循相同的公开内容边界；不把被排除的标识写入日志。
snapshot.prices = snapshot.prices.filter(price => !forbidden.some(term => JSON.stringify(price).toLowerCase().includes(term)));
if (!snapshot.prices.length) throw new Error("没有可公开的价格条目");
snapshot.version = priceContentVersion(snapshot.prices);
const excluded = originalCount - snapshot.prices.length;
const licenseResponse = await fetch("https://raw.githubusercontent.com/anomalyco/models.dev/dev/LICENSE", {
  signal: AbortSignal.timeout(20_000), redirect: "error", credentials: "omit",
});
if (!licenseResponse.ok) throw new Error("无法获取价格数据许可证");
const license = (await licenseResponse.text()).trim();
if (!license.startsWith("MIT License") || !license.includes("Copyright (c) 2025 models.dev") || license.includes("*/")) {
  throw new Error("价格数据许可证发生变化，请人工审阅");
}
const header = `/**\n * 公开价格数据：https://models.dev/api.json\n * 获取时间：${fetchedAt}；不表示历史价格生效日期。\n * 按仓库公开内容边界排除 ${excluded} 个条目，其余计价字段完整保留。\n * 由 scripts/update-usage-prices.mjs 生成，不手工编辑。\n *\n${license.split("\n").map(line => ` *${line ? ` ${line}` : ""}`).join("\n")}\n */\n`;
// 每行保留一个完整模型，更新 diff 可逐模型审阅，档位仍完整保存。
const { prices, ...metadata } = snapshot;
const serialized = `${JSON.stringify(metadata, null, 2).slice(0, -2)},\n  "prices": [\n${prices.map(price => `    ${JSON.stringify(price)}`).join(",\n")}\n  ]\n}`;
const content = `${header}import type { PriceSnapshot } from "../usage-contracts.js";\n\nexport const bundledPriceSnapshot: PriceSnapshot = ${serialized};\n`;
await writeFile(fileURLToPath(new URL("../src/usage/bundled-prices.ts", import.meta.url)), content);
console.log(`已保存 ${snapshot.prices.length} 条价格，公开边界排除 ${excluded} 条；内容版本 ${snapshot.version}；获取时间 ${fetchedAt}`);
