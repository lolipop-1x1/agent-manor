import assert from "node:assert/strict";
import test from "node:test";
import { summaryRequestPath, summarizeResponse, summarizeStatus } from "../src/output/summary.js";
import { humanOutput } from "../src/output/format.js";
import { createProgram } from "../src/program.js";

test("状态摘要保留会话计数、陈旧与同步失败，省略无界诊断目录", () => {
  const session = { version: "history-v1", sessionCount: 23, sourceCount: 7, stale: true, gapCount: 2000,
    projects: Array.from({ length: 2000 }, (_, index) => `project-${index}`), gaps: [{ message: "synthetic" }],
    job: { id: "sync-1", status: "failed", progress: 0, error: "synthetic sync error" },
    autoSync: { state: "backoff", intervalMs: 60000, consecutiveFailures: 2, error: "synthetic retry error" } };
  const result = summarizeStatus({ sessions: session, repositoryCount: 2, jobCount: 3 }) as { sessions: typeof session };
  assert.equal(result.sessions.sessionCount, 23);
  assert.equal(result.sessions.version, "history-v1");
  assert.equal(result.sessions.sourceCount, 7);
  assert.equal(result.sessions.stale, true);
  assert.equal(result.sessions.job.error, session.job.error);
  assert.equal(result.sessions.autoSync.error, session.autoSync.error);
  assert.equal(result.sessions.projects, undefined);
  assert.equal(result.sessions.gaps, undefined);
  assert.ok(JSON.stringify(result).length < 1000);
  const human = humanOutput({ running: true, state: "running", status: { sessions: result.sessions } }, "zh-CN");
  assert.match(human, /23/);
  assert.match(human, /synthetic sync error/);
  assert.match(human, /synthetic retry error/);
});

test("业务摘要消费稳定诊断描述，未知诊断保留并标明原始详情", () => {
  const value = { status: "failed", error: "Synthetic source context is missing.", errorDescriptor: { key: "knowledge.errors.context_required" } };
  const chinese = humanOutput(value, "zh-CN"), english = humanOutput(value, "en");
  assert.match(chinese, /上下文/);
  assert.match(chinese, /原始详情: Synthetic source context is missing\./);
  assert.match(english, /More context is needed/);
  assert.match(humanOutput({ error: "Unknown upstream response" }, "zh-CN"), /原始详情: Unknown upstream response/);
  assert.match(humanOutput({ jobs: [value] }, "zh-CN"), /上下文/);
  assert.deepEqual(JSON.parse(humanOutput(value, "zh-CN", true)), value);
});

test("默认请求只选择轻量视图，full与显式导出保持原接口", () => {
  assert.equal(summaryRequestPath("/sessions?page=2", false), "/sessions?page=2&response=summary&pageSize=20");
  assert.equal(summaryRequestPath("/sessions?pageSize=3", false), "/sessions?pageSize=3&response=summary");
  assert.equal(summaryRequestPath("/sessions", true), "/sessions");
  assert.equal(summaryRequestPath("/resources/usage/one", false), "/resources/usage/one");
  assert.match(summaryRequestPath("/sessions/one/messages?messageId=m1&textOffset=100", false), /textOffset=100/);
});

test("服务状态不重复完整业务数据并保留必要错误与任务定位", () => {
  const state = { instance: { id: "service", pid: 42 }, preparation: { state: "failed", error: "synthetic failure" }, repositories: [{ id: "r", baseline: "large" }], jobs: [{ id: "j", status: "running" }], activeTasks: [{ id: "j", kind: "sessions", status: "running" }] };
  const result = summarizeStatus({ ...state, running: true, state: "running", status: state }) as Record<string, unknown>;
  assert.equal(result.repositoryCount, undefined);
  assert.deepEqual((result.status as Record<string, unknown>).preparation, state.preparation);
  assert.equal((result.status as Record<string, unknown>).repositoryCount, 1);
  assert.equal("repositories" in result, false);
  assert.equal("jobs" in result, false);
});

test("写入知识保留当前修订定位，删除历史正文；确认预览未经投影", () => {
  const revision = { id: "r2", knowledgeId: "k", version: 2, review: "pending", title: "Title", body: "body", sources: [{ excerpt: "source" }] };
  const detail = { id: "k", latestRevisionId: "r2", publishedRevisionId: "r1", revision, revisions: [revision], audit: [{ id: "a" }], availability: "active" };
  const result = summarizeResponse("/knowledge/entries/k/revisions", "POST", detail) as Record<string, unknown>;
  assert.equal(result.latestRevisionId, "r2");
  assert.deepEqual(result.revision, { id: "r2", knowledgeId: "k", version: 2, review: "pending", title: "Title" });
  assert.equal("revisions" in result, false);
  assert.deepEqual(summarizeResponse("/knowledge/entries/k", "GET", detail), detail);
});

test("业务人读输出保留中英文标题、未知和估算语义，full仍可读取完整对象", () => {
  const result = { version: "v1", total: 21, page: 1, pageSize: 20, sessions: [{ id: "s1", title: "Synthetic title", client: "codex", project: "/workspace/example", estimatedTokens: null }] };
  assert.match(humanOutput(result, "en"), /ID\s+Title\s+Client/);
  assert.match(humanOutput(result, "zh-CN"), /标识\s+标题\s+客户端/);
  assert.match(humanOutput(result, "zh-CN"), /估算 Token/);
  assert.match(humanOutput(result, "en"), /—/);
  assert.doesNotMatch(humanOutput(result, "en"), /"sessions"|Translation unavailable/);
  assert.deepEqual(JSON.parse(humanOutput(result, "en", true)), result);
});

test("完整响应、画像分区和价格分页命令均可发现；回放缺失上下文在连接前拒绝", async () => {
  const program = createProgram("en");
  assert.match(program.helpInformation(), /--full/);
  const sessions = program.commands.find(command => command.name() === "sessions")!;
  assert.match(sessions.commands.find(command => command.name() === "profile")!.helpInformation(), /--section/);
  assert.match(sessions.commands.find(command => command.name() === "messages")!.helpInformation(), /--text-offset/);
  const usage = program.commands.find(command => command.name() === "usage")!;
  assert.ok(usage.commands.find(command => command.name() === "pricing")!.commands.find(command => command.name() === "list"));
  await assert.rejects(createProgram("en").parseAsync(["repositories", "replay-evidence", "repo", "--event-id", "event"], { from: "user" }), { code: "INVALID_INPUT" });
});

test("实际命令的默认与JSON共用摘要视图，full保留完整字段与显式分页", async () => {
  const { createServer } = await import("node:http");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { VERSION } = await import("../../../src/version.js");
  const home = await mkdtemp(join(tmpdir(), "manor-summary-cli-"));
  let instance: Record<string, unknown>;
  const queries: URL[] = [];
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname === "/api/v1/status") { response.end(JSON.stringify({ instance, version: VERSION, protocolVersion: 1 })); return; }
    queries.push(url);
    const summary = url.searchParams.get("response") === "summary";
    if (url.pathname.endsWith("/profile")) response.end(JSON.stringify(summary ? { version: "v1", section: url.searchParams.get("section") ?? "summary", items: [{ id: "step1" }], page: 2, pageSize: 3, total: 5, hasMore: false } : { version: "v1", steps: [{ id: "step1" }], contextSnapshots: [{ inputTokens: 2 }] }));
    else if (url.pathname.endsWith("/messages") && url.searchParams.get("mode") === "brief") response.end(JSON.stringify({ version: "v1", session: { id: "s1" }, messages: [{ id: "m1", turnId: "t1", kind: "user", text: "Synthetic export body ".repeat(1_000) }], total: 1, page: 1, pageSize: 200 }));
    else if (url.pathname.endsWith("/prices")) response.end(JSON.stringify({ version: "price1", prices: [{ model: "synthetic-model", provider: "example", input: 1, output: 2 }], page: 2, pageSize: 3, total: 5, hasMore: false }));
    else response.end(JSON.stringify({ version: "v1", sessions: [{ id: "s1", title: "Synthetic title", client: "codex", ...(!summary ? { contextSnapshots: Array.from({ length: 1_000 }, (_, id) => ({ id, value: "synthetic" })) } : {}) }], total: 1, page: 1, pageSize: Number(url.searchParams.get("pageSize") ?? 50) }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  instance = { id: "synthetic-summary-service-identity", pid: process.pid, host: "127.0.0.1", port: address.port, startedAt: new Date().toISOString(), version: VERSION, protocolVersion: 1 };
  await writeFile(join(home, "service.json"), JSON.stringify(instance));
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stdout.write;
  const execute = async (args: string[], language: "en" | "zh-CN" = "en") => {
    output = "";
    await createProgram(language).parseAsync(["--home", home, ...args], { from: "user" });
    return output;
  };
  try {
    const json = JSON.parse(await execute(["sessions", "list", "--json"]));
    assert.equal(json.pageSize, 20); assert.equal(json.sessions[0].contextSnapshots, undefined);
    assert.ok(output.length < 1_000);
    const english = await execute(["sessions", "list"]);
    const chinese = await execute(["sessions", "list"], "zh-CN");
    assert.match(english, /ID\s+Title\s+Client/); assert.match(chinese, /标识\s+标题\s+客户端/);
    assert.equal(queries.at(-1)!.searchParams.get("response"), "summary");
    const full = JSON.parse(await execute(["--full", "--json", "sessions", "list"]));
    assert.equal(full.sessions[0].contextSnapshots.length, 1_000); assert.equal(full.pageSize, 50);
    assert.equal(queries.at(-1)!.searchParams.has("response"), false);
    await execute(["sessions", "profile", "s1", "--section", "context", "--page", "2", "--page-size", "3", "--json"]);
    assert.equal(queries.at(-1)!.searchParams.get("section"), "context");
    assert.equal(queries.at(-1)!.searchParams.get("pageSize"), "3");
    const prices = JSON.parse(await execute(["usage", "pricing", "list", "--model", "synthetic-model", "--version", "price1", "--page", "2", "--page-size", "3", "--json"]));
    assert.equal(prices.prices[0].model, "synthetic-model"); assert.equal(prices.version, "price1");
    assert.equal(queries.at(-1)!.searchParams.get("version"), "price1");
    assert.equal(queries.at(-1)!.searchParams.get("model"), "synthetic-model");
    assert.equal(prices.total, 5); assert.equal(prices.page, 2); assert.equal(prices.hasMore, false);
    await execute(["sessions", "messages", "s1", "--message-id", "m1", "--text-offset", "50", "--max-text-chars", "20", "--version", "v1", "--json"]);
    assert.equal(queries.at(-1)!.searchParams.get("textOffset"), "50");
    assert.equal(queries.at(-1)!.searchParams.get("version"), "v1");
    const exported = JSON.parse(await execute(["sessions", "export", "s1", "--json"]));
    assert.equal(queries.at(-1)!.searchParams.has("response"), false, "导出始终绕过摘要正文");
    assert.ok(exported.markdown.includes("Synthetic export body ".repeat(1_000)));
  } finally {
    process.stdout.write = originalWrite;
    await new Promise<void>(done => server.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
});

test("收藏和来源变更不回传完整目录，知识版本与失败信息仍能定位", () => {
  const favorite = summarizeResponse("/resources/favorites", "POST", { favoriteIds: ["target", ...Array.from({ length: 1_000 }, (_, i) => `other-${i}`)] }, { id: "target", value: true });
  assert.deepEqual(favorite, { id: "target", favorite: true, favoriteCount: 1_001 });
  const sources = summarizeResponse("/resources/sources", "POST", { observedAt: "now", manualSources: [{ id: "source1", path: "/workspace/example" }, ...Array.from({ length: 1_000 }, (_, i) => ({ id: `other-${i}`, path: `/workspace/${i}` }))], sources: [1, 2], gaps: [] }, { path: "/workspace/example" });
  assert.deepEqual(sources, { observedAt: "now", sourceCount: 2, gapCount: 0, manualSourceCount: 1_001, source: { id: "source1", path: "/workspace/example" } });
  const task = { id: "j", previewId: "p", status: "failed", error: "synthetic failure", results: Array.from({ length: 1_000 }, (_, i) => ({ knowledgeId: `k-${i}`, revisionId: `r-${i}` })), events: [{ id: "e" }], failedSessions: [{ sessionId: "s", error: "synthetic failure" }] };
  const history = summarizeResponse("/knowledge/extractions?page=2&pageSize=1", "GET", { jobs: [task], total: 2, page: 2, pageSize: 1, hasMore: false, usage: { inputTokens: 1 }, automatic: { enabled: false } }) as Record<string, unknown>;
  assert.equal(history.total, 2); assert.equal(history.page, 2); assert.equal(history.hasMore, false);
  assert.equal((history.jobs as Record<string, unknown>[])[0]!.id, "j");
  assert.equal((history.jobs as Record<string, unknown>[])[0]!.resultCount, 1_000);
  assert.equal((history.jobs as Record<string, unknown>[])[0]!.failedSessions, undefined);
  assert.equal((history.jobs as Record<string, unknown>[])[0]!.failedSessionCount, 1);
  assert.ok(JSON.stringify(history).length < 1_000);
});

test("准备失败的可读状态保留原始错误，已有摘要计数不会被二次投影删除", () => {
  const state = { instance: { pid: 42, port: 16666, version: "0.1.0" }, preparation: { state: "failed", error: "synthetic failure" }, repositoryCount: 3, jobCount: 4 };
  assert.deepEqual(summarizeStatus(state), state);
  assert.match(humanOutput(state, "en"), /Error: Original details: synthetic failure/);
  assert.match(humanOutput(state, "zh-CN"), /错误: 原始详情: synthetic failure/);
});


test("生命周期外壳的失败使用同一诊断描述与原文规则", () => {
  const preparation = { state: "failed", error: "Synthetic upstream failure", errorDescriptor: { key: "knowledge.errors.context_required" } };
  const shells = [{ running: true, state: "running", status: { preparation } }, { instance: { pid: 42, port: 16666 }, preparation }];
  for (const shell of shells) {
    assert.match(humanOutput(shell, "zh-CN"), /上下文/);
    assert.match(humanOutput(shell, "zh-CN"), /原始详情: Synthetic upstream failure/);
    assert.match(humanOutput(shell, "en"), /More context is needed/);
  }
  assert.match(humanOutput({ running: true, state: "running", error: "Unknown upstream" }, "zh-CN"), /原始详情: Unknown upstream/);
});
