import { DiagnosticError } from "./i18n/diagnostics.js";
import Fastify from "fastify";
import type { FastifyRequest, FastifyReply } from "fastify";
import { SessionSearchManager } from "./sessions/search-manager.js";
import type { SearchOperation } from "./sessions/search-manager.js";
import type { SessionQuery } from "./session-contracts.js";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiErrorCode, DeleteRepositoryResponse, RegisterRepositoryResponse, ServiceInstance } from "./contracts.js";
import type { DiscoverRoots } from "./history/index.js";
import { AnalysisStore, StoreError, WorkerManager } from "./index/index.js";
import { VERSION } from "./version.js";
import { bodyText, emptyBody, integer, ServiceError } from "./service/input.js";
import { acquireLock, dataHome, removeInstance, writeInstance } from "./service/runtime.js";
import { SessionStore } from "./sessions/store.js";
import { queryBoolean, sessionMessageQuery, sessionProfileQuery, sessionQuery, sessionRefreshOptions, sessionTimelineQuery } from "./service/session-input.js";
import { textValue } from "./service/input.js";
import { clientIds } from "./clients.js";
import type { Client } from "./contracts.js";
import type { ResourceInventoryOptions } from "./resource-inventory-contracts.js";
import { ResourceManager } from "./resources/management.js";
import { ResourceUsageManager } from "./resources/usage-manager.js";
import { ResourceService } from "./resources/service.js";
import { registerResourceRoutes } from "./service/resource-routes.js";
import { readPreferences, registerPreferenceRoutes, subscribePreferences } from "./service/preferences.js";
import { SessionAutoSyncScheduler, type SessionAutoSyncClock } from "./service/session-auto-sync.js";
import { compactIndexAtStartup } from "./index/maintenance.js";
import { PricingService } from "./usage/pricing.js";
import { registerUsageRoutes } from "./service/usage-routes.js";
import { UsageManager } from "./usage/manager.js";
import { OverviewManager } from "./overview/manager.js";
import { registerOverviewRoutes } from "./service/overview-routes.js";
import { SemanticManager } from "./semantic/manager.js";
import { registerSemanticRoutes, semanticRequest } from "./service/semantic-routes.js";
import { defaultSemanticConfig } from "./semantic/config.js";
import type { SemanticSearchQuery } from "./semantic-contracts.js";
import { registerReplayRoutes } from "./service/replay-routes.js";
import { ReplayManager } from "./replay/manager.js";
import { MapQueryManager } from "./analysis/query-manager.js";
import { registerMapQueryRoutes } from "./service/map-query-routes.js";
import { KnowledgeStore } from "./knowledge/store.js";
import { KnowledgeManager } from "./knowledge/manager.js";
import { KnowledgeSources } from "./knowledge/sources.js";
import { KnowledgeSemantic } from "./knowledge/semantic.js";
import { registerKnowledgeRoutes } from "./service/knowledge-routes.js";

export interface ServiceOptions {
  home?: string;
  port?: number;
  roots?: DiscoverRoots;
  staticRoot?: string;
  startupRefresh?: boolean;
  sessionsAutoSyncClock?: SessionAutoSyncClock;
  resourceInventory?: ResourceInventoryOptions;
  usagePricing?: { fetch?: typeof globalThis.fetch; now?: () => Date };
}

function statusCode(code: ApiErrorCode): number {
  if (code === "INVALID_INPUT") return 400;
  if (code === "FORBIDDEN") return 403;
  if (code === "ANALYSIS_NOT_READY" || code === "CONTENT_STALE") return 409;
  if (code === "INTERNAL_ERROR") return 500;
  return 404;
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
  let resourceHistory: ResourceUsageManager | undefined;
  let pricing: PricingService | undefined;
  let usageManager: UsageManager | undefined;
  let overviewManager: OverviewManager | undefined;
  let searchManager: SessionSearchManager | undefined;
  let replayManager: ReplayManager | undefined;
  let mapQueryManager: MapQueryManager | undefined;
  let semanticManager: SemanticManager | undefined;
  let knowledgeStore: KnowledgeStore | undefined;
  let knowledgeManager: KnowledgeManager | undefined;
  let knowledgeSources: KnowledgeSources | undefined;
  let knowledgeSemantic: KnowledgeSemantic | undefined;
  let autoSync: SessionAutoSyncScheduler | undefined;
  let unsubscribePreferences: (() => void) | undefined;
  const app = Fastify({ logger: false, bodyLimit: 65_536, forceCloseConnections: true });
  const instance: ServiceInstance = { id: randomUUID(), pid: process.pid, host: "127.0.0.1", port: requestedPort, startedAt: new Date().toISOString() };
  try {
    const indexMaintenance = await compactIndexAtStartup(home);
    store = new AnalysisStore(join(home, "index.sqlite"));
    sessions = new SessionStore(store.dbPath);
    manager = new WorkerManager(store, { roots: options.roots }, sessions);
    const index = store;
    const library = sessions;
    const semanticQuery = (raw: Record<string, unknown>): SemanticSearchQuery => {
      const query = sessionQuery(raw);
      if (query.version && query.version !== library.currentVersion()) throw new ServiceError("CONTENT_STALE", "Semantic search requires the current history version");
      const scope = { ...defaultSemanticConfig().scope, timeRange: "all" as const,
        clients: query.client ? [query.client] : [], projects: query.project ? [query.project === "none" ? "" : query.project] : [],
        from: query.from, to: query.to, executionMode: query.executionMode === "quiet" ? "quiet" as const : query.executionMode === "all" ? "all" as const : "exclude_quiet" as const,
        relationship: queryBoolean(raw.includeSubagents, "includeSubagents") ? "all" as const : "exclude_children" as const, ...query.scope };
      const sort = textValue(raw.sort, "sort");
      if (sort && sort !== "relevance" && sort !== "updated") throw new ServiceError("INVALID_INPUT", "Unknown semantic sort");
      return { q: query.q ?? "", scope, page: query.page, pageSize: query.pageSize, sort: sort as SemanticSearchQuery["sort"], sessionId: textValue(raw.sessionId, "sessionId") };
    };
    searchManager = new SessionSearchManager(library);
    replayManager = new ReplayManager(index, library);
    mapQueryManager = new MapQueryManager(index);
    semanticManager = new SemanticManager(home, library);
    knowledgeStore = new KnowledgeStore(join(home, "knowledge", "knowledge.sqlite"));
    knowledgeSources = new KnowledgeSources(library.dbPath);
    knowledgeManager = new KnowledgeManager(home, knowledgeStore, knowledgeSources, {
      similarity: (candidate, others, config, signal) => knowledgeSemantic?.compareCandidates(candidate, others, config, signal) ?? Promise.resolve(undefined),
    });
    knowledgeSemantic = new KnowledgeSemantic(home, knowledgeStore, knowledgeManager, semanticManager);
    const searches = searchManager;
    const search = async (request: FastifyRequest, reply: FastifyReply, type: SearchOperation, query: SessionQuery & { sessionId?: string }) => {
      const controller = new AbortController();
      const cancel = () => { if (!reply.raw.writableFinished) controller.abort(); };
      request.raw.once("aborted", cancel); reply.raw.once("close", cancel);
      if (request.raw.aborted || reply.raw.destroyed) controller.abort();
      try { return await searches.execute(type, query, controller.signal); }
      finally { request.raw.removeListener("aborted", cancel); reply.raw.removeListener("close", cancel); }
    };
    const worker = manager;
    autoSync = new SessionAutoSyncScheduler(worker, library.globalCheckState(), options.sessionsAutoSyncClock);
    const sync = autoSync;
    let syncInterval = 0;
    // 偏好损坏不能阻止显式语言覆盖或手动检查；保留原文件和偏好接口的真实错误。
    try { syncInterval = (await readPreferences(home)).sessionsAutoRefreshInterval; }
    catch { /* 无法读取策略时不安排后台自动检查。 */ }
    unsubscribePreferences = subscribePreferences(home, preferences => {
      syncInterval = preferences.sessionsAutoRefreshInterval;
      sync.updateInterval(syncInterval);
    });
    const sessionStatus = (summary: boolean) => {
      const active = worker.activeSessionJobs();
      const job = active.find(candidate => candidate.status === "running") ?? active.find(candidate => candidate.status === "queued");
      return { ...(summary ? library.statusSummary() : library.status()), ...(job ? { job } : {}), autoSync: sync.status() };
    };
    resourceManager = new ResourceManager(home);
    pricing = new PricingService(home, options.usagePricing);
    usageManager = new UsageManager(library, pricing, join(home, "usage-rollups.sqlite"));
    overviewManager = new OverviewManager(library, pricing, () => index.listRepositories(), undefined, usageManager);
    const management = resourceManager;
    resourceHistory = new ResourceUsageManager(library);
    const resources = new ResourceService(library, management, options.resourceInventory ?? { environment: process.env }, () =>
      [...new Set([...index.listRepositories().map(repository => repository.path), ...library.status().projects])], resourceHistory);
    app.addHook("onClose", async () => {
      unsubscribePreferences?.();
      sync.close();
      await knowledgeSemantic?.close();
      await knowledgeManager?.close();
      await knowledgeSources?.close();
      knowledgeStore?.close();
      await semanticManager?.close();
      await searchManager?.close();
      await replayManager?.close();
      await mapQueryManager?.close();
      await resourceHistory?.close();
      await overviewManager?.close();
      await usageManager?.close();
      await worker.close();
      index.close();
      library.close();
      management.close();
      pricing?.close();
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
    registerUsageRoutes(app, usageManager, pricing, library);
    registerOverviewRoutes(app, overviewManager);
    registerSemanticRoutes(app, semanticManager);
    registerReplayRoutes(app, replayManager);
    registerMapQueryRoutes(app, mapQueryManager);
    registerKnowledgeRoutes(app, knowledgeStore, knowledgeManager, knowledgeSources, knowledgeSemantic);
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
    app.get<{ Querystring: Record<string, unknown> }>("/api/v1/status", async request => ({ instance, version: VERSION, repositories: index.listRepositories(), jobs: index.listJobs(),
      sessions: sessionStatus(queryBoolean(request.query.summary, "summary")), indexMaintenance, indexReclaim: worker.reclaimStatus }));
    app.post("/api/v1/stop", async (request, reply) => {
      emptyBody(request.body);
      reply.send({ stopping: true });
      setImmediate(() => { void app.close(); });
    });
    app.get("/api/v1/repositories", async () => ({ repositories: index.listRepositories() }));
    app.post("/api/v1/repositories", async (request): Promise<RegisterRepositoryResponse> => {
      const path = bodyText(request.body, "path");
      let result;
      try { result = await index.registerRepositoryResult(path); }
      catch { throw new ServiceError("INVALID_INPUT", "path 必须是可读取的 Git 仓库", { key: "diagnostics.server.m013" }); }
      return result.created ? { repository: result.repository, job: worker.refresh(result.repository.id) } : { repository: result.repository };
    });
    const base = "/api/v1/repositories/:id";
    type RepositoryParams = { id: string };
    type Query = Record<string, unknown>;
    app.delete<{ Params: RepositoryParams }>(base, async (request): Promise<DeleteRepositoryResponse> => {
      emptyBody(request.body);
      worker.deleteRepository(request.params.id);
      return { repositoryId: request.params.id };
    });
    app.get<{ Querystring: Query }>("/api/v1/sessions/status", async request => sessionStatus(queryBoolean(request.query.summary, "summary")));
    app.get("/api/v1/sessions/facets", async () => library.searchFacets());
    app.get<{ Querystring: Query }>("/api/v1/sessions/gaps", async request => library.indexGaps(textValue(request.query.version, "version")));
    app.get<{ Querystring: Query }>("/api/v1/sessions", async (request, reply) => {
      const query = sessionQuery(request.query);
      return query.q?.trim() ? search(request, reply, "list", query) : library.list(query);
    });
    app.get<{ Querystring: Query }>("/api/v1/sessions/search/groups", async (request, reply) => request.query.mode === "semantic"
      ? semanticRequest(() => semanticManager!.search(semanticQuery(request.query))) : search(request, reply, "groups", sessionQuery(request.query)));
    app.get<{ Params: { id: string }; Querystring: Query }>("/api/v1/sessions/:id/turns", async request => library.turnDirectory(request.params.id, sessionMessageQuery(request.query)));
    app.get<{ Params: { id: string }; Querystring: Query }>("/api/v1/sessions/:id/matches", async (request, reply) => search(request, reply, "matches", { ...sessionQuery(request.query), sessionId: request.params.id }));
    app.get<{ Querystring: Query }>("/api/v1/sessions/search", async (request, reply) => {
      const query = sessionQuery(request.query);
      if (!query.q) throw new ServiceError("INVALID_INPUT", "搜索需要 q", { key: "diagnostics.server.m014" });
      if (request.query.mode === "semantic") {
        const result = await semanticRequest(() => semanticManager!.search(semanticQuery(request.query)));
        return { ...result, hits: result.groups.flatMap(group => group.hits) };
      }
      if (request.query.mode !== undefined && request.query.mode !== "keyword") throw new ServiceError("INVALID_INPUT", "Unknown search mode");
      return search(request, reply, "records", { ...query, sessionId: textValue(request.query.sessionId, "sessionId") });
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
    app.get<{ Params: { id: string }; Querystring: Query }>("/api/v1/sessions/:id/timeline", async request => library.timeline(request.params.id, sessionTimelineQuery(request.query)));
    app.get<{ Params: { id: string }; Querystring: Query }>("/api/v1/sessions/:id/profile", async request => library.profile(request.params.id, sessionProfileQuery(request.query)));
    app.post("/api/v1/sessions/refresh", async request => ({ job: worker.refreshSessions(false, sessionRefreshOptions(request.body)) }));
    app.post("/api/v1/sessions/auto-refresh", async request => {
      emptyBody(request.body);
      return { job: worker.autoRefreshSessions(Date.now(), sync.status().intervalMs) };
    });
    registerResourceRoutes(app, resources);
    app.delete("/api/v1/sessions/cache", async request => { emptyBody(request.body); return { job: worker.refreshSessions(true) }; });
    app.post<{ Params: RepositoryParams }>(`${base}/associations`, async (request) => {
      index.associateSource(request.params.id, bodyText(request.body, "sourceId"));
      return { job: worker.refresh(request.params.id) };
    });
    app.post<{ Params: RepositoryParams }>(`${base}/refresh`, async (request) => {
      emptyBody(request.body);
      index.getRepository(request.params.id);
      return { job: worker.refresh(request.params.id) };
    });
    app.post<{ Params: RepositoryParams }>(`${base}/auto-refresh`, async request => {
      emptyBody(request.body);
      const { mapAutoRefreshInterval } = await readPreferences(home);
      return { job: worker.autoRefreshRepository(request.params.id, Date.now(), mapAutoRefreshInterval) };
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
    usageManager.start();
    if (options.startupRefresh !== false) {
      worker.refreshSessions();
      for (const repository of index.listRepositories()) worker.refresh(repository.id);
    }
    sync.updateInterval(syncInterval);
    return { app, instance, close: () => app.close() };
  } catch (error) {
    unsubscribePreferences?.();
    autoSync?.close();
    await app.close().catch(() => undefined);
    await knowledgeSemantic?.close().catch(() => undefined);
    await knowledgeManager?.close().catch(() => undefined);
    await knowledgeSources?.close().catch(() => undefined);
    try { knowledgeStore?.close(); } catch { /* 初始化失败时可能已关闭。 */ }
    await semanticManager?.close().catch(() => undefined);
    await manager?.close().catch(() => undefined);
    await searchManager?.close().catch(() => undefined);
    await replayManager?.close().catch(() => undefined);
    await mapQueryManager?.close().catch(() => undefined);
    await resourceHistory?.close().catch(() => undefined);
    await usageManager?.close().catch(() => undefined);
    await overviewManager?.close().catch(() => undefined);
    try { store?.close(); } catch { /* 初始化失败时可能已关闭。 */ }
    try { sessions?.close(); } catch { /* 初始化失败时可能已关闭。 */ }
    try { resourceManager?.close(); } catch { /* 初始化失败时可能已关闭。 */ }
    pricing?.close();
    await release();
    throw error;
  }
}
