import assert from "node:assert/strict";
import test from "node:test";
import { buildOverviewReport, resourceIdentity } from "../src/overview/analytics.js";
import { factDelegation, factDetail, factProcess, factResourceCandidates, factResources, modelTransitions, projectMonths, usageRankingDetail } from "../src/overview/details.js";
import { overviewDetailQuery, overviewPanel } from "../src/service/overview-input.js";
import { source, session, resource, request, event, pricing, now } from "./overview-fixtures.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/sessions/store.js";
import { OverviewFactStore } from "../src/overview/facts.js";
import type { OverviewQuery, OverviewSource } from "../src/overview-contracts.js";
import { buildUsageReport } from "../src/usage/analytics.js";
import { coreOverviewInsights, generateOverviewInsights } from "../src/overview/insights.js";

const normalized = <T>(value: T): T => JSON.parse(JSON.stringify(value));
async function withFacts(input: OverviewSource, run: (facts: OverviewFactStore, original: OverviewSource) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-overview-detail-facts-")), store = new SessionStore(join(directory, "index.sqlite"));
  const facts = new OverviewFactStore(store);
  try {
    const revisions = input.sessions.map(session => {
      const path = `/workspace/history/${session.id}.jsonl`, pending = store.createRevision(path, "synthetic");
      const events = input.events.filter(event => event.sessionId === session.id);
      for (const event of events) pending.sink.message({ ...event, text: "合成正文", turnId: event.turnId ?? "turn-1", recordLine: event.ordinal + 1 });
      for (const resource of input.resources.filter(resource => resource.sessionId === session.id)) {
        if (events.some(event => event.id === resource.messageId)) continue;
        pending.sink.message({ sessionId: session.id, id: resource.messageId, ordinal: resource.ordinal, recordLine: resource.ordinal + 1,
          kind: resource.kind === "skill_read" ? "user" : "tool_call", turnId: resource.turnId, text: "合成资源", occurredAt: resource.occurredAt,
          tool: resource.tool, status: resource.status, resource: { kind: resource.kind, name: resource.name, nameDescriptor: resource.nameDescriptor,
            server: resource.server, path: resource.path } });
      }
      for (const request of input.requests.filter(request => request.sessionId === session.id)) pending.sink.usage(request.usage);
      pending.flush(); store.finishRevision(pending.revision, { ...session, path, sourceId: `source-${session.id}` });
      return { path, revision: pending.revision, fingerprint: "synthetic" };
    });
    store.publish(store.createJob().id, revisions, input.gaps); await run(facts, store.overviewSource());
  } finally { facts.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
}

test("对象分布在服务端分页，元数据和日期趋势不重复嵌入完整分布", async () => {
  const input = source({ sessions: Array.from({ length: 6 }, (_, index) => session(String(index), { project: `/synthetic/project-${index}` })),
    events: Array.from({ length: 6 }, (_, index) => event(String(index), `event-${index}`)),
    resources: Array.from({ length: 6 }, (_, index) => resource(String(index), `resource-${index}`, "skill-a", "2026-01-01", { project: `/synthetic/project-${index}` })) });
  await withFacts(input, async (facts, original) => {
    const report = buildOverviewReport(original, { window: "all", timezone: "UTC" }, pricing, now), resourceId = resourceIdentity(original.resources[0]!);
    await facts.prepare(report.query, now);
    const first = factDetail(facts, report, { view: "resource", resourceId, dimension: "project", page: 1, pageSize: 2 }, now);
    const second = factDetail(facts, report, { view: "resource", resourceId, dimension: "project", page: 2, pageSize: 2 }, now);
    assert.equal(first.total, 6); assert.equal(first.rows.length, 2); assert.equal(second.rows.length, 2);
    assert.notDeepEqual(first.rows, second.rows); assert.equal(first.object!.uses, 6);
    assert.equal(first.counts!.projects, 6); assert.deepEqual(first.object!.projects, []); assert.deepEqual(first.object!.days, [{ day: "2026-01-01", uses: 6, sessions: 6 }]);
  });
});
test("计时列表先按组分页，单对象只返回同客户端模型依据组", async () => {
  const input = source({ sessions: [session("a")], requests: Array.from({ length: 4 }, (_, index) => request("a", `request-${index}`, "2026-01-01", {
    model: `model-${index}`, outputTokens: 20, timing: { basis: "recorded", method: "zcode_request_span", completion: "explicit", durationMs: (index + 1) * 1000 } })) });
  await withFacts(input, async (facts, original) => {
    const report = buildOverviewReport(original, { window: "all", timezone: "UTC" }, pricing, now); await facts.prepare(report.query, now);
    let decoded = 0; const decode = facts.decodeRequest.bind(facts); facts.decodeRequest = row => { decoded++; return decode(row); };
    const page = factDetail(facts, report, { view: "timings", page: 2, pageSize: 1 }, now);
    assert.equal(decoded, 1);
    assert.equal(page.total, 4); assert.equal(page.rows.length, 1);
    const group = page.rows[0] as typeof report.process.timing[number]; assert.equal(group.model, "model-1"); assert.equal(group.duration.medianMs, 2000);
    const single = factDetail(facts, report, { view: "timing", timingGroup: group.id }, now);
    assert.equal(single.total, 1); assert.deepEqual(single.rows, page.rows);
  });
});
test("窄SQL分页与完整统计在时区、模型、父子、未知及配对上保持等价", async () => {
  const sessions = Array.from({ length: 6 }, (_, index) => session(`session-${index}`, { project: index === 5 ? undefined : `/workspace/project-${index % 2}`,
    ...(index === 1 ? { relationship: "child" as const, parentSessionId: "session-0" } : index === 2 ? { relationship: "fork" as const } : {}) }));
  const input = source({ sessions, events: sessions.flatMap((item, index) => [event(item.id, `user-${index}`, "2026-01-01"),
    event(item.id, `tool-${index}`, "2026-01-02", { ordinal: 30, kind: "tool_call", tool: "exec_command", status: index % 2 ? "failure" : "success" }),
    event(item.id, `compression-${index}`, "2026-01-02", { ordinal: 31, kind: "compression" }),
    event(item.id, `copied-${index}`, "2026-01-02", { ordinal: 32, copied: true })]),
    resources: sessions.flatMap((item, index) => [resource(item.id, `skill-${index}`, "skill-a", "2026-01-01", { ordinal: 2 }),
      resource(item.id, `mcp-${index}`, "server-a", "2026-01-15", { ordinal: 3, kind: "mcp", server: "server-a", tool: "mcp__server_a__tool_a" }),
      resource(item.id, `skill-more-${index}`, "skill-a", "2026-02-01", { ordinal: 4 }),
      resource(item.id, `skill-missing-${index}`, "skill-a", "2026-02-01", { ordinal: 5, occurredAt: undefined })]),
    requests: sessions.flatMap(item => [request(item.id, `request-first-${item.id}`, "2026-01-01", { model: "model-a", outputTokens: 20,
      timing: { basis: "recorded", method: "zcode_request_span", completion: "explicit", durationMs: 1000 } }),
      request(item.id, `request-next-${item.id}`, "2026-02-01", { model: "model-b", outputTokens: undefined }),
      request(item.id, `request-unknown-${item.id}`, "2026-02-01", { model: undefined, inputTokens: undefined, outputTokens: undefined }),
      request(item.id, `request-tail-${item.id}`, "2026-02-02", { model: "model-a", inputTokens: -1, outputTokens: 0 })]) });
  await withFacts(input, async (facts, original) => {
    facts.source = async () => { throw new Error("详情及首页不能恢复完整事实来源"); };
    for (const query of [{ window: "all", timezone: "UTC" }, { window: "custom", timezone: "America/New_York", from: "2026-01-01", to: "2026-02-02", models: ["model-a"] },
      { window: "30", timezone: "UTC", clients: ["pi"] }] satisfies OverviewQuery[]) {
      const report = buildOverviewReport(original, query, pricing, now); await facts.prepare(report.query, now);
      const resources = factResources(facts, report, now);
      const narrow = (rows: typeof report.resources.skills) => rows.slice(0, 5).map(row => ({ ...row, clients: [], projects: [], tools: [] }));
      assert.deepEqual(normalized(resources.resources.skills), normalized(narrow(report.resources.skills)));
      assert.deepEqual(normalized(resources.resources.mcp), normalized(narrow(report.resources.mcp)));
      assert.equal(resources.resources.missingTimeEvents, report.resources.missingTimeEvents);
      assert.equal(resources.resources.missingTurnEvents, report.resources.missingTurnEvents);
      const { process } = factProcess(facts, report, now);
      for (const field of ["categories", "results", "failures", "compressions", "compressionSessions", "missingTimingRequests"] as const) {
        assert.deepEqual(normalized(process[field]), normalized(report.process[field]), field);
      }
      assert.deepEqual(normalized(factDelegation(facts, report, now)), normalized(report.delegation));
      assert.deepEqual(normalized(factDetail(facts, report, { view: "months", pageSize: 100 }, now).rows), normalized(projectMonths(original, report)));
      assert.deepEqual(normalized(factDetail(facts, report, { view: "transitions", pageSize: 100 }, now).rows), normalized(modelTransitions({ ...original,
        requests: original.requests.filter(request => !query.clients?.length || original.sessions.find(session => session.id === request.sessionId)?.client === query.clients[0]) }, report)));
      for (const view of ["observations", "combinations"] as const) {
        const expected = view === "observations" ? report.resources.observations : report.resources.combinations.sessions;
        const actual = factDetail(facts, report, { view, pageSize: 100 }, now);
        const byId = (rows: typeof actual.rows) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        assert.equal(actual.total, expected.length); assert.deepEqual(normalized(byId(actual.rows)), normalized(byId(expected)));
      }
    }
  });
});
test("资源和工具身份先分页，仅解码所选页首记录，费用排行保留小计语义", async () => {
  const input = source({ sessions: [session("main")], events: [event("main", "user")],
    resources: Array.from({ length: 150 }, (_, index) => resource("main", `resource-${index}`, `skill-${index}`, "2026-01-01", { ordinal: index + 2 })) });
  await withFacts(input, async (facts, original) => {
    const report = buildOverviewReport(original, { window: "all", timezone: "UTC" }, pricing, now); await facts.prepare(report.query, now);
    let decoded = 0; const decode = facts.decodeResource.bind(facts); facts.decodeResource = row => { decoded++; return decode(row); };
    const page = factDetail(facts, report, { view: "resources", kind: "skill", page: 2, pageSize: 5 }, now);
    assert.equal(page.total, 150); assert.equal(page.rows.length, 5); assert.equal(decoded, 5);
  });
  const usageInput = source({ sessions: [session("priced"), session("unknown")], requests: [request("priced", "complete"),
    request("unknown", "partial", "2026-01-01", { outputTokens: undefined })] });
  const report = buildOverviewReport(usageInput, { window: "all", timezone: "UTC" }, pricing, now);
  const grouped = buildUsageReport(usageInput, { groupBy: "model" }, pricing.status, pricing.estimate);
  assert.equal(usageRankingDetail(grouped, report, { view: "ranking", dimension: "model", sort: "cost" }).rows[0]?.costCoverage, "partial");
});
test("工具排行批量恢复页内首记录，查询次数不随工具数增加", async () => {
  const input = source({ sessions: [session("main")], events: Array.from({ length: 150 }, (_, index) => event("main", `tool-${index}`, "2026-01-01", {
    ordinal: index + 1, kind: "tool_call", tool: `tool-${index}`, status: "success" })) });
  await withFacts(input, async (facts, original) => {
    const report = buildOverviewReport(original, { window: "all", timezone: "UTC" }, pricing, now); await facts.prepare(report.query, now);
    let queries = 0, decoded = 0;
    const read = facts.readRows.bind(facts), decode = facts.decodeEvent.bind(facts);
    facts.readRows = <T>(sql: string, values: (string | number | null)[] = []) => { queries++; return read<T>(sql, values); };
    facts.decodeEvent = row => { decoded++; return decode(row); };
    const page = factDetail(facts, report, { view: "ranking", dimension: "tool", pageSize: 100 }, now);
    assert.equal(page.total, 150); assert.equal(page.rows.length, 100); assert.equal(decoded, 100);
    assert.ok(queries <= 5, "页内首记录通过一次批量查询读取，不能为每个工具重扫历史");
    const expected = report.process.tools.slice(0, 100);
    assert.deepEqual(page.rows, expected.map(row => ({ ...row, clients: [], projects: [] })));
  });
});
test("核心资源变化和确凿过程候选先筛身份，不解码全部事件及请求", async () => {
  const sessions = Array.from({ length: 10 }, (_, index) => session(`main-${index}`));
  const input = source({ sessions, events: sessions.flatMap((item, index) => [event(item.id, `user-${index}`, "2026-02-01"),
    ...Array.from({ length: 2 }, (_, ordinal) => event(item.id, `call-${index}-${ordinal}`, "2026-02-10", {
      ordinal: ordinal + 20, kind: "tool_call", tool: "exec_command", status: index < 2 ? "failure" : "success" }))]),
    resources: sessions.flatMap((item, index) => [
      ...["2026-02-01", "2026-02-08", "2026-02-15", "2026-02-22"].map((day, ordinal) => resource(item.id, `current-${index}-${ordinal}`, "skill-a", day, { ordinal: ordinal + 2 })),
      ...(index < 5 ? ["2026-01-01", "2026-01-08", "2026-01-15", "2026-01-22"].map((day, ordinal) => resource(item.id, `previous-${index}-${ordinal}`, "skill-a", day, { ordinal: ordinal + 6 })) : []),
    ]) });
  await withFacts(input, async (facts, original) => {
    const clock = new Date("2026-03-01T12:00:00Z"), report = buildOverviewReport(original, { window: "custom", from: "2026-02-01", to: "2026-02-28", timezone: "UTC" }, pricing, clock);
    await facts.prepare(report.query, clock); let decodedResources = 0, decodedEvents = 0;
    const decodeResource = facts.decodeResource.bind(facts), decodeEvent = facts.decodeEvent.bind(facts);
    facts.decodeResource = row => { decodedResources++; return decodeResource(row); };
    facts.decodeEvent = row => { decodedEvents++; return decodeEvent(row); };
    facts.decodeRequest = () => { throw new Error("核心洞察不应恢复请求JSON"); };
    const resources = factResourceCandidates(facts, report, clock), { process } = factProcess(facts, report, clock, true);
    const actual = coreOverviewInsights({ ...report, resources: resources.resources, process }, resources);
    assert.deepEqual(normalized(actual.insights), normalized(generateOverviewInsights(original, report.query, pricing, report).insights));
    assert.equal(actual.insights.find(row => row.rule === "03")?.previous, 5);
    assert.equal(actual.insights.find(row => row.rule === "11")?.current, 4);
    assert.equal(decodedResources, 3); assert.equal(decodedEvents, 1);
  });
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
