import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 验收只创建合成历史和独立数据目录，所有命令从安装包外执行。
const root = fileURLToPath(new URL("../", import.meta.url));
const sandbox = await mkdtemp(join(tmpdir(), "manor-cli-cases space-"));
const outside = join(sandbox, "outside"), prefix = join(sandbox, "install"), home = join(sandbox, "data");
const results = [];
const npmCli = process.env.npm_execpath;
assert.ok(npmCli?.endsWith(".js"), "请通过 npm run test:cli:installed 执行");
let cli, instance, environment = { ...process.env, AGENT_MANOR_HOME: home, AGENT_MANOR_PORT: "0", AGENT_MANOR_LANG: "en" };
let generationCalls = 0;
const model = createServer(async (request, response) => {
  let body = ""; for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  generationCalls++;
  assert.ok(Buffer.byteLength(body) < 60_000, "模型输入必须保持有界");
  response.setHeader("Content-Type", "application/json");
  const value = request.url.endsWith("/embeddings")
    ? { data: input.input.map((_, index) => ({ index, embedding: [1, 0, 0] })), usage: { prompt_tokens: 12 } }
    : { choices: [{ message: { content: JSON.stringify({ disposition: "no_value", candidates: [], carry: [], needsMessageIds: [], limitations: [] }) } }], usage: { prompt_tokens: 120, completion_tokens: 20 } };
  response.end(JSON.stringify(value));
});
async function run(executable, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: outside, env: environment, stdio: "pipe", ...options, input: undefined });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`命令超时：${args.join(" ")}`)); }, 90_000);
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); done({ code, stdout, stderr }); });
    child.stdin.end(options.input);
  });
}
async function command(args, { input, error } = {}) {
  const result = await run(process.execPath, [cli, ...args, "--json"], { input });
  if (error) {
    assert.notEqual(result.code, 0, `${args.join(" ")} 应失败`); assert.equal(result.stdout, "");
    const failure = JSON.parse(result.stderr); assert.equal(failure.error.code, error, result.stderr); return failure.error;
  }
  assert.equal(result.code, 0, `${args.join(" ")}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}
async function api(path, method = "GET", body) {
  const response = await fetch(`http://127.0.0.1:${instance.port}/api/v1${path}`, { method, headers: { "x-agent-manor-instance": instance.id, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value;
}
async function step(name, action) { await action(); results.push(name); process.stderr.write(`通过：${name}\n`); }
async function equivalent(args, path) { assert.deepEqual(await command(args), await api(path)); }
try {
  await mkdir(outside, { recursive: true });
  const tarball = resolve(process.argv[2]);
  const installed = await run(process.execPath, [npmCli, "install", "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/", tarball]);
  assert.equal(installed.code, 0, installed.stderr);
  const packageRoot = join(prefix, "node_modules", "agent-manor"); cli = join(packageRoot, "dist/cli.js");
  const { clientIds } = await import(pathToFileURL(join(packageRoot, "dist/clients.js")).href);
  environment = { ...environment, MYFLICKER_HOME: join(sandbox, "absent", "myflicker"), ...Object.fromEntries(clientIds.map(id => [`AGENT_MANOR_${id.toUpperCase().replaceAll("-", "_")}_DIR`, join(sandbox, "history", id)])) };
  const history = environment.AGENT_MANOR_CODEX_DIR; await mkdir(history, { recursive: true });
  const project = join(sandbox, "atlas"); await mkdir(project); await writeFile(join(project, "README.md"), "# Synthetic Atlas\n");
  assert.equal((await run("git", ["init", "-q", project])).code, 0);
  for (const [id, question] of [["synthetic-cache", "Atlas cache invalidation"], ["synthetic-retry", "Atlas retry policy"]]) {
    const payloads = [
      { type: "session_meta", payload: { id, cwd: project } },
      { type: "turn_context", payload: { model: "synthetic-model" } },
      { type: "response_item", payload: { id: `${id}-user`, type: "message", role: "user", content: [{ type: "input_text", text: question }] } },
      { type: "response_item", payload: { id: `${id}-answer`, type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Invalidate cached snapshots after updates; verify the new value. Retry at most twice." }] } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, total_tokens: 130 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, total_tokens: 130 } } } },
    ];
    await writeFile(join(history, `${id}.jsonl`), payloads.map((value, index) => JSON.stringify({ timestamp: `2026-01-01T10:00:0${index}Z`, ...value })).join("\n") + "\n");
  }
  await step("纯状态、帮助、版本、诊断与日志不启动后台", async () => {
    assert.equal((await command(["status"])).running, false);
    await command(["version"]); await command(["doctor"]); await command(["logs"]);
    for (const language of ["en", "zh-CN"]) assert.equal((await run(process.execPath, [cli, "knowledge", "--help", "--lang", language])).code, 0);
    assert.equal((await command(["status"])).running, false);
  });
  await step("后台启动、实际地址与准备等待", async () => { instance = (await command(["start", "--wait-data"])).instance; assert(instance.port > 0); assert.equal((await command(["status"])).running, true); });
  const sessions = await command(["sessions", "list", "--client", "codex"]);
  const session = sessions.sessions?.find(item => item.clientSessionId === "synthetic-cache") ?? sessions.sessions?.[0];
  assert.ok(session?.id, JSON.stringify(sessions));
  const sid = session.id, encoded = encodeURIComponent(sid);
  await step("会话列表、搜索、分组和分页返回真实合成数据", async () => {
    assert.equal(sessions.total, 2);
    await equivalent(["sessions", "list", "--client", "codex", "--page-size", "1"], "/sessions?client=codex&pageSize=1");
    await equivalent(["sessions", "search", "cache", "--client", "codex"], "/sessions/search?q=cache&client=codex");
    await equivalent(["sessions", "groups", "Atlas", "--client", "codex"], "/sessions/search/groups?q=Atlas&client=codex");
    await equivalent(["sessions", "facets"], "/sessions/facets");
    await command(["sessions", "list", "--page", "0"], { error: "INVALID_INPUT" });
  });
  await step("消息、连续轮次、轨迹、画像、费用与来源定位", async () => {
    for (const name of ["messages", "turns", "timeline", "profile", "cost"]) await equivalent(["sessions", name, sid], `/sessions/${encoded}/${name}`);
    const messages = await command(["sessions", "messages", sid, "--page-size", "1"]); assert.equal(messages.messages.length, 1);
    await equivalent(["sessions", "locate", "--client", "codex", "--client-session-id", "synthetic-cache"], "/sessions/locate?client=codex&clientSessionId=synthetic-cache");
  });
  await step("Markdown 导出与空格文件路径", async () => {
    const destination = join(outside, "dialogue export.md");
    const result = await command(["sessions", "export", sid, "--output", destination]);
    const content = await readFile(destination, "utf8"); assert(content.includes("cache invalidation")); assert(content.includes("Invalidate cached snapshots")); assert.equal(result.messages, 2);
  });
  await step("用量、总览与面板复用同一 API 数据", async () => {
    for (const [args, path] of [[["usage", "status"], "/usage/status"], [["usage", "report"], "/usage"], [["usage", "requests", "--session-id", sid], `/usage/requests?sessionId=${encoded}`], [["overview", "snapshot", "--window", "all"], "/overview/snapshot?window=all"], [["overview", "panel", "--window", "all", "--panel", "facets"], "/overview/panel?window=all&panel=facets"], [["overview", "review", "--window", "all"], "/overview/review?window=all"]]) await equivalent(args, path);
  });
  let entry, revision;
  const draft = { title: "Atlas cache procedure", body: "Invalidate snapshots after configuration updates; verify a new read.", type: "procedure", language: "en", tags: ["cache", "atlas"], scope: { kind: "project", project }, subject: "project", sources: [{ kind: "agent", client: "codex", sessionId: sid }] };
  await step("知识 stdin 写入、幂等、待审搜索和正文读取", async () => {
    entry = await command(["knowledge", "write", "--input", "-"], { input: JSON.stringify({ ...draft, idempotencyKey: "synthetic-create" }) });
    assert.equal(entry.revision.review, "pending"); assert.equal(generationCalls, 0);
    assert.equal((await command(["knowledge", "list"])).total, 0);
    const repeat = await command(["knowledge", "write", "--data", JSON.stringify({ ...draft, idempotencyKey: "synthetic-create" })]); assert.equal(repeat.id, entry.id);
    await equivalent(["knowledge", "list", "--review", "pending"], "/knowledge/entries?review=pending");
    assert.equal((await command(["knowledge", "search", "snapshots", "--review", "pending"])).items[0].id, entry.id);
    await equivalent(["knowledge", "get", entry.id, "--review", "all"], `/knowledge/entries/${entry.id}?review=all`);
    await command(["knowledge", "write", "--data", "[]"], { error: "INVALID_INPUT" });
  });
  await step("人工审阅精确授权与拒绝伪确认", async () => {
    const args = ["knowledge", "review", entry.id, entry.latestRevisionId, "approve"];
    const error = await command(args, { error: "CONFIRMATION_REQUIRED" });
    assert.equal(error.details.preview.targetRevision.id, entry.latestRevisionId);
    await command([...args, "--authorize", "yes"], { error: "CONFIRMATION_REQUIRED" });
    const approved = await command([...args, "--authorize", error.details.confirmation]); assert.equal(approved.revision.review, "reviewed");
    assert.equal((await command(["knowledge", "list"])).items[0].id, entry.id);
  });
  await step("知识修订冲突、历史快照与恢复重新待审", async () => {
    revision = await command(["knowledge", "revise", entry.id, "--data", JSON.stringify({ ...draft, body: "Revised cache guidance", baseRevisionId: entry.latestRevisionId })]);
    assert.equal((await command(["knowledge", "get", entry.id])).revision.body, draft.body);
    await command(["knowledge", "revise", entry.id, "--data", JSON.stringify({ ...draft, baseRevisionId: entry.latestRevisionId })], { error: "CONTENT_STALE" });
    assert.equal((await command(["knowledge", "revisions", entry.id])).revisions.length, 2);
    const restored = await command(["knowledge", "restore", entry.id, "--data", JSON.stringify({ revisionId: entry.latestRevisionId, baseRevisionId: revision.latestRevisionId })]); assert.equal(restored.revision.review, "pending"); assert.equal(restored.revision.body, draft.body); revision = restored;
  });
  await step("知识废弃与重新启用均需具体授权", async () => {
    for (const state of ["deprecated", "active"]) {
      const args = ["knowledge", "availability", entry.id, state]; const failure = await command(args, { error: "CONFIRMATION_REQUIRED" });
      assert.equal((await command([...args, "--authorize", failure.details.confirmation])).availability, state);
      assert.equal((await command(["knowledge", "list"])).total, state === "deprecated" ? 0 : 1);
    }
  });
  await step("共享偏好持久化与单次语言覆盖", async () => {
    await command(["preferences", "set", "--data", JSON.stringify({ language: "zh-CN" })]);
    assert.equal((await command(["preferences", "get", "--lang", "en"])).language, "zh-CN");
    await equivalent(["preferences", "get"], "/preferences");
  });
  await new Promise(done => model.listen(0, "127.0.0.1", done));
  await step("模型设置脱敏、凭据按需查看、限定输入抽取和任务历史", async () => {
    const settings = await command(["knowledge", "settings", "get"]);
    Object.assign(settings.config.generation, { url: `http://127.0.0.1:${model.address().port}/v1`, model: "synthetic-small", contextTokens: 8192, outputTokens: 1024, retries: 0, requestsPerMinute: 600, taskInputTokenBudget: 10_000 });
    const saved = await command(["knowledge", "settings", "set", "--data", JSON.stringify({ config: settings.config, generationKey: "synthetic-only-secret" })]);
    assert(!JSON.stringify(saved).includes("synthetic-only-secret"));
    const keyArgs = ["knowledge", "settings", "key", "generation"], challenge = await command(keyArgs, { error: "CONFIRMATION_REQUIRED" });
    assert.equal((await command([...keyArgs, "--authorize", challenge.details.confirmation])).key, "synthetic-only-secret");
    const scope = { ...settings.config.automatic.scope, timeRange: "all", sessionIds: [sid], turnStart: 1, turnEnd: 1 };
    const preview = await command(["knowledge", "extraction", "preview", "--data", JSON.stringify({ scope })]); assert.equal(preview.sessionCount, 1); assert(preview.estimatedTokens < 10_000);
    const job = await command(["knowledge", "extraction", "start", preview.id, "--wait"]); assert.equal(job.status, "complete"); assert.equal(job.createdEntries, 0); assert(job.noValue >= 1); assert.equal(job.completedChunks, job.totalChunks); assert(generationCalls > 0);
    assert((await command(["knowledge", "extraction", "list"])).jobs.some(item => item.id === job.id));
    await equivalent(["knowledge", "extraction", "get", job.id], `/knowledge/extractions/${job.id}`);
  });
  await step("仓库登记、覆盖与回放数据、删除登记保留原始文件", async () => {
    const registered = await command(["repositories", "register", project, "--wait"]), id = registered.repository.id;
    for (const name of ["coverage", "sources", "hotspots", "unobserved"]) await equivalent([name, id], `/repositories/${id}/${name}`);
    await equivalent(["repositories", "gaps", id], `/repositories/${id}/coverage/gaps`);
    await equivalent(["repositories", "replay-sessions", id], `/repositories/${id}/replay/sessions`);
    await command(["repositories", "remove", id]); assert.equal(await readFile(join(project, "README.md"), "utf8"), "# Synthetic Atlas\n");
  });
  await step("资源查询、语义状态与关闭模式不隐式调用模型", async () => {
    const before = generationCalls;
    for (const [args, path] of [[["resources", "status"], "/resources/status"], [["resources", "map"], "/resources/map"], [["semantic", "status"], "/semantic/status"], [["knowledge", "index", "status"], "/knowledge/index/status"]]) await equivalent(args, path);
    assert.equal(generationCalls, before);
  });
  await step("停止等待、重启后知识与偏好仍在，日志无凭据正文", async () => {
    assert.equal((await command(["stop", "--wait"])).stopped, true);
    assert.equal((await command(["status"])).running, false);
    instance = (await command(["start", "--wait-data"])).instance;
    assert.equal((await command(["preferences", "get"])).language, "zh-CN");
    assert.equal((await command(["knowledge", "revision", entry.id, entry.latestRevisionId])).body, draft.body);
    const log = await command(["logs"]); assert(!log.text.includes("synthetic-only-secret")); assert(!log.text.includes(draft.body));
  });
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, checks: results.length, generationRequests: generationCalls, cases: results }, null, 2));
} finally {
  if (cli) await run(process.execPath, [cli, "stop", "--wait", "--json"]).catch(() => undefined);
  model.closeAllConnections(); await new Promise(done => model.close(done));
  await rm(sandbox, { recursive: true, force: true });
}
