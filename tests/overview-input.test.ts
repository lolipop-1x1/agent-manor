import assert from "node:assert/strict";
import test from "node:test";
import { overviewDistributionDimension, overviewEvidenceQuery, overviewPanel, overviewQuery } from "../src/service/overview-input.js";

test("总览查询只接受本地日期和独立模型范围，保留数组中的路径", () => {
  assert.equal(overviewQuery({ anchorDay: "2026-10-12" }).anchorDay, "2026-10-12");
  assert.deepEqual(overviewQuery({ window: "custom", from: "2026-10-01", to: "2026-10-12", timezone: "Asia/Shanghai",
    clients: '["codex"]', projects: '["/synthetic/project,one"]', models: '["synthetic-model"]' }), {
    window: "custom", from: "2026-10-01", to: "2026-10-12", timezone: "Asia/Shanghai",
    clients: ["codex"], projects: ["/synthetic/project,one"], models: ["synthetic-model"],
  });
  for (const raw of [{ anchorDay: "2026-02-31" }, { anchorDay: "2026-10-01T00:00:00Z" }, { anchorDay: ["2026-10-12"] }, { from: "2026-02-31" }, { from: "2026-10-01T00:00:00Z" }, { window: "unknown" },
    { timezone: "synthetic-invalid" }, { clients: '["synthetic-invalid"]' }, { from: "2026-10-12", to: "2026-10-01" },
    { from: "1900-01-01", to: "9999-12-31" }, { relationship: "child" }, { evidence: "{}" }]) {
    assert.throws(() => overviewQuery(raw), { code: "INVALID_INPUT" });
  }
});

test("新增按需分区明确指定分布维度，其他分区拒绝维度参数", () => {
  for (const panel of ["distribution", "delegation", "facets"]) assert.equal(overviewPanel(panel), panel);
  for (const dimension of ["client", "project", "model"]) assert.equal(overviewDistributionDimension(dimension, "distribution"), dimension);
  assert.equal(overviewDistributionDimension(undefined, "usage"), undefined);
  for (const raw of [undefined, "tool", "unknown", ["model"]]) {
    assert.throws(() => overviewDistributionDimension(raw, "distribution"), { code: "INVALID_INPUT" });
  }
  assert.throws(() => overviewDistributionDimension("model", "usage"), { code: "INVALID_INPUT" });
});

test("调查查询与总览边界分别编码，拒绝失效枚举、未知参数和越界分页", () => {
  const evidence = { kind: "resources", from: "2026-09-01", to: "2026-09-30", resourceKind: "mcp", tool: "synthetic-tool", page: 2, pageSize: 50 };
  assert.deepEqual(overviewEvidenceQuery(JSON.stringify(evidence)), evidence);
  assert.deepEqual(overviewEvidenceQuery(JSON.stringify({ kind: "requests", ordinalFrom: 0, ordinalTo: 12,
    requestId: "synthetic-request", modelFrom: "synthetic-a", modelTo: "synthetic-b", transition: "switch" })), {
    kind: "requests", ordinalFrom: 0, ordinalTo: 12, requestId: "synthetic-request", modelFrom: "synthetic-a", modelTo: "synthetic-b", transition: "switch",
  });
  assert.equal(overviewQuery({ evidence: JSON.stringify(evidence) }, true).window, "365");
  for (const invalid of [null, [], {}, { kind: "unknown" }, { kind: "tools", status: "maybe" },
    { kind: "tools", pageSize: 201 }, { kind: "tools", page: 0 }, { kind: "tools", page: "2" },
    { kind: "requests", ordinalFrom: -1 }, { kind: "requests", ordinalFrom: 4, ordinalTo: 2 }, { kind: "requests", undated: "true" },
    { kind: "activity", day: "2026-02-31" }, { kind: "tools", sql: "synthetic" }, { kind: "activity", from: "2026-10-12", to: "2026-10-01" }]) {
    assert.throws(() => overviewEvidenceQuery(JSON.stringify(invalid)), { code: "INVALID_INPUT" });
  }
});
