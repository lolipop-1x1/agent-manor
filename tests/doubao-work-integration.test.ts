import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import type { CoverageResult, EventsResponse, JobResponse, RegisterRepositoryResponse, SourcesResponse } from "../src/contracts.js";
import type { SessionIndexStatus, SessionJob, SessionListResult, SessionMessageResult, SessionProfile, SessionSearchResult } from "../src/session-contracts.js";
import type { ResourceLocalResult } from "../src/resource-service-contracts.js";
import type { ResourceManagementOperation, ResourceManagementPreview } from "../src/resource-management-contracts.js";
import type { UsageReport } from "../src/usage-contracts.js";
import type { OverviewReport } from "../src/overview-contracts.js";
import { discoverSources } from "../src/history/index.js";
import { HISTORY_ADAPTERS, readHistoryEvidence } from "../src/history/adapters/index.js";
import { normalizedHash } from "../src/history/adapters/normalized.js";
import { startService } from "../src/server.js";
import { apiRequest, delay } from "../src/service/runtime.js";
import { collectDialogue, dialogueMarkdown } from "../web/features/sessions/session-export.js";
import { createDoubaoWorkScenario } from "./helpers/doubao-work-scenario.js";
import { isolatedHistoryEnvironment } from "./helpers/history-roots.js";

const run = promisify(execFile);

test("豆包合成缓存贯通 HTTP、CLI、完整索引、阅读导出、未知统计、地图与资源管理", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-doubao-integration-")));
  const fixture = await createDoubaoWorkScenario(directory);
  const service = await startService({ home: fixture.home, roots: fixture.roots, startupRefresh: false,
    resourceInventory: { userHome: fixture.userHome, environment: {} }, usagePricing: { fetch: (async () => { throw new Error("synthetic offline pricing"); }) as typeof fetch } });
  const api = <T>(route: string, method = "GET", body?: unknown) => apiRequest<T>(service.instance, route, method, body);
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const hook = fileURLToPath(import.meta.resolve("tsx/esm"));
  const env = isolatedHistoryEnvironment(directory, { AGENT_MANOR_HOME: fixture.home });
  const command = async <T>(args: string[]) => JSON.parse((await run(process.execPath, ["--import", hook, cliPath, ...args, "--json"],
    { cwd: directory, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout) as T;
  const wait = async (id: string) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const { job } = await api<{ job: SessionJob | JobResponse["job"] }>(`/jobs/${id}`);
      assert.notEqual(job.status, "failed", "error" in job ? job.error : undefined);
      if (["complete", "completed"].includes(job.status)) return job;
      await delay(25);
    }
    assert.fail("隔离任务未在限定时间内结束");
  };
  try {
    const refresh = await api<{ job: SessionJob }>("/sessions/refresh", "POST", { client: "doubao-work", mode: "full" }); await wait(refresh.job.id);
    const list = await api<SessionListResult>("/sessions?client=doubao-work");
    assert.equal(list.total, 1); const session = list.sessions[0]!;
    assert.equal(session.title, fixture.title); assert.equal(session.project, fixture.project); assert.equal(session.turnCount, 2);
    assert.deepEqual(await command(["sessions", "list", "--client", "doubao-work"]), list);
    const modes = new Map<string, SessionMessageResult>();
    for (const mode of ["brief", "full", "trace"]) {
      const result = await api<SessionMessageResult>(`/sessions/${session.id}/messages?mode=${mode}&version=${list.version}&pageSize=200`);
      assert.equal(result.version, list.version); modes.set(mode, result);
      assert.deepEqual(await command(["sessions", "messages", session.id, "--mode", mode, "--version", list.version, "--page-size", "200"]), result);
    }
    assert.equal(modes.get("brief")!.messages.length, 4);
    assert.ok(!modes.get("brief")!.messages.some(message => message.kind === "thinking" || message.kind === "context"));
    assert.ok(modes.get("full")!.messages.some(message => message.text === fixture.thinking));
    assert.ok(modes.get("trace")!.messages.some(message => message.text.includes("File does not exist") && message.kind === "context"));
    assert.ok(modes.get("trace")!.messages.every(message => !message.tool && !message.status && !message.final && !message.resource));
    const search = await api<SessionSearchResult>(`/sessions/search?client=doubao-work&q=${fixture.needle}`);
    assert.equal(search.total, 1); assert.equal(search.hits[0]?.session.id, session.id);
    assert.deepEqual(await command(["sessions", "search", fixture.needle, "--client", "doubao-work"]), search);
    const dialogue = await collectDialogue(page => api(`/sessions/${session.id}/messages?mode=brief&version=${list.version}&page=${page}&pageSize=2`), list.version);
    const markdown = dialogueMarkdown(dialogue, "zh-CN");
    assert.ok(markdown.includes(fixture.needle)); assert.ok(markdown.includes("合成回复")); assert.ok(markdown.includes("未确认")); assert.ok(!markdown.includes(fixture.thinking));
    const locations = await discoverSources(fixture.roots); assert.equal(locations.length, 1);
    const source = locations[0]!, adapter = HISTORY_ADAPTERS.find(value => value.id === source.format)!;
    const raw = (await adapter.readRecords!(source)).records.find(value => value.line === 2)!;
    const reference = { sourceId: source.sourceId!, format: source.format!, path: source.path, selector: source.selector, recordLine: raw.line, hash: normalizedHash(raw.raw) };
    assert.ok((await readHistoryEvidence(reference))?.raw.includes("合成回复"));
    const profile = await api<SessionProfile>(`/sessions/${session.id}/profile?version=${list.version}`);
    assert.equal(profile.usage.requests, 0); assert.equal(profile.usage.inputTokens, null); assert.equal(profile.usage.outputTokens, null);
    assert.deepEqual(profile.steps, []); assert.deepEqual(profile.tools, []); assert.deepEqual(profile.resources, []);
    assert.ok(profile.gaps.some(gap => gap.messageDescriptor?.key.endsWith("measurementUnknown")));
    const clients = encodeURIComponent(JSON.stringify(["doubao-work"]));
    const usage = await api<UsageReport>(`/usage?clients=${clients}&from=2026-10-01&to=2026-10-31`);
    assert.equal(usage.totals.requests, 0); assert.equal(usage.totals.tokens, null); assert.equal(usage.totals.estimatedCost, null);
    const overview = await api<OverviewReport>(`/overview/report?clients=${clients}&window=custom&from=2026-10-01&to=2026-10-31`);
    assert.equal(overview.summary.sessions, 1); assert.equal(overview.summary.requests, 0); assert.equal(overview.summary.tokens, null);
    assert.equal(overview.process.failures, 0); assert.deepEqual(overview.resources.skills, []); assert.deepEqual(overview.resources.mcp, []);
    const registered = await api<RegisterRepositoryResponse>("/repositories", "POST", { path: fixture.project }); await wait(registered.job!.id);
    const repositoryRoute = `/repositories/${registered.repository.id}`;
    const coverage = await api<CoverageResult>(`${repositoryRoute}/coverage?client=doubao-work`);
    assert.deepEqual(coverage.summary.readExact, { files: 0, lines: 0 }); assert.deepEqual(coverage.summary.editExact, { files: 0, lines: 0 });
    assert.equal((await api<EventsResponse>(`${repositoryRoute}/events?client=doubao-work`)).total, 0);
    const sources = await api<SourcesResponse>(`${repositoryRoute}/sources?client=doubao-work`);
    assert.equal(sources.sources.length, 1); assert.ok(sources.gaps.some(gap => gap.messageDescriptor?.key.endsWith("fileCardUnknown")));
    assert.deepEqual(await command(["coverage", registered.repository.id, "--client", "doubao-work"]), coverage);
    const local = await api<ResourceLocalResult>("/resources/local?kind=skill&client=doubao-work"); assert.equal(local.total, 2);
    const managed = local.rows.find(row => row.body.name === "doubao-managed-guide")!, ordinary = local.rows.find(row => row.body.name === "doubao-shared-guide")!;
    const managedEntry = managed.entries.find(entry => entry.client === "doubao-work")!, ordinaryEntry = ordinary.entries.find(entry => entry.client === "doubao-work")!;
    assert.equal(managedEntry.protected, true); assert.equal(managedEntry.capabilities.trash, false);
    await assert.rejects(api("/resources/preview", "POST", { entryId: managedEntry.id, action: "trash" }), { code: "FORBIDDEN" });
    assert.equal(ordinaryEntry.capabilities.trash, true); assert.equal(ordinaryEntry.capabilities.disable, false);
    const preview = await api<ResourceManagementPreview>("/resources/preview", "POST", { entryId: ordinaryEntry.id, action: "trash" });
    const removed = await api<ResourceManagementOperation>("/resources/apply", "POST", { previewId: preview.id, confirmed: true }); assert.equal(removed.status, "success");
    await assert.rejects(readFile(join(fixture.sharedSkill, "SKILL.md")));
    const restore = await api<ResourceManagementPreview>("/resources/preview", "POST", { operationId: removed.id, action: "restore" });
    assert.equal((await api<ResourceManagementOperation>("/resources/apply", "POST", { previewId: restore.id, confirmed: true })).status, "success");
    assert.ok((await readFile(join(fixture.sharedSkill, "SKILL.md"), "utf8")).includes("人工合成"));
    await fixture.writeCache("替换后的合成回复");
    assert.equal(await readHistoryEvidence(reference), undefined);
    assert.equal((await command<{ job: SessionJob }>(["sessions", "refresh", "--client", "doubao-work", "--mode", "full", "--wait"])).job.status, "complete");
    const changed = await api<SessionListResult>("/sessions?client=doubao-work"); assert.notEqual(changed.version, list.version);
    const changedMessages = await api<SessionMessageResult>(`/sessions/${session.id}/messages?mode=brief`);
    assert.ok(changedMessages.messages.some(message => message.text === "替换后的合成回复"));
    await fixture.writeCache("", false);
    assert.equal((await command<{ job: SessionJob }>(["sessions", "refresh", "--client", "doubao-work", "--mode", "full", "--wait"])).job.status, "complete");
    assert.equal((await api<SessionListResult>("/sessions?client=doubao-work")).total, 0);
    assert.equal((await api<SessionIndexStatus>("/sessions/status")).stale, false);
    assert.equal((await api<ResourceLocalResult>("/resources/local?kind=skill&client=doubao-work")).total, 2);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
