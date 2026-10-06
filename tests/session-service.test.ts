import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startService } from "../src/server.js";
import { apiRequest, delay } from "../src/service/runtime.js";
import type { SessionIndexStatus, SessionJob, SessionListResult, SessionMessageResult, SessionProfile, SessionSearchResult, SessionTimelineResult } from "../src/session-contracts.js";
import { sessionFixture, encodeSession } from "../scripts/session-fixture.mjs";
import { SessionStore } from "../src/sessions/store.js";

test("全局 HTTP 和串行 Worker 完整发布三客户端、无项目会话及可定位的过程搜索", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-session-service-"));
  const roots = { codex: join(directory, "codex"), claude: join(directory, "claude"), codeflicker: join(directory, "codeflicker"), "codeflicker-desktop": [], dsh: [], pi: [], workbuddy: [], opencode: [], zcode: [], codebuddy: [], qoder: [] };
  const fixture = sessionFixture(join(directory, "unregistered-project"));
  for (const client of ["codex", "claude", "codeflicker"] as const) {
    await mkdir(roots[client]);
    await writeFile(join(roots[client], "demo.jsonl"), encodeSession(fixture[client]));
  }
  await writeFile(join(roots.codex, "orphan.jsonl"), encodeSession(fixture.orphan));
  await writeFile(join(roots.codeflicker, "quiet.jsonl"), encodeSession([{ type: "message", sessionId: "quiet-http-demo", uuid: "quiet-user",
    role: "user", content: "Quiet HTTP 合成样例", entrypoint: "sdk-cli", version: "0.3.26" }]));
  const service = await startService({ home: join(directory, "data"), roots });
  try {
    let status: SessionIndexStatus | undefined;
    for (let i = 0; i < 400; i++) {
      status = await apiRequest(service.instance, "/sessions/status");
      if (status?.job?.status === "failed") assert.fail(status.job.error);
      if (status?.version) break;
      await delay(25);
    }
    assert.ok(status?.version, "启动应自动发布全局索引");
    const list = await apiRequest<SessionListResult>(service.instance, "/sessions");
    assert.equal(list.total, 4);
    const codex = list.sessions.find(session => session.clientSessionId === "demo-codex")!;
    assert.ok(codex);
    assert.equal((await apiRequest<SessionListResult>(service.instance, "/sessions?project=none")).total, 1);
    assert.equal((await apiRequest<SessionListResult>(service.instance, "/sessions?client=codeflicker")).total, 1);
    const quiet = await apiRequest<SessionListResult>(service.instance, "/sessions?executionMode=quiet");
    assert.equal(quiet.total, 1);
    assert.equal(quiet.sessions[0]?.executionMode, "quiet");
    assert.equal((await apiRequest<SessionListResult>(service.instance, "/sessions?executionMode=all")).total, 5);
    assert.equal((await apiRequest<SessionSearchResult>(service.instance, "/sessions/search?q=Quiet&executionMode=regular")).total, 0);
    const quietSearch = await apiRequest<SessionSearchResult>(service.instance, "/sessions/search?q=Quiet&executionMode=quiet");
    assert.equal(quietSearch.total, 2, "标题与正文分别计为命中");
    assert.ok(quietSearch.hits.every(hit => hit.session.id === quiet.sessions[0]!.id));
    assert.equal((await apiRequest<SessionMessageResult>(service.instance, `/sessions/${quiet.sessions[0]!.id}/messages`)).total, 1);
    const profile = await apiRequest<SessionProfile>(service.instance, `/sessions/${codex.id}/profile`);
    assert.equal(profile.usage.inputTokens, 100, "重复 token_count 不累计");
    assert.equal(profile.usage.cachedInputTokens, 60);
    assert.equal(profile.usage.cacheReadRatio, 0.6);
    assert.ok(profile.steps[0]?.messageId, "请求步骤应定位实际用量记录");
    assert.equal(profile.tools.length, 2);
    assert.ok(profile.resources.some(resource => resource.kind === "mcp"));
    const base = await apiRequest<SessionSearchResult>(service.instance, "/sessions/search?q=局部轨迹标记");
    assert.equal(base.total, 0);
    const full = await apiRequest<SessionSearchResult>(service.instance, "/sessions/search?q=局部轨迹标记&kinds=user,assistant,tool_result");
    assert.equal(full.total, 1);
    const hit = full.hits[0]!;
    const messages = await apiRequest<SessionMessageResult>(service.instance, `/sessions/${codex.id}/messages?mode=trace&messageId=${hit.messageId}`);
    assert.ok(messages.messages.some(message => message.id === hit.messageId));
    const brief = await apiRequest<SessionMessageResult>(service.instance, `/sessions/${codex.id}/messages?mode=brief`);
    assert.equal(brief.session.turnCount, 1, "注入包不能增加用户轮次");
    assert.ok(brief.messages.every(message => message.kind !== "context"));
    const overview = await apiRequest<SessionTimelineResult>(service.instance, `/sessions/${codex.id}/timeline`);
    assert.equal(overview.version, list.version);
    assert.equal(overview.events.filter(event => event.kind === "context").length, 2);
    assert.ok(overview.events.every(event => !("text" in event)));
    assert.equal(overview.events.filter(event => event.usage).length, 1);
    assert.equal(brief.messages.filter(message => message.kind === "assistant").length, 1);
    assert.ok(brief.messages.some(message => message.final === "explicit"));
    const turnPage = await apiRequest<SessionMessageResult>(service.instance, `/sessions/${codex.id}/messages?mode=brief&pageUnit=turn`);
    assert.equal(turnPage.pageUnit, "turn");
    assert.equal(turnPage.pageSize, 10);
    assert.equal(turnPage.totalTurns, 1);
    assert.equal(turnPage.turns?.[0]?.messageCount, 2);
    const toolTarget = await apiRequest<SessionMessageResult>(service.instance, `/sessions/${codex.id}/messages?mode=trace&pageUnit=turn&toolName=shell_command`);
    assert.equal(toolTarget.messages.find(message => message.id === toolTarget.focusMessageId)?.tool, "shell_command");
    const resourceTarget = await apiRequest<SessionMessageResult>(service.instance, `/sessions/${codex.id}/messages?mode=trace&pageUnit=turn&resourceKind=mcp`);
    assert.equal(resourceTarget.messages.find(message => message.id === resourceTarget.focusMessageId)?.resource?.kind, "mcp");
    const locate = await apiRequest<{ target: { sessionId: string; messageId?: string } }>(service.instance, "/sessions/locate?client=codex&clientSessionId=demo-codex&callId=read-entry");
    assert.equal(locate.target.sessionId, codex.id);
    assert.ok(locate.target.messageId);
    for (const query of ["page=0", "kinds=unknown", "client=unknown", "from=invalid", "pageSize=999", "includeSubagents=wrong", "executionMode=unknown"]) {
      await assert.rejects(apiRequest(service.instance, `/sessions?${query}`), { code: "INVALID_INPUT" });
    }
    await assert.rejects(apiRequest(service.instance, "/sessions/search"), { code: "INVALID_INPUT" });
    await assert.rejects(apiRequest(service.instance, `/sessions/${codex.id}/messages?mode=wrong`), { code: "INVALID_INPUT" });
    for (const query of ["pageUnit=wrong", "pageUnit=turn&turnPosition=0", "pageUnit=turn&turnPosition=2", "turnPosition=1",
      "resourceKind=unknown", "pageUnit=turn&pageSize=201", "pageUnit=turn&turnPosition=1.5", "pageUnit=turn&mode=brief&toolName=shell_command"]) {
      await assert.rejects(apiRequest(service.instance, `/sessions/${codex.id}/messages?${query}`), { code: "INVALID_INPUT" });
    }
    await assert.rejects(apiRequest(service.instance, `/sessions/${codex.id}/messages?pageUnit=turn&messageId=missing-message`), { code: "SOURCE_NOT_FOUND" });
    await assert.rejects(apiRequest(service.instance, "/sessions/missing-session/messages?pageUnit=turn"), { code: "SOURCE_NOT_FOUND" });
    const { job } = await apiRequest<{ job: SessionJob }>(service.instance, "/sessions/refresh", "POST");
    let done = job;
    for (let i = 0; i < 400 && ["queued", "running"].includes(done.status); i++) {
      await delay(25);
      done = (await apiRequest<{ job: SessionJob }>(service.instance, `/jobs/${job.id}`)).job;
    }
    assert.equal(done.status, "complete", done.error);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP 完整轮次分页可定位跨旧消息分页阈值的工具，首末及简易切换保持完整轮次", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-session-turn-http-"));
  const home = join(directory, "data");
  const store = new SessionStore(join(home, "index.sqlite"));
  const id = "synthetic-navigation";
  const path = "/workspace/history/navigation.jsonl";
  const pending = store.createRevision(path, "synthetic");
  let ordinal = 0;
  for (let turn = 1; turn <= 3; turn++) {
    for (let item = 0; item < (turn === 1 ? 55 : 2); item++) {
      const kind = item === 0 ? "user" : item === (turn === 1 ? 54 : 1) ? "assistant" : "tool_call";
      pending.sink.message({ id: `synthetic-message-${ordinal}`, sessionId: id, ordinal, recordLine: ordinal + 1,
        turnId: `synthetic-turn-${turn}`, kind, text: "人工合成内容", tool: kind === "tool_call" ? "read" : undefined,
        final: kind === "assistant" ? "explicit" : undefined });
      ordinal += 1;
    }
  }
  pending.flush();
  store.finishRevision(pending.revision, { id, client: "codex", clientSessionId: id, sourceId: `codex:${id}`, path,
    title: "合成轮次导航", titleOrigin: "recorded", messageCount: ordinal, turnCount: 3, models: [], gaps: [] });
  store.publish(store.createJob().id, [{ path, revision: pending.revision, fingerprint: "synthetic" }], []);
  store.close();
  const service = await startService({ home, startupRefresh: false, roots: { codex: [], claude: [], codeflicker: [], "codeflicker-desktop": [], dsh: [], pi: [], workbuddy: [], opencode: [], zcode: [], codebuddy: [], qoder: [] } });
  try {
    const first = await apiRequest<SessionMessageResult>(service.instance, `/sessions/${id}/messages?pageUnit=turn&pageSize=1&turnPosition=1`);
    assert.equal(first.messages.length, 55);
    assert.equal(first.totalTurns, 3);
    const target = await apiRequest<SessionMessageResult>(service.instance, `/sessions/${id}/messages?pageUnit=turn&pageSize=1&page=3&messageId=synthetic-message-50`);
    assert.equal(target.page, 1);
    assert.equal(target.focusMessageId, "synthetic-message-50");
    assert.equal(target.messages.length, 55);
    const last = await apiRequest<SessionMessageResult>(service.instance, `/sessions/${id}/messages?pageUnit=turn&pageSize=1&turnPosition=${first.totalTurns}`);
    assert.equal(last.page, 3);
    assert.equal(last.messages.length, 2);
    assert.equal(last.turns?.[0]?.position, 3);
    const brief = await apiRequest<SessionMessageResult>(service.instance, `/sessions/${id}/messages?pageUnit=turn&pageSize=1&mode=brief&turnPosition=1`);
    assert.equal(brief.messages.length, 2);
    assert.equal(brief.total, 6);
    assert.equal(brief.totalTurns, 3);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
