import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProgram } from "../src/program.js";
import { managementConfirmation } from "../src/api/management.js";
import { managementDigest } from "../../../src/service/management.js";
import { VERSION } from "../../../src/version.js";
import type { ServiceInstance } from "../../../src/contracts.js";
import { timeoutMilliseconds } from "../src/api/tasks.js";
import { readJsonInput } from "../src/api/input.js";

const commands: [string[], string, string?][] = [
  [["sessions", "list", "--q", "sample", "--page-size", "2"], "/sessions"],
  [["sessions", "messages", "session:one", "--page-unit", "turn", "--turn-position", "2", "--message-limit", "3", "--max-text-chars", "100"], "/sessions/session%3Aone/messages"],
  [["sessions", "profile", "session:one", "--summary", "true", "--step-limit", "2", "--step-offset", "0"], "/sessions/session%3Aone/profile"],
  [["coverage", "repo:one", "--query", '{"sessionClient":"codex","clientSessionId":"one"}'], "/repositories/repo%3Aone/coverage"],
  [["resources", "detail", "resource:one", "--view", "overview", "--query", '{"section":"locations"}'], "/resources/overview/resource%3Aone"],
  [["overview", "snapshot", "--window", "7"], "/overview/snapshot"],
  [["overview", "panel", "--panel", "activity"], "/overview/panel"],
  [["overview", "review"], "/overview/review"], [["overview", "review-detail", "--detail", '{"kind":"sessions"}'], "/overview/review/detail"],
  [["overview", "detail", "--detail", '{"view":"resources"}'], "/overview/detail"], [["overview", "report"], "/overview/report"],
  [["overview", "evidence", "--evidence", '{"kind":"sessions"}'], "/overview/evidence"],
  [["sessions", "facets"], "/sessions/facets"], [["sessions", "gaps"], "/sessions/gaps"],
  [["sessions", "groups", "words", "--client", "codex"], "/sessions/search/groups"],
  [["sessions", "turns", "session:one", "--page-unit", "turn"], "/sessions/session%3Aone/turns"],
  [["sessions", "matches", "session:one", "--q", "words"], "/sessions/session%3Aone/matches"],
  [["sessions", "timeline", "session:one", "--max-events", "100"], "/sessions/session%3Aone/timeline"],
  [["sessions", "cost", "session:one"], "/sessions/session%3Aone/cost"],
  [["sessions", "locate", "--client", "codex", "--client-session-id", "one"], "/sessions/locate"],
  [["sessions", "auto-refresh"], "/sessions/auto-refresh", "POST"],
  [["repositories", "remove", "repo:one"], "/repositories/repo%3Aone", "DELETE"],
  [["repositories", "sessions", "repo:one"], "/repositories/repo%3Aone/sessions"],
  [["repositories", "gaps", "repo:one"], "/repositories/repo%3Aone/coverage/gaps"],
  [["repositories", "replay-sessions", "repo:one"], "/repositories/repo%3Aone/replay/sessions"],
  [["repositories", "replay", "repo:one", "--session-id", "one"], "/repositories/repo%3Aone/replay"],
  [["repositories", "replay-evidence", "repo:one", "--event-id", "event:one", "--session-id", "one", "--version", "v1", "--session-version", "s1"], "/repositories/repo%3Aone/replay/evidence/event%3Aone"],
  [["repositories", "auto-refresh", "repo:one"], "/repositories/repo%3Aone/auto-refresh", "POST"],
  [["usage", "report", "--clients", '["codex"]', "--group-by", "model"], "/usage"],
  [["usage", "status"], "/usage/status"], [["usage", "requests", "--session-id", "one", "--request-page", "2"], "/usage/requests"],
  [["usage", "pricing", "get"], "/usage/pricing"], [["usage", "pricing", "refresh"], "/usage/pricing/refresh", "POST"],
  [["usage", "pricing", "set", "--data", '{"overrides":[],"mappings":[]}'], "/usage/pricing", "PUT"],
  [["resources", "map", "--kind", "skill"], "/resources/map"],
  [["preferences", "get"], "/preferences"], [["preferences", "set", "--data", '{"language":"en"}'], "/preferences", "PUT"],
  [["knowledge", "list", "--review", "pending", "--tag", "sample"], "/knowledge/entries"],
  [["knowledge", "search", "words", "--mode", "keyword", "--page", "2"], "/knowledge/search", "POST"],
  [["knowledge", "facets"], "/knowledge/facets"], [["knowledge", "get", "knowledge:one", "--review", "all"], "/knowledge/entries/knowledge%3Aone"],
  [["knowledge", "write", "--data", '{"title":"sample"}'], "/knowledge/entries", "POST"],
  [["knowledge", "revise", "knowledge:one", "--data", '{"baseRevisionId":"r1"}'], "/knowledge/entries/knowledge%3Aone/revisions", "POST"],
  [["knowledge", "restore", "knowledge:one", "--data", '{"revisionId":"r1","baseRevisionId":"r2"}'], "/knowledge/entries/knowledge%3Aone/restore", "POST"],
  [["knowledge", "revisions", "knowledge:one"], "/knowledge/entries/knowledge%3Aone/revisions"],
  [["knowledge", "revision", "knowledge:one", "r1"], "/knowledge/entries/knowledge%3Aone/revisions/r1"],
  [["knowledge", "settings", "get"], "/knowledge/settings"], [["knowledge", "settings", "defaults"], "/knowledge/settings/defaults"],
  [["knowledge", "settings", "set", "--data", '{"config":{}}'], "/knowledge/settings", "PUT"],
  [["knowledge", "settings", "test"], "/knowledge/test", "POST"],
  [["knowledge", "settings", "try", "--data", '{"scope":{}}'], "/knowledge/prompts/try", "POST"],
  [["knowledge", "extraction", "preview", "--data", '{"scope":{"sessionIds":["one"]}}'], "/knowledge/extractions/preview", "POST"],
  [["knowledge", "extraction", "preview-get", "p1"], "/knowledge/extractions/previews/p1"],
  [["knowledge", "extraction", "start", "p1"], "/knowledge/extractions", "POST"],
  [["knowledge", "extraction", "list"], "/knowledge/extractions"], [["knowledge", "extraction", "get", "j1"], "/knowledge/extractions/j1"],
  [["knowledge", "extraction", "pause", "j1"], "/knowledge/extractions/j1/pause", "POST"],
  [["knowledge", "extraction", "resume", "j1"], "/knowledge/extractions/j1/resume", "POST"],
  [["knowledge", "extraction", "retry", "j1"], "/knowledge/extractions/j1/retry", "POST"],
  [["knowledge", "index", "status"], "/knowledge/index/status"], [["knowledge", "index", "preview"], "/knowledge/index/preview", "POST"],
  [["knowledge", "index", "build", "p1"], "/knowledge/index/build", "POST"],
  [["knowledge", "index", "pause"], "/knowledge/index/pause", "POST"], [["knowledge", "index", "resume"], "/knowledge/index/resume", "POST"],
  [["semantic", "facets"], "/semantic/facets"], [["semantic", "status"], "/semantic/status"],
  [["semantic", "settings", "get"], "/semantic/settings"], [["semantic", "settings", "set", "--data", '{"config":{}}'], "/semantic/settings", "PUT"],
  [["semantic", "test"], "/semantic/test", "POST"], [["semantic", "preview", "--data", '{"scope":{}}'], "/semantic/preview", "POST"],
  [["semantic", "search", "--data", '{"q":"words","scope":{}}'], "/semantic/search", "POST"],
  [["semantic", "build", "p1"], "/semantic/build", "POST"], [["semantic", "pause"], "/semantic/action", "POST"], [["semantic", "resume"], "/semantic/action", "POST"],
];

test("全部新增业务命令路由、HTTP方法、查询和JSON结果均保持后台契约", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-command-matrix-"));
  let instance: ServiceInstance;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname === "/api/v1/status") { response.end(JSON.stringify({ instance, version: VERSION, protocolVersion: 1 })); return; }
    const buffers: Buffer[] = []; for await (const chunk of request) buffers.push(chunk);
    const body = buffers.length ? JSON.parse(Buffer.concat(buffers).toString()) : undefined;
    response.end(JSON.stringify({ path: url.pathname.replace("/api/v1", ""), method: request.method, query: Object.fromEntries(url.searchParams), body }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  instance = { id: "synthetic-command-service-identity", pid: process.pid, host: "127.0.0.1", port: address.port, startedAt: new Date().toISOString(), version: VERSION, protocolVersion: 1 };
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, "service.json"), JSON.stringify(instance));
  const oldWrite = process.stdout.write; let output = "";
  process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    for (const [args, path, method = "GET"] of commands) {
      output = "";
      await createProgram("en").parseAsync(["--home", directory, "--json", "--full", ...args], { from: "user" });
      const result = JSON.parse(output);
      assert.equal(result.path, path, args.join(" ")); assert.equal(result.method, method, args.join(" "));
      assert.doesNotMatch(output, /Translation unavailable/);
      if (args[0] === "sessions" && args[1] === "messages") { assert.equal(result.query.messageLimit, "3"); assert.equal(result.query.turnPosition, "2"); assert.equal(result.query.maxTextChars, "100"); }
      if (args[0] === "sessions" && args[1] === "profile") { assert.equal(result.query.stepLimit, "2"); assert.equal(result.query.summary, "true"); assert.equal(result.query.stepOffset, "0"); }
      if (args[0] === "coverage") assert.equal(result.query.clientSessionId, "one");
      if (args[0] === "knowledge" && args[1] === "search") { assert.equal(result.body.q, "words"); assert.equal(result.body.page, 2); }
      if (args[0] === "usage" && args[1] === "report") assert.deepEqual(JSON.parse(result.query.clients), ["codex"]);
    }
  } finally { process.stdout.write = oldWrite; await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); }
});

test("全部层级中英文帮助完整，旧命令和新命令保持可发现", () => {
  for (const language of ["en", "zh-CN"] as const) {
    const root = createProgram(language);
    function visit(command: ReturnType<typeof createProgram>): void {
      assert.doesNotMatch(command.helpInformation(), /Translation unavailable|翻译暂不可用|cli\.ext\./);
      for (const child of command.commands) visit(child);
    }
    visit(root);
    for (const name of ["coverage", "register", "sessions", "resources", "knowledge", "overview", "usage", "semantic", "start", "skills"]) assert.ok(root.commands.find(item => item.name() === name));
  }
});

test("管理确认摘要与后台完全一致，内容或修订变化必须重新授权", () => {
  const operation = { method: "POST", path: "/knowledge/entries/one/reviews", body: { revisionId: "r1", action: "approve" } };
  assert.equal(managementConfirmation(operation.method, operation.path, operation.body), managementDigest(operation));
  assert.notEqual(managementConfirmation(operation.method, operation.path, { ...operation.body, revisionId: "r2" }), managementDigest(operation));
  assert.equal(managementConfirmation("GET", "/semantic/key"), managementDigest({ method: "GET", path: "/semantic/key" }));
});

test("输入对象与等待时间在发起请求前校验", async () => {
  const command = createProgram().command("sample").option("--data <json>").option("--input <path>");
  command.parse(["--data", "[]"], { from: "user" });
  await assert.rejects(readJsonInput(command), { code: "INVALID_INPUT" });
  const directory = await mkdtemp(join(tmpdir(), "manor-cli-input-"));
  try {
    const file = join(directory, "knowledge with spaces.json"); await writeFile(file, '{"title":"合成知识"}');
    const input = createProgram().command("sample").option("--input <path>"); input.parse(["--input", file], { from: "user" });
    assert.deepEqual(await readJsonInput(input), { title: "合成知识" });
  } finally { await rm(directory, { recursive: true, force: true }); }
  for (const value of ["0", "-1", "Infinity", "invalid", "3601"]) assert.throws(() => timeoutMilliseconds(value), { code: "INVALID_INPUT" });
  assert.equal(timeoutMilliseconds("0.1"), 100);
});
