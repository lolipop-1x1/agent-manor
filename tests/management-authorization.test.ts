import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { managementDigest, registerManagementRoutes, requireManagement } from "../src/service/management.js";
import { knowledgeDraft, knowledgeFixture } from "./helpers/knowledge-fixture.js";
import type { KnowledgeDetail } from "../src/knowledge-contracts.js";

test("管理授权绑定实例、请求内容和方法，单次消费且不接受通用确认", async () => {
  const app = Fastify();
  registerManagementRoutes(app);
  const path = "/knowledge/entries/synthetic-entry/reviews";
  app.post(`/api/v1${path}`, async request => { requireManagement(request); return { accepted: true }; });
  app.setErrorHandler((error, _request, reply) => { reply.code(403).send({ error: String(error) }); });
  const headers = { "x-agent-manor-instance": "synthetic-instance-identity" };
  const operation = { method: "POST", path, body: { revisionId: "synthetic-revision", action: "approve" } };
  const grant = async () => {
    const result = await app.inject({ method: "POST", url: "/api/v1/management/authorizations", headers, payload: { ...operation, confirmation: managementDigest(operation) } });
    assert.equal(result.statusCode, 200); assert.equal(result.headers["cache-control"], "no-store");
    return result.json<{ token: string }>().token;
  };
  try {
    const unconfirmed = await app.inject({ method: "POST", url: "/api/v1/management/authorizations", headers, payload: { ...operation, confirmation: "yes" } });
    assert.equal(unconfirmed.statusCode, 403);
    const forbiddenPath = { ...operation, path: "/stop" };
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/management/authorizations", headers, payload: { ...forbiddenPath, confirmation: managementDigest(forbiddenPath) } })).statusCode, 403);
    const token = await grant();
    const authorizedHeaders = { ...headers, "x-agent-manor-management": token };
    assert.equal((await app.inject({ method: "POST", url: `/api/v1${path}`, headers: authorizedHeaders, payload: operation.body })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: `/api/v1${path}`, headers: authorizedHeaders, payload: operation.body })).statusCode, 403);
    const changed = await grant();
    assert.equal((await app.inject({ method: "POST", url: `/api/v1${path}`, headers: { ...headers, "x-agent-manor-management": changed }, payload: { ...operation.body, revisionId: "other-revision" } })).statusCode, 403);
    const otherInstance = await grant();
    assert.equal((await app.inject({ method: "POST", url: `/api/v1${path}`, headers: { "x-agent-manor-instance": "other-instance", "x-agent-manor-management": otherInstance }, payload: operation.body })).statusCode, 403);
  } finally { await app.close(); }
});

test("知识 CLI 可明确授权发布；旧修订和无授权的凭据读取继续拒绝", async () => knowledgeFixture(async ({ service, agent }) => {
  const created = await agent<KnowledgeDetail>("/entries", "POST", knowledgeDraft());
  const headers = { host: `127.0.0.1:${service.instance.port}`, "x-agent-manor-instance": service.instance.id };
  const authorize = async (path: string, body: unknown) => {
    const operation = { method: "POST", path, body };
    const response = await service.app.inject({ method: "POST", url: "/api/v1/management/authorizations", headers, payload: { ...operation, confirmation: managementDigest(operation) } });
    assert.equal(response.statusCode, 200);
    return { ...headers, "x-agent-manor-management": response.json<{ token: string }>().token };
  };
  const reviewPath = `/knowledge/entries/${created.id}/reviews`;
  const body = { revisionId: created.latestRevisionId, baseRevisionId: created.latestRevisionId, action: "approve" };
  const response = await service.app.inject({ method: "POST", url: `/api/v1${reviewPath}`, headers: await authorize(reviewPath, body), payload: body });
  assert.equal(response.statusCode, 200); assert.equal(response.json<KnowledgeDetail>().revision.review, "reviewed");
  const availabilityPath = `/knowledge/entries/${created.id}/availability`;
  const availability = { availability: "deprecated", baseRevisionId: created.latestRevisionId };
  const staleHeaders = await authorize(availabilityPath, availability);
  await agent(`/entries/${created.id}/revisions`, "POST", { ...knowledgeDraft({ body: "Synthetic changed content" }), baseRevisionId: created.latestRevisionId });
  assert.equal((await service.app.inject({ method: "POST", url: `/api/v1${availabilityPath}`, headers: staleHeaders, payload: availability })).statusCode, 409);
  const key = await service.app.inject({ method: "GET", url: "/api/v1/semantic/key", headers });
  assert.equal(key.statusCode, 403);
}));
