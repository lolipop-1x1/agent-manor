import { DiagnosticError } from "./i18n/diagnostics.js";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnalysisSnapshot, ApiErrorCode, CoverageQuery, FileDetail, Filters, ServiceInstance } from "./contracts.js";
import { buildCoverage, eventFilePaths, filterEvents, filterHistoricalEvents, getHotspots, getUnreadFiles } from "./analysis/coverage.js";
import type { DiscoverRoots } from "./history/index.js";
import { AnalysisStore, StoreError, WorkerManager } from "./index/index.js";
import { VERSION } from "./version.js";
import { bodyText, coverageQuery, emptyBody, eventsQuery, integer, relativePath, ServiceError } from "./service/input.js";
import { contentHash, readCurrentFile, readEvidence } from "./service/files.js";
import { acquireLock, dataHome, removeInstance, writeInstance } from "./service/runtime.js";
import { SessionStore } from "./sessions/store.js";
import { queryBoolean, sessionMessageQuery, sessionQuery, sessionRefreshOptions } from "./service/session-input.js";
import { textValue } from "./service/input.js";
import { clientIds } from "./clients.js";
import type { Client } from "./contracts.js";
import type { ResourceInventoryOptions } from "./resource-inventory-contracts.js";
import { ResourceManager } from "./resources/management.js";
import { ResourceService } from "./resources/service.js";
import { registerResourceRoutes } from "./service/resource-routes.js";
import { registerPreferenceRoutes } from "./service/preferences.js";

export interface ServiceOptions {
  home?: string;
  port?: number;
  roots?: DiscoverRoots;
  staticRoot?: string;
  startupRefresh?: boolean;
  resourceInventory?: ResourceInventoryOptions;
}

function statusCode(code: ApiErrorCode): number {
  if (code === "INVALID_INPUT") return 400;
  if (code === "FORBIDDEN") return 403;
  if (code === "ANALYSIS_NOT_READY" || code === "CONTENT_STALE") return 409;
  if (code === "INTERNAL_ERROR") return 500;
  return 404;
}

function filtersOf({ version: _version, ...filters }: CoverageQuery): Filters { return filters; }
function hasEventPath(snapshot: AnalysisSnapshot, eventId: string, path: string): boolean {
  const event = snapshot.events.find((candidate) => candidate.id === eventId);
  return Boolean(event && (eventFilePaths(event, snapshot.repository).includes(path)
    || snapshot.mappings.some((mapping) => mapping.eventId === eventId && mapping.filePath === path)));
}

export async function startService(options: ServiceOptions = {}) {
  const home = dataHome(options.home);
  const requestedPort = options.port ?? (process.env.AGENT_MANOR_PORT ? Number(process.env.AGENT_MANOR_PORT) : 0);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new DiagnosticError("端口必须是 0 到 65535 的整数", { key: "diagnostics.server.m001" });
  const release = await acquireLock(home, "service.lock");
  let store: AnalysisStore | undefined;
  let manager: WorkerManager | undefined;
  let sessions: SessionStore | undefined;
  let resourceManager: ResourceManager | undefined;
  const app = Fastify({ logger: false, bodyLimit: 65_536, forceCloseConnections: true });
  const instance: ServiceInstance = { id: randomUUID(), pid: process.pid, host: "127.0.0.1", port: requestedPort, startedAt: new Date().toISOString() };
  try {
    store = new AnalysisStore(join(home, "index.sqlite"));
    sessions = new SessionStore(store.dbPath);
    manager = new WorkerManager(store, { roots: options.roots }, sessions);
    const index = store;
    const library = sessions;
    const worker = manager;
    resourceManager = new ResourceManager(home);
    const management = resourceManager;
    const resources = new ResourceService(library, management, options.resourceInventory ?? { environment: process.env }, () =>
      [...new Set([...index.listRepositories().map(repository => repository.path), ...library.status().projects])]);
    app.addHook("onClose", async () => {
      await worker.close();
      index.close();
      library.close();
      management.close();
      await removeInstance(home, instance);
      await release();
    });
    app.setErrorHandler((error, _request, reply) => {
      const known = error instanceof StoreError || error instanceof ServiceError;
      const malformed = !known && typeof error === "object" && error !== null && "statusCode" in error
        && Number(error.statusCode) >= 400 && Number(error.statusCode) < 500;
      const code: ApiErrorCode = known ? error.code : malformed ? "INVALID_INPUT" : "INTERNAL_ERROR";
      reply.code(statusCode(code)).send({ error: { code, message: known ? error.message : malformed ? "无效 HTTP 请求" : "本地服务处理失败", messageDescriptor: known ? error.messageDescriptor : malformed ? { key: "diagnostics.server.m002" } : { key: "diagnostics.server.m003" } } });
    });
    app.setNotFoundHandler((_request, reply) => { reply.code(404).send({ error: { code: "FILE_NOT_FOUND", message: "资源不存在", messageDescriptor: { key: "diagnostics.server.m004" } } }); });
    app.addHook("onRequest", async (request) => {
      let host: URL;
      try { host = new URL(`http://${request.headers.host ?? ""}`); } catch { throw new ServiceError("FORBIDDEN", "无效 Host", { key: "diagnostics.server.m005" }); }
      if (!["127.0.0.1", "localhost"].includes(host.hostname) || (host.port || "80") !== String(instance.port)
        || host.username || host.password || host.pathname !== "/" || host.search || host.hash) throw new ServiceError("FORBIDDEN", "仅允许本机服务 Host", { key: "diagnostics.server.m006" });
      const origin = request.headers.origin;
      if (origin) {
        let source: URL;
        try { source = new URL(origin); } catch { throw new ServiceError("FORBIDDEN", "无效 Origin", { key: "diagnostics.server.m007" }); }
        let sameOrigin = source.origin === host.origin;
        // 兼容 Origin 丢失端口；浏览器同源标记与完整 Referer 必须同时匹配。
        if (!sameOrigin && !source.port && source.protocol === host.protocol && source.hostname === host.hostname
          && request.headers["sec-fetch-site"] === "same-origin") {
          try {
            const referrer = new URL(request.headers.referer ?? "");
            sameOrigin = referrer.origin === host.origin && !referrer.username && !referrer.password;
          } catch { /* 没有完整同源来源时继续拒绝。 */ }
        }
        if (!sameOrigin || source.pathname !== "/" || source.search || source.hash || source.username || source.password) {
          throw new ServiceError("FORBIDDEN", "仅允许同服务页面请求", { key: "diagnostics.server.m008" });
        }
      }
      const token = request.headers["x-agent-manor-instance"];
      if (token !== undefined && token !== instance.id) throw new ServiceError("FORBIDDEN", "服务实例已变化", { key: "diagnostics.server.m009" });
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        if (request.headers["sec-fetch-site"] === "cross-site") throw new ServiceError("FORBIDDEN", "拒绝跨站写入", { key: "diagnostics.server.m010" });
        const contentType = request.headers["content-type"];
        if (contentType && !/^application\/json(?:\s*;|$)/i.test(contentType)) throw new ServiceError("INVALID_INPUT", "写入请求仅接受 application/json", { key: "diagnostics.server.m011" });
        if (Number(request.headers["content-length"] ?? 0) > 0 && !contentType) throw new ServiceError("INVALID_INPUT", "请求体需要 application/json", { key: "diagnostics.server.m012" });
      }
    });
    registerPreferenceRoutes(app, home);
    app.get("/api/v1/status", async () => ({ instance, version: VERSION, repositories: index.listRepositories(), jobs: index.listJobs(), sessions: library.status() }));
    app.post("/api/v1/stop", async (request, reply) => {
      emptyBody(request.body);
      reply.send({ stopping: true });
      setImmediate(() => { void app.close(); });
    });
    app.get("/api/v1/repositories", async () => ({ repositories: index.listRepositories() }));
    app.post("/api/v1/repositories", async (request) => {
      const path = bodyText(request.body, "path");
      let repository;
      try { repository = await index.registerRepository(path); }
      catch { throw new ServiceError("INVALID_INPUT", "path 必须是可读取的 Git 仓库", { key: "diagnostics.server.m013" }); }
      return { repository, job: worker.refresh(repository.id) };
    });
    const base = "/api/v1/repositories/:id";
    type RepositoryParams = { id: string };
    type Query = Record<string, unknown>;
    app.get("/api/v1/sessions/status", async () => library.status());
    app.get<{ Querystring: Query }>("/api/v1/sessions", async request => library.list(sessionQuery(request.query)));
    app.get<{ Querystring: Query }>("/api/v1/sessions/search", async request => {
      const query = sessionQuery(request.query);
      if (!query.q) throw new ServiceError("INVALID_INPUT", "搜索需要 q", { key: "diagnostics.server.m014" });
      return library.search({ ...query, sessionId: textValue(request.query.sessionId, "sessionId") });
    });
    app.get<{ Querystring: Query }>("/api/v1/sessions/locate", async request => {
      const client = textValue(request.query.client, "client", true)!;
      if (!clientIds.includes(client as Client)) throw new ServiceError("INVALID_INPUT", "未知客户端", { key: "diagnostics.server.m015" });
      const target = library.locate({ client: client as Client, clientSessionId: textValue(request.query.clientSessionId, "clientSessionId", true)!,
        sourceId: textValue(request.query.sourceId, "sourceId"),
        recordLine: request.query.recordLine === undefined ? undefined : integer(request.query.recordLine, "recordLine", 1, 1_000_000_000),
        callId: textValue(request.query.callId, "callId") });
      return { target };
    });
    app.get<{ Params: { id: string }; Querystring: Query }>("/api/v1/sessions/:id/messages", async request => library.messages(request.params.id, sessionMessageQuery(request.query)));
    app.get<{ Params: { id: string }; Querystring: Query }>("/api/v1/sessions/:id/timeline", async request => library.timeline(request.params.id, textValue(request.query.version, "version")));
    app.get<{ Params: { id: string }; Querystring: Query }>("/api/v1/sessions/:id/profile", async request => library.profile(request.params.id, {
      ...sessionQuery(request.query), includeChildren: queryBoolean(request.query.includeChildren, "includeChildren"),
    }));
    app.post("/api/v1/sessions/refresh", async request => ({ job: worker.refreshSessions(false, sessionRefreshOptions(request.body)) }));
    registerResourceRoutes(app, resources);
    app.delete("/api/v1/sessions/cache", async request => { emptyBody(request.body); return { job: worker.refreshSessions(true) }; });
    const snapshotFor = (id: string, query: CoverageQuery) => index.getSnapshot(id, query.version);
    app.get<{ Params: RepositoryParams; Querystring: Query }>(`${base}/coverage`, async (request) => {
      const query = coverageQuery(request.query);
      return buildCoverage(snapshotFor(request.params.id, query), filtersOf(query));
    });
    app.get<{ Params: RepositoryParams; Querystring: Query }>(`${base}/hotspots`, async (request) => {
      const query = coverageQuery(request.query);
      const metric = request.query.metric ?? "activity";
      if (metric !== "read" && metric !== "edit" && metric !== "activity") throw new ServiceError("INVALID_INPUT", "未知热点指标", { key: "diagnostics.server.m016" });
      const coverage = buildCoverage(snapshotFor(request.params.id, query), filtersOf(query));
      return { ...coverage, files: getHotspots(coverage, metric, integer(request.query.limit, "limit", 20, 1000)) };
    });
    app.get<{ Params: RepositoryParams; Querystring: Query }>(`${base}/unobserved`, async (request) => {
      const query = coverageQuery(request.query);
      const coverage = buildCoverage(snapshotFor(request.params.id, query), filtersOf(query));
      return { ...coverage, files: getUnreadFiles(coverage) };
    });
    app.get<{ Params: RepositoryParams; Querystring: Query }>(`${base}/file`, async (request): Promise<FileDetail> => {
      const query = coverageQuery(request.query);
      const path = relativePath(request.query.path);
      const snapshot = snapshotFor(request.params.id, query);
      const coverage = buildCoverage(snapshot, filtersOf(query));
      const file = coverage.files.find((candidate) => candidate.path === path);
      if (!file) throw new ServiceError("FILE_NOT_FOUND", "文件不在所选分析范围内", { key: "diagnostics.server.m017" });
      let content: string | null = null;
      let hash: string | undefined;
      try {
        const bytes = await readCurrentFile(snapshot.repository.path, path);
        hash = contentHash(bytes);
        if (hash === file.hash) content = bytes.toString("utf8");
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        if (!["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      const events = filterEvents(snapshot, filtersOf(query)).filter((event) => hasEventPath(snapshot, event.id, path)).map((event) => ({
        ...event, mapping: content === null ? undefined : snapshot.mappings.find((mapping) => mapping.eventId === event.id && mapping.filePath === path),
      }));
      return { repository: coverage.repository, version: coverage.version, baselineHash: coverage.baselineHash,
        createdAt: coverage.createdAt, stale: coverage.stale || content === null, filters: coverage.filters,
        previousVersion: coverage.previousVersion, file, content, contentHash: hash, contentStale: content === null, events };
    });
    app.get<{ Params: RepositoryParams; Querystring: Query }>(`${base}/events`, async (request) => {
      const query = eventsQuery(request.query);
      const snapshot = snapshotFor(request.params.id, query);
      const events = filterHistoricalEvents(snapshot, filtersOf(query)).filter((event) => (!query.kind || event.kind === query.kind)
        && (!query.path || hasEventPath(snapshot, event.id, query.path)));
      const start = (query.page! - 1) * query.pageSize!;
      return { version: snapshot.version, events: events.slice(start, start + query.pageSize!), total: events.length, page: query.page, pageSize: query.pageSize };
    });
    app.get<{ Params: RepositoryParams & { eventId: string }; Querystring: Query }>(`${base}/evidence/:eventId`, async (request) => {
      const query = coverageQuery(request.query);
      const snapshot = snapshotFor(request.params.id, query);
      const event = filterHistoricalEvents(snapshot, filtersOf(query)).find((candidate) => candidate.id === request.params.eventId);
      if (!event) throw new ServiceError("EVENT_NOT_FOUND", "活动不在所选分析范围内", { key: "diagnostics.server.m018" });
      const records = [];
      const unavailable = [];
      for (const source of event.sources) {
        const record = await readEvidence(source);
        if (record) records.push(record); else unavailable.push(source);
      }
      return { version: snapshot.version, event, records, unavailable };
    });
    app.get<{ Params: RepositoryParams; Querystring: Query }>(`${base}/sources`, async (request) => {
      const query = coverageQuery(request.query);
      const result = index.listSources(request.params.id, query.version);
      if (!query.client) return result;
      return { ...result, sources: result.sources.filter((source) => source.client === query.client),
        unassociated: result.unassociated.filter((source) => source.client === query.client),
        gaps: result.gaps.filter((gap) => !gap.sourceId || [...result.sources, ...result.unassociated].some((source) => source.sourceId === gap.sourceId && source.client === query.client)) };
    });
    app.post<{ Params: RepositoryParams }>(`${base}/associations`, async (request) => {
      index.associateSource(request.params.id, bodyText(request.body, "sourceId"));
      return { job: worker.refresh(request.params.id) };
    });
    app.post<{ Params: RepositoryParams }>(`${base}/refresh`, async (request) => {
      emptyBody(request.body);
      index.getRepository(request.params.id);
      return { job: worker.refresh(request.params.id) };
    });
    app.delete<{ Params: RepositoryParams }>(`${base}/cache`, async (request) => {
      emptyBody(request.body);
      index.getRepository(request.params.id);
      return { job: worker.clearCache(request.params.id) };
    });
    app.get<{ Params: { id: string } }>("/api/v1/jobs/:id", async request => {
      try { return { job: index.getJob(request.params.id) }; }
      catch (error) { if (!(error instanceof StoreError) || error.code !== "JOB_NOT_FOUND") throw error; }
      return { job: library.getJob(request.params.id) };
    });
    const staticRoot = resolve(options.staticRoot ?? fileURLToPath(new URL("./web/", import.meta.url)));
    if (existsSync(staticRoot)) {
      await app.register(fastifyStatic, { root: staticRoot, allowedPath: (path) => {
        try {
          const file = resolve(staticRoot, `.${path}`, path.endsWith("/") ? "index.html" : "");
          const local = relative(staticRoot, file);
          if (!local || local === ".." || local.startsWith(`..${sep}`)) return false;
          let current = staticRoot;
          for (const part of local.split(sep)) {
            current = join(current, part);
            if (lstatSync(current).isSymbolicLink()) return false;
          }
          return realpathSync(file) === file;
        } catch { return false; }
      } });
    }
    await app.listen({ host: "127.0.0.1", port: requestedPort });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new DiagnosticError("未取得本地监听端口", { key: "diagnostics.server.m019" });
    instance.port = address.port;
    await writeInstance(home, instance);
    if (options.startupRefresh !== false) {
      worker.refreshSessions();
      for (const repository of index.listRepositories()) worker.refresh(repository.id);
    }
    return { app, instance, close: () => app.close() };
  } catch (error) {
    await app.close().catch(() => undefined);
    await manager?.close().catch(() => undefined);
    try { store?.close(); } catch { /* 初始化失败时可能已关闭。 */ }
    try { sessions?.close(); } catch { /* 初始化失败时可能已关闭。 */ }
    try { resourceManager?.close(); } catch { /* 初始化失败时可能已关闭。 */ }
    await release();
    throw error;
  }
}
