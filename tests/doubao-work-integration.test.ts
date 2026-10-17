import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import Database from "better-sqlite3";
import { clientIds, clientName, CLIENTS } from "../src/clients.js";
import { discoverSources } from "../src/history/index.js";
import { doubaoWorkAdapter } from "../src/history/adapters/doubao-work.js";
import { parseSessionSource } from "../src/sessions/parser.js";
import { SessionStore } from "../src/sessions/store.js";
import { startService } from "../src/server.js";
import { delay } from "../src/service/runtime.js";
import { createDoubaoWorkScenario } from "./helpers/doubao-work-scenario.js";
import { isolatedHistoryEnvironment } from "./helpers/history-roots.js";

const run = promisify(execFile);

test("豆包停用升级原子排除旧索引和旧版本，HTTP、CLI、全局刷新及统计不再导入或展示", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-paused-doubao-")));
  const fixture = await createDoubaoWorkScenario(directory);
  const supportedRoot = join(directory, "supported"); await mkdir(supportedRoot);
  const supportedPath = join(supportedRoot, "supported.jsonl");
  await writeFile(supportedPath, [
    { type: "session_meta", payload: { id: "synthetic-supported", cwd: fixture.project } },
    { type: "response_item", timestamp: "2026-10-16T00:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "SupportedFixtureNeedle" }] } },
    { type: "response_item", timestamp: "2026-10-16T00:00:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic supported answer" }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const roots = { ...fixture.roots, codex: [supportedRoot] };
  let store = new SessionStore(join(fixture.home, "index.sqlite"));
  const oldVersions: string[] = [];
  let supportedId = "", pausedId = "", oldRevisionCount = 0;
  try {
    assert.equal(clientIds.includes("doubao-work"), false);
    assert.equal(CLIENTS.some(client => client.id === "doubao-work"), false);
    assert.equal(clientName("doubao-work"), "Doubao Work", "旧身份和研究代码仍保留");
    assert.deepEqual((await discoverSources(roots)).map(source => source.client), ["codex"]);
    const native = (await doubaoWorkAdapter.discoverFile!({ client: "doubao-work", path: fixture.current }))[0]!;
    const sources = [native, { client: "codex" as const, path: supportedPath, format: "codex-jsonl" }];
    const revisions = [];
    for (const source of sources) {
      const pending = store.createRevision(source.path, "synthetic-legacy");
      const meta = await parseSessionSource(source, pending.sink);
      if (source.client === "codex") {
        supportedId = meta.id;
        pending.sink.usage({ id: "synthetic-supported-request", model: "synthetic-model", inputTokens: 12, outputTokens: 4, occurredAt: "2026-10-16T00:00:01Z" });
      } else pausedId = meta.id;
      pending.flush(); store.finishRevision(pending.revision, meta);
      revisions.push({ path: source.path, revision: pending.revision, fingerprint: "synthetic-legacy" });
    }
    const gap = { kind: "unsupported_format" as const, message: "Synthetic paused gap", sourceId: native.sourceId };
    oldVersions.push(store.publish(store.createJob().id, revisions, [gap]));
    oldVersions.push(store.publish(store.createJob().id, revisions, [gap, { kind: "ambiguous", message: "Synthetic active gap", sourceId: "codex:synthetic-supported" }]));
    assert.equal(store.list().total, 2, "模拟停用前已发布的索引");
    const pausedJob = store.status().job!;
    store.updateJob(pausedJob.id, { client: "doubao-work" });
    const before = store.profile(supportedId); oldRevisionCount = revisions.length;
    store.close(); store = new SessionStore(join(fixture.home, "index.sqlite"));
    assert.ok(!oldVersions.includes(store.currentVersion()!));
    assert.equal(store.status().previousVersion, undefined);
    assert.deepEqual(store.status().clients, ["codex"]);
    assert.notEqual(store.status().job?.id, pausedJob.id, "历史豆包专项同步不再显示为当前任务");
    assert.equal(store.status().sessionCount, 1); assert.equal(store.status().sourceCount, 1);
    assert.ok(store.indexGaps().gaps.every(gap => !gap.sourceId?.startsWith("doubao-work:")));
    assert.equal(store.list().total, 1); assert.equal(store.search({ q: fixture.needle }).total, 0);
    assert.throws(() => store.messages(pausedId), /不存在/);
    for (const version of oldVersions) assert.throws(() => store.list({ version }), /版本不存在/);
    assert.deepEqual(store.profile(supportedId).usage, before.usage);
    assert.equal(store.profile(supportedId).messageCount, before.messageCount);
    assert.ok(store.usageFactSessions().sessions.every(row => row.session.client !== "doubao-work"));
    assert.ok(store.overviewSource().sessions.every(row => row.client !== "doubao-work"));
    const database = new Database(join(fixture.home, "index.sqlite"), { readonly: true });
    try { assert.equal((database.prepare("SELECT COUNT(*) AS count FROM session_revisions").get() as { count: number }).count, oldRevisionCount); }
    finally { database.close(); }
    const version = store.currentVersion(); store.close(); store = new SessionStore(join(fixture.home, "index.sqlite"));
    assert.equal(store.currentVersion(), version, "重复启动不重复发布");
    store.close();
    const sourceBefore = await readFile(fixture.current);
    const service = await startService({ home: fixture.home, roots, startupRefresh: false,
      resourceInventory: { userHome: fixture.userHome, environment: {} }, usagePricing: { fetch: (async () => { throw new Error("synthetic offline pricing"); }) as typeof fetch } });
    try {
      const api = async (url: string, method: "GET" | "POST" = "GET", payload?: object) => service.app.inject({ method, url: `/api/v1${url}`, payload, headers: { host: `127.0.0.1:${service.instance.port}`, "x-agent-manor-instance": service.instance.id } });
      for (const url of ["/sessions?client=doubao-work", "/sessions/search?client=doubao-work&q=fixture", "/usage?clients=%5B%22doubao-work%22%5D"]) {
        assert.equal((await api(url)).statusCode, 400);
      }
      assert.equal((await api("/sessions/refresh", "POST", { client: "doubao-work" })).statusCode, 400);
      assert.equal((await api(`/sessions/${pausedId}/messages?mode=full`)).statusCode, 404);
      assert.equal((await api("/sessions")).json().total, 1);
      const status = (await api("/resources/status")).json();
      assert.ok(status.sources.every((row: { client: string }) => row.client !== "doubao-work"));
      for (const url of ["/overview/report?window=all", "/usage?from=2020-01-01&to=2030-01-01"]) {
        const response = await api(url); assert.equal(response.statusCode, 200, response.body);
        assert.ok(!response.body.includes('"doubao-work"'));
      }
      const env = isolatedHistoryEnvironment(directory, { AGENT_MANOR_HOME: fixture.home });
      await assert.rejects(run(process.execPath, ["--import", "tsx", "src/cli.ts", "sessions", "list", "--client", "doubao-work", "--json"], { env, timeout: 15_000 }));
      const refresh = (await api("/sessions/refresh", "POST", {})).json();
      let job;
      for (let attempt = 0; attempt < 200; attempt++) {
        job = (await api(`/jobs/${refresh.job.id}`)).json().job;
        if (["complete", "failed"].includes(job.status)) break;
        await delay(20);
      }
      assert.equal(job.status, "complete"); assert.equal(job.counts.discovered, 1);
      assert.deepEqual((await api("/sessions")).json().sessions.map((row: { client: string }) => row.client), ["codex"]);
      assert.deepEqual(await readFile(fixture.current), sourceBefore);
    } finally { await service.close(); }
  } finally { try { store.close(); } catch {} await rm(directory, { recursive: true, force: true }); }
});
