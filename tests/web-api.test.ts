import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, errorMessage, request } from "../web/api.ts";

test("响应体 JSON 解析被中止时保留 AbortError", async () => {
  let markBodyStarted!: () => void;
  const bodyStarted = new Promise<void>(resolve => { markBodyStarted = resolve; });
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller;
      controller.enqueue(new TextEncoder().encode('{"value":'));
      markBodyStarted();
    },
  });
  const nativeFetch = globalThis.fetch;
  let markResponseReady!: () => void;
  const responseReady = new Promise<void>(resolve => { markResponseReady = resolve; });
  globalThis.fetch = async (_input, init) => {
    const response = new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    init?.signal?.addEventListener("abort", () => {
      bodyController.error(new DOMException("Aborted", "AbortError"));
    }, { once: true });
    markResponseReady();
    return response;
  };

  try {
    const controller = new AbortController();
    let requestSettled = false;
    const pending = request<{ value: string }>("/streaming", { signal: controller.signal })
      .finally(() => { requestSettled = true; });
    await Promise.all([bodyStarted, responseReady]);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(requestSettled, false);
    controller.abort();
    await assert.rejects(pending, error => error instanceof Error && error.name === "AbortError");
  } finally {
    globalThis.fetch = nativeFetch;
  }
});


test("产品错误保留原始诊断与描述，展示时使用当前语言", async () => {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: {
    code: "INVALID_RESPONSE", message: "原始合成诊断", messageDescriptor: { key: "common.error.http", params: { status: 503 } },
  } }), { status: 503, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(request("/synthetic"), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, "原始合成诊断");
      assert.deepEqual(error.messageDescriptor, { key: "common.error.http", params: { status: 503 } });
      assert.match(errorMessage(error), /HTTP 503/);
      assert.doesNotMatch(errorMessage(error), /原始合成诊断/);
      return true;
    });
  } finally { globalThis.fetch = nativeFetch; }
});

test("外部错误与旧诊断原文保留，未识别失败使用产品兜底", () => {
  assert.equal(errorMessage(new ApiError("EXTERNAL", "raw synthetic error")), "raw synthetic error");
  assert.equal(errorMessage(new ApiError("LEGACY", "原始合成旧错误", { key: "diagnostics.synthetic.obsolete" })), "原始合成旧错误");
  assert.equal(errorMessage(new Error("原始合成外部错误")), "原始合成外部错误");
  assert.equal(errorMessage("原始合成旧诊断"), "原始合成旧诊断");
  assert.equal(errorMessage(null), "The query failed. Try again.");
});
