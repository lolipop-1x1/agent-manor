import assert from "node:assert/strict";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import type { ResourceInventoryEntry } from "../src/resource-inventory-contracts.js";
import { resourceMaterialPath } from "../src/resources/vault-path.js";

const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
const vault = "/synthetic/data/resource-vault";
function entry(path: string, extra: Partial<ResourceInventoryEntry> = {}): ResourceInventoryEntry {
  return { id: "synthetic-entry", kind: "skill", name: "guide", client: "codex", scope: "user", entryPath: path,
    sourceId: "synthetic-source", bodyId: "synthetic-body", entryType: "directory", readState: "present", nativeState: "unknown",
    sourceFormat: "skill-directory", observedAt: "2026-01-01T00:00:00Z", protected: false, locator: { type: "skill", skillFile: join(path, "SKILL.md") },
    capabilities: { inventory: true, associate: true, disable: false, standby: false, restore: false, trash: false, purge: false }, ...extra };
}

test("恢复材料按名称与原入口区分来源，同名共享目标及重复回收不会覆盖", () => {
  const selected = entry("/synthetic/codex/guide", { targetPath: "/synthetic/shared/guide" });
  const other = entry("/synthetic/claude/guide", { client: "claude", targetPath: selected.targetPath });
  const first = resourceMaterialPath(vault, "trash", selected, firstId);
  const second = resourceMaterialPath(vault, "trash", other, firstId);
  assert.notEqual(first, second);
  assert.match(relative(vault, first), /^trash\/skill\/guide--[\da-f]{64}\/[\da-f-]+\/material$/);
  assert.equal(first, resourceMaterialPath(vault, "standby", selected, firstId));
  assert.equal(dirname(dirname(first)), dirname(dirname(resourceMaterialPath(vault, "trash", selected, secondId))));
  assert.notEqual(first, resourceMaterialPath(vault, "trash", selected, secondId));
  assert.ok(resourceMaterialPath(vault, "disable", selected, firstId).startsWith(join(vault, "backups", "skill") + sep));
  assert.equal(first, resourceMaterialPath(vault, "trash", { ...selected, client: "claude" }, firstId));
});

test("MCP 来源同时区分配置路径及注册项，不按同名归并", () => {
  const selected = entry("/synthetic/config.json", { kind: "mcp", entryType: "registration", server: "demo",
    locator: { type: "mcp", configPath: "/synthetic/config.json", keyPath: ["mcpServers", "demo"] } });
  const first = resourceMaterialPath(vault, "trash", selected, firstId);
  for (const other of [
    { ...selected, locator: { ...selected.locator, configPath: "/synthetic/other.json" } },
    { ...selected, locator: { ...selected.locator, keyPath: ["projects", "mcpServers", "demo"] } },
    { ...selected, server: "other-registration" },
  ]) assert.notEqual(first, resourceMaterialPath(vault, "trash", other, firstId));
  assert.ok(first.startsWith(join(vault, "trash", "mcp") + sep));
});

test("名称可辨认且长度受限，不能注入路径；操作 ID 必须为 UUID", () => {
  const selected = entry("/synthetic/guide", { name: "../\\\u0000<>:\"|?* " + "合成资源".repeat(40) });
  const parts = relative(vault, resourceMaterialPath(vault, "trash", selected, firstId)).split(sep);
  assert.equal(parts.length, 5);
  assert.ok(Buffer.byteLength(parts[2]!, "utf8") <= 146);
  assert.match(parts[2]!, /合成资源/);
  assert.doesNotMatch(parts[2]!, /[<>:"/\\|?*\u0000-\u001f\u007f]/);
  assert.throws(() => resourceMaterialPath(vault, "trash", selected, "../operation"), TypeError);
  assert.throws(() => resourceMaterialPath(vault, "restore", selected, firstId), TypeError);
  assert.throws(() => resourceMaterialPath(vault, "trash", { ...selected, kind: "../../outside" } as ResourceInventoryEntry, firstId), TypeError);
});
