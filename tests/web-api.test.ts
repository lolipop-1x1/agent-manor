import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "../web/api.ts";

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
