import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceInventoryEntry } from "../src/resource-inventory-contracts.js";
import type { ResourceLocalRow } from "../src/resource-service-contracts.js";
import { physicalLocationEntry, resourceLocationGroups } from "../web/features/resources/resource-location-groups.js";

test("同一物理注册只展示一次，各客户端控制保留，独立文件和键不合并", () => {
  const entry = (id: string, client: ResourceInventoryEntry["client"], path: string, name = "sample") => ({
    id, bodyId: id, kind: "mcp", client, entryPath: path, locator: { keyPath: ["mcpServers", name] },
    capabilities: { trash: client !== "pi", disable: client === "opencode" },
  }) as ResourceInventoryEntry;
  const entries = [entry("a", "pi", "/synthetic/.mcp.json"), entry("b", "claude", "/synthetic/.mcp.json"),
    entry("c", "opencode", "/synthetic/.mcp.json"), entry("d", "claude", "/synthetic/project/.mcp.json"), entry("e", "claude", "/synthetic/.mcp.json", "other")];
  const rows = entries.map(item => ({ body: { id: item.id, name: "sample" }, entries: [item] })) as ResourceLocalRow[];
  const groups = resourceLocationGroups(rows, "mcp");
  assert.equal(groups.length, 3);
  assert.equal(new Set(groups.map(group => group.key)).size, 3);
  assert.deepEqual(groups[0]!.entries.map(item => item.id), ["a", "b", "c"]);
  assert.equal(physicalLocationEntry(groups[0]!.entries)?.id, "b");
  assert.equal(rows[0]!.entries.length, 1);
  assert.strictEqual(resourceLocationGroups(rows, "skill"), rows);
});
