import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configurationPreview, prepareConfig } from "../src/resources/config-editor.js";
import type { ResourceInventoryEntry } from "../src/resource-inventory-contracts.js";

test("MCP 停用、移除与恢复只公开精确字段，不泄露完整注册", async () => {
  const root = await mkdtemp(join(tmpdir(), "manor-preview-projection-"));
  try {
    const path = join(root, "config.toml");
    await writeFile(path, '[mcp_servers.demo]\nenabled = true\ncommand = "synthetic-secret-command"\nurl = "https://example.invalid/private"\n[mcp_servers.demo.env]\nTOKEN = "synthetic-private-value"\n');
    const entry = { kind: "mcp", name: "demo", locator: { type: "mcp", nativeControl: "codex-mcp", format: "toml", keyPath: ["mcp_servers", "demo"], configPath: path } } as ResourceInventoryEntry;
    const disable = configurationPreview(await prepareConfig(entry, "disable"));
    assert.deepEqual(disable.keyPath, ["mcp_servers", "demo", "enabled"]);
    assert.equal(disable.path, path); assert.equal(disable.before, true); assert.equal(disable.after, false);
    const change = await prepareConfig(entry, "trash");
    const removal = configurationPreview(change), restore = configurationPreview(change, true);
    assert.equal(removal.kind, "registration"); assert.equal(removal.before, "present"); assert.equal(removal.after, "missing");
    assert.equal(restore.before, "missing"); assert.equal(restore.after, "present"); assert.equal(restore.path, path);
    assert.doesNotMatch(JSON.stringify([disable, removal, restore]), /synthetic-secret-command|synthetic-private-value|example\.invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Skill 路径规则、名字规则与默认控制值各自保留原生语义", async () => {
  const root = await mkdtemp(join(tmpdir(), "manor-skill-preview-"));
  try {
    const path = join(root, "config.toml"), skillPath = join(root, "skills", "guide", "SKILL.md");
    await mkdir(join(root, "skills", "guide"), { recursive: true }); await writeFile(path, "");
    const entry = { kind: "skill", name: "guide", locator: { type: "skill", nativeControl: "codex-skill", controlPath: path } } as ResourceInventoryEntry;
    const change = configurationPreview(await prepareConfig(entry, "disable", skillPath));
    assert.deepEqual(change.keyPath, ["skills", "config", "[]", "enabled"]);
    assert.deepEqual(change.selector, { key: "path", value: skillPath });
    assert.equal(change.before, "missing"); assert.equal(change.after, false);
    entry.locator = { type: "skill", controlPath: join(root, "settings.json"), nativeRule: { type: "name-list", format: "json", keyPath: ["skills", "disabled"], member: "guide" } };
    const list = configurationPreview(await prepareConfig(entry, "disable"));
    assert.equal(list.kind, "membership"); assert.equal(list.before, false); assert.equal(list.after, true);
    assert.deepEqual(list.selector, { key: "name", value: "guide" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
