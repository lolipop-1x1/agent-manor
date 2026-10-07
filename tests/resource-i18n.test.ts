import assert from "node:assert/strict";
import test from "node:test";
import { formatDate, formatPercent, translate } from "../src/i18n/index.js";
import { resourceQuery } from "../web/resource-api.js";
import { timeFilters } from "../web/model.js";

test("趋势活动与会话各自使用复数，独立数量不串用单数规则", () => {
  for (const [events, sessions, expected] of [[1, 1, "1 activity · 1 session"], [1, 2, "1 activity · 2 sessions"],
    [2, 1, "2 activities · 1 session"], [0, 0, "0 activities · 0 sessions"], [1234, 1, "1,234 activities · 1 session"]] as const) {
    assert.equal(translate("en", "resources.trend.point", { date: "date", events: translate("en", "resources.map.metricValue", { count: events }), sessions: translate("en", "resources.map.sessionValue", { count: sessions }) }), `date · ${expected}`);
    assert.equal(translate("zh-CN", "resources.trend.point", { date: "日期", events: translate("zh-CN", "resources.map.metricValue", { count: events }), sessions: translate("zh-CN", "resources.map.sessionValue", { count: sessions }) }), `日期 · ${new Intl.NumberFormat("zh-CN").format(events)} 次 · ${new Intl.NumberFormat("zh-CN").format(sessions)} 个会话`);
  }
});

test("资源数量采用中英文复数与数字规则，零和单个资源不显示错误词形", () => {
  assert.equal(translate("en", "resources.resourceCount", { count: 0 }), "0 resources");
  assert.equal(translate("en", "resources.resourceCount", { count: 1 }), "1 resource");
  assert.equal(translate("en", "resources.resourceCount", { count: 1234 }), "1,234 resources");
  assert.equal(translate("en", "resources.entryCount", { count: 1 }), "1 entry");
  assert.equal(translate("en", "resources.entryCount", { count: 2 }), "2 entries");
  assert.equal(translate("en", "resources.map.callValue", { count: 1 }), "1 call");
  assert.equal(translate("en", "resources.map.callValue", { count: 2 }), "2 calls");
  assert.equal(translate("zh-CN", "resources.map.callValue", { count: 1234 }), "1,234 次调用");
  assert.equal(translate("en", "resources.map.sessionValue", { count: 1 }), "1 session");
  assert.equal(translate("en", "resources.map.sessionValue", { count: 2 }), "2 sessions");
  assert.equal(translate("zh-CN", "resources.resourceCount", { count: 1234 }), "1,234 个资源");
  assert.equal(translate("zh-CN", "resources.map.sessionValue", { count: 1 }), "1 个会话");
});

test("资源参数保留同名原始名称与路径，不猜测替换生成标签", () => {
  const name = "未记录名称 / <script> / {{count}}";
  assert.equal(translate("en", "resources.viewUsage", { name }), `View usage details for ${name}`);
  assert.equal(translate("zh-CN", "resources.viewUsage", { name }), `查看${name}的使用详情`);
  const query = { q: name, project: "/synthetic/project", from: "2026-10-07T00:00:00.000Z", metric: "calls", candidate: "unused", page: 2 };
  const original = structuredClone(query);
  for (const language of ["en", "zh-CN"] as const) {
    translate(language, "resources.quickFilters", { kind: "Skill" });
    const params = new URLSearchParams(resourceQuery(query));
    assert.equal(params.get("q"), name);
    assert.equal(params.get("project"), query.project);
    assert.equal(params.get("candidate"), "unused");
    assert.equal(params.get("page"), "2");
    assert.deepEqual(query, original);
  }
});

test("资源趋势日期与占比格式改变显示但保留日期边界和面积数值", () => {
  const date = "2026-10-07";
  const scope = timeFilters("custom", date, date);
  const value = .00001;
  assert.notEqual(formatDate("en", `${date}T00:00:00`), formatDate("zh-CN", `${date}T00:00:00`));
  for (const language of ["en", "zh-CN"] as const) {
    assert.equal(formatPercent(language, value, { maximumFractionDigits: 3 }), new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 3 }).format(value));
    assert.deepEqual(timeFilters("custom", date, date), scope);
  }
  assert.equal(value, .00001);
});

test("来源诊断和作用范围使用独立中英文复数，原生边界明确区分", () => {
  assert.equal(translate("en", "resources.diagnostic.count", { count: 1 }), "Source diagnostics · 1 item");
  assert.equal(translate("en", "resources.diagnostic.count", { count: 1234 }), "Source diagnostics · 1,234 items");
  assert.equal(translate("zh-CN", "resources.diagnostic.count", { count: 1234 }), "来源诊断 · 1,234 项");
  assert.equal(translate("en", "resources.entry.selectionScopes", { count: 1 }), "Scope · 1 context");
  assert.equal(translate("en", "resources.entry.selectionScopes", { count: 2 }), "Scope · 2 contexts");
  assert.equal(translate("zh-CN", "resources.entry.selectionScopes", { count: 2 }), "作用范围 · 2 项");
  for (const language of ["en", "zh-CN"] as const) {
    assert.notEqual(translate(language, "resources.entry.userOnly"), translate(language, "resources.tab.disabled"));
    assert.notEqual(translate(language, "resources.empty.local"), translate(language, "resources.empty.localUnreadable"));
    assert.notEqual(translate(language, "resources.empty.localUnreadable"), translate(language, "resources.empty.localUnsupported"));
    assert.notEqual(translate(language, "resources.diagnostic.shadowed"), translate(language, "resources.diagnostic.residual"));
    assert.match(translate(language, "resources.management.desktopMcpReadOnly"), /CodeFlicker/);
  }
});
