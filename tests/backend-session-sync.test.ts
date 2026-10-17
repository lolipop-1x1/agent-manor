import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { SessionIndexSummary, SessionJob, SessionListResult, SessionMessageResult } from "../src/session-contracts.js";
import type { SemanticPreview, SemanticSettings, SemanticStatus } from "../src/semantic-contracts.js";
import { startService } from "../src/server.js";
import { apiRequest, delay } from "../src/service/runtime.js";
import { updatePreferences } from "../src/service/preferences.js";
import { historyManualJobOutcome, historyManualJobToRead } from "../web/shared/refresh/history-refresh.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

type Service = Awaited<ReturnType<typeof startService>>;
const encode = (value: unknown) => JSON.stringify(value) + "\n";
const source = (id: string, text = "检查连接超时并限制重试次数。") => encode({ type: "session_meta", payload: { id, cwd: "/workspace/example" } })
  + encode({ type: "response_item", payload: { type: "message", id: `${id}-message`, role: "user", content: [{ type: "input_text", text }] } });
const summary = (service: Service) => apiRequest<SessionIndexSummary>(service.instance, "/sessions/status?summary=true");
// Worker 写完终态与主线程处理完成通知之间有窗口；须等待周期基准也完成结算。
const successSettled = (status: SessionIndexSummary) => status.autoSync?.state === "waiting" && !!status.autoSync.lastSuccessAt && !!status.autoSync.nextRunAt;

function jobs(home: string): SessionJob[] {
  const database = new Database(join(home, "index.sqlite"), { readonly: true });
  try { return (database.prepare("SELECT json FROM session_jobs ORDER BY rowid").all() as { json: string }[]).map(row => JSON.parse(row.json) as SessionJob); }
  finally { database.close(); }
}

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!matches(value) && Date.now() < deadline) { await delay(20); value = await read(); }
  assert.ok(matches(value), `后台同步未达到预期状态：${JSON.stringify(value)}`);
  return value;
}

async function fixture(run: (context: { service: Service; home: string; history: string }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-backend-sync-"));
  const home = join(directory, "data"), history = join(directory, "history");
  await mkdir(history); await writeFile(join(history, "first.jsonl"), source("first"));
  const service = await startService({ home, roots: isolatedHistoryRoots({ codex: history }), startupRefresh: false,
    resourceInventory: { userHome: join(directory, "isolated"), environment: {} } });
  try { await run({ service, home, history }); }
  finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
}

test("后台无页面连接也按完成时间同步；多读者与旧 POST 不创建扫描", async () => fixture(async ({ service, home, history }) => {
  await assert.rejects(apiRequest(service.instance, "/sessions/auto-refresh", "POST", { client: "codex" }), { code: "INVALID_INPUT" });
  assert.deepEqual(await apiRequest(service.instance, "/sessions/auto-refresh", "POST", {}), {});
  assert.equal(jobs(home).length, 0);
  await apiRequest(service.instance, "/preferences", "PUT", { sessionsAutoRefreshInterval: 5_000 });
  const first = await until(() => summary(service), status => successSettled(status) && status.sessionCount === 1);
  assert.equal(jobs(home).length, 1); assert.ok(first.autoSync?.lastSuccessAt);
  assert.equal(Date.parse(first.autoSync!.nextRunAt!) - Date.parse(first.autoSync!.lastSuccessAt!), 5_000);
  await Promise.all(Array.from({ length: 12 }, (_, i) => i % 2 ? summary(service) : apiRequest(service.instance, "/sessions/auto-refresh", "POST", {})));
  assert.equal(jobs(home).length, 1);
  await writeFile(join(history, "second.jsonl"), source("second", "增加第二份合成历史。"));
  // 这段时间不发送 HTTP 请求，后台必须自己扫描并发布新版本。
  await delay(5_100);
  const second = await until(() => summary(service), status => successSettled(status) && status.sessionCount === 2 && status.autoSync!.lastSuccessAt !== first.autoSync!.lastSuccessAt);
  assert.notEqual(second.version, first.version); assert.equal(jobs(home).length, 2);
  const list = await apiRequest<SessionListResult>(service.instance, "/sessions");
  assert.equal(list.version, second.version); assert.equal(list.total, 2);
  const unchanged = await until(() => summary(service), status => jobs(home).length === 3 && successSettled(status) && status.autoSync!.lastSuccessAt !== second.autoSync!.lastSuccessAt, 7_000);
  assert.equal(unchanged.version, second.version, "无变化检查沿用已发布版本");
  assert.notEqual(unchanged.autoSync?.lastSuccessAt, second.autoSync?.lastSuccessAt);
  await apiRequest(service.instance, "/preferences", "PUT", { sessionsAutoRefreshInterval: 0 });
  await delay(100);
  assert.equal(jobs(home).length, 3); assert.equal((await summary(service)).autoSync?.state, "disabled");
}));

test("保存新间隔立即重算截止时间，相同保存与并发局部偏好不触发扫描", async () => fixture(async ({ service, home }) => {
  await apiRequest(service.instance, "/preferences", "PUT", { sessionsAutoRefreshInterval: 60_000 });
  const first = await until(() => summary(service), successSettled);
  await delay(5_050);
  const before = jobs(home).length;
  await Promise.all([
    apiRequest(service.instance, "/preferences", "PUT", { mapAutoRefreshInterval: 300_000 }),
    apiRequest(service.instance, "/preferences", "PUT", { language: "en" }),
    apiRequest(service.instance, "/preferences", "PUT", { sessionsAutoRefreshInterval: 60_000 }),
  ]);
  assert.equal(jobs(home).length, before);
  const unchanged = await summary(service);
  assert.equal(unchanged.autoSync?.nextRunAt, first.autoSync?.nextRunAt);
  await apiRequest(service.instance, "/preferences", "PUT", { sessionsAutoRefreshInterval: 5_000 });
  await until(() => summary(service), value => jobs(home).length === before + 1 && successSettled(value) && value.autoSync!.lastSuccessAt !== first.autoSync!.lastSuccessAt);
  const preferences = await apiRequest<{ language: string; sessionsAutoRefreshInterval: number; mapAutoRefreshInterval: number }>(service.instance, "/preferences");
  assert.deepEqual(preferences, { language: "en", sessionsAutoRefreshInterval: 5_000, mapAutoRefreshInterval: 300_000 });
  await apiRequest(service.instance, "/preferences", "PUT", { mapAutoRefreshInterval: 0 });
  assert.equal((await summary(service)).autoSync?.intervalMs, 5_000);
}));

test("已有局部检查不能吞掉全局后台同步，局部检查也不重置全局周期", async () => fixture(async ({ service, home, history }) => {
  const local = await apiRequest<{ job: SessionJob }>(service.instance, "/sessions/refresh", "POST", { client: "claude" });
  assert.equal(local.job.client, "claude");
  await apiRequest(service.instance, "/preferences", "PUT", { sessionsAutoRefreshInterval: 5_000 });
  const global = await until(() => summary(service), value => value.sessionCount === 1 && successSettled(value));
  assert.equal(jobs(home).length, 2); assert.equal(jobs(home)[1]!.client, undefined);
  assert.equal(global.clientChecks?.find(check => check.client === "codex")?.mode, "quick");
  await delay(1_000);
  const extra = await apiRequest<{ job: SessionJob }>(service.instance, "/sessions/refresh", "POST", { client: "codex" });
  await until(() => summary(service), value => value.job?.id === extra.job.id && value.job.status === "complete");
  assert.equal((await summary(service)).autoSync?.nextRunAt, global.autoSync?.nextRunAt);
  await writeFile(join(history, "new.jsonl"), source("new", "全局同步应继续按原周期执行。"));
  await until(() => summary(service), value => value.sessionCount === 2 && successSettled(value) && value.autoSync!.lastSuccessAt !== global.autoSync!.lastSuccessAt);
  assert.equal(jobs(home).length, 4);
}));

test("真实 Worker 整项失败保留上一版，后台退避且手动成功可立即恢复周期", async () => fixture(async ({ service, home, history }) => {
  await apiRequest(service.instance, "/preferences", "PUT", { sessionsAutoRefreshInterval: 5_000 });
  const initial = await until(() => summary(service), successSettled);
  const database = new Database(join(home, "index.sqlite"));
  try {
    database.exec("CREATE TRIGGER synthetic_publication_failure BEFORE INSERT ON session_versions BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END");
    await writeFile(join(history, "new.jsonl"), source("new", "本轮故障不能覆盖旧历史。"));
    const failed = await until(() => summary(service), value => value.autoSync?.state === "backoff");
    assert.equal(failed.version, initial.version); assert.equal(failed.sessionCount, 1);
    const retained = await apiRequest<SessionListResult>(service.instance, `/sessions?version=${initial.version}`);
    const messages = await apiRequest<SessionMessageResult>(service.instance, `/sessions/${encodeURIComponent(retained.sessions[0]!.id)}/messages?version=${initial.version}&mode=full`);
    assert.ok(messages.messages.some(message => message.text === "检查连接超时并限制重试次数。"));
    assert.equal(failed.autoSync?.consecutiveFailures, 1); assert.match(failed.autoSync?.error ?? "", /synthetic publication failure/);
    assert.equal(Date.parse(failed.autoSync!.nextRunAt!) - Date.parse(jobs(home).at(-1)!.finishedAt!), 30_000);
    await delay(100); assert.equal(jobs(home).length, 2);
    database.exec("DROP TRIGGER synthetic_publication_failure");
    const manual = await apiRequest<{ job: SessionJob }>(service.instance, "/sessions/refresh", "POST", {});
    const recovered = await until(() => summary(service), value => successSettled(value) && value.sessionCount === 2 && value.autoSync!.lastSuccessAt !== initial.autoSync!.lastSuccessAt);
    assert.equal(recovered.job?.id, manual.job.id); assert.equal(recovered.autoSync?.consecutiveFailures, 0);
    assert.equal(recovered.autoSync?.error, undefined); assert.notEqual(recovered.version, initial.version);
    assert.equal(Date.parse(recovered.autoSync!.nextRunAt!) - Date.parse(recovered.autoSync!.lastSuccessAt!), 5_000);
  } finally { database.exec("DROP TRIGGER IF EXISTS synthetic_publication_failure"); database.close(); }
}));

test("后台重启沿用已保存开关并复用启动检查，停止后不再检查或重放旧队列", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-backend-sync-restart-"));
  const home = join(directory, "data"), history = join(directory, "history");
  await mkdir(history); await writeFile(join(history, "first.jsonl"), source("restart-first"));
  await updatePreferences(home, { sessionsAutoRefreshInterval: 5_000, mapAutoRefreshInterval: 300_000 });
  const options = { home, roots: isolatedHistoryRoots({ codex: history }),
    resourceInventory: { userHome: join(directory, "isolated"), environment: {} } };
  let service = await startService(options);
  try {
    const first = await until(() => summary(service), successSettled);
    assert.equal(first.sessionCount, 1); assert.equal(jobs(home).length, 1);
    await service.close();
    await writeFile(join(history, "second.jsonl"), source("restart-second", "服务停止期间新增的数据。"));
    await delay(100); assert.equal(jobs(home).length, 1);
    const database = new Database(join(home, "index.sqlite"));
    const interrupted: SessionJob = { id: "synthetic-interrupted", status: "queued", phase: "queued", progress: 0, createdAt: new Date().toISOString(), client: "claude", mode: "full" };
    database.prepare("INSERT INTO session_jobs(id,created_at,json) VALUES(?,?,?)").run(interrupted.id, interrupted.createdAt, JSON.stringify(interrupted));
    database.close();
    service = await startService(options);
    const restarted = await until(() => summary(service), value => successSettled(value) && value.sessionCount === 2 && value.autoSync!.lastSuccessAt !== first.autoSync!.lastSuccessAt);
    assert.notEqual(restarted.version, first.version); assert.equal(jobs(home).length, 3);
    assert.equal(jobs(home).find(job => job.id === interrupted.id)?.status, "failed");
    assert.equal(jobs(home).filter(job => job.status === "complete").length, 2);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("自动历史发布驱动既有语义维护，重复正文复用且无变化检查不编码", async () => fixture(async ({ service, history }) => {
  const calls: string[][] = [];
  const embedding = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[] };
    calls.push(body.input); response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0.5, 0.25] })), usage: { prompt_tokens: 12 } }));
  });
  await new Promise<void>(resolve => embedding.listen(0, "127.0.0.1", resolve));
  const address = embedding.address(); assert.ok(address && typeof address !== "string");
  try {
    await apiRequest(service.instance, "/preferences", "PUT", { sessionsAutoRefreshInterval: 5_000 });
    await until(() => summary(service), successSettled);
    const settings = await apiRequest<SemanticSettings>(service.instance, "/semantic/settings");
    Object.assign(settings.config.connection, { url: `http://127.0.0.1:${address.port}/v1`, model: "synthetic-embedding", dimensions: 3 });
    settings.config.scope.timeRange = "all"; settings.config.strategy.quietMinutes = 0; settings.config.strategy.maxDelayMinutes = 0;
    await apiRequest(service.instance, "/semantic/settings", "PUT", { config: settings.config });
    const preview = await apiRequest<SemanticPreview>(service.instance, "/semantic/preview", "POST", {});
    await apiRequest(service.instance, "/semantic/build", "POST", { previewId: preview.id });
    const built = await until(() => apiRequest<SemanticStatus>(service.instance, "/semantic/status"), value => value.job?.status === "complete");
    assert.equal(built.uniqueVectors, 1); assert.equal(calls.length, 1);
    await until(() => summary(service), successSettled);
    await delay(5_100);
    assert.equal(calls.length, 1, "无变化的历史检查不产生语义模型调用");
    await writeFile(join(history, "copy.jsonl"), source("copied-first"));
    await writeFile(join(history, "new.jsonl"), source("new-content", "如何验证自动发布会触发新的语义增量？"));
    const published = await until(() => summary(service), value => value.sessionCount === 3 && successSettled(value));
    const maintained = await until(() => apiRequest<SemanticStatus>(service.instance, "/semantic/status"), value => value.sourceVersion === published.version && value.job?.status === "complete", 15_000);
    assert.equal(maintained.indexedSessions, 3); assert.equal(maintained.uniqueVectors, 2);
    assert.equal(calls.length, 2); assert.equal(calls[1]!.length, 1);
    assert.match(calls[1]![0]!, /如何验证自动发布/);
    await apiRequest(service.instance, "/preferences", "PUT", { sessionsAutoRefreshInterval: 0 });
    assert.equal((await apiRequest<SemanticStatus>(service.instance, "/semantic/status")).enabled, true);
  } finally { embedding.closeAllConnections(); await new Promise<void>(resolve => embedding.close(() => resolve())); }
}));

test("坏偏好不阻止后台与手动检查，自动策略保持关闭且原错误和原文件可见", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-sync-invalid-preferences-"));
  const original = "{invalid synthetic preference}";
  await writeFile(join(directory, "preferences.json"), original);
  const service = await startService({ home: directory, roots: isolatedHistoryRoots(), startupRefresh: false,
    resourceInventory: { userHome: join(directory, "isolated"), environment: {} } });
  try {
    const initial = await summary(service);
    assert.equal(initial.autoSync?.state, "disabled"); assert.equal(initial.autoSync?.intervalMs, 0);
    assert.equal(jobs(directory).length, 0);
    await assert.rejects(apiRequest(service.instance, "/preferences"), { code: "INTERNAL_ERROR" });
    assert.equal(await readFile(join(directory, "preferences.json"), "utf8"), original);
    const manual = await apiRequest<{ job: SessionJob }>(service.instance, "/sessions/refresh", "POST", {});
    const completed = await until(() => apiRequest<{ job: SessionJob }>(service.instance, `/jobs/${manual.job.id}`), value => value.job.status === "complete");
    assert.equal(completed.job.mode, "quick"); assert.equal(completed.job.client, undefined);
    assert.equal((await summary(service)).autoSync?.state, "disabled");
    assert.equal(await readFile(join(directory, "preferences.json"), "utf8"), original);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("无变化手动任务的终态可按身份补读，后继任务摘要不会吞掉主动重读", async () => fixture(async ({ service }) => {
  const run = () => apiRequest<{ job: SessionJob }>(service.instance, "/sessions/refresh", "POST", {});
  const read = (id: string) => apiRequest<{ job: SessionJob }>(service.instance, `/jobs/${encodeURIComponent(id)}`);
  const initial = await run();
  const first = await until(() => read(initial.job.id), value => value.job.status === "complete");
  const manual = await run();
  const completed = await until(() => read(manual.job.id), value => value.job.status === "complete");
  assert.equal(completed.job.version, first.job.version, "手动检查没有发布新版本");
  const successor = await run();
  assert.notEqual(successor.job.id, manual.job.id);
  await until(() => read(successor.job.id), value => value.job.status === "complete");
  const snapshot = await summary(service);
  assert.equal(snapshot.job?.id, successor.job.id); assert.equal(snapshot.version, first.job.version);
  const pendingId = historyManualJobToRead(manual.job.id, snapshot.job);
  assert.equal(pendingId, manual.job.id);
  const confirmation = await read(pendingId!);
  assert.equal(historyManualJobOutcome(pendingId, confirmation.job), "complete");
  assert.equal(historyManualJobOutcome(undefined, confirmation.job), undefined, "独立结算后不再次通知");
  assert.equal((await summary(service)).job?.id, successor.job.id, "补读是只读操作，不改写后继摘要");
}));
