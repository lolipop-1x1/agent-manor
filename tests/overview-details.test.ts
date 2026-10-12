import assert from "node:assert/strict";
import test from "node:test";
import { buildOverviewReport, resourceIdentity } from "../src/overview/analytics.js";
import { overviewDetail } from "../src/overview/details.js";
import { overviewDetailQuery, overviewPanel } from "../src/service/overview-input.js";
import { source, session, resource, request, event, pricing, now } from "./overview-fixtures.js";

test("对象分布在服务端分页，元数据和日期趋势不重复嵌入完整分布", () => {
  const input = source({ sessions: Array.from({ length: 6 }, (_, index) => session(String(index), { project: `/synthetic/project-${index}` })),
    events: Array.from({ length: 6 }, (_, index) => event(String(index), `event-${index}`)),
    resources: Array.from({ length: 6 }, (_, index) => resource(String(index), `resource-${index}`, "skill-a", "2026-01-01", { project: `/synthetic/project-${index}` })) });
  const report = buildOverviewReport(input, { window: "all", timezone: "UTC" }, pricing, now), resourceId = resourceIdentity(input.resources[0]!);
  const first = overviewDetail(input, report, { view: "resource", resourceId, dimension: "project", page: 1, pageSize: 2 });
  const second = overviewDetail(input, report, { view: "resource", resourceId, dimension: "project", page: 2, pageSize: 2 });
  assert.equal(first.total, 6); assert.equal(first.rows.length, 2); assert.equal(second.rows.length, 2);
  assert.notDeepEqual(first.rows, second.rows); assert.equal(first.object!.uses, 6);
  assert.equal(first.counts!.projects, 6); assert.deepEqual(first.object!.projects, []); assert.deepEqual(first.object!.days, [{ day: "2026-01-01", uses: 6, sessions: 6 }]);
});
test("计时列表先按组分页，单对象只返回同客户端模型依据组", () => {
  const input = source({ sessions: [session("a")], requests: Array.from({ length: 4 }, (_, index) => request("a", `request-${index}`, "2026-01-01", {
    model: `model-${index}`, outputTokens: 20, timing: { basis: "recorded", method: "zcode_request_span", completion: "explicit", durationMs: (index + 1) * 1000 } })) });
  const report = buildOverviewReport(input, { window: "all", timezone: "UTC" }, pricing, now);
  const page = overviewDetail(input, report, { view: "timings", page: 2, pageSize: 1 });
  assert.equal(page.total, 4); assert.equal(page.rows.length, 1);
  const group = page.rows[0] as typeof report.process.timing[number]; assert.equal(group.model, "model-1"); assert.equal(group.duration.medianMs, 2000);
  const single = overviewDetail(input, report, { view: "timing", timingGroup: group.id });
  assert.equal(single.total, 1); assert.deepEqual(single.rows, page.rows);
});
test("新增API枚举、分页和对象边界严格验证", () => {
  assert.equal(overviewPanel("core"), "core"); assert.throws(() => overviewPanel("unknown"), { code: "INVALID_INPUT" });
  assert.deepEqual(overviewDetailQuery('{"view":"ranking","dimension":"model","sort":"cost","pageSize":100}'), {
    view: "ranking", dimension: "model", sort: "cost", pageSize: 100 });
  for (const value of [{ view: "resource" }, { view: "resource", resourceId: "synthetic", dimension: "model" },
    { view: "timing" }, { view: "timings", pageSize: 101 }, { view: "ranking", page: 0 }, { view: "unknown" }, { view: "resources", sql: "synthetic" }]) {
    assert.throws(() => overviewDetailQuery(JSON.stringify(value)), { code: "INVALID_INPUT" });
  }
});
