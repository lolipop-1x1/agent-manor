import assert from "node:assert/strict";
import test from "node:test";
import { sessionNavigationAddress } from "../web/features/sessions/session-address.js";

test("证据地址保留完整版本和消息身份，普通会话入口不强加版本", () => {
  const target = { sessionId: "codex:synthetic/session&1", version: "synthetic-version/1&2", messageId: "message ?/&1", mode: "trace" as const, branch: "all" };
  const address = new URL(sessionNavigationAddress(target), "https://example.invalid");
  const params = new URLSearchParams(address.hash.split("?")[1]);
  assert.equal(params.get("id"), target.sessionId);
  assert.equal(params.get("version"), target.version);
  assert.equal(params.get("message"), target.messageId);
  assert.equal(params.get("mode"), "trace");
  assert.equal(params.get("branch"), "all");
  const ordinary = new URLSearchParams(sessionNavigationAddress({ sessionId: "synthetic-session" }).split("?")[1]);
  assert.equal(ordinary.get("version"), null);
  assert.equal(ordinary.get("message"), null);
  assert.equal(ordinary.get("mode"), null);
});
