import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";
import { defaultSemanticConfig } from "../dist/semantic/config.js";

// 单独进程复用已构建的本地测试库，避免样本复制留下的内存分配干扰服务观测。
const repository = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: { home: { type: "string", default: ".local/semantic-search-real/performance/home" }, "settle-ms": { type: "string", default: "500" } } });
const home = resolve(repository, values.home), local = relative(join(repository, ".local"), home);
if (!local || local.startsWith("..") || isAbsolute(local) || !existsSync(join(home, "semantic", "vectors.sqlite"))) {
  throw new Error("Use an existing isolated semantic database inside .local");
}
const settleMs = Number(values["settle-ms"]);
if (!Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > 10000) throw new Error("Invalid settle-ms");
const evidence = join(dirname(home), "evidence"), resources = [];
const report = { startedAt: new Date().toISOString(), pid: process.pid, node: process.version, settleMs,
  limitations: ["全新Node服务进程，不包含之前样本复制的分配", "阶段RSS包括HTTP服务、通常启动的用量Worker及本脚本少量HTTP客户端开销", "阶段差值受GC、分配器与Worker初始化影响，并非语义功能的精确常驻增量", "不包括独立Ollama进程、GPU和系统统一内存总占用", "复用已构建索引，仅查询和预览，不重新首建"] };
const started = performance.now(), cpu = process.cpuUsage();
let phase = "initial", service;
const sample = () => ({ milliseconds: performance.now() - started, phase, rssBytes: process.memoryUsage().rss, cpu: process.cpuUsage(cpu) });
const beforeService = sample();
const sampler = setInterval(() => resources.push(sample()), 100);
async function capture(name) {
  await delay(settleMs);
  const current = sample(), stageSamples = resources.filter(item => item.phase === phase);
  return { name, ...current, sampledPeakRssBytes: Math.max(current.rssBytes, ...stageSamples.map(item => item.rssBytes)) };
}
try {
  const roots = Object.fromEntries(clientIds.map(client => [client, []]));
  service = await startService({ home, port: 0, roots, startupRefresh: false, staticRoot: join(repository, "dist", "web"),
    resourceInventory: { userHome: join(dirname(home), "isolated-user"), projects: [], environment: {} } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const api = async (path, body) => {
    const response = await fetch(base + "/api/v1" + path, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const value = await response.json();
    if (!response.ok || value.error) throw Object.assign(new Error(`API failure (${response.status}) at ${path}`), { diagnostic: value });
    return value;
  };
  phase = "http_started";
  report.beforeService = beforeService;
  report.httpStarted = { ...await capture("HTTP启动后，尚未请求语义API"), semanticWorkerExpected: false };
  phase = "semantic_status";
  const statusStart = performance.now(), status = await api("/semantic/status");
  const statusMs = performance.now() - statusStart;
  report.afterStatus = { ...await capture("读取语义状态后"), requestMs: statusMs,
    ready: status.ready, indexedSessions: status.indexedSessions, uniqueVectors: status.uniqueVectors };
  phase = "semantic_query";
  const scope = { ...defaultSemanticConfig().scope, timeRange: "all" }, queryStart = performance.now();
  const result = await api("/semantic/search", { q: "查找会话搜索与数据库性能的讨论", scope, pageSize: 20 });
  const queryMs = performance.now() - queryStart;
  report.afterQuery = { ...await capture("一次未缓存语义查询后"), requestMs: queryMs, candidateSessions: result.total };
  phase = "semantic_preview";
  const previewStart = performance.now(), preview = await api("/semantic/preview", {});
  const previewMs = performance.now() - previewStart;
  report.afterPreview = { ...await capture("一次构建预览后"), requestMs: previewMs,
    sessions: preview.sessionCount, uniqueInputs: preview.uniqueInputs, reusedInputs: preview.reusedInputs, pendingInputs: preview.pendingInputs };
  report.stageObservedDifferences = { statusMinusHttpBytes: report.afterStatus.rssBytes - report.httpStarted.rssBytes,
    queryMinusHttpBytes: report.afterQuery.rssBytes - report.httpStarted.rssBytes,
    previewMinusHttpBytes: report.afterPreview.rssBytes - report.httpStarted.rssBytes };
  report.completedAt = new Date().toISOString();
  console.log(JSON.stringify({ stage: "profile_complete", beforeService: report.beforeService, httpStarted: report.httpStarted,
    afterStatus: report.afterStatus, afterQuery: report.afterQuery, afterPreview: report.afterPreview, stageObservedDifferences: report.stageObservedDifferences }));
} catch (error) {
  report.error = { message: error.message, diagnostic: error.diagnostic };
  console.error(JSON.stringify({ stage: "profile_failed", message: error.diagnostic ? "API failure; diagnostics saved locally" : error.message }));
  process.exitCode = 1;
} finally {
  clearInterval(sampler);
  if (service) await service.close();
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await writeFile(join(evidence, "clean-process-profile.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  await writeFile(join(evidence, "clean-process-resources.json"), JSON.stringify(resources) + "\n", { mode: 0o600 });
}
