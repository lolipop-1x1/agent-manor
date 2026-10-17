import assert from "node:assert/strict";
import test from "node:test";
import { availableClientOptions } from "../web/shared/ui/client-options.ts";
import { readUsageRoute } from "../web/features/usage/model.ts";
import { readOverviewRoute } from "../web/features/overview/model.ts";
import { readSessionFilters } from "../web/features/sessions/session-address.ts";

test("所有客户端筛选统一忽略豆包，旧页面地址保留其余筛选", () => {
  assert.deepEqual(availableClientOptions(["doubao-work", "codex"]).map(option => option.value), ["codex"]);
  const clients = encodeURIComponent(JSON.stringify(["codex", "doubao-work"]));
  const excluded = encodeURIComponent(JSON.stringify(["doubao-work"]));
  const usage = readUsageRoute(`#usage?window=all&clients=${clients}&excludeClients=${excluded}&projects=%5B%22synthetic%22%5D`);
  assert.deepEqual(usage.clients, ["codex"]); assert.deepEqual(usage.excludeClients, []); assert.deepEqual(usage.projects, ["synthetic"]);
  const overview = readOverviewRoute(`#overview?window=all&clients=${clients}&metric=cost`);
  assert.deepEqual(overview.clients, ["codex"]); assert.equal(overview.metric, "cost");
  assert.equal(readSessionFilters("#sessions?client=doubao-work").client, "all");
});
