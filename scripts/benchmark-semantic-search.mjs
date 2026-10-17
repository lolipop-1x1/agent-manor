import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir, cpus, totalmem } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { AnalysisStore } from "../dist/index/store.js";
import { SessionStore } from "../dist/sessions/store.js";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";
import { defaultSemanticConfig } from "../dist/semantic/config.js";

// 真实正文、会话身份和命中只进入本机 .local；控制台只输出规模、时间和测试服务地址。
const repository = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: {
  days: { type: "string", default: "3" }, "max-messages": { type: "string", default: "200" },
  "max-sessions": { type: "string", default: "40" }, endpoint: { type: "string", default: "http://127.0.0.1:11434/v1" },
  model: { type: "string", default: "qwen3-embedding:0.6b" }, home: { type: "string" }, "source-home": { type: "string" },
  serve: { type: "boolean", default: false }, "skip-pause-check": { type: "boolean", default: false },
  "timeout-minutes": { type: "string", default: "45" },
} });
function integer(value, minimum, maximum, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Invalid ${name}`);
  return parsed;
}
const days = integer(values.days, 1, 36500, "days"), maxMessages = integer(values["max-messages"], 1, 10000, "max-messages");
const maxSessions = integer(values["max-sessions"], 1, 1000, "max-sessions");
const timeoutMs = integer(values["timeout-minutes"], 1, 1440, "timeout-minutes") * 60_000;
const sourceHome = resolve(values["source-home"] ?? process.env.AGENT_MANOR_HOME ?? join(homedir(), ".agent-manor"));
const home = resolve(values.home ?? join(repository, ".local", "semantic-search-real", "home"));
if (sourceHome === home) throw new Error("Benchmark home must differ from the source data home");
const evidence = join(dirname(home), "evidence");
const localHome = relative(join(repository, ".local"), home);
if (!localHome || localHome.startsWith("..") || isAbsolute(localHome)) throw new Error("Keep benchmark data inside the repository .local directory");
if (existsSync(join(home, "index.sqlite"))) throw new Error("Benchmark home already contains an index; choose a fresh --home");
if (!existsSync(join(repository, "dist", "web", "index.html"))) throw new Error("Run npm run build before benchmarking");
await mkdir(evidence, { recursive: true, mode: 0o700 });
await mkdir(home, { recursive: true, mode: 0o700 });
const report = { startedAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
  parameters: { days, maxMessages, maxSessions, endpoint: values.endpoint, model: values.model, home, sourceHome },
  limitations: ["仅选定真实样本，不代表全库质量和全库构建吞吐", "RSS/CPU包含本脚本内HTTP服务、Worker和少量测试客户端开销，不包含独立Ollama进程", "本地API单价设为0不表示本机CPU/GPU和电力成本为0"] };
const resources = [];
const ollamaResources = [];
let service, sampler, ollamaSampler;
const samples = [];
const timings = { status: [], keyword: [], semanticStatus: [] };
const measured = async operation => {
  const start = performance.now(), result = await operation(); return { result, milliseconds: performance.now() - start };
};
const percentile = (items, probability) => items.length ? [...items].sort((a, b) => a - b)[Math.min(items.length - 1, Math.ceil(items.length * probability) - 1)] : null;
const distribution = items => ({ count: items.length, p50Ms: percentile(items, 0.5), p95Ms: percentile(items, 0.95), maxMs: items.length ? Math.max(...items) : null });
const save = async () => {
  await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  await writeFile(join(evidence, "resources.json"), JSON.stringify(resources) + "\n", { mode: 0o600 });
  await writeFile(join(evidence, "ollama-resources.json"), JSON.stringify(ollamaResources) + "\n", { mode: 0o600 });
};
const execute = promisify(execFile);
async function ollamaProcesses() {
  if (process.platform === "win32") return [];
  const { stdout } = await execute("ps", ["-Ao", "pid=,ppid=,rss=,%cpu=,time=,command="], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\n").flatMap(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d:.\-]+)\s+(.+)$/.exec(line);
    if (!row) return [];
    const role = /^(?:\S*[/\\])?ollama\s+(runner|serve)(?:\s|$)/.exec(row[6])?.[1];
    if (!role) return [];
    const [clock, day] = row[5].includes("-") ? row[5].split("-").reverse() : [row[5], "0"];
    const cpuSeconds = Number(day) * 86400 + clock.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0);
    return [{ pid: Number(row[1]), parentPid: Number(row[2]), rssBytes: Number(row[3]) * 1024, cpuPercentReportedByPs: Number(row[4]), cpuSeconds, role }];
  });
}
function readSession(source, row) {
  const records = source.prepare("SELECT id,ordinal,record_line,turn_id,kind,final,call_id,copied,text,json FROM session_messages WHERE revision=? ORDER BY ordinal,id").all(row.revision)
    .map(message => ({ ...JSON.parse(message.json), id: message.id, ordinal: message.ordinal, recordLine: message.record_line, turnId: message.turn_id,
      kind: message.kind, text: message.text, ...(message.final === null ? {} : { final: message.final }),
      ...(message.call_id === null ? {} : { callId: message.call_id }), ...(message.copied === null ? {} : { copied: Boolean(message.copied) }) }));
  const usages = source.prepare("SELECT json FROM session_usage WHERE revision=? ORDER BY id").all(row.revision).map(row => JSON.parse(row.json));
  return { summary: JSON.parse(row.json), records, usages, fingerprint: row.fingerprint, sourcePath: row.path };
}
function copySession(store, session) {
  const pending = store.createRevision(session.sourcePath, session.fingerprint, true);
  for (const message of session.records) pending.sink.message(message);
  for (const usage of session.usages) pending.sink.usage(usage);
  pending.flush(); store.finishRevision(pending.revision, session.summary, session.fingerprint);
  return { path: session.sourcePath, revision: pending.revision, fingerprint: session.fingerprint };
}
try {
  const source = new Database(join(sourceHome, "index.sqlite"), { readonly: true, fileMustExist: true });
  let holdout;
  const copyStart = performance.now();
  const sourceMetadata = new AnalysisStore(join(home, "index.sqlite")); sourceMetadata.close();
  const destination = new SessionStore(join(home, "index.sqlite"));
  let published;
  try {
    source.transaction(() => {
      const version = source.prepare("SELECT json_extract(json,'$.version') version FROM session_state WHERE id=1").get()?.version;
      if (!version) throw new Error("The source history has no published version");
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days + 1); cutoff.setHours(0, 0, 0, 0);
      const selected = source.prepare(`SELECT r.id revision,r.json,r.fingerprint,r.path FROM session_version_sessions s JOIN session_revisions r ON r.id=s.revision
        WHERE s.version=? AND julianday(COALESCE(r.updated_at,r.started_at))>=julianday(?)
        AND COALESCE(json_extract(r.json,'$.messageCount'),0)<=?
        AND COALESCE(json_extract(r.json,'$.relationship'),'')!='child' AND COALESCE(json_extract(r.json,'$.executionMode'),'')!='quiet'
        AND NOT EXISTS(SELECT 1 FROM session_version_relations relation WHERE relation.version=s.version AND relation.child=s.session_id)
        AND EXISTS(SELECT 1 FROM session_messages m WHERE m.revision=r.id AND m.kind IN ('user','assistant') AND length(trim(m.text))>0)
        ORDER BY COALESCE(r.updated_at,r.started_at) DESC,s.session_id LIMIT ?`).all(version, cutoff.toISOString(), maxMessages, maxSessions);
      if (!selected.length) throw new Error("No source sessions matched the bounded real-data selection");
      const holdoutIndex = !values["skip-pause-check"] && selected.length > 1 ? selected.reduce((best, row, index) =>
        JSON.parse(row.json).messageCount > JSON.parse(selected[best].json).messageCount ? index : best, 0) : -1;
      published = [];
      for (const [index, row] of selected.entries()) {
        const session = readSession(source, row);
        samples.push({ id: session.summary.id, title: session.summary.title, client: session.summary.client, project: session.summary.project,
          messageCount: session.records.length, usageCount: session.usages.length, characters: session.records.reduce((sum, message) => sum + Array.from(message.text).length, 0),
          holdout: index === holdoutIndex });
        if (index === holdoutIndex) holdout = session;
        else published.push(copySession(destination, session));
      }
      destination.publish(destination.createJob().id, published, []);
      report.source = { version, cutoff: cutoff.toISOString(), totalPublishedSessions: source.prepare("SELECT COUNT(*) count FROM session_version_sessions WHERE version=?").get(version).count,
        databaseBytes: source.prepare("PRAGMA page_count").get().page_count * source.prepare("PRAGMA page_size").get().page_size };
    })();
  } finally { source.close(); destination.close(); }
  report.sample = { selectedSessions: samples.length, firstBuildSessions: published.length, holdoutSessions: holdout ? 1 : 0,
    messages: samples.reduce((sum, item) => sum + item.messageCount, 0), characters: samples.reduce((sum, item) => sum + item.characters, 0),
    copyMs: performance.now() - copyStart };
  await writeFile(join(evidence, "sample-private.json"), JSON.stringify(samples, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ stage: "copied", selectedSessions: samples.length, firstBuildSessions: published.length, messages: report.sample.messages, copyMs: report.sample.copyMs }));
  const emptyUser = join(dirname(home), "isolated-user"), roots = Object.fromEntries(clientIds.map(client => [client, []]));
  await mkdir(emptyUser, { recursive: true, mode: 0o700 });
  service = await startService({ home, port: 0, roots, startupRefresh: false, staticRoot: join(repository, "dist", "web"),
    resourceInventory: { userHome: emptyUser, projects: [], environment: {} } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  report.service = { pid: process.pid, url: base };
  await writeFile(join(evidence, "service.json"), JSON.stringify({ ...report.service, home }, null, 2) + "\n", { mode: 0o600 });
  const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(base + "/api/v1" + path, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    const result = await response.json();
    if (!response.ok || result.error) throw Object.assign(new Error(`API request failed (${response.status}) at ${path}`), { privateDiagnostic: result });
    return result;
  };
  const config = defaultSemanticConfig();
  config.enabled = false; config.connection = { url: values.endpoint, model: values.model, documentPrefix: "", queryPrefix: "" };
  config.scope.timeRange = "all"; config.strategy.pricePerMillion = 0;
  const connection = await measured(() => api("/semantic/test", { connection: config.connection }));
  config.connection.dimensions = connection.result.dimensions;
  config.enabled = true;
  await api("/semantic/settings", { config }, "PUT");
  report.connection = { testMs: connection.milliseconds, dimensions: connection.result.dimensions, tokens: connection.result.tokens };
  const preview = await measured(() => api("/semantic/preview", {}));
  report.preview = { ...preview.result, milliseconds: preview.milliseconds };
  console.log(JSON.stringify({ stage: "preview", sessions: preview.result.sessionCount, positions: preview.result.positionCount, uniqueInputs: preview.result.uniqueInputs,
    pendingInputs: preview.result.pendingInputs, estimatedTokens: preview.result.estimatedTokens, milliseconds: preview.milliseconds }));
  const usageBefore = (await api("/semantic/status")).usage;
  const ollamaBefore = await ollamaProcesses();
  const cpuStart = process.cpuUsage(), buildStart = performance.now(), buildBaselineRss = process.memoryUsage().rss;
  ollamaResources.push({ milliseconds: 0, processes: ollamaBefore });
  sampler = setInterval(() => resources.push({ milliseconds: performance.now() - buildStart, rssBytes: process.memoryUsage().rss, cpu: process.cpuUsage(cpuStart) }), 100);
  let samplingOllama = false;
  ollamaSampler = setInterval(() => {
    if (samplingOllama) return;
    samplingOllama = true;
    void ollamaProcesses().then(processes => ollamaResources.push({ milliseconds: performance.now() - buildStart, processes }))
      .catch(error => { report.ollamaSamplingError = error.message; })
      .finally(() => { samplingOllama = false; });
  }, 500);
  const waitForBuild = async (checkResponsiveness = false) => {
    const deadline = Date.now() + timeoutMs; let lastProbe = 0;
    for (;;) {
      const status = await measured(() => api("/semantic/status"));
      if (checkResponsiveness) timings.semanticStatus.push(status.milliseconds);
      if (["failed", "budget_stopped"].includes(status.result.job?.status)) throw Object.assign(new Error("Semantic build failed"), { privateDiagnostic: status.result });
      if (status.result.job?.status === "complete") return status.result;
      if (Date.now() > deadline) throw new Error("Semantic build timed out");
      if (checkResponsiveness && Date.now() - lastProbe > 2000) {
        lastProbe = Date.now();
        const [statusProbe, keywordProbe] = await Promise.all([
          measured(() => api("/status?summary=true")),
          measured(() => api("/sessions/search/groups?q=" + encodeURIComponent("搜索") + "&pageSize=20")),
        ]);
        timings.status.push(statusProbe.milliseconds); timings.keyword.push(keywordProbe.milliseconds);
      }
      await delay(500);
    }
  };
  await api("/semantic/build", { previewId: preview.result.id });
  const completed = await waitForBuild(true), buildMs = performance.now() - buildStart;
  clearInterval(sampler); sampler = undefined;
  clearInterval(ollamaSampler); ollamaSampler = undefined;
  const ollamaAfter = await ollamaProcesses();
  ollamaResources.push({ milliseconds: performance.now() - buildStart, processes: ollamaAfter });
  const ollamaCpuMs = ollamaAfter.reduce((sum, item) => sum + Math.max(0, item.cpuSeconds - (ollamaBefore.find(previous => previous.pid === item.pid)?.cpuSeconds ?? 0)) * 1000, 0);
  const cpu = process.cpuUsage(cpuStart);
  report.firstBuild = { milliseconds: buildMs, inputs: completed.job.totalInputs, completedInputs: completed.job.completedInputs, reusedInputs: completed.job.reusedInputs,
    indexedSessions: completed.indexedSessions, indexedPositions: completed.indexedPositions, uniqueVectors: completed.uniqueVectors,
    modelRequests: completed.usage.byPurpose.build.requests - usageBefore.byPurpose.build.requests,
    actualTokens: completed.usage.actualTokens - usageBefore.actualTokens, estimatedTokens: completed.usage.estimatedTokens - usageBefore.estimatedTokens,
    actualRequests: completed.usage.actualRequests - usageBefore.actualRequests,
    baselineRssBytes: buildBaselineRss, peakRssBytes: Math.max(buildBaselineRss, ...resources.map(item => item.rssBytes)),
    cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, cpuPercentOfOneCore: (cpu.user + cpu.system) / (buildMs * 10),
    databaseBytes: completed.databaseBytes, samplesAt100ms: resources.length,
    ollama: { available: ollamaBefore.length > 0 || ollamaAfter.length > 0, samplingIntervalMs: 500, baselineProcesses: ollamaBefore, lastProcesses: ollamaAfter, cpuMs: ollamaCpuMs,
      cpuPercentOfOneCore: ollamaCpuMs / buildMs * 100,
      peakSummedRssBytes: Math.max(0, ...ollamaResources.map(item => item.processes.reduce((sum, process) => sum + process.rssBytes, 0))),
      peakRunnerRssBytes: Math.max(0, ...ollamaResources.flatMap(item => item.processes.filter(process => process.role === "runner").map(process => process.rssBytes))),
      note: "独立Ollama server/runner进程RSS之和可能包含共享页；不表示GPU或系统统一内存总占用；ps采样本身有少量开销" },
    responsiveness: { status: distribution(timings.status), keyword: distribution(timings.keyword), semanticStatus: distribution(timings.semanticStatus) } };
  console.log(JSON.stringify({ stage: "built", ...report.firstBuild }));
  const queries = ["查找搜索性能优化和数据库索引相关的讨论", "界面布局、交互和易用性的设计", "模型调用费用、预算与资源占用", "如何排查测试失败和修复程序错误", "会话历史、分支和数据同步的处理方式"];
  report.queries = [];
  const privateHits = [];
  for (const query of queries) {
    const before = (await api("/semantic/status")).usage.byPurpose.query.requests;
    const first = await measured(() => api("/semantic/search", { q: query, scope: config.scope, pageSize: 20 }));
    const cached = [];
    for (let index = 0; index < 20; index++) cached.push((await measured(() => api("/semantic/search", { q: query, scope: config.scope, pageSize: 20 }))).milliseconds);
    const after = (await api("/semantic/status")).usage.byPurpose.query.requests;
    assert.equal(after - before, 1, "Repeated identical queries should reuse the encoded vector");
    report.queries.push({ query, firstMs: first.milliseconds, cached: distribution(cached), modelRequests: after - before, candidateSessions: first.result.total });
    privateHits.push({ query, firstMs: first.milliseconds, groups: first.result.groups.slice(0, 3) });
  }
  await writeFile(join(evidence, "query-hits-private.json"), JSON.stringify(privateHits, null, 2) + "\n", { mode: 0o600 });
  const beforeRepeat = (await api("/semantic/status")).usage.requests;
  const repeated = await measured(() => api("/semantic/preview", {}));
  assert.equal(repeated.result.pendingInputs, 0, "An unchanged second preview should have no inputs to encode");
  await api("/semantic/build", { previewId: repeated.result.id });
  await waitForBuild();
  const afterRepeat = (await api("/semantic/status")).usage.requests;
  assert.equal(afterRepeat, beforeRepeat, "An unchanged build should not call the model");
  report.repeat = { previewMs: repeated.milliseconds, pendingInputs: repeated.result.pendingInputs, reusedInputs: repeated.result.reusedInputs, addedModelRequests: afterRepeat - beforeRepeat };
  if (holdout) {
    const incrementalCopyStart = performance.now(), destination = new SessionStore(join(home, "index.sqlite"));
    try { published.push(copySession(destination, holdout)); destination.publish(destination.createJob().id, published, []); }
    finally { destination.close(); }
    const incrementalPreview = await api("/semantic/preview", {});
    assert.ok(incrementalPreview.pendingInputs > 0, "The held-out real session must add uncached inputs");
    await api("/semantic/build", { previewId: incrementalPreview.id });
    const paused = await api("/semantic/action", { action: "pause" });
    assert.equal(paused.job.status, "paused", "Pause verification must observe an actually paused build");
    const before = paused.usage.byPurpose.query.requests;
    const query = "在构建暂停的时候查找仍可使用的历史记录";
    const searched = await measured(() => api("/semantic/search", { q: query, scope: config.scope, pageSize: 20 }));
    const after = await api("/semantic/status");
    assert.equal(after.job.status, "paused"); assert.equal(after.usage.byPurpose.query.requests - before, 1);
    report.pausedQuery = { verified: true, incrementalCopyAndPreviewMs: performance.now() - incrementalCopyStart, pendingInputs: incrementalPreview.pendingInputs,
      pausedCompletedInputs: paused.job.completedInputs, pausedTotalInputs: paused.job.totalInputs, queryMs: searched.milliseconds, addedQueryRequests: after.usage.byPurpose.query.requests - before };
    await api("/semantic/action", { action: "resume" });
    await waitForBuild();
  } else report.pausedQuery = { verified: false, reason: "No held-out real session available" };
  report.finalStatus = await api("/semantic/status");
  report.completedAt = new Date().toISOString();
  report.destinationIndexBytes = (await stat(join(home, "index.sqlite"))).size;
  await save();
  console.log(JSON.stringify({ stage: "complete", firstBuild: report.firstBuild, repeat: report.repeat, pausedQuery: report.pausedQuery,
    queries: report.queries.map(({ firstMs, cached, modelRequests }) => ({ firstMs, cached, modelRequests })), url: base }));
  if (values.serve) {
    console.log(JSON.stringify({ stage: "serving", url: base, pid: process.pid }));
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  }
} catch (error) {
  report.error = { message: error.message, stack: error.stack, diagnostic: error.privateDiagnostic };
  await save();
  console.error(JSON.stringify({ stage: "failed", message: error.privateDiagnostic ? "API failure; private diagnostics saved locally" : error.message }));
  process.exitCode = 1;
} finally {
  if (sampler) clearInterval(sampler);
  if (ollamaSampler) clearInterval(ollamaSampler);
  if (service) await service.close();
}
