import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ResourceInventoryEntry } from "../src/resource-inventory-contracts.js";
import { scanResourceInventory } from "../src/resources/inventory.js";
import { ResourceManager } from "../src/resources/management.js";
import { hasExplicitResourceControl } from "../src/resources/config-editor.js";

const entry = (extra: Partial<ResourceInventoryEntry> = {}): ResourceInventoryEntry => ({
  id: "synthetic-entry", sourceId: "synthetic-source", bodyId: "synthetic-body", name: "guide", kind: "skill", client: "omp",
  scope: "project", project: "/synthetic/project", entryPath: "/synthetic/project/.claude/skills/guide", entryType: "directory",
  readState: "present", nativeState: "enabled", sourceFormat: "skill-directory", observedAt: "2026-10-01T00:00:00Z", protected: false,
  locator: { type: "skill", controlPath: "/synthetic/user/config.json", nativeControl: "native-rule",
    nativeRule: { format: "json", type: "name-list", keyPath: ["disabledExtensions"], member: "skill:guide", effectScope: "client" } },
  capabilities: { inventory: true, associate: true, disable: false, standby: false, trash: false, restore: false, purge: false }, ...extra,
});

test("兼容目录不证明客户端存在，不创建默认启停配置；文件仍可回收恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "manor-control-evidence-"));
  const project = join(root, "project"), userHome = join(root, "user"), path = join(project, ".claude", "skills", "guide");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), "---\nname: guide\ndescription: 合成说明\n---\n合成资源\n");
  const manager = new ResourceManager(join(root, "data"));
  try {
    const snapshot = await scanResourceInventory({ userHome, projects: [project], environment: {} });
    const entries = manager.decorateInventory(snapshot).entries.filter(entry => entry.entryPath === path);
    assert.ok(entries.some(entry => entry.client === "omp"));
    assert.ok(entries.every(entry => !entry.capabilities.disable));
    for (const entry of entries) await assert.rejects(manager.preview({ entryId: entry.id, action: "disable" }, snapshot));
    const file = entries.find(entry => entry.capabilities.trash)!; assert.ok(file);
    const preview = await manager.preview({ entryId: file.id, action: "trash" }, snapshot);
    assert.equal((await manager.apply(preview.id, true, snapshot)).status, "success");
    const archive = manager.archives("trash")[0]!;
    const removed = await scanResourceInventory({ userHome, projects: [project], environment: {} });
    const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, removed);
    assert.equal((await manager.apply(restore.id, true, removed)).status, "success");
    assert.match(await readFile(join(path, "SKILL.md"), "utf8"), /合成资源/);
    for (const config of [join(userHome, ".omp", "agent", "config.yml"), join(userHome, ".reasonix", "capability-activation.json")]) await assert.rejects(stat(config));
  } finally { manager.close(); await rm(root, { recursive: true, force: true }); }
});

test("配置证据须精确匹配资源，空配置、其他名字与其他 activation 身份均不成立", () => {
  const selected = entry();
  assert.equal(hasExplicitResourceControl("", selected), false);
  assert.equal(hasExplicitResourceControl('{"disabledExtensions":["skill:other"]}', selected), false);
  const activation = entry({ locator: { ...selected.locator, nativeRule: { format: "json", type: "activation", keyPath: ["overrides"], effectScope: "client", identity: { kind: "skill", scope: "global", name: "guide" } } } });
  assert.equal(hasExplicitResourceControl('{"overrides":[{"kind":"skill","scope":"global","name":"guide","enabled":true}]}', activation), true);
  assert.equal(hasExplicitResourceControl('{"overrides":[{"kind":"skill","scope":"project","name":"guide","enabled":true}]}', activation), false);
  const mcp = entry({ kind: "mcp", name: "server", server: "server", locator: { ...selected.locator, type: "mcp", configPath: "/synthetic/project/mcp.json", nativeRule: { format: "json", type: "name-list", keyPath: ["disabledServers"], member: "server", effectScope: "client" } } });
  assert.equal(hasExplicitResourceControl('{"enabledServers":["server"]}', mcp), true);
  assert.equal(hasExplicitResourceControl('{"enabledServers":["other"]}', mcp), false);
});

test("CodeWhale 项目 MCP 的控制范围来自项目配置，保留全局设置", async () => {
  const root = await mkdtemp(join(tmpdir(), "manor-project-control-"));
  const userHome = join(root, "user"), project = join(root, "project");
  const config = join(userHome, ".codewhale", "config.toml"), projectConfig = join(project, ".codewhale", "mcp.json");
  await mkdir(join(userHome, ".codewhale"), { recursive: true }); await mkdir(join(project, ".codewhale"), { recursive: true });
  const original = `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`;
  await writeFile(config, original); await writeFile(projectConfig, JSON.stringify({ servers: { sample: { command: "synthetic-tool", enabled: true } } }));
  const manager = new ResourceManager(join(root, "data"));
  try {
    const snapshot = await scanResourceInventory({ userHome, projects: [project], environment: {} });
    const resource = snapshot.entries.find(entry => entry.client === "codewhale" && entry.kind === "mcp" && entry.project === project)!;
    assert.ok(resource); const preview = await manager.preview({ entryId: resource.id, action: "disable" }, snapshot);
    assert.equal(preview.configuration?.controlScope, "project"); assert.equal(preview.configuration?.controlProject, project);
    assert.equal(preview.configuration?.path, projectConfig);
    assert.equal((await manager.apply(preview.id, true, snapshot)).status, "success");
    assert.equal(await readFile(config, "utf8"), original);
    assert.equal(JSON.parse(await readFile(projectConfig, "utf8")).servers.sample.enabled, false);
  } finally { manager.close(); await rm(root, { recursive: true, force: true }); }
});

test("盘点后删除 MCP 注册，旧入口预览及旧计划均不得重建配置", async () => {
  const root = await mkdtemp(join(tmpdir(), "manor-stale-registration-")), userHome = join(root, "user");
  const path = join(userHome, ".codewhale", "mcp.json");
  await mkdir(join(userHome, ".codewhale"), { recursive: true });
  await writeFile(path, JSON.stringify({ servers: { sample: { command: "synthetic-tool", enabled: true } } }));
  const manager = new ResourceManager(join(root, "data"));
  try {
    const snapshot = await scanResourceInventory({ userHome, environment: {} });
    const resource = snapshot.entries.find(entry => entry.client === "codewhale" && entry.kind === "mcp" && entry.name === "sample")!;
    assert.ok(resource);
    const plan = await manager.preview({ entryId: resource.id, action: "disable" }, snapshot);
    const changed = JSON.stringify({ servers: { other: { command: "other-synthetic-tool" } } }); await writeFile(path, changed);
    assert.equal(manager.decorateInventory(snapshot).entries.find(entry => entry.id === resource.id)?.capabilities.disable, false);
    await assert.rejects(manager.preview({ entryId: resource.id, action: "disable" }, snapshot));
    const fresh = await scanResourceInventory({ userHome, environment: {} });
    assert.equal((await manager.apply(plan.id, true, fresh)).status, "conflict");
    assert.equal(await readFile(path, "utf8"), changed);
    assert.equal(manager.archives().length, 0);
  } finally { manager.close(); await rm(root, { recursive: true, force: true }); }
});
