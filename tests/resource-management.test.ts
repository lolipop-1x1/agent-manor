import assert from "node:assert/strict";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { parse as parseToml } from "smol-toml";
import type { ResourceInventoryEntry, ResourceInventorySnapshot } from "../src/resource-inventory-contracts.js";
import { ResourceManager, resourceMaterialFingerprint } from "../src/resources/management.js";
import { scanResourceInventory } from "../src/resources/inventory.js";
import { ServiceError } from "../src/service/input.js";

async function fixture(run: (manager: ResourceManager, directory: string, home: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "manor-resource-management-"));
  const home = join(directory, "data"); const manager = new ResourceManager(home);
  try { await run(manager, directory, home); }
  finally { manager.close(); await rm(directory, { recursive: true, force: true }); }
}
const capabilities = { inventory: true, associate: true, disable: false, standby: false, restore: false, trash: false, purge: false };
function entry(path: string, extra: Partial<ResourceInventoryEntry> = {}): ResourceInventoryEntry {
  return { id: "synthetic-entry", kind: "skill", name: "guide", client: "codex", scope: "user", entryPath: path,
    sourceId: "synthetic-source", bodyId: "synthetic-body", entryType: "directory", readState: "present", nativeState: "unknown",
    sourceFormat: "skill-directory", observedAt: "2026-01-01T00:00:00Z", protected: false, locator: { type: "skill", skillFile: join(path, "SKILL.md") }, capabilities, ...extra };
}
function snapshot(entries: ResourceInventoryEntry[], observedAt = "2026-01-01T00:00:00Z"): ResourceInventorySnapshot {
  return { observedAt, entries, bodies: [{ id: "synthetic-body", kind: "skill", name: "guide", entryIds: entries.map(value => value.id) }], gaps: [],
    sources: [{ id: "synthetic-source", client: entries[0]?.client ?? "codex", kind: entries[0]?.kind ?? "skill", scope: "user",
      path: dirname(entries[0]?.entryPath ?? "/synthetic/resources/unknown"), format: entries[0]?.sourceFormat ?? "skill-directory",
      origin: "manual", readState: "ok", observedAt, verified: true }] };
}
async function skill(path: string): Promise<void> { await mkdir(path, { recursive: true }); await writeFile(join(path, "SKILL.md"), "# 人工合成 Skill\n"); }

test("恢复材料越界或属于其他操作时拒绝预览和执行，不删除外部目录", async () => fixture(async (manager, directory) => {
  const path = join(directory, "skills", "guide"); await skill(path);
  const initial = snapshot([entry(path)]);
  const trash = await manager.preview({ entryId: "synthetic-entry", action: "trash" }, initial);
  assert.equal((await manager.apply(trash.id, true, initial)).status, "success");
  const archive = manager.archives("trash")[0]!;
  const outside = join(directory, "unrelated");
  await mkdir(outside); await cp(archive.storedPath!, join(outside, "material"), { recursive: true });
  const database = new Database(manager.dbPath);
  try {
    const row = database.prepare("SELECT json FROM resource_archives WHERE id=?").get(archive.id) as { json: string };
    const changePath = (path: string) => {
      const value = JSON.parse(row.json); value.public.storedPath = path;
      database.prepare("UPDATE resource_archives SET json=? WHERE id=?").run(JSON.stringify(value), archive.id);
    };
    for (const action of ["restore", "purge"] as const) {
      changePath(join(outside, "material"));
      await assert.rejects(manager.preview({ operationId: archive.operationId, action }, snapshot([])));
    }
    changePath(archive.storedPath!);
    const purge = await manager.preview({ operationId: archive.operationId, action: "purge" }, snapshot([]));
    changePath(join(outside, "material"));
    assert.equal((await manager.apply(purge.id, true, snapshot([]))).status, "conflict");
    assert.ok((await stat(outside)).isDirectory());
    assert.ok((await stat(archive.storedPath!)).isDirectory());
    const another = join(dirname(dirname(archive.storedPath!)), "another-operation", "material");
    await mkdir(dirname(another)); await cp(archive.storedPath!, another, { recursive: true });
    changePath(another);
    await assert.rejects(manager.preview({ operationId: archive.operationId, action: "purge" }, snapshot([])));
    changePath(`${dirname(archive.storedPath!)}/../${relative(dirname(dirname(archive.storedPath!)), dirname(archive.storedPath!))}/material`);
    await assert.rejects(manager.preview({ operationId: archive.operationId, action: "purge" }, snapshot([])));
  } finally { database.close(); }
}));

test("恢复材料祖先变为链接后拒绝清除，保留链接目标及材料", async () => fixture(async (manager, directory) => {
  const path = join(directory, "skills", "guide"); await skill(path);
  const initial = snapshot([entry(path)]);
  const trash = await manager.preview({ entryId: "synthetic-entry", action: "trash" }, initial);
  await manager.apply(trash.id, true, initial);
  const archive = manager.archives("trash")[0]!;
  const purge = await manager.preview({ operationId: archive.operationId, action: "purge" }, snapshot([]));
  const parent = dirname(dirname(archive.storedPath!)), outside = join(directory, "outside-materials");
  await rename(parent, outside); await symlink(outside, parent, "dir");
  assert.equal((await manager.apply(purge.id, true, snapshot([]))).status, "conflict");
  assert.ok((await stat(join(outside, ...relative(parent, archive.storedPath!).split(sep)))).isDirectory());
}));

test("恢复材料父目录缺失时保留档案并返回材料冲突", async () => fixture(async (manager, directory) => {
  const path = join(directory, "skills", "guide"); await skill(path);
  const initial = snapshot([entry(path)]);
  const trash = await manager.preview({ entryId: "synthetic-entry", action: "trash" }, initial);
  await manager.apply(trash.id, true, initial);
  const archive = manager.archives("trash")[0]!;
  await rm(dirname(archive.storedPath!), { recursive: true });
  for (const action of ["restore", "purge"] as const) await assert.rejects(
    manager.preview({ operationId: archive.operationId, action }, snapshot([])),
    error => error instanceof ServiceError && error.code === "CONTENT_STALE");
  assert.equal(manager.archives("recoverable").length, 1);
}));
function mcp(path: string, format: "json" | "jsonc" | "toml" = "json", extra: Partial<ResourceInventoryEntry> = {}): ResourceInventoryEntry {
  return entry(path, { kind: "mcp", name: "selected", server: "selected", entryType: "registration", sourceFormat: format,
    locator: { type: "mcp", format, configPath: path, keyPath: [format === "toml" ? "mcp_servers" : "mcpServers", "selected"],
      nativeControl: format === "toml" ? "codex-mcp" : undefined }, ...extra });
}

test("恢复目录根被替换为链接时不写入外部目标或改变其权限", async () => fixture(async (manager, directory) => {
  const path = join(directory, "skills", "guide"); await skill(path);
  const outside = join(directory, "outside-vault"); await mkdir(outside, { mode: 0o755 });
  const initial = snapshot([entry(path)]);
  const plan = await manager.preview({ entryId: initial.entries[0]!.id, action: "trash" }, initial);
  await rename(manager.vaultPath, `${manager.vaultPath}-retained`);
  await symlink(outside, manager.vaultPath);
  const mode = (await stat(outside)).mode & 0o777;
  assert.equal((await manager.apply(plan.id, true, initial)).status, "failure");
  assert.equal((await stat(outside)).mode & 0o777, mode);
  assert.match(await readFile(join(path, "SKILL.md"), "utf8"), /人工合成/);
  assert.throws(() => new ResourceManager(join(directory, "data")), /符号链接/);
  assert.equal((await stat(outside)).mode & 0o777, mode);
}));

test("共享链接只隔离所选入口，具体确认后写入，备用恢复不改目标与其他入口", async () => fixture(async (manager, directory) => {
  const target = join(directory, "shared", "guide"); const first = join(directory, "codex", "guide"); const second = join(directory, "claude", "guide");
  await skill(target); await mkdir(dirname(first), { recursive: true }); await mkdir(dirname(second), { recursive: true });
  await symlink(target, first); await symlink(target, second);
  const selected = entry(first, { entryType: "symlink", targetPath: target, linkTarget: target });
  const other = entry(second, { id: "other-entry", client: "claude", entryType: "symlink", targetPath: target, linkTarget: target });
  const initial = snapshot([selected, other]); manager.setFavorite(selected.id, true);
  const preview = await manager.preview({ entryId: selected.id, action: "standby" }, initial);
  assert.equal(preview.restorationDescriptor?.key, "diagnostics.resources.management.m021");
  assert.equal(preview.protected, true); assert.equal(preview.affectedEntries.length, 2); assert.equal(preview.referencesComplete, false);
  assert.equal(await readlink(first), target);
  await assert.rejects(manager.apply(preview.id, false as true, initial), ServiceError);
  const applied = await manager.apply(preview.id, true, initial);
  assert.equal(applied.status, "success"); assert.equal(applied.clientEffect, "unknown");
  assert.equal(applied.messageDescriptor?.key, "diagnostics.resources.management.m033");
  assert.equal(manager.operations(1, 50, { project: "none" }).total, 1);
  assert.equal(manager.operations(1, 50, { project: "/synthetic/project" }).total, 0);
  await assert.rejects(readlink(first)); assert.equal(await readlink(second), target); assert.match(await readFile(join(target, "SKILL.md"), "utf8"), /人工合成/);
  const archive = manager.archives("standby")[0]!;
  assert.equal(archive.restorable, true); assert.equal(await readlink(archive.storedPath!), target);
  const current = snapshot([other]);
  const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, current);
  assert.equal((await manager.apply(restore.id, true, current)).status, "success");
  assert.equal(await readlink(first), target); assert.equal(await readlink(second), target);
  assert.equal(manager.archives()[0]?.state, "restored");
  await assert.rejects(manager.apply(preview.id, true, initial), ServiceError);
}));

test("共享目录支持文件回收，旧隔离仍关闭，原生禁用与链接隔离不删除本体", async () => fixture(async (manager, directory) => {
  const userHome = join(directory, "synthetic-user"); const path = join(userHome, ".agents", "skills", "guide"); await skill(path);
  const alias = join(userHome, ".claude", "skills", "guide"); const config = join(userHome, ".codex", "config.toml");
  await mkdir(dirname(config), { recursive: true }); await writeFile(config, `# 合成配置\n[[skills.config]]\npath = ${JSON.stringify(join(path, "SKILL.md"))}\nenabled = true\n`);
  const samePath = await scanResourceInventory({ userHome, environment: {} });
  const selected = samePath.entries.find(value => value.client === "codex" && value.entryPath === path)!;
  assert.ok(samePath.entries.filter(value => value.entryPath === path).length > 1);
  assert.equal(manager.decorateInventory(samePath).entries.find(value => value.id === selected.id)?.capabilities.standby, false);
  await assert.rejects(manager.preview({ entryId: selected.id, action: "standby" }, samePath), (error: unknown) => error instanceof ServiceError && error.code === "FORBIDDEN");
  await mkdir(dirname(alias), { recursive: true }); await symlink(path, alias);
  const initial = await scanResourceInventory({ userHome, environment: {} });
  const linked = initial.entries.find(value => value.client === "claude" && value.entryPath === alias)!;
  const decorated = manager.decorateInventory(initial).entries.find(value => value.id === selected.id)!;
  assert.equal(decorated.capabilities.standby, false); assert.equal(decorated.capabilities.trash, true); assert.equal(decorated.capabilities.disable, true);
  for (const action of ["standby"] as const) {
    await assert.rejects(manager.preview({ entryId: selected.id, action }, initial), (error: unknown) => error instanceof ServiceError && error.code === "FORBIDDEN");
  }
  assert.equal(manager.archives().length, 0); assert.equal(manager.operations().total, 0);
  for (const value of initial.entries.filter(value => value.bodyId === selected.bodyId)) assert.match(await readFile(value.locator.skillFile!, "utf8"), /人工合成/);
  const disable = await manager.preview({ entryId: selected.id, action: "disable" }, initial);
  assert.equal((await manager.apply(disable.id, true, initial)).status, "success");
  const disabled = await scanResourceInventory({ userHome, environment: {} });
  assert.equal(disabled.entries.find(value => value.id === selected.id)?.nativeState, "disabled");
  for (const value of disabled.entries.filter(value => value.bodyId === selected.bodyId)) assert.match(await readFile(value.locator.skillFile!, "utf8"), /人工合成/);
  const archive = manager.archives("disabled")[0]!;
  const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, disabled);
  assert.equal((await manager.apply(restore.id, true, disabled)).status, "success");
  assert.equal(manager.decorateInventory(initial).entries.find(value => value.id === linked.id)?.capabilities.standby, true);
  const standby = await manager.preview({ entryId: linked.id, action: "standby" }, initial);
  assert.equal((await manager.apply(standby.id, true, initial)).status, "success");
  await assert.rejects(readlink(alias)); assert.match(await readFile(join(path, "SKILL.md"), "utf8"), /人工合成/);
  const remaining = await scanResourceInventory({ userHome, environment: {} });
  for (const value of remaining.entries.filter(value => value.bodyId === selected.bodyId)) assert.match(await readFile(value.locator.skillFile!, "utf8"), /人工合成/);
}));

test("同一物理文件被不同客户端发现时支持文件回收，即使本体标识不同", async () => fixture(async (manager, directory) => {
  const path = join(directory, "skills", "guide.md"); await mkdir(dirname(path), { recursive: true }); await writeFile(path, "# 合成独立文件\n");
  const selected = entry(path, { entryType: "file", sourceFormat: "skill-files", locator: { type: "skill", skillFile: path } });
  const other = { ...selected, id: "other-client", client: "claude" as const, bodyId: "other-body" };
  const initial = snapshot([selected, other]); const decorated = manager.decorateInventory(initial).entries[0]!;
  assert.equal(decorated.capabilities.standby, false); assert.equal(decorated.capabilities.trash, true);
  const preview = await manager.preview({ entryId: selected.id, action: "trash" }, initial);
  assert.equal(preview.target, "file"); assert.equal(preview.affectedEntries.length, 2);
  assert.equal(await readFile(path, "utf8"), "# 合成独立文件\n");
  assert.equal((await manager.apply(preview.id, true, initial)).status, "success");
  assert.deepEqual(manager.clientOptions().filter(row => row.view === "trash").map(row => row.client).sort(), ["claude", "codex"]);
  assert.deepEqual(manager.clientOptions().filter(row => row.view === "operations").map(row => row.client).sort(), ["claude", "codex"]);
  assert.equal(manager.operations(1, 1).operations.length, 1);
  assert.equal(manager.clientOptions().filter(row => row.view === "operations").length, 2, "共享入口候选不能受单页操作记录限制");
  await assert.rejects(readFile(path)); assert.equal(manager.archives("trash").length, 1);
  const archive = manager.archives("trash")[0]!;
  const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, snapshot([]));
  assert.equal(restore.affectedEntries.length, 2);
  assert.equal((await manager.apply(restore.id, true, snapshot([]))).status, "success");
  assert.equal(manager.clientOptions().filter(row => row.view === "trash").length, 0);
  assert.equal(manager.clientOptions().filter(row => row.view === "operations").length, 2, "恢复后历史操作仍有数据");
  assert.equal(await readFile(path, "utf8"), "# 合成独立文件\n");
}));

test("物理本体隔离与恢复的旧预览遇到新增共享链接时冲突，断链引用也不绕过复核", async () => fixture(async (manager, directory) => {
  const userHome = join(directory, "synthetic-user"); const path = join(userHome, ".codex", "skills", "guide"); await skill(path);
  const alias = join(userHome, ".claude", "skills", "guide"); await mkdir(dirname(alias), { recursive: true });
  const initial = await scanResourceInventory({ userHome, environment: {} });
  const selected = initial.entries.find(value => value.client === "codex" && value.entryPath === path)!;
  const old = await manager.preview({ entryId: selected.id, action: "trash" }, initial);
  await symlink(path, alias);
  const shared = await scanResourceInventory({ userHome, environment: {} });
  const conflict = await manager.apply(old.id, true, shared);
  assert.equal(conflict.status, "conflict"); assert.equal(conflict.localState, "unchanged");
  assert.ok(conflict.messageDescriptor); assert.equal(manager.archives().length, 0);
  assert.match(await readFile(join(path, "SKILL.md"), "utf8"), /人工合成/); assert.match(await readFile(join(alias, "SKILL.md"), "utf8"), /人工合成/);
  await rm(alias);
  const single = await scanResourceInventory({ userHome, environment: {} });
  const standby = await manager.preview({ entryId: selected.id, action: "standby" }, single);
  assert.equal((await manager.apply(standby.id, true, single)).status, "success");
  const archive = manager.archives("standby")[0]!;
  const absent = await scanResourceInventory({ userHome, environment: {} });
  const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, absent);
  await symlink(path, alias);
  const broken = await scanResourceInventory({ userHome, environment: {} });
  assert.equal(broken.entries.find(value => value.client === "claude" && value.entryPath === alias)?.readState, "broken");
  const changed = await manager.apply(restore.id, true, broken);
  assert.equal(changed.status, "conflict"); assert.equal(changed.localState, "unchanged"); await assert.rejects(stat(path));
  await assert.rejects(manager.preview({ operationId: archive.operationId, action: "restore" }, broken), (error: unknown) => error instanceof ServiceError && error.code === "FORBIDDEN");
  assert.equal(await readlink(alias), path); assert.equal(manager.archives("standby")[0]?.restorable, true);
  await rm(alias);
  const current = await scanResourceInventory({ userHome, environment: {} });
  const retry = await manager.preview({ operationId: archive.operationId, action: "restore" }, current);
  assert.equal((await manager.apply(retry.id, true, current)).status, "success"); assert.match(await readFile(join(path, "SKILL.md"), "utf8"), /人工合成/);
}));

test("普通目录可靠备份后入回收，恢复原权限；原路径占用与旧预览变化不覆盖", async () => fixture(async (manager, directory) => {
  const path = join(directory, "skills", "guide"); await skill(path);
  const selected = entry(path); const initial = snapshot([selected]);
  const old = await manager.preview({ entryId: selected.id, action: "trash" }, initial);
  await writeFile(join(path, "SKILL.md"), "# 用户新的合成内容\n");
  const conflict = await manager.apply(old.id, true, initial);
  assert.equal(conflict.status, "conflict"); assert.equal(conflict.localState, "unchanged");
  assert.equal(manager.archives().length, 0); assert.match(await readFile(join(path, "SKILL.md"), "utf8"), /用户新的/);
  const preview = await manager.preview({ entryId: selected.id, action: "trash" }, initial);
  assert.equal((await manager.apply(preview.id, true, initial)).status, "success");
  const archive = manager.archives("trash")[0]!;
  assert.equal((await stat(join(archive.storedPath!, "SKILL.md"))).mode & 0o777, 0o600);
  await skill(path);
  await assert.rejects(manager.preview({ operationId: archive.operationId, action: "restore" }, initial), (error: unknown) => error instanceof ServiceError && error.code === "CONTENT_STALE");
  assert.match(await readFile(join(path, "SKILL.md"), "utf8"), /人工合成/);
  await rm(path, { recursive: true });
  const restored = await manager.preview({ operationId: archive.operationId, action: "restore" }, snapshot([]));
  assert.equal((await manager.apply(restored.id, true, snapshot([]))).status, "success");
  assert.match(await readFile(join(path, "SKILL.md"), "utf8"), /用户新的/);
  assert.equal((await stat(join(path, "SKILL.md"))).mode & 0o777, 0o644);
}));

test("备份失败不修改来源，受管理资源只读且不会执行原生脚本", async () => fixture(async (manager, directory) => {
  const path = join(directory, "guide"); await skill(path); const selected = entry(path); const initial = snapshot([selected]);
  const preview = await manager.preview({ entryId: selected.id, action: "trash" }, initial);
  await mkdir(dirname(dirname(preview.destinationPath!)), { recursive: true });
  await writeFile(dirname(preview.destinationPath!), "人工阻塞备份位置");
  const result = await manager.apply(preview.id, true, initial);
  assert.equal(result.status, "failure"); assert.equal(result.localState, "unchanged"); assert.equal(manager.archives().length, 0);
  assert.match(await readFile(join(path, "SKILL.md"), "utf8"), /人工合成/);
  const managed = { ...selected, protected: true, owner: "synthetic-plugin", protectionReason: "plugin" as const };
  assert.equal(manager.decorateInventory(snapshot([managed])).entries[0]?.capabilities.trash, false);
  await assert.rejects(manager.preview({ entryId: managed.id, action: "trash" }, snapshot([managed])), (error: unknown) => error instanceof ServiceError && error.code === "FORBIDDEN");
  const unverified = snapshot([selected]); unverified.sources[0]!.verified = false;
  await assert.rejects(manager.preview({ entryId: selected.id, action: "standby" }, unverified), ServiceError);
}));

test("JSON 注册只移选中 key，注释与未知字段保留；恢复保留其他项编辑且拒绝目标项冲突", async () => fixture(async (manager, directory) => {
  const path = join(directory, "mcp.jsonc"); const secret = "synthetic-private-value";
  const text = `// 人工注释\n{\n  "unknown": 7,\n  "mcpServers": {\n    "selected": {"command":"synthetic-tool","env":{"TOKEN":"${secret}"},"extra":true},\n    "other": {"command":"other-tool","unknown":17}\n  }\n}\n`;
  await writeFile(path, text); const selected = mcp(path, "jsonc", { client: "claude" }); const initial = snapshot([selected]);
  const preview = await manager.preview({ entryId: selected.id, action: "standby" }, initial);
  assert.ok(!JSON.stringify(preview).includes(secret)); assert.ok(!JSON.stringify(preview).includes("command"));
  const result = await manager.apply(preview.id, true, initial);
  assert.equal(result.status, "success"); assert.ok(!JSON.stringify(result).includes(secret));
  const after = await readFile(path, "utf8"); assert.ok(after.startsWith("// 人工注释")); assert.ok(after.includes('"unknown": 7')); assert.ok(!after.includes(secret));
  assert.ok(after.includes('"other": {"command":"other-tool","unknown":17}'));
  const archive = manager.archives()[0]!; assert.ok(!JSON.stringify(archive).includes(secret));
  const unrelatedEdit = after.replace('"unknown": 7', '"unknown": 8'); await writeFile(path, unrelatedEdit);
  const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, initial);
  assert.equal((await manager.apply(restore.id, true, initial)).status, "success");
  const restored = await readFile(path, "utf8"); assert.ok(restored.includes(secret)); assert.ok(restored.includes('"unknown": 8')); assert.ok(restored.startsWith("// 人工注释"));
  const again = await manager.preview({ entryId: selected.id, action: "trash" }, initial); await manager.apply(again.id, true, initial);
  const active = manager.archives("trash")[0]!;
  const removed = await readFile(path, "utf8");
  await writeFile(path, removed.replace('"mcpServers": {', '"mcpServers": {"selected":{"command":"user-choice"},'));
  await assert.rejects(manager.preview({ operationId: active.operationId, action: "restore" }, initial), (error: unknown) => error instanceof ServiceError && error.code === "CONTENT_STALE");
  assert.ok((await readFile(path, "utf8")).includes("user-choice"));
}));

test("Codex MCP 原生停用局部修改 TOML，保留注释整数和未知项；恢复允许其他表变动", async () => fixture(async (manager, directory) => {
  const path = join(directory, "config.toml");
  const text = '# 原有注释\nlarge = 9007199254740993\n[mcp_servers.selected]\ncommand = "synthetic-tool"\nenabled = true # 保留注释\nunknown = 17\n[mcp_servers.selected.env]\nTOKEN = "synthetic-private-value"\n[mcp_servers.other]\ncommand = "other-tool"\n';
  await writeFile(path, text); const selected = mcp(path, "toml"); const initial = snapshot([selected]);
  assert.equal(manager.decorateInventory(initial).entries[0]?.capabilities.disable, true);
  const preview = await manager.preview({ entryId: selected.id, action: "disable" }, initial);
  assert.equal(preview.method, "native_toggle");
  assert.ok(preview.destinationPath!.startsWith(join(manager.vaultPath, "backups", "mcp") + sep));
  const applied = await manager.apply(preview.id, true, initial); assert.equal(applied.status, "success");
  const after = await readFile(path, "utf8"); assert.equal(after, text.replace("enabled = true", "enabled = false"));
  await assert.rejects(manager.preview({ entryId: selected.id, action: "disable" }, initial), ServiceError);
  await writeFile(path, after.replace('command = "other-tool"', 'command = "user-other-tool"'));
  const archive = manager.archives("disabled")[0]!;
  const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, initial);
  assert.equal((await manager.apply(restore.id, true, initial)).status, "success");
  const restored = await readFile(path, "utf8"); assert.ok(restored.includes("enabled = true # 保留注释")); assert.ok(restored.includes("9007199254740993")); assert.ok(restored.includes("user-other-tool"));
}));

test("Codex Skill 原生开关使用 canonical SKILL.md，恢复只撤销本次规则；复杂 TOML 明确只读", async () => fixture(async (manager, directory) => {
  const path = join(directory, "skills", "guide"); await skill(path); const config = join(directory, "config.toml");
  await writeFile(config, `# 保留内容\nunknown = 7\n[[skills.config]]\nname = "other-skill"\nenabled = false\n[[skills.config]]\npath = ${JSON.stringify(join(path, "SKILL.md"))}\nenabled = true\n`);
  const selected = entry(path, { locator: { type: "skill", nativeControl: "codex-skill", controlPath: config, skillFile: join(path, "SKILL.md") } });
  const initial = snapshot([selected]);
  const preview = await manager.preview({ entryId: selected.id, action: "disable" }, initial);
  assert.equal((await manager.apply(preview.id, true, initial)).status, "success");
  const after = await readFile(config, "utf8"); const parsed = parseToml(after) as { skills: { config: { path?: string; name?: string; enabled: boolean }[] } };
  assert.equal(parsed.skills.config.at(-1)?.path, await realpath(join(path, "SKILL.md"))); assert.equal(parsed.skills.config.at(-1)?.enabled, false);
  await writeFile(config, after.replace("unknown = 7", "unknown = 8") + '\n[[skills.config]]\nname = "later-skill"\nenabled = false\n');
  const archive = manager.archives("disabled")[0]!;
  const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, initial);
  assert.equal((await manager.apply(restore.id, true, initial)).status, "success");
  const restored = await readFile(config, "utf8"); assert.ok(restored.includes("unknown = 8")); assert.ok(restored.includes("later-skill")); assert.ok(restored.includes("other-skill")); assert.equal((parseToml(restored) as { skills: { config: { path?: string; enabled: boolean }[] } }).skills.config.find(rule => rule.path === join(path, "SKILL.md"))?.enabled, true);
  await writeFile(config, 'unknown = """\n人工多行配置\n"""\n');
  assert.equal(manager.decorateInventory(initial).entries[0]?.capabilities.disable, false);
  await assert.rejects(manager.preview({ entryId: selected.id, action: "disable" }, initial), (error: unknown) => error instanceof ServiceError && error.code === "FORBIDDEN");
  await writeFile(config, 'skills.config = [{name="other",enabled=false}]\n');
  assert.equal(manager.decorateInventory(initial).entries[0]?.capabilities.disable, false);
  await assert.rejects(manager.preview({ entryId: selected.id, action: "disable" }, initial), (error: unknown) => error instanceof ServiceError && error.code === "FORBIDDEN");
}));

test("管理状态跨重启与历史索引清理保留，永久清除需另次预览和确认", async () => fixture(async (manager, directory, home) => {
  const path = join(directory, "skills", "guide"); await skill(path); const selected = entry(path); const initial = snapshot([selected]);
  manager.observeInventory(initial); manager.setFavorite(selected.id, true);
  const manual = manager.addManualSource({ client: "codex", kind: "skill", path: dirname(path), format: "skill-directory" });
  const preview = await manager.preview({ entryId: selected.id, action: "trash" }, initial);
  assert.equal((await manager.apply(preview.id, true, initial)).status, "success");
  await writeFile(join(home, "index.sqlite"), "人工历史缓存"); await rm(join(home, "index.sqlite"));
  const reopened = new ResourceManager(home);
  try {
    assert.deepEqual(reopened.favorites(), [selected.id]); assert.equal(reopened.manualSources()[0]?.id, manual.id);
    assert.equal(reopened.operations().total, 1); assert.ok(reopened.operations().operations[0]?.messageDescriptor); assert.equal(reopened.archives("trash").length, 1);
    assert.equal(reopened.decorateInventory(snapshot([selected], "2026-02-01T00:00:00Z")).entries[0]?.firstSeenAt, "2026-01-01T00:00:00Z");
    assert.equal((await stat(reopened.dbPath)).mode & 0o777, 0o600); assert.equal((await stat(reopened.vaultPath)).mode & 0o777, 0o700);
    const archive = reopened.archives("trash")[0]!;
    const purge = await reopened.preview({ operationId: archive.operationId, action: "purge" }, snapshot([]));
    assert.equal(purge.restorationDescriptor?.key, "diagnostics.resources.management.m020");
    assert.equal(purge.method, "permanent_purge"); assert.match(purge.restoration, /失去/);
    await assert.rejects(reopened.apply(purge.id, false as true, snapshot([])), ServiceError);
    assert.ok(await stat(archive.storedPath!));
    assert.equal((await reopened.apply(purge.id, true, snapshot([]))).status, "success");
    await assert.rejects(stat(archive.storedPath!)); assert.equal(reopened.archives()[0]?.state, "purged");
    await assert.rejects(reopened.preview({ operationId: archive.operationId, action: "restore" }, snapshot([])), ServiceError);
  } finally { reopened.close(); }
}));

test("过期预览和确认前的恢复目标变化明确冲突，不重放操作或覆盖用户内容", async () => fixture(async (manager, directory) => {
  const path = join(directory, "guide"); await skill(path); const selected = entry(path); const initial = snapshot([selected]);
  const expired = await manager.preview({ entryId: selected.id, action: "trash" }, initial);
  const database = new Database(manager.dbPath);
  database.prepare("UPDATE resource_plans SET json=json_set(json,'$.public.expiresAt',?) WHERE id=?").run("2025-01-01T00:00:00Z", expired.id); database.close();
  assert.equal((await manager.apply(expired.id, true, initial)).status, "conflict");
  assert.equal(manager.archives().length, 0); assert.ok(await stat(path));
  const preview = await manager.preview({ entryId: selected.id, action: "trash" }, initial); await manager.apply(preview.id, true, initial);
  const archive = manager.archives("trash")[0]!;
  const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, snapshot([]));
  await skill(path); await writeFile(join(path, "SKILL.md"), "# 用户新内容\n");
  const conflict = await manager.apply(restore.id, true, snapshot([]));
  assert.equal(conflict.status, "conflict"); assert.equal(conflict.localState, "unchanged");
  assert.equal(await readFile(join(path, "SKILL.md"), "utf8"), "# 用户新内容\n");
  assert.equal(manager.archives("trash")[0]?.restorable, true);
}));

test("TOML 注册回收与恢复只操作所选表和子表，合法但未经保留编辑适配的格式只读", async () => fixture(async (manager, directory) => {
  const path = join(directory, "config.toml");
  const text = '# 注释\nunknown = 9007199254740993\n[mcp_servers."demo.name"]\ncommand = "synthetic-tool"\n[mcp_servers."demo.name".env]\nTOKEN = "synthetic-private-value"\n[mcp_servers.other]\ncommand = "other-tool"\n';
  await writeFile(path, text);
  const selected = mcp(path, "toml", { name: "demo.name", server: "demo.name",
    locator: { type: "mcp", format: "toml", configPath: path, nativeControl: "codex-mcp", keyPath: ["mcp_servers", "demo.name"] } });
  const initial = snapshot([selected]); const preview = await manager.preview({ entryId: selected.id, action: "trash" }, initial);
  assert.equal((await manager.apply(preview.id, true, initial)).status, "success");
  const after = await readFile(path, "utf8"); assert.ok(!after.includes("demo.name")); assert.ok(after.includes("9007199254740993")); assert.ok(after.includes("other-tool"));
  const archive = manager.archives("trash")[0]!; const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, initial);
  assert.equal((await manager.apply(restore.id, true, initial)).status, "success"); assert.equal(await readFile(path, "utf8"), text);
  await writeFile(path, 'mcp_servers.selected = {command="synthetic-tool",enabled=true}\n');
  const inline = mcp(path, "toml"); const inlineSnapshot = snapshot([inline]);
  assert.equal(manager.decorateInventory(inlineSnapshot).entries[0]?.capabilities.disable, false);
  assert.equal(manager.decorateInventory(inlineSnapshot).entries[0]?.capabilities.trash, false);
  await assert.rejects(manager.preview({ entryId: inline.id, action: "trash" }, inlineSnapshot), (error: unknown) => error instanceof ServiceError && error.code === "FORBIDDEN");
}));

test("真实盘点契约到管理模块贯通，收藏本体显示保护，原生停用与恢复按当前快照复核", async () => fixture(async (manager, directory) => {
  const userHome = join(directory, "synthetic-user"); const path = join(userHome, ".agents", "skills", "guide"); await skill(path);
  const config = join(userHome, ".codex", "config.toml"); await mkdir(dirname(config), { recursive: true });
  const originalConfig = `[mcp_servers.selected]\ncommand = "synthetic-tool"\n[[skills.config]]\npath = ${JSON.stringify(join(path, "SKILL.md"))}\nenabled = true\n`;
  await writeFile(config, originalConfig);
  const initial = await scanResourceInventory({ userHome, environment: {} });
  const selected = initial.entries.find(value => value.kind === "skill" && value.client === "codex")!;
  assert.ok(selected); manager.setFavorite(selected.bodyId, true);
  assert.equal(manager.decorateInventory(initial).entries.find(value => value.id === selected.id)?.favorite, true);
  const preview = await manager.preview({ entryId: selected.id, action: "disable" }, initial);
  assert.equal(preview.protected, true); assert.equal((await manager.apply(preview.id, true, initial)).status, "success");
  const disabled = await scanResourceInventory({ userHome, environment: {} });
  assert.equal(disabled.entries.find(value => value.id === selected.id)?.nativeState, "disabled");
  await assert.rejects(manager.preview({ entryId: selected.id, action: "disable" }, disabled), ServiceError);
  const archive = manager.archives("disabled")[0]!; const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, disabled);
  assert.equal((await manager.apply(restore.id, true, disabled)).status, "success");
  assert.equal(await readFile(config, "utf8"), originalConfig);
}));

test("写入后反馈失败保留部分完成与可用恢复材料，不虚报成功；恢复后的材料另行清除", async () => fixture(async (manager, directory) => {
  const path = join(directory, "config.toml"); const original = '[mcp_servers.selected]\ncommand = "synthetic-tool"\nenabled = true\n';
  await writeFile(path, original); const selected = mcp(path, "toml"); const initial = snapshot([selected]);
  const preview = await manager.preview({ entryId: selected.id, action: "disable" }, initial);
  const access = manager as unknown as { writeConfig: (...args: unknown[]) => Promise<void> };
  const write = access.writeConfig.bind(manager);
  access.writeConfig = async (...args) => { await write(...args); throw new Error("人工写入后反馈失败"); };
  const applied = await manager.apply(preview.id, true, initial); access.writeConfig = write;
  assert.equal(applied.status, "partial"); assert.equal(applied.localState, "partial"); assert.equal(applied.clientEffect, "unknown");
  assert.equal(applied.messageDescriptor?.key, "diagnostics.resources.management.m034");
  assert.doesNotMatch(applied.message, /人工写入后反馈失败/);
  assert.ok((await readFile(path, "utf8")).includes("enabled = false"));
  const archive = manager.archives("disabled")[0]!; assert.equal(archive.operationStatus, "partial"); assert.equal(archive.restorable, true);
  const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, initial);
  assert.equal((await manager.apply(restore.id, true, initial)).status, "success"); assert.equal(await readFile(path, "utf8"), original);
  const purge = await manager.preview({ operationId: archive.operationId, action: "purge" }, initial);
  assert.equal(purge.clientEffect, "unknown"); assert.equal((await manager.apply(purge.id, true, initial)).status, "success");
  assert.equal(await readFile(path, "utf8"), original); assert.equal(manager.archives()[0]?.state, "purged");
}));

test("同名 Skill 的不同原入口和重复回收分别保留，目录受限且永久清除只移除该次材料", async () => fixture(async (manager, directory) => {
  const first = entry(join(directory, "first", "guide"), { id: "first-entry", bodyId: "first-body" });
  const second = entry(join(directory, "second", "guide"), { id: "second-entry", bodyId: "second-body" });
  await skill(first.entryPath); await skill(second.entryPath);
  const firstPreview = await manager.preview({ entryId: first.id, action: "trash" }, snapshot([first]));
  assert.equal((await manager.apply(firstPreview.id, true, snapshot([first]))).status, "success");
  const firstArchive = manager.archives("trash")[0]!;
  const secondPreview = await manager.preview({ entryId: second.id, action: "trash" }, snapshot([second]));
  assert.equal((await manager.apply(secondPreview.id, true, snapshot([second]))).status, "success");
  const secondArchive = manager.archives("trash")[0]!;
  assert.notEqual(dirname(dirname(firstArchive.storedPath!)), dirname(dirname(secondArchive.storedPath!)));
  const restore = await manager.preview({ operationId: firstArchive.operationId, action: "restore" }, snapshot([]));
  assert.equal((await manager.apply(restore.id, true, snapshot([]))).status, "success");
  const sourceDirectory = dirname(dirname(firstArchive.storedPath!));
  await chmod(sourceDirectory, 0o755);
  const repeatedPreview = await manager.preview({ entryId: first.id, action: "trash" }, snapshot([first]));
  assert.equal((await manager.apply(repeatedPreview.id, true, snapshot([first]))).status, "success");
  const repeatedArchive = manager.archives("trash")[0]!;
  assert.equal(dirname(dirname(repeatedArchive.storedPath!)), sourceDirectory);
  assert.notEqual(repeatedArchive.storedPath, firstArchive.storedPath);
  const parts = relative(manager.vaultPath, dirname(repeatedArchive.storedPath!)).split(sep);
  for (let count = 0; count <= parts.length; count++) {
    assert.equal((await stat(join(manager.vaultPath, ...parts.slice(0, count)))).mode & 0o777, 0o700);
  }
  assert.equal((await stat(join(repeatedArchive.storedPath!, "SKILL.md"))).mode & 0o777, 0o600);
  const purge = await manager.preview({ operationId: firstArchive.operationId, action: "purge" }, snapshot([]));
  assert.equal((await manager.apply(purge.id, true, snapshot([]))).status, "success");
  await assert.rejects(stat(dirname(firstArchive.storedPath!)));
  assert.match(await readFile(join(repeatedArchive.storedPath!, "SKILL.md"), "utf8"), /人工合成/);
  assert.match(await readFile(join(secondArchive.storedPath!, "SKILL.md"), "utf8"), /人工合成/);
}));

test("同名 MCP 多注册回收各有恢复材料，删除所选注册不覆盖另一份备份", async () => fixture(async (manager, directory) => {
  const path = join(directory, "mcp.json");
  await writeFile(path, '{"mcpServers":{"first":{"command":"first-tool"},"second":{"command":"second-tool"}}}');
  const registered = (server: string) => mcp(path, "json", { id: server, bodyId: server, name: "same-name", server,
    locator: { type: "mcp", configPath: path, format: "json", keyPath: ["mcpServers", server] } });
  const first = registered("first"); const second = registered("second");
  const firstPreview = await manager.preview({ entryId: first.id, action: "trash" }, snapshot([first]));
  assert.equal((await manager.apply(firstPreview.id, true, snapshot([first]))).status, "success");
  const firstArchive = manager.archives("trash")[0]!;
  const secondPreview = await manager.preview({ entryId: second.id, action: "trash" }, snapshot([second]));
  assert.equal((await manager.apply(secondPreview.id, true, snapshot([second]))).status, "success");
  const secondArchive = manager.archives("trash")[0]!;
  assert.notEqual(dirname(dirname(firstArchive.storedPath!)), dirname(dirname(secondArchive.storedPath!)));
  assert.ok(firstArchive.storedPath!.startsWith(join(manager.vaultPath, "trash", "mcp") + sep));
  assert.ok((await readFile(firstArchive.storedPath!, "utf8")).includes("first-tool"));
  assert.ok((await readFile(secondArchive.storedPath!, "utf8")).includes("second-tool"));
  const restore = await manager.preview({ operationId: firstArchive.operationId, action: "restore" }, snapshot([]));
  assert.equal((await manager.apply(restore.id, true, snapshot([]))).status, "success");
  assert.equal(JSON.parse(await readFile(path, "utf8")).mcpServers.first.command, "first-tool");
  assert.equal(JSON.parse(await readFile(path, "utf8")).mcpServers.second, undefined);
}));

test("旧备用档案纳入回收查询，启动保留旧目录并支持恢复及另次确认永久清除", async () => fixture(async (manager, directory, home) => {
  const path = join(directory, "skills", "guide"); await skill(path); const selected = entry(path); const initial = snapshot([selected]);
  const preview = await manager.preview({ entryId: selected.id, action: "standby" }, initial);
  assert.ok(preview.destinationPath!.startsWith(join(manager.vaultPath, "trash", "skill") + sep));
  assert.equal((await manager.apply(preview.id, true, initial)).status, "success");
  const archive = manager.archives("standby")[0]!;
  const legacyDirectory = join(manager.vaultPath, preview.id);
  await rename(dirname(archive.storedPath!), legacyDirectory);
  const legacyMaterial = join(legacyDirectory, "material");
  const fingerprint = await resourceMaterialFingerprint(legacyMaterial);
  const database = new Database(manager.dbPath);
  database.prepare("UPDATE resource_archives SET json=json_set(json,'$.public.storedPath',?) WHERE id=?").run(legacyMaterial, archive.id);
  database.close();
  const reopened = new ResourceManager(home);
  try {
    assert.equal(reopened.archives("standby").length, 1);
    assert.equal(reopened.archives("trash")[0]?.state, "standby");
    assert.equal(reopened.archives("trash")[0]?.storedPath, legacyMaterial);
    assert.equal(await resourceMaterialFingerprint(legacyMaterial), fingerprint);
    const restore = await reopened.preview({ operationId: archive.operationId, action: "restore" }, snapshot([]));
    assert.equal((await reopened.apply(restore.id, true, snapshot([]))).status, "success");
    assert.match(await readFile(join(path, "SKILL.md"), "utf8"), /人工合成/);
    const purge = await reopened.preview({ operationId: archive.operationId, action: "purge" }, snapshot([]));
    await assert.rejects(reopened.apply(purge.id, false as true, snapshot([])), ServiceError);
    assert.equal(await resourceMaterialFingerprint(legacyMaterial), fingerprint);
    assert.equal((await reopened.apply(purge.id, true, snapshot([]))).status, "success");
    assert.equal(await resourceMaterialFingerprint(legacyMaterial), "missing");
    assert.match(await readFile(join(path, "SKILL.md"), "utf8"), /人工合成/);
  } finally { reopened.close(); }
}));

test("尚未恢复的旧备用档案也可另行确认永久清除，不自动删除材料", async () => fixture(async (manager, directory) => {
  const path = join(directory, "guide"); await skill(path); const selected = entry(path); const initial = snapshot([selected]);
  const preview = await manager.preview({ entryId: selected.id, action: "standby" }, initial);
  assert.equal((await manager.apply(preview.id, true, initial)).status, "success");
  const archive = manager.archives("standby")[0]!;
  const legacyDirectory = join(manager.vaultPath, preview.id); await rename(dirname(archive.storedPath!), legacyDirectory);
  const legacyMaterial = join(legacyDirectory, "material");
  const database = new Database(manager.dbPath);
  database.prepare("UPDATE resource_archives SET json=json_set(json,'$.public.storedPath',?) WHERE id=?").run(legacyMaterial, archive.id);
  database.close();
  const purge = await manager.preview({ operationId: archive.operationId, action: "purge" }, snapshot([]));
  await assert.rejects(manager.apply(purge.id, false as true, snapshot([])), ServiceError);
  assert.equal(manager.archives("trash")[0]?.restorable, true); assert.ok(await stat(legacyMaterial));
  assert.equal((await manager.apply(purge.id, true, snapshot([]))).status, "success");
  await assert.rejects(stat(legacyDirectory)); assert.equal(manager.archives("trash").length, 0);
  assert.equal(manager.archives()[0]?.state, "purged"); await assert.rejects(stat(path));
}));


test("普通共享 Skill 只回收一次文件，保存全部已知范围，跨客户端可查并恢复", async () => fixture(async (manager, directory) => {
  const userHome = join(directory, "synthetic-user"); const path = join(userHome, ".agents", "skills", "shared-guide");
  await skill(path);
  const alias = join(userHome, ".claude", "skills", "guide-link"); await mkdir(dirname(alias), { recursive: true }); await symlink(path, alias);
  const initial = await scanResourceInventory({ userHome, projects: [userHome], environment: {} });
  const selected = initial.entries.find(value => value.client === "pi" && value.entryPath === path)!;
  assert.ok(selected); assert.equal(manager.decorateInventory(initial).entries.find(value => value.id === selected.id)?.capabilities.trash, true);
  assert.equal(manager.decorateInventory(initial).entries.find(value => value.id === selected.id)?.capabilities.disable, false);
  const preview = await manager.preview({ entryId: selected.id, action: "trash" }, initial);
  assert.equal(preview.target, "file"); assert.ok(new Set(preview.affectedEntries.map(value => value.client)).size > 2);
  const result = await manager.apply(preview.id, true, initial); assert.equal(result.status, "success");
  await assert.rejects(readFile(join(path, "SKILL.md"))); assert.equal(await readlink(alias), path);
  const archives = manager.archives("trash"); assert.equal(archives.length, 1);
  const archive = archives[0]!; assert.equal(archive.target, "file"); assert.equal(JSON.stringify(archive.affectedEntries), JSON.stringify(preview.affectedEntries));
  assert.equal(manager.operations(1, 50, { client: "codex" }).total, 1);
  assert.equal(manager.operations(1, 50, { project: userHome }).total, 1);
  assert.equal(manager.operations(1, 50, { q: "guide-link", client: "claude", project: "none" }).total, 1);
  const current = await scanResourceInventory({ userHome, projects: [userHome], environment: {} });
  const broken = manager.decorateInventory(current).entries.find(value => value.entryPath === alias)!;
  assert.equal(broken.readState, "broken"); assert.equal(broken.managementState, "trash"); assert.equal(broken.capabilities.restore, true);
  const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, current);
  for (const affected of preview.affectedEntries) assert.ok(restore.affectedEntries.some(value => value.id === affected.id && value.project === affected.project));
  assert.equal((await manager.apply(restore.id, true, current)).status, "success");
  assert.match(await readFile(join(path, "SKILL.md"), "utf8"), /人工合成/);
  assert.match(await readFile(join(alias, "SKILL.md"), "utf8"), /人工合成/);
  assert.equal(manager.archives().length, 1); assert.equal(manager.archives()[0]?.state, "restored");
  assert.equal(manager.operations(1, 50, { client: "codex" }).total, 2);
}));

test("共享文件中的保护引用阻止回收，新增保护引用使旧预览冲突", async () => fixture(async (manager, directory) => {
  const path = join(directory, "skills", "guide"); await skill(path);
  const selected = entry(path); const protectedAlias = entry(path, { id: "protected-alias", bodyId: "plugin-body", protected: true, protectionReason: "plugin", owner: "synthetic-plugin" });
  const protectedSnapshot = snapshot([selected, protectedAlias]);
  assert.equal(manager.decorateInventory(protectedSnapshot).entries[0]?.capabilities.trash, false);
  await assert.rejects(manager.preview({ entryId: selected.id, action: "trash" }, protectedSnapshot), (error: unknown) => error instanceof ServiceError && error.code === "FORBIDDEN");
  const preview = await manager.preview({ entryId: selected.id, action: "trash" }, snapshot([selected]));
  assert.equal((await manager.apply(preview.id, true, protectedSnapshot)).status, "conflict");
  assert.equal(manager.archives().length, 0); assert.match(await readFile(join(path, "SKILL.md"), "utf8"), /人工合成/);
}));

test("链式链接目标缺失仍可恢复，目标内容变化不影响链接恢复", async () => fixture(async (manager, directory) => {
  const target = join(directory, "target"); await skill(target);
  const middle = join(directory, "middle"); const path = join(directory, "link"); await symlink(target, middle); await symlink(middle, path);
  const selected = entry(path, { entryType: "symlink", linkTarget: middle, targetPath: target });
  const initial = snapshot([selected]); const trash = await manager.preview({ entryId: selected.id, action: "trash" }, initial);
  assert.equal(trash.target, "entry"); assert.equal((await manager.apply(trash.id, true, initial)).status, "success");
  const archive = manager.archives("trash")[0]!; await rm(target, { recursive: true });
  const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, snapshot([]));
  assert.deepEqual(restore.link, { target: middle, resolvedTarget: middle, state: "missing" });
  const restored = await manager.apply(restore.id, true, snapshot([]));
  assert.equal(restored.status, "success"); assert.deepEqual(restored.link, restore.link);
  assert.equal(await readlink(path), middle); await assert.rejects(realpath(path)); assert.equal(await readlink(middle), target);
  await skill(target);
  const again = await manager.preview({ entryId: selected.id, action: "trash" }, initial);
  const removed = await manager.apply(again.id, true, initial);
  const available = await manager.preview({ operationId: removed.id, action: "restore" }, snapshot([]));
  await writeFile(join(target, "extra.md"), "合成目标的内容变更\n");
  assert.equal((await manager.apply(available.id, true, snapshot([]))).status, "success");
  assert.equal(await readlink(path), middle); assert.equal(await readFile(join(target, "extra.md"), "utf8"), "合成目标的内容变更\n");
}));

for (const relativeLink of [false, true]) test(`原本断开的${relativeLink ? "相对" : "绝对"}链接可移除恢复并单独永久清除`, async () => fixture(async (manager, directory) => {
  const target = join(directory, "missing-target"); const path = join(directory, "links", "guide");
  const other = join(directory, "other-link"); await mkdir(dirname(path));
  const text = relativeLink ? relative(dirname(path), target) : target;
  await symlink(text, path); await symlink(target, other);
  const selected = entry(path, { entryType: "symlink", readState: "broken", linkTarget: text });
  const initial = snapshot([selected]);
  const trash = await manager.preview({ entryId: selected.id, action: "trash" }, initial);
  assert.deepEqual(trash.link, { target: text, resolvedTarget: target, state: "missing" });
  const removed = await manager.apply(trash.id, true, initial); assert.equal(removed.status, "success");
  await assert.rejects(lstat(path)); await assert.rejects(lstat(target)); assert.equal(await readlink(other), target);
  const archive = manager.archives("trash")[0]!;
  assert.equal(await readlink(archive.storedPath!), text); assert.equal(archive.restorable, true);
  const restore = await manager.preview({ operationId: removed.id, action: "restore" }, snapshot([]));
  assert.equal(restore.originalPath, path); assert.deepEqual(restore.link, trash.link);
  assert.equal((await manager.apply(restore.id, true, snapshot([]))).status, "success");
  assert.equal(await readlink(path), text); await assert.rejects(realpath(path));
  const again = await manager.preview({ entryId: selected.id, action: "trash" }, initial);
  const removedAgain = await manager.apply(again.id, true, initial);
  const purge = await manager.preview({ operationId: removedAgain.id, action: "purge" }, snapshot([]));
  assert.equal(purge.originalPath, path); assert.deepEqual(purge.link, trash.link);
  const material = manager.archives("trash")[0]!.storedPath!;
  assert.equal((await manager.apply(purge.id, true, snapshot([]))).status, "success");
  await assert.rejects(lstat(material)); await assert.rejects(lstat(path)); await assert.rejects(lstat(target));
  assert.equal(await readlink(other), target);
  await assert.rejects(manager.preview({ operationId: removedAgain.id, action: "restore" }, snapshot([])), ServiceError);
}));

test("循环目标状态无法确认时仍只恢复所选链接", async () => fixture(async (manager, directory) => {
  const target = join(directory, "loop"); const path = join(directory, "link");
  await symlink(target, target); await symlink(target, path);
  const selected = entry(path, { entryType: "symlink", readState: "broken", linkTarget: target });
  const initial = snapshot([selected]); const trash = await manager.preview({ entryId: selected.id, action: "trash" }, initial);
  assert.deepEqual(trash.link, { target, resolvedTarget: target, state: "unreadable" });
  const removed = await manager.apply(trash.id, true, initial);
  const restore = await manager.preview({ operationId: removed.id, action: "restore" }, snapshot([]));
  assert.deepEqual(restore.link, trash.link);
  const restored = await manager.apply(restore.id, true, snapshot([]));
  assert.equal(restored.status, "success"); assert.deepEqual(restored.link, restore.link);
  assert.equal(await readlink(path), target); assert.equal(await readlink(target), target);
}));

for (const targetAppears of [false, true]) test(`预览后目标${targetAppears ? "出现" : "消失"}不阻止恢复链接，结果使用执行时状态`, async () => fixture(async (manager, directory) => {
  const target = join(directory, "target"); const path = join(directory, "link");
  if (!targetAppears) await skill(target);
  await symlink(target, path);
  const selected = entry(path, { entryType: "symlink", linkTarget: target, readState: targetAppears ? "broken" : "present" });
  const initial = snapshot([selected]); const trash = await manager.preview({ entryId: selected.id, action: "trash" }, initial);
  const removed = await manager.apply(trash.id, true, initial);
  const restore = await manager.preview({ operationId: removed.id, action: "restore" }, snapshot([]));
  assert.equal(restore.link?.state, targetAppears ? "missing" : "available");
  if (targetAppears) await skill(target); else await rm(target, { recursive: true });
  const restored = await manager.apply(restore.id, true, snapshot([]));
  assert.equal(restored.status, "success"); assert.equal(restored.link?.state, targetAppears ? "available" : "missing");
  assert.equal(await readlink(path), target);
}));

for (const conflict of ["occupied", "material"] as const) test(`断链恢复仍拒绝${conflict === "occupied" ? "原位置被其他断链占用" : "材料指向被篡改"}`, async () => fixture(async (manager, directory) => {
  const path = join(directory, "link"); const target = join(directory, "missing-target"); await symlink(target, path);
  const initial = snapshot([entry(path, { entryType: "symlink", readState: "broken", linkTarget: target })]);
  const trash = await manager.preview({ entryId: initial.entries[0]!.id, action: "trash" }, initial);
  const removed = await manager.apply(trash.id, true, initial);
  const archive = manager.archives("trash")[0]!;
  const restore = await manager.preview({ operationId: removed.id, action: "restore" }, snapshot([]));
  const replacement = join(directory, "other-missing-target");
  if (conflict === "occupied") await symlink(replacement, path);
  else { await rm(archive.storedPath!); await symlink(replacement, archive.storedPath!); }
  assert.equal((await manager.apply(restore.id, true, snapshot([]))).status, "conflict");
  assert.equal(manager.archives("trash")[0]?.restorable, true);
  if (conflict === "occupied") assert.equal(await readlink(path), replacement); else await assert.rejects(lstat(path));
  await assert.rejects(manager.preview({ operationId: removed.id, action: "restore" }, snapshot([])), ServiceError);
}));

test("共享链接回收只影响同一路径的发现入口，恢复保留这些客户端范围", async () => fixture(async (manager, directory) => {
  const target = join(directory, "target"); const path = join(directory, "link"); const otherPath = join(directory, "other-link");
  await skill(target); await symlink(target, path); await symlink(target, otherPath);
  const selected = entry(path, { entryType: "symlink", linkTarget: target, targetPath: target });
  const samePath = { ...selected, id: "same-path-client", client: "claude" as const };
  const other = { ...selected, id: "other-link", entryPath: otherPath };
  const initial = snapshot([selected, samePath, other]);
  const trash = await manager.preview({ entryId: selected.id, action: "trash" }, initial);
  assert.equal(trash.target, "entry"); assert.equal(trash.affectedEntries.length, 2);
  assert.ok(trash.affectedEntries.every(value => value.entryPath === path));
  assert.equal((await manager.apply(trash.id, true, initial)).status, "success");
  assert.equal(await readlink(otherPath), target); assert.match(await readFile(join(target, "SKILL.md"), "utf8"), /人工合成/);
  const archive = manager.archives("trash")[0]!;
  const current = snapshot([other]); const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, current);
  assert.equal(JSON.stringify(restore.affectedEntries), JSON.stringify(trash.affectedEntries));
  assert.equal((await manager.apply(restore.id, true, current)).status, "success");
  assert.equal(await readlink(path), target);
}));


test("恢复中心合并尚未撤销的配置、链接和文件变更，按变更时间排序", async () => fixture(async (manager, directory) => {
  const config = join(directory, "config.toml"); await writeFile(config, '[mcp_servers.selected]\ncommand = "synthetic-tool"\nenabled = true\n');
  const registered = mcp(config, "toml", { nativeState: "enabled" });
  const disabled = await manager.apply((await manager.preview({ entryId: registered.id, action: "disable" }, snapshot([registered]))).id, true, snapshot([registered]));
  const file = join(directory, "guide"); await skill(file); const selected = entry(file);
  const removed = await manager.apply((await manager.preview({ entryId: selected.id, action: "trash" }, snapshot([selected]))).id, true, snapshot([selected]));
  const link = join(directory, "link"); await symlink(file, link); const linked = entry(link, { id: "linked", entryType: "symlink", readState: "broken", linkTarget: file });
  const unlinked = await manager.apply((await manager.preview({ entryId: linked.id, action: "standby" }, snapshot([linked]))).id, true, snapshot([linked]));
  assert.equal(manager.archives("recoverable").length, 3);
  const database = new Database(manager.dbPath);
  try {
    const archive = manager.archives("disabled")[0]!;
    const row = database.prepare("SELECT json FROM resource_archives WHERE id=?").get(archive.id) as { json: string };
    const stored = JSON.parse(row.json); stored.public.createdAt = "2099-01-01T00:00:00Z";
    database.prepare("UPDATE resource_archives SET json=? WHERE id=?").run(JSON.stringify(stored), archive.id);
  } finally { database.close(); }
  assert.equal(manager.archives("recoverable")[0]?.operationId, disabled.id);
  assert.equal(manager.archives("trash").length, 2);
  const restore = await manager.preview({ operationId: removed.id, action: "restore" }, snapshot([]));
  assert.equal((await manager.apply(restore.id, true, snapshot([]))).status, "success");
  assert.ok(!manager.archives("recoverable").some(value => value.operationId === removed.id));
  const purge = await manager.preview({ operationId: disabled.id, action: "purge" }, snapshot([]));
  assert.equal((await manager.apply(purge.id, true, snapshot([]))).status, "success");
  assert.equal(parseToml(await readFile(config, "utf8")).mcp_servers.selected.enabled, false);
  assert.deepEqual(manager.archives("recoverable").map(value => value.operationId), [unlinked.id]);
  assert.equal(manager.operations().total, 5);
}));

test("恢复材料被外部删除后保留待撤销记录，预览明确拒绝且不写原位置", async () => fixture(async (manager, directory) => {
  const path = join(directory, "link"); const target = join(directory, "missing-target"); await symlink(target, path);
  const selected = entry(path, { entryType: "symlink", readState: "broken", linkTarget: target }); const initial = snapshot([selected]);
  const removed = await manager.apply((await manager.preview({ entryId: selected.id, action: "trash" }, initial)).id, true, initial);
  await rm(manager.archives("recoverable")[0]!.storedPath!);
  assert.equal(manager.archives("recoverable")[0]?.operationId, removed.id);
  await assert.rejects(manager.preview({ operationId: removed.id, action: "restore" }, snapshot([])),
    (error: unknown) => error instanceof ServiceError && error.code === "CONTENT_STALE");
  await assert.rejects(lstat(path)); await assert.rejects(lstat(target));
  assert.equal(manager.operations().total, 1);
}));

for (const missingFile of [true, false]) test(`恢复链接核验实际目标 Skill 文件${missingFile ? "缺失" : "不可读"}`, async () => fixture(async (manager, directory) => {
  const target = join(directory, "target"); const path = join(directory, "link"); await mkdir(target);
  if (!missingFile) await mkdir(join(target, "SKILL.md"));
  await symlink(target, path); const selected = entry(path, { entryType: "symlink", linkTarget: target }); const initial = snapshot([selected]);
  const trash = await manager.preview({ entryId: selected.id, action: "trash" }, initial);
  assert.equal(trash.link?.state, missingFile ? "skill_missing" : "skill_unreadable");
  const removed = await manager.apply(trash.id, true, initial);
  const restore = await manager.preview({ operationId: removed.id, action: "restore" }, snapshot([]));
  const result = await manager.apply(restore.id, true, snapshot([]));
  assert.equal(result.status, "success"); assert.equal(result.link?.state, trash.link?.state); assert.equal(await readlink(path), target);
}));
