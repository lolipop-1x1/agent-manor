import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startService } from "../../src/server.js";
import { apiRequest, delay, RequestError } from "../../src/service/runtime.js";
import { AnalysisStore } from "../../src/index/store.js";
import { SessionStore } from "../../src/sessions/store.js";
import { isolatedHistoryRoots } from "./history-roots.js";
import type { KnowledgeDetail, KnowledgeDraft, KnowledgeIndexStatus, KnowledgeSettings } from "../../src/knowledge-contracts.js";

export const knowledgeDraft = (changes: Partial<KnowledgeDraft> = {}): KnowledgeDraft => ({
  title: "动态配置旧值的排查方法", body: "遇到配置更新而读取旧值时，检查静态快照和缓存，再验证动态切换。", type: "procedure", tags: ["配置", "排障"],
  scope: { kind: "project", project: "/projects/atlas" }, subject: "project", language: "zh-CN", sources: [{ kind: "agent", client: "codex" }], ...changes,
});
export interface ModelCall { path: string; input: string[]; model?: string; authorization?: string }
export interface KnowledgeFixture {
  home: string; service: Awaited<ReturnType<typeof startService>>; calls: ModelCall[]; modelUrl: string;
  agent<T>(path: string, method?: string, body?: unknown): Promise<T>;
  web<T>(path: string, body: unknown): Promise<T>;
}
export const requestError = (code: string) => (error: unknown): boolean => error instanceof RequestError && error.code === code;

export async function knowledgeFixture(run: (fixture: KnowledgeFixture) => Promise<void>, options: { delayMs?: number } = {}): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "manor-knowledge-http-"));
  const index = new AnalysisStore(join(home, "index.sqlite")); index.close();
  const sessions = new SessionStore(join(home, "index.sqlite")), sourcePath = "/synthetic/history/conversation.jsonl";
  const pending = sessions.createRevision(sourcePath, "synthetic-fingerprint");
  for (const [ordinal, kind, text] of [[1, "user", "检查配置客户端旧值"], [2, "assistant", "移除静态快照后动态切换验证通过"]] as const) pending.sink.message({
    id: `synthetic-message-${ordinal}`, sessionId: "synthetic-session", turnId: "synthetic-session:turn:1", ordinal, recordLine: ordinal,
    kind, text, occurredAt: "2026-01-01T10:00:00Z",
  });
  pending.flush(); sessions.finishRevision(pending.revision, { id: "synthetic-session", client: "codex", clientSessionId: "synthetic-native-session",
    title: "人工合成排障会话", titleOrigin: "recorded", path: sourcePath, sourceId: "synthetic-source", project: "/projects/atlas", messageCount: 2, turnCount: 1, models: [], gaps: [], updatedAt: "2026-01-01T10:00:00Z" });
  sessions.publish(sessions.createJob().id, [{ path: sourcePath, revision: pending.revision, fingerprint: "synthetic-fingerprint" }], []); sessions.close();
  const calls: ModelCall[] = [];
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { input?: string[]; model?: string };
    calls.push({ path: request.url ?? "", input: body.input ?? [], model: body.model, authorization: request.headers.authorization });
    await delay(options.delayMs ?? 10);
    response.setHeader("Content-Type", "application/json");
    if (request.url?.endsWith("/embeddings")) response.end(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0.5, 0.25] })), usage: { prompt_tokens: 12 } }));
    else { response.writeHead(400); response.end(JSON.stringify({ error: { message: "Synthetic generation endpoint was unexpectedly called" } })); }
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const address = model.address(); assert(address && typeof address !== "string");
  const service = await startService({ home, startupRefresh: false, roots: isolatedHistoryRoots({}), staticRoot: join(home, "absent"), resourceInventory: { userHome: join(home, "isolated"), environment: {} } });
  const agent = <T>(path: string, method = "GET", body?: unknown): Promise<T> => apiRequest(service.instance, `/knowledge${path}`, method, body);
  const web = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${service.instance.port}/api/v1/knowledge${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify(body),
    });
    const value = await response.json() as T | { error: { code: string; message: string } };
    if (!response.ok) { const failure = value as { error: { code: string; message: string } }; throw new RequestError(failure.error.code, failure.error.message); }
    return value as T;
  };
  try { await run({ home, service, calls, modelUrl: `http://127.0.0.1:${address.port}/v1`, agent, web }); }
  finally { await service.close(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
}

export async function approve(fixture: KnowledgeFixture, entry: KnowledgeDetail): Promise<KnowledgeDetail> {
  return fixture.web(`/entries/${entry.id}/reviews`, { revisionId: entry.latestRevisionId, baseRevisionId: entry.latestRevisionId, action: "approve" });
}
export async function independent(fixture: KnowledgeFixture): Promise<KnowledgeSettings> {
  const settings = await fixture.agent<KnowledgeSettings>("/settings");
  Object.assign(settings.config.embedding, { mode: "independent", connection: { url: fixture.modelUrl, model: "synthetic-embedding", dimensions: 3, documentPrefix: "passage: ", queryPrefix: "query: " } });
  return fixture.agent("/settings", "PUT", { config: settings.config, embeddingKey: "synthetic-embedding-secret" });
}
export async function waitIndex(fixture: KnowledgeFixture, status: KnowledgeIndexStatus["status"] = "ready"): Promise<KnowledgeIndexStatus> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const current = await fixture.agent<KnowledgeIndexStatus>("/index/status");
    if (current.status === status) return current;
    assert.notEqual(current.status, "failed", current.error);
    await delay(20);
  }
  assert.fail(`Synthetic knowledge index did not become ${status}`);
}
export async function waitCalls(fixture: KnowledgeFixture, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && fixture.calls.length < count; attempt++) await delay(5);
  assert.ok(fixture.calls.length >= count, "Synthetic model request did not start");
}
