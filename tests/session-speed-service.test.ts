import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startService } from "../src/server.js";
import { apiRequest, delay } from "../src/service/runtime.js";
import type { SessionIndexStatus, SessionListResult, SessionMessageResult, SessionProfile } from "../src/session-contracts.js";
import { requestSpeed, summarizeRequestSpeed } from "../src/session-speed.js";
import { SessionStore } from "../src/sessions/store.js";
import { sessionSpeedFixture, indexSpeedBranchFixture } from "../scripts/session-speed-fixture.mjs";
import { encodeSession } from "../scripts/session-fixture.mjs";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

test("合成原生历史经发现、Worker、索引与 HTTP 保留三来源请求速度、边界及覆盖", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-speed-service-"));
  const fixture = sessionSpeedFixture("/workspace/speed-demo");
  const roots = isolatedHistoryRoots(Object.fromEntries(["codex", "claude", "codeflicker", "pi"].map(client => [client, join(directory, client)])));
  for (const source of fixture.files) {
    const root = roots[source.client] as string;
    await mkdir(root, { recursive: true });
    await writeFile(join(root, source.name), encodeSession(source.records));
  }
  const home = join(directory, "data");
  const service = await startService({ home, roots, resourceInventory: { environment: {}, userHome: join(directory, "isolated-user") } });
  try {
    let status: SessionIndexStatus | undefined;
    for (let attempt = 0; attempt < 400; attempt++) {
      status = await apiRequest(service.instance, "/sessions/status");
      if (status?.job?.status === "failed") assert.fail(status.job.error);
      if (status?.version) break;
      await delay(25);
    }
    assert.ok(status?.version, "原生历史应成功发布新索引版本");
    const list = await apiRequest<SessionListResult>(service.instance, "/sessions?includeSubagents=true");
    assert.equal(list.total, fixture.files.length);
    for (const source of fixture.files) {
      const session = list.sessions.find(item => item.clientSessionId === source.id)!;
      assert.ok(session, source.id);
      const profile = await apiRequest<SessionProfile>(service.instance, `/sessions/${session.id}/profile`);
      assert.equal(profile.version, list.version);
      assert.equal(profile.usage.requests, source.expected.requests, `${source.client} 原生请求数`);
      assert.deepEqual(summarizeRequestSpeed(profile.steps), source.expected, `${source.client} 合格子集、原始输出与耗时`);
      if (["claude", "codeflicker", "codex"].includes(source.client) && source.id.startsWith("speed-") && source.name === "speed.jsonl") {
        assert.deepEqual(profile.steps.map(step => requestSpeed(step).tokensPerSecond ?? requestSpeed(step).reason),
          [40, 20, "output_below_threshold", "end_unconfirmed", "partial_response"]);
        assert.equal(profile.steps[0]?.timing?.durationMs, 12000, "第一请求止于模型输出，不包含后续 48 秒工具等待");
        assert.equal(profile.steps[1]?.timing?.durationMs, 30000, "第二请求从工具结果开始");
        assert.equal(profile.steps[0]?.requestMessageIds?.length, 2, "同一次模型请求保留思考与文本片段关联");
        assert.ok(profile.steps.every(step => step.timing?.basis === "estimated"));
        const records = await apiRequest<SessionMessageResult>(service.instance, `/sessions/${session.id}/messages?mode=trace&pageSize=200`);
        for (const id of profile.steps[0]?.requestMessageIds ?? []) {
          assert.ok(records.messages.some(message => message.id === id && ["assistant", "thinking"].includes(message.kind)), "关联可定位到真实模型记录");
        }
      }
      if (source.id === "speed-thresholds") {
        assert.deepEqual(profile.steps.map(step => requestSpeed(step).tokensPerSecond ?? requestSpeed(step).reason).sort(),
          [200, "duration_below_threshold", "output_missing", "timing_missing"].sort());
        const missing = profile.steps.find(step => requestSpeed(step).reason === "output_missing")!;
        assert.equal(missing.outputTokens, undefined, "缺失输出不制造零值");
        assert.equal(missing.messageId, undefined, "没有原用量记录不伪造来源位置");
      }
      if (source.id === "speed-bulk") {
        assert.equal(profile.steps.length, 660, "用量明细不按会话分页截断");
        const first = await apiRequest<SessionMessageResult>(service.instance, `/sessions/${session.id}/messages?mode=full&pageUnit=turn&pageSize=10`);
        const last = await apiRequest<SessionMessageResult>(service.instance, `/sessions/${session.id}/messages?mode=full&pageUnit=turn&pageSize=10&turnPosition=110`);
        assert.equal(first.totalTurns, 110); assert.equal(last.page, 11); assert.equal(last.turns?.at(-1)?.position, 110);
        assert.equal(summarizeRequestSpeed(profile.steps.filter(step => step.turnId === last.turns?.at(-1)?.id)).tokensPerSecond, 200);
      }
      if (source.id === "speed-pi") {
        assert.equal(session.branches?.length, 2);
        const current = await apiRequest<SessionMessageResult>(service.instance, `/sessions/${session.id}/messages?mode=brief`);
        const other = await apiRequest<SessionMessageResult>(service.instance, `/sessions/${session.id}/messages?mode=brief&branch=pi-old`);
        assert.ok(current.messages.some(message => message.text === "当前分支合成回答"));
        assert.ok(other.messages.some(message => message.text === "旧分支合成回答"));
        assert.ok(profile.steps.every(step => requestSpeed(step).reason === "timing_missing"), "未支持的来源不补造计时");
      }
    }
    const parent = list.sessions.find(session => session.clientSessionId === "speed-codex")!;
    const tree = await apiRequest<SessionProfile>(service.instance, `/sessions/${parent.id}/profile?includeChildren=true`);
    assert.equal(tree.scope, "tree"); assert.equal(tree.sessionIds.length, 2);
    assert.deepEqual(summarizeRequestSpeed(tree.steps), fixture.treeExpected, "父子范围使用同一批可计算请求");
    assert.equal(tree.children[0]?.clientSessionId, "speed-child");
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("明确标注的直接索引分支样例保留完整请求关联，阅读分支不会丢失另一分支的用量", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-speed-branch-ui-"));
  const store = new SessionStore(join(directory, "index.sqlite"));
  try {
    const source = indexSpeedBranchFixture(store, join(directory, "branch-ui.jsonl"));
    store.publish(store.createJob().id, [source], []);
    const profile = store.profile(source.id);
    assert.equal(profile.steps.length, 30);
    assert.equal(summarizeRequestSpeed(profile.steps).tokensPerSecond, 12000 / 450);
    for (const [branch, expected] of [["branch-a", 20], ["branch-b", 40]] as const) {
      const page = store.messages(source.id, { mode: "full", pageUnit: "turn", pageSize: 10, branch });
      const ids = new Set(page.messages.map(message => message.id));
      const requests = profile.steps.filter(step => step.requestMessageIds?.some(id => ids.has(id)));
      assert.equal(requests.length, 10);
      assert.equal(summarizeRequestSpeed(requests).tokensPerSecond, expected, "显式消息身份决定分支覆盖范围");
      assert.ok(page.messages.filter(message => message.kind === "assistant").every(message => message.branchIds?.includes(branch)));
    }
    assert.equal(store.profile(source.id).usage.requests, 30, "阅读选项不修改完整请求用量");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
