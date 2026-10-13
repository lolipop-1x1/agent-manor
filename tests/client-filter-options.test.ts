import assert from "node:assert/strict";
import test from "node:test";
import { availableClientOptions } from "../web/shared/ui/client-options.js";

test("客户端筛选只列完整数据候选，空数据不回退支持名单，重复及未知身份不混入", () => {
  assert.deepEqual(availableClientOptions(), []);
  assert.deepEqual(availableClientOptions([]), []);
  const options = availableClientOptions(["pi", "claude", "codex", "claude", "synthetic-unsupported"]);
  assert.deepEqual(options.map(option => option.value), ["codex", "claude", "pi"]);
  assert.deepEqual(options.map(option => option.label), ["Codex", "Claude Code", "Pi"]);
});
