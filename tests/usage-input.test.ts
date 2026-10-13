import assert from "node:assert/strict";
import test from "node:test";
import { pricingConfiguration, usageQuery } from "../src/service/usage-input.js";
import { ServiceError } from "../src/service/input.js";

test("用量输入保留包含与排除，日期边界、零阈值及分页不混入会话筛选", () => {
  const query = usageQuery({ clients: '["codex","claude","codex"]', excludeProjects: '["unknown"]', models: '["model/a,b"]',
    from: "2026-10-01", to: "2026-10-11", timezone: "Asia/Shanghai", minTokens: "0", maxCost: "0.25", pageSize: "12", interval: "hour" });
  assert.deepEqual(query.clients, ["codex", "claude"]);
  assert.deepEqual(query.models, ["model/a,b"]);
  assert.deepEqual(query.excludeProjects, ["unknown"]);
  assert.equal(query.minTokens, 0);
  assert.equal(query.maxCost, 0.25);
  assert.equal(query.pageSize, 12);
});

test("用量输入拒绝无效日历日期、混合边界和无效时区", () => {
  for (const raw of [{ from: "2026-02-31" }, { from: "2026-10-12", to: "2026-10-11" },
    { from: "2026-10-11", to: "2026-10-12T00:00:00Z" }, { timezone: "Invalid/Zone" }, { from: "2026-10-11T00:00:00" }]) {
    assert.throws(() => usageQuery(raw), (error: unknown) => error instanceof ServiceError && error.code === "INVALID_INPUT");
  }
});

test("用量输入拒绝未知条件、数组类型、客户端和无效数值", () => {
  for (const raw of [{ arbitrary: "ignored" }, { clients: "codex" }, { clients: '["invalid"]' },
    { models: '[null]' }, { projects: '[""]' }, { coverage: "invalid" }, { page: "0" },
    { minCost: "Infinity" }, { minCost: "-1" }, { minTokens: "0.5" }, { minCost: "2", maxCost: "1" }]) {
    assert.throws(() => usageQuery(raw), (error: unknown) => error instanceof ServiceError && error.code === "INVALID_INPUT");
  }
});

test("价格请求只接受显式价格与映射容器", () => {
  assert.deepEqual(pricingConfiguration({ overrides: [], mappings: [] }), { overrides: [], mappings: [] });
  for (const body of [undefined, [], { overrides: [] }, { overrides: [], mappings: [], arbitrary: true }]) {
    assert.throws(() => pricingConfiguration(body), (error: unknown) => error instanceof ServiceError && error.code === "INVALID_INPUT");
  }
});

test("速度是可选附加查询，分组仅允许与速度开关一起使用", () => {
  assert.equal(usageQuery({ includeSpeed: "true", speedGroup: '["codex","model-a"]' }).includeSpeed, true);
  assert.equal(usageQuery({ includeSpeed: "false" }).includeSpeed, false);
  assert.equal(usageQuery({}).includeSpeed, undefined);
  for (const raw of [{ includeSpeed: "1" }, { includeSpeed: true }, { speedGroup: "group" },
    { includeSpeed: "false", speedGroup: "group" }, { includeSpeed: "true", speedGroup: " " },
    { includeSpeed: "true", speedGroup: "x".repeat(8193) }]) {
    assert.throws(() => usageQuery(raw), (error: unknown) => error instanceof ServiceError && error.code === "INVALID_INPUT");
  }
});

test("速度多选 HTTP 使用有界 JSON 数组并保留空选与顺序", () => {
  const parsed = usageQuery({ includeSpeed: "true", speedGroups: '["b","a","b"]', speedGroup: "legacy" });
  assert.deepEqual(parsed.speedGroups, ["b", "a"]); assert.equal(parsed.speedGroup, "legacy");
  assert.deepEqual(usageQuery({ includeSpeed: "true", speedGroups: "[]" }).speedGroups, []);
  assert.equal(usageQuery({ includeSpeed: "true", speedGroups: JSON.stringify(["x".repeat(8192)]) }).speedGroups![0]!.length, 8192);
  assert.equal(usageQuery({ includeSpeed: "true", speedGroups: JSON.stringify(Array.from({ length: 500 }, (_, i) => `group-${i}`)) }).speedGroups!.length, 500);
  for (const raw of [{ speedGroups: "[]" }, { includeSpeed: "false", speedGroups: "[]" }, { includeSpeed: "true", speedGroups: [] },
    { includeSpeed: "true", speedGroups: "not-json" }, { includeSpeed: "true", speedGroups: '"group"' },
    { includeSpeed: "true", speedGroups: "[null]" }, { includeSpeed: "true", speedGroups: '[""]' },
    { includeSpeed: "true", speedGroups: '[" "]' }, { includeSpeed: "true", speedGroups: "[12]" },
    { includeSpeed: "true", speedGroups: JSON.stringify(["x".repeat(8193)]) },
    { includeSpeed: "true", speedGroups: JSON.stringify(Array.from({ length: 501 }, () => "same")) }]) {
    assert.throws(() => usageQuery(raw), (error: unknown) => error instanceof ServiceError && error.code === "INVALID_INPUT");
  }
});
