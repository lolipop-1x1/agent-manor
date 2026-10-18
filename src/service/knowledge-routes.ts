import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ApiErrorCode } from "../contracts.js";
import type { KnowledgeAvailability, KnowledgeDetail, KnowledgeDraft, KnowledgeExtractionScope, KnowledgeQuery, KnowledgeReview, KnowledgeReviewInput, KnowledgeRevisionInput, KnowledgeSettingsInput, KnowledgeSourceReader } from "../knowledge-contracts.js";
import { knowledgeTypes } from "../knowledge-contracts.js";
import { KnowledgeStore, KnowledgeError } from "../knowledge/store.js";
import { KnowledgeManager } from "../knowledge/manager.js";
import { defaultKnowledgeConfig, KnowledgeModelError } from "../knowledge/config.js";
import { KnowledgeSemantic } from "../knowledge/semantic.js";
import { SemanticError } from "../semantic/config.js";
import { ServiceError, textValue } from "./input.js";

const prefix = "/api/v1/knowledge";
function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ServiceError("INVALID_INPUT", "Expected a JSON object", { key: "knowledge.errors.request_invalid" });
  return value as Record<string, unknown>;
}
function enumeration<T extends string>(value: unknown, choices: readonly T[], key: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !choices.includes(value as T)) throw new ServiceError("INVALID_INPUT", `Invalid ${key}`, { key: "knowledge.errors.request_invalid" });
  return value as T;
}
function query(input: unknown): KnowledgeQuery {
  const raw = object(input), result: KnowledgeQuery = {};
  for (const key of ["q", "project", "client", "tag", "taskId"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") throw new ServiceError("INVALID_INPUT", `Invalid ${key}`, { key: "knowledge.errors.request_invalid" });
    if (raw[key] !== undefined) result[key] = raw[key] as string;
  }
  result.view = enumeration(raw.view, ["all", "personal", "project", "general"], "view");
  result.review = enumeration(raw.review, ["pending", "reviewed", "rejected", "all"], "review");
  result.availability = enumeration(raw.availability, ["active", "deprecated", "expired", "superseded", "resolved", "all"], "availability");
  result.type = enumeration(raw.type, knowledgeTypes, "type");
  for (const key of ["from", "to"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string" || !Number.isFinite(Date.parse(raw[key] as string))) throw new ServiceError("INVALID_INPUT", `Invalid ${key}`, { key: "knowledge.errors.request_invalid" });
    result[key] = raw[key] as string;
  }
  for (const key of ["page", "pageSize"] as const) {
    if (raw[key] === undefined) continue;
    const value = typeof raw[key] === "string" && /^\d+$/.test(raw[key]) ? Number(raw[key]) : raw[key];
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > (key === "page" ? 1_000_000 : 200)) throw new ServiceError("INVALID_INPUT", `Invalid ${key}`, { key: "knowledge.errors.request_invalid" });
    result[key] = Number(value);
  }
  return result;
}

/** 审阅属于页面明确的管理动作，普通 Agent 实例调用不能自报人工确认。 */
function management(request: FastifyRequest): void {
  if (request.headers["x-agent-manor-instance"] !== undefined || request.headers["sec-fetch-site"] !== "same-origin") {
    throw new ServiceError("FORBIDDEN", "Review and availability changes require the local management page", { key: "knowledge.errors.management_required" });
  }
}

export async function knowledgeRequest<T>(operation: () => Promise<T> | T): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ServiceError) throw error;
    if (error instanceof KnowledgeError) {
      const code: ApiErrorCode = error.code === "CONFLICT" ? "CONTENT_STALE" : error.code === "NOT_FOUND" ? "SOURCE_NOT_FOUND" : "INVALID_INPUT";
      throw new ServiceError(code, error.message, error.messageDescriptor ?? { key: `knowledge.errors.${error.code.toLowerCase()}` });
    }
    if (error instanceof KnowledgeModelError || error instanceof SemanticError) {
      const status = error.status ?? 500;
      throw new ServiceError(status === 404 ? "JOB_NOT_FOUND" : status >= 400 && status < 409 ? "INVALID_INPUT" : "ANALYSIS_NOT_READY", error.message, error.messageDescriptor);
    }
    throw error;
  }
}

export function registerKnowledgeRoutes(app: FastifyInstance, store: KnowledgeStore, manager: KnowledgeManager, sources: KnowledgeSourceReader, semantic: KnowledgeSemantic): void {
  const params = (request: FastifyRequest) => request.params as { id: string; revisionId?: string };
  const verified = async (detail: KnowledgeDetail): Promise<KnowledgeDetail> => {
    const revisions = new Map(detail.revisions.map(revision => [revision.id, revision]));
    revisions.set(detail.revision.id, detail.revision);
    if (detail.pendingRevision) revisions.set(detail.pendingRevision.id, detail.pendingRevision);
    for (const revision of revisions.values()) {
      if (revision.sources) revision.sources = await Promise.all(revision.sources.map(source => sources.verify(source)));
    }
    return { ...detail, revision: revisions.get(detail.revision.id)!,
      pendingRevision: detail.pendingRevision ? revisions.get(detail.pendingRevision.id) : undefined,
      revisions: detail.revisions.map(revision => revisions.get(revision.id)!) };
  };
  app.get(`${prefix}/entries`, async request => knowledgeRequest(() => store.list(query(request.query))));
  app.post(`${prefix}/search`, async request => knowledgeRequest(() => {
    const body = object(request.body);
    const mode = enumeration(body.mode, ["keyword", "semantic"], "mode") ?? "keyword";
    const value = query(body);
    return mode === "semantic" ? semantic.search(value) : store.list(value);
  }));
  app.get(`${prefix}/facets`, async () => knowledgeRequest(() => store.facets()));
  app.post(`${prefix}/entries`, { bodyLimit: 2_097_152 }, async request => knowledgeRequest(() => {
    const { idempotencyKey, ...input } = object(request.body);
    return store.create(input as unknown as KnowledgeDraft, textValue(idempotencyKey, "idempotencyKey"));
  }));
  app.get(`${prefix}/entries/:id`, async request => knowledgeRequest(async () => {
    const raw = object(request.query);
    return verified(store.get(params(request).id, { revisionId: textValue(raw.revisionId, "revisionId"),
      review: enumeration(raw.review, ["all", "pending", "reviewed", "rejected"], "review") as KnowledgeReview | "all" | undefined,
      availability: enumeration(raw.availability, ["all", "active", "deprecated", "expired", "superseded", "resolved"], "availability") as KnowledgeAvailability | "all" | undefined }));
  }));
  app.post(`${prefix}/entries/:id/revisions`, { bodyLimit: 2_097_152 }, async request => knowledgeRequest(() => {
    const { idempotencyKey, ...input } = object(request.body);
    return store.revise(params(request).id, input as unknown as KnowledgeRevisionInput, textValue(idempotencyKey, "idempotencyKey"));
  }));
  app.get(`${prefix}/entries/:id/revisions`, async request => knowledgeRequest(async () => {
    const detail = await verified(store.get(params(request).id, { review: "all", availability: "all" }));
    return { revisions: detail.revisions };
  }));
  app.get(`${prefix}/entries/:id/revisions/:revisionId`, async request => knowledgeRequest(async () => {
    const detail = await verified(store.get(params(request).id, { revisionId: params(request).revisionId, review: "all", availability: "all" }));
    return detail.revision;
  }));
  app.post(`${prefix}/entries/:id/reviews`, async request => knowledgeRequest(() => { management(request); return store.review(params(request).id, object(request.body) as unknown as KnowledgeReviewInput); }));
  app.post(`${prefix}/entries/:id/availability`, async request => knowledgeRequest(() => { management(request); return store.setAvailability(params(request).id, object(request.body) as unknown as { availability: "active" | "deprecated" | "superseded"; reason?: string }); }));
  app.post(`${prefix}/entries/:id/restore`, async request => knowledgeRequest(() => {
    const body = object(request.body);
    return store.restore(params(request).id, textValue(body.revisionId, "revisionId", true)!, textValue(body.baseRevisionId, "baseRevisionId", true)!, textValue(body.idempotencyKey, "idempotencyKey"));
  }));
  app.get(`${prefix}/settings/defaults`, async request => {
    const language = enumeration(object(request.query).language, ["zh-CN", "en"], "language");
    return { config: defaultKnowledgeConfig(language) };
  });
  app.get(`${prefix}/settings`, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return knowledgeRequest(() => manager.settings(enumeration(object(request.query).language, ["zh-CN", "en"], "language")));
  });
  app.put(`${prefix}/settings`, async request => knowledgeRequest(() => manager.saveSettings(object(request.body) as unknown as KnowledgeSettingsInput)));
  app.post(`${prefix}/test`, async request => knowledgeRequest(() => {
    const input = object(request.body);
    return manager.test(Object.keys(input).length ? input as unknown as KnowledgeSettingsInput : undefined);
  }));
  app.post(`${prefix}/extractions/preview`, async request => knowledgeRequest(() => manager.preview(object(request.body).scope as KnowledgeExtractionScope)));
  app.get(`${prefix}/extractions/previews/:id`, async request => knowledgeRequest(() => manager.previewById(params(request).id)));
  app.post(`${prefix}/extractions`, async request => knowledgeRequest(() => {
    const body = object(request.body);
    return manager.start(textValue(body.previewId, "previewId", true)!, textValue(body.idempotencyKey, "idempotencyKey"));
  }));
  app.get(`${prefix}/extractions`, async (_request, reply) => { reply.header("Cache-Control", "no-store"); return knowledgeRequest(() => manager.status()); });
  app.get(`${prefix}/extractions/:id`, async request => knowledgeRequest(() => manager.job(params(request).id)));
  for (const action of ["pause", "resume", "retry"] as const) app.post(`${prefix}/extractions/:id/${action}`, async request => knowledgeRequest(() => manager.action(params(request).id, action)));
  app.post(`${prefix}/prompts/try`, async request => knowledgeRequest(() => {
    const body = object(request.body);
    return manager.tryExtract(body.scope as KnowledgeExtractionScope, body.settings as KnowledgeSettingsInput | undefined);
  }));
  app.get(`${prefix}/index/status`, async (_request, reply) => { reply.header("Cache-Control", "no-store"); return knowledgeRequest(() => semantic.status()); });
  app.post(`${prefix}/index/preview`, async () => knowledgeRequest(() => semantic.preview()));
  app.post(`${prefix}/index/build`, async request => knowledgeRequest(() => semantic.build(textValue(object(request.body).previewId, "previewId", true)!)));
  for (const action of ["pause", "resume"] as const) app.post(`${prefix}/index/${action}`, async () => knowledgeRequest(() => semantic.action(action)));
}
