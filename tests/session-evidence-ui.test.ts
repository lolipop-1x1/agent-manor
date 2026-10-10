import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionMessage, SessionTimelineEvent } from "../src/session-contracts.js";
import { EVIDENCE_PAGE_SIZE, evidencePreviews, evidenceSummary } from "../web/features/sessions/session-evidence-model.js";

const event: SessionTimelineEvent = { id: "failed-call", sessionId: "synthetic-session", ordinal: 1, turnId: "turn-1", kind: "tool_call", tool: "exec", status: "failure" };
const message: SessionMessage = { ...event, recordLine: 2, text: "npm test\nexit 1" };

test("证据预览仅查询当前页，保留版本、身份和正文长度边界", async () => {
  const previous = globalThis.fetch;
  const seen: URL[] = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input), "http://example.invalid"); seen.push(url);
    return Response.json({ version: "v1", messages: [{ ...message, id: url.searchParams.get("messageId") }] });
  };
  try {
    const all = Array.from({ length: 19 }, (_, index) => ({ ...event, id: `call-${index}` }));
    const previews = await evidencePreviews(all.slice(EVIDENCE_PAGE_SIZE, EVIDENCE_PAGE_SIZE * 2), "v1", new AbortController().signal);
    assert.equal(previews.length, 8);
    assert.equal(seen.length, 8);
    assert.equal(seen[0].searchParams.get("messageId"), "call-8");
    assert.equal(seen.at(-1)!.searchParams.get("messageId"), "call-15");
    for (const url of seen) {
      assert.equal(url.searchParams.get("version"), "v1");
      assert.equal(url.searchParams.get("pageSize"), "1");
      assert.equal(url.searchParams.get("maxTextChars"), "320");
      assert.equal(url.searchParams.get("branch"), "all");
    }
  } finally { globalThis.fetch = previous; }
});

test("证据预览拒绝旧版本和跨会话同名记录", async () => {
  const previous = globalThis.fetch;
  try {
    for (const payload of [{ version: "v0", messages: [message] }, { version: "v1", messages: [{ ...message, sessionId: "another-session" }] }, { version: "v1", messages: [] }]) {
      globalThis.fetch = async () => Response.json(payload);
      await assert.rejects(evidencePreviews([event], "v1", new AbortController().signal), { code: "VERSION_MISMATCH" });
    }
  } finally { globalThis.fetch = previous; }
});

test("关闭证据浮层的取消信号传递到预览请求", async () => {
  const previous = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.signal, controller.signal);
    return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  };
  try {
    const pending = evidencePreviews([event], "v1", controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
  } finally { globalThis.fetch = previous; }
});

test("证据摘要仅显示记录中的对象或正文，不推断错误原因", () => {
  assert.equal(evidenceSummary(message), "npm test exit 1");
  assert.equal(evidenceSummary({ ...message, filePaths: ["src/request.ts"] }), "src/request.ts");
  assert.equal(evidenceSummary({ ...message, resource: { kind: "skill_read", name: "review", path: "skills/review/SKILL.md" } }), "skills/review/SKILL.md");
});


test("切换证据页后到达的响应不能成为有效预览", async () => {
  const previous = globalThis.fetch;
  const controller = new AbortController();
  let finish: (response: Response) => void;
  globalThis.fetch = async () => new Promise(resolve => { finish = resolve; });
  try {
    const pending = evidencePreviews([event], "v1", controller.signal);
    controller.abort();
    finish!(Response.json({ version: "v1", messages: [message] }));
    await assert.rejects(pending, { name: "AbortError" });
  } finally { globalThis.fetch = previous; }
});
