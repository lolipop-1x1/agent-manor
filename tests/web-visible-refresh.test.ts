import assert from "node:assert/strict";
import { test } from "node:test";
import { startVisiblePolling } from "../web/shared/refresh/visible-polling.ts";
import { completeMessage } from "../web/features/sessions/session-message-content.ts";
import type { SessionMessage } from "../src/session-contracts.ts";
import { sessionParams } from "../web/features/sessions/session-model.ts";

test("有界查询参数真正编码到请求，显式零偏移与摘要开关保持语义", () => {
  const query = new URLSearchParams(sessionParams({ summary: true, stepLimit: 12, stepOffset: 0, maxEvents: 1800,
    messageLimit: 300, messageOffset: 0, maxTextChars: 6000 }));
  assert.equal(query.get("summary"), "true"); assert.equal(query.get("stepLimit"), "12"); assert.equal(query.get("stepOffset"), "0");
  assert.equal(query.get("maxEvents"), "1800"); assert.equal(query.get("messageLimit"), "300"); assert.equal(query.get("messageOffset"), "0");
  assert.equal(query.get("maxTextChars"), "6000");
});

function clock(visible = true) {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let changed: () => void = () => {};
  const environment = {
    visible: () => visible,
    now: () => now,
    schedule: (run: () => void, delay: number) => { const id = ++next; timers.set(id, { at: now + delay, run }); return id; },
    cancel: (id: unknown) => { timers.delete(id as number); },
    subscribe: (callback: () => void) => { changed = callback; return () => { changed = () => {}; }; },
  };
  return {
    environment,
    visibility(value: boolean) { visible = value; changed(); },
    async advance(amount: number) {
      const end = now + amount;
      for (;;) {
        const due = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].run();
        await Promise.resolve(); await Promise.resolve();
      }
      now = end;
    },
  };
}

test("可见页面按间隔检查，隐藏暂停，恢复只补查一次", async () => {
  const fixture = clock(false), calls: number[] = [];
  const stop = startVisiblePolling(fixture.environment, 60_000, async () => { calls.push(fixture.environment.now()); }, error => { throw error; });
  await fixture.advance(180_000); assert.deepEqual(calls, []);
  fixture.visibility(true); await fixture.advance(0); assert.deepEqual(calls, [180_000]);
  await fixture.advance(20_000); fixture.visibility(false); await fixture.advance(10_000);
  fixture.visibility(true); await fixture.advance(29_999); assert.equal(calls.length, 1);
  await fixture.advance(1); assert.deepEqual(calls, [180_000, 240_000]);
  fixture.visibility(false); await fixture.advance(600_000); fixture.visibility(true); await fixture.advance(0);
  assert.deepEqual(calls, [180_000, 240_000, 840_000]);
  stop(); await fixture.advance(600_000); assert.equal(calls.length, 3);
});

test("检查未结束时不重叠，隐藏不取消已开始请求，卸载取消请求", async () => {
  const fixture = clock();
  let release: () => void = () => {}, signal: AbortSignal | undefined, calls = 0;
  const stop = startVisiblePolling(fixture.environment, 60_000, async value => {
    signal = value; calls++;
    await new Promise<void>(resolve => { release = resolve; });
  }, error => { throw error; });
  await fixture.advance(0); await fixture.advance(180_000); assert.equal(calls, 1);
  fixture.visibility(false); assert.equal(signal?.aborted, false); release(); await Promise.resolve(); await Promise.resolve();
  fixture.visibility(true); await fixture.advance(0); assert.equal(calls, 2);
  stop(); assert.equal(signal?.aborted, true); release();
});

test("失败之后仍按间隔重试，不用快速空转请求", async () => {
  const fixture = clock(), failures: unknown[] = []; let calls = 0;
  const stop = startVisiblePolling(fixture.environment, 5000, async () => { calls++; throw new Error("synthetic failure"); }, error => { failures.push(error); });
  await fixture.advance(4999); assert.equal(calls, 1); assert.equal(failures.length, 1);
  await fixture.advance(1); assert.equal(calls, 2); stop();
});

test("完整正文按消息身份和版本读取，预览末尾不混入复制内容", async () => {
  const message: SessionMessage = { id: "message-a", sessionId: "session-a", ordinal: 1, recordLine: 1, turnId: "turn-a", kind: "assistant", text: "preview", textLength: 20_000, textTruncated: true };
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async input => {
    fetched++;
    const query = new URL(String(input), "http://example.invalid").searchParams;
    assert.equal(query.get("messageId"), message.id); assert.equal(query.get("version"), "version-a");
    assert.equal(query.get("maxTextChars"), null); assert.equal(query.get("pageSize"), "1");
    return new Response(JSON.stringify({ version: "version-a", messages: [{ ...message, text: "complete text with original tail", textTruncated: false }] }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    assert.equal((await completeMessage(message, "version-a")).text, "complete text with original tail");
    await completeMessage({ ...message, textTruncated: false }, "version-a"); assert.equal(fetched, 1);
    globalThis.fetch = async () => new Response(JSON.stringify({ version: "version-b", messages: [message] }));
    await assert.rejects(completeMessage(message, "version-a"), /结果版本/);
  } finally { globalThis.fetch = original; }
});

test("完整轮复制复用同版查询、视图分支和语言，只导出指定轮次", async () => {
  const { completeTurnMarkdown } = await import("../web/features/sessions/session-message-content.ts");
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const query = new URL(String(input), "http://example.invalid").searchParams;
    assert.equal(query.get("version"), "version-a"); assert.equal(query.get("mode"), "brief"); assert.equal(query.get("branch"), "branch-a");
    assert.equal(query.get("pageUnit"), "turn"); assert.equal(query.get("turnPosition"), "2"); assert.equal(query.get("maxTextChars"), null);
    return new Response(JSON.stringify({ version: "version-a", messages: [
      { id: "wanted", sessionId: "session-a", kind: "assistant", turnId: "turn-a", text: "original tail", final: "explicit" },
      { id: "unrelated", sessionId: "session-a", kind: "user", turnId: "initial", text: "excluded context" },
    ] }));
  };
  try {
    const text = await completeTurnMarkdown("session-a", "turn-a", 2, { version: "version-a", mode: "brief", branch: "branch-a" }, "en");
    assert.ok(text.includes("AI reply")); assert.ok(text.includes("original tail")); assert.ok(!text.includes("excluded context"));
  } finally { globalThis.fetch = original; }
});

test("未知回复组和初始组复制从第一页读取，不发送零轮次位置或混入其他组", async () => {
  const { completeTurnMarkdown } = await import("../web/features/sessions/session-message-content.ts");
  const original = globalThis.fetch;
  const turns = ["session-a:turn:0", "session-a:unassigned:4:turn:0"];
  let version = "version-a";
  globalThis.fetch = async input => {
    const query = new URL(String(input), "http://example.invalid").searchParams;
    assert.equal(query.get("version"), "version-a");
    assert.equal(query.get("mode"), "full");
    assert.equal(query.get("branch"), "all");
    assert.equal(query.get("pageUnit"), "turn");
    assert.equal(query.get("page"), "1");
    assert.equal(query.get("turnPosition"), null);
    assert.equal(query.get("messageLimit"), null);
    assert.equal(query.get("maxTextChars"), null);
    return Response.json({ version, messages: [
      ...turns.map((turnId, index) => ({ id: `reply-${index}`, sessionId: "session-a", kind: "assistant", turnId, text: `Complete saved reply ${index}` })),
      { id: "user", sessionId: "session-a", kind: "user", turnId: "session-a:turn:1", text: "Unrelated request" },
    ] });
  };
  try {
    for (const [index, turn] of turns.entries()) {
      for (const language of ["en", "zh-CN"] as const) {
        const text = await completeTurnMarkdown("session-a", turn, 0, { version: "version-a", mode: "full", branch: "all" }, language);
        assert.ok(text.includes(`Complete saved reply ${index}`));
        assert.ok(!text.includes(`Complete saved reply ${1 - index}`));
        assert.ok(!text.includes("Unrelated request"));
      }
    }
    version = "version-b";
    await assert.rejects(completeTurnMarkdown("session-a", turns[1]!, 0, { version: "version-a", mode: "full", branch: "all" }, "en"), { code: "VERSION_MISMATCH" });
    globalThis.fetch = async () => { throw new Error("synthetic unavailable source"); };
    await assert.rejects(completeTurnMarkdown("session-a", turns[1]!, 0, { version: "version-a", mode: "full", branch: "all" }, "en"), { code: "CONNECTION_FAILED" });
  } finally { globalThis.fetch = original; }
});
