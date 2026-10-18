import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalysisStore } from "../dist/index/store.js";
import { SessionStore } from "../dist/sessions/store.js";
import { KnowledgeStore } from "../dist/knowledge/store.js";
import { KnowledgeConfigStore, defaultKnowledgeConfig } from "../dist/knowledge/config.js";
import { knowledgeMessageHash } from "../dist/knowledge/source-reader.js";
import { writePreferences } from "../dist/service/preferences.js";
import { clientIds } from "../dist/clients.js";
import { startService } from "../dist/server.js";

// 浏览器验收只使用临时合成历史、知识、凭据和本机模拟模型。
export async function knowledgeFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-knowledge-e2e-"))), home = join(directory, "data"); await mkdir(home);
  new AnalysisStore(join(home, "index.sqlite")).close();
  const sessions = new SessionStore(join(home, "index.sqlite")), revisions = [], firstMessages = [];
  for (let index = 0; index < 3; index++) {
    const id = `knowledge-session-${index}`, path = `/synthetic/history/${id}.jsonl`, pending = sessions.createRevision(path, "synthetic");
    let ordinal = 0;
    for (let turn = 1; turn <= 4; turn++) for (const [kind, text, extra] of [
      ["user", `请排查合成配置，第 ${turn} 轮`, {}], ["tool_call", "读取合成配置", { callId: `synthetic-call-${turn}`, tool: "Read" }],
      ["tool_result", "发现静态快照，动态切换验证已通过", { callId: `synthetic-call-${turn}`, status: "success" }], ["assistant", "已核对读取链路并验证动态切换", { final: "explicit" }],
    ]) {
      const message = { id: `${id}:message:${ordinal}`, sessionId: id, ordinal, recordLine: ordinal + 1, turnId: `${id}:turn:${turn}`, kind, text, occurredAt: new Date(Date.now() - 86_400_000 + ordinal * 1000).toISOString(), ...extra };
      if (index === 0 && ordinal === 2) firstMessages.push(message);
      pending.sink.message(message); ordinal++;
    }
    pending.flush(); sessions.finishRevision(pending.revision, { id, client: index === 2 ? "claude" : "codex", clientSessionId: id, path, sourceId: id, title: `合成排障会话 ${index + 1}`, titleOrigin: "recorded", project: `/synthetic/projects/${index === 2 ? "beta" : "atlas"}`, messageCount: ordinal, turnCount: 4, models: ["synthetic-model"], gaps: [], startedAt: new Date(Date.now() - 86_400_000).toISOString(), updatedAt: new Date(Date.now() - 3_600_000).toISOString() });
    revisions.push({ path, revision: pending.revision, fingerprint: "synthetic" });
  }
  const version = sessions.publish(sessions.createJob().id, revisions, []); sessions.close();
  const store = new KnowledgeStore(join(home, "knowledge", "knowledge.sqlite"));
  const source = { kind: "extraction", client: "codex", sessionId: "knowledge-session-0", sessionTitle: "合成排障会话 1", sourceVersion: version, branch: "current", messageId: firstMessages[0].id, turnId: firstMessages[0].turnId, turnPosition: 1, ordinal: 2, hash: knowledgeMessageHash(firstMessages[0]), excerpt: firstMessages[0].text };
  const main = store.create({ title: "配置更新后仍读取旧值", body: "## 适用场景\n服务端配置已更新，客户端仍读取旧值。\n\n## 排查方法\n先检查静态快照，再检查缓存。\n\n## 验证\n动态切换配置，核对客户端新值。", type: "procedure", subject: "project", scope: { kind: "project", project: "/synthetic/projects/atlas" }, language: "zh-CN", tags: ["动态配置", "排障"], sources: [source] });
  store.review(main.id, { revisionId: main.revision.id, action: "approve" });
  const { id: _id, knowledgeId: _knowledgeId, version: _version, createdAt: _created, review: _review, ...content } = main.revision;
  store.revise(main.id, { ...content, baseRevisionId: main.revision.id, body: `${content.body}\n\n## 新增验证\n覆盖断线重连后的配置恢复。`, changeReason: "补充断线重连验证" });
  for (let index = 0; index < 13; index++) {
    const personal = index % 4 === 1, general = index % 4 === 2;
    const entry = store.create({ title: ["代码评审保留证据", "按用途组织项目文档", "排障时先建立最小复现", "缓存失效的验证方法"][index % 4] + ` ${index + 1}`, body: "保留适用条件、验证方法与必要例外，依据实际结果修正结论。\n\n" + "人工合成知识正文。\n".repeat(3), type: ["constraint", "preference", "lesson", "fact"][index % 4], subject: personal ? "personal" : general ? "general" : "project", scope: personal || general ? { kind: "global" } : { kind: "project", project: `/synthetic/projects/${index % 2 ? "beta" : "atlas"}` }, language: "zh-CN", tags: [index % 2 ? "开发约定" : "验证"], sources: [{ kind: "manual", client: index % 2 ? "claude" : "codex" }] });
    store.review(entry.id, { revisionId: entry.revision.id, action: "approve" });
  }
  store.close();
  const calls = [];
  const model = createServer(async (request, response) => {
    const buffers = []; for await (const chunk of request) buffers.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(buffers).toString()), user = body.messages?.at(-1)?.content ?? "";
    calls.push({ path: request.url, at: Date.now() });
    await new Promise(resolve => setTimeout(resolve, 900));
    let payload; try { payload = JSON.parse(user.match(/<source_material>\s*([\s\S]*?)\s*<\/source_material>/)?.[1] ?? user); } catch { payload = {}; }
    let result = { ok: true };
    if (payload.evidence) {
      const refs = payload.evidence.map(item => item.reference).filter(Boolean).slice(0, 2);
      result = { disposition: "knowledge", candidates: [{ topic: "synthetic-browser-method", title: "合成会话的可复用验证方法", body: "从实际工具结果核对读取链路，再执行动态切换验证。", type: "procedure", tags: ["浏览器验收"], subject: "project", references: refs }], carry: [], needsMessageIds: [], limitations: [] };
    }
    if (payload.earlier && payload.later) result.relation = "complement";
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 80, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 } }));
  });
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  const config = defaultKnowledgeConfig(); config.generation.url = `http://127.0.0.1:${model.address().port}/v1`; config.generation.model = "synthetic-small-model"; config.generation.retries = 0;
  await new KnowledgeConfigStore(home).save({ config, generationKey: "synthetic-browser-key" });
  await writePreferences(home, "zh-CN");
  const service = await startService({ home, startupRefresh: false, roots: Object.fromEntries(clientIds.map(client => [client, []])), resourceInventory: { userHome: join(directory, "isolated"), environment: {} } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  return { directory, home, base, mainId: main.id, service, calls, close: async () => { await service.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await rm(directory, { recursive: true, force: true }); } };
}
