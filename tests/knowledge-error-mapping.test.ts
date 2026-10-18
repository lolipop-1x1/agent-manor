import assert from "node:assert/strict";
import test from "node:test";
import { StoreError } from "../src/index/store.js";
import { knowledgeRequest } from "../src/service/knowledge-routes.js";
import { ServiceError } from "../src/service/input.js";
import type { KnowledgeSettings } from "../src/knowledge-contracts.js";
import { knowledgeFixture, requestError } from "./helpers/knowledge-fixture.js";

test("知识请求保留会话来源的错误码与诊断描述", async () => {
  for (const code of ["INVALID_INPUT", "SOURCE_NOT_FOUND", "CONTENT_STALE"] as const) {
    const descriptor = { key: "diagnostics.sessions.store.m012" };
    await assert.rejects(knowledgeRequest(() => { throw new StoreError(code, "Synthetic source error", descriptor); }), error => {
      assert.ok(error instanceof ServiceError); assert.equal(error.code, code); assert.deepEqual(error.messageDescriptor, descriptor); return true;
    });
  }
  const unexpected = new Error("Synthetic unexpected failure");
  await assert.rejects(knowledgeRequest(() => { throw unexpected; }), error => error === unexpected);
});

test("不存在的会话分支返回输入错误而非内部异常", async () => knowledgeFixture(async ({ agent, calls }) => {
  const settings = await agent<KnowledgeSettings>("/settings");
  await assert.rejects(agent("/extractions/preview", "POST", {
    scope: { ...settings.config.automatic.scope, timeRange: "all", sessionIds: ["synthetic-session"], branch: "synthetic-missing-branch" },
  }), requestError("INVALID_INPUT"));
  assert.equal(calls.length, 0);
}));
