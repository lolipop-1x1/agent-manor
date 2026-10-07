import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DataMigrationError, migrateDataHome } from "../src/data-migration.js";
import { ResourceManager } from "../src/resources/management.js";
import type { ResourceInventoryEntry, ResourceInventorySnapshot } from "../src/resource-inventory-contracts.js";
import { acquireLock } from "../src/service/runtime.js";

async function fixture(run: (root: string, source: string, destination: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "manor-data-migration-"));
  const source = join(root, "temporary-data"); await mkdir(source);
  const index = new Database(join(source, "index.sqlite"));
  index.exec("CREATE TABLE synthetic_values(id TEXT PRIMARY KEY,value TEXT); INSERT INTO synthetic_values VALUES('version','synthetic-version');");
  index.close();
  try { await run(root, source, join(root, "persistent-data")); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const code = (expected: string) => (error: unknown) => error instanceof DataMigrationError && error.code === expected;
function inventory(path: string): ResourceInventorySnapshot {
  const entry: ResourceInventoryEntry = { id: "synthetic-entry", sourceId: "synthetic-source", bodyId: "synthetic-body", kind: "skill", name: "guide",
    client: "codex", scope: "user", entryPath: path, targetPath: path, entryType: "directory", readState: "present", nativeState: "unknown", protected: false,
    observedAt: "2026-01-01T00:00:00Z", sourceFormat: "skill-directory", locator: { type: "skill", skillFile: join(path, "SKILL.md") },
    capabilities: { inventory: true, associate: true, disable: false, standby: false, trash: false, restore: false, purge: false } };
  return { entries: [entry], bodies: [{ id: entry.bodyId, name: entry.name, kind: "skill", entryIds: [entry.id] }], gaps: [], observedAt: entry.observedAt,
    sources: [{ id: entry.sourceId, client: "codex", kind: "skill", scope: "user", path: dirname(path), format: "skill-directory", origin: "manual",
      readState: "ok", verified: true, observedAt: entry.observedAt }] };
}

test("持久目录迁移保留索引、偏好与旧备用恢复，旧预览失效且原数据保留", async () => fixture(async (root, source, destination) => {
  const skill = join(root, "original-skills", "guide"); await mkdir(skill, { recursive: true }); await writeFile(join(skill, "SKILL.md"), "# 人工合成正文\n");
  const snapshot = inventory(skill); const manager = new ResourceManager(source);
  manager.setFavorite("synthetic-entry", true);
  manager.addManualSource({ client: "codex", kind: "skill", path: dirname(skill), format: "skill-directory" });
  const plan = await manager.preview({ action: "standby", entryId: snapshot.entries[0]!.id }, snapshot);
  const operation = await manager.apply(plan.id, true, snapshot); assert.equal(operation.status, "success");
  const archive = manager.archives()[0]!;
  await manager.preview({ action: "restore", operationId: archive.operationId }, snapshot);
  manager.close();
  // 模拟上一版平铺目录，恢复依赖完整原位置而不是新目录名。
  const legacy = join(source, "resource-vault", archive.id, "material"); await mkdir(dirname(legacy)); await rename(archive.storedPath!, legacy);
  const originalDb = new Database(join(source, "resources.sqlite"));
  const row = originalDb.prepare("SELECT json FROM resource_archives WHERE id=?").get(archive.id) as { json: string };
  const value = JSON.parse(row.json); value.public.storedPath = legacy;
  originalDb.prepare("UPDATE resource_archives SET json=? WHERE id=?").run(JSON.stringify(value), archive.id); originalDb.close();
  await writeFile(join(source, "preferences.json"), JSON.stringify({ language: "en" }));
  const phases: string[] = []; const result = await migrateDataHome(source, destination, phase => phases.push(phase));
  assert.deepEqual(result, { databases: 2, archives: 1, sourceRetained: true }); assert.ok(phases.includes("publish"));
  assert.equal(await readFile(join(destination, "preferences.json"), "utf8"), '{"language":"en"}');
  const copiedIndex = new Database(join(destination, "index.sqlite"), { readonly: true });
  assert.equal((copiedIndex.prepare("SELECT value FROM synthetic_values WHERE id='version'").get() as { value: string }).value, "synthetic-version"); copiedIndex.close();
  const copiedDb = new Database(join(destination, "resources.sqlite"), { readonly: true });
  assert.equal((copiedDb.prepare("SELECT COUNT(*) AS n FROM resource_plans").get() as { n: number }).n, 0); copiedDb.close();
  assert.equal(await readFile(join(legacy, "SKILL.md"), "utf8"), "# 人工合成正文\n");
  const moved = new ResourceManager(destination);
  try {
    assert.deepEqual(moved.favorites(), ["synthetic-entry"]); assert.equal(moved.manualSources()[0]?.path, dirname(skill));
    const recovered = moved.archives("trash")[0]!;
    assert.equal(recovered.originalPath, skill); assert.ok(recovered.storedPath!.startsWith(join(destination, "resource-vault", "trash", "skill")));
    assert.equal(moved.operations().total, 1);
    const restore = await moved.preview({ action: "restore", operationId: recovered.operationId }, snapshot);
    assert.equal((await moved.apply(restore.id, true, snapshot)).status, "success");
    assert.equal(await readFile(join(skill, "SKILL.md"), "utf8"), "# 人工合成正文\n");
  } finally { moved.close(); }
  assert.equal((await stat(destination)).mode & 0o777, 0o700);
  assert.equal((await stat(join(destination, "index.sqlite"))).mode & 0o777, 0o600);
}));

test("活动服务、管理锁及已存在目标不会被迁移覆盖", async () => fixture(async (_root, source, destination) => {
  for (const name of ["service.lock", "resource-management.lock"]) {
    const release = await acquireLock(source, name);
    try { await assert.rejects(migrateDataHome(source, destination), code("SOURCE_IN_USE")); }
    finally { await release(); }
  }
  await mkdir(destination); await writeFile(join(destination, "keep"), "existing");
  await assert.rejects(migrateDataHome(source, destination), code("TARGET_EXISTS"));
  assert.equal(await readFile(join(destination, "keep"), "utf8"), "existing");
}));

test("停用备份迁入 backups，恢复保持外部 Skill 与无关配置", async () => fixture(async (root, source, destination) => {
  const skill = join(root, "skills", "guide"); const config = join(root, "client", "config.toml");
  await mkdir(skill, { recursive: true }); await writeFile(join(skill, "SKILL.md"), "# 人工合成\n");
  await mkdir(dirname(config)); await writeFile(config, 'model = "synthetic-model"\n');
  const snapshot = inventory(skill); snapshot.entries[0]!.locator.nativeControl = "codex-skill"; snapshot.entries[0]!.locator.controlPath = config;
  const manager = new ResourceManager(source);
  const plan = await manager.preview({ action: "disable", entryId: snapshot.entries[0]!.id }, snapshot);
  assert.equal((await manager.apply(plan.id, true, snapshot)).status, "success"); manager.close();
  const before = await readFile(config, "utf8"); await migrateDataHome(source, destination);
  assert.equal(await readFile(config, "utf8"), before); assert.equal(await readFile(join(skill, "SKILL.md"), "utf8"), "# 人工合成\n");
  const migrated = new ResourceManager(destination);
  try {
    const archive = migrated.archives("disabled")[0]!;
    assert.ok(archive.storedPath!.startsWith(join(destination, "resource-vault", "backups", "skill")));
    assert.equal(archive.originalPath, config);
    const preview = await migrated.preview({ action: "restore", operationId: archive.operationId }, snapshot);
    assert.equal((await migrated.apply(preview.id, true, snapshot)).status, "success");
    assert.equal(await readFile(config, "utf8"), 'model = "synthetic-model"\n');
  } finally { migrated.close(); }
}));

test("恢复材料被改动时迁移失败，原记录及原材料保留，目标不发布", async () => fixture(async (root, source, destination) => {
  const skill = join(root, "skills", "guide"); await mkdir(skill, { recursive: true }); await writeFile(join(skill, "SKILL.md"), "# 人工合成\n");
  const snapshot = inventory(skill); const manager = new ResourceManager(source);
  const plan = await manager.preview({ action: "trash", entryId: snapshot.entries[0]!.id }, snapshot); await manager.apply(plan.id, true, snapshot);
  const archive = manager.archives()[0]!; manager.close();
  await writeFile(join(archive.storedPath!, "SKILL.md"), "# 已改变\n");
  await assert.rejects(migrateDataHome(source, destination), code("RECOVERY_MATERIAL_INVALID"));
  await assert.rejects(stat(destination)); assert.equal(await readFile(join(archive.storedPath!, "SKILL.md"), "utf8"), "# 已改变\n");
  assert.ok(!(await readdir(root)).some(name => name.includes("migration-")));
}));

test("SQLite WAL 中已提交的索引随数据迁移，嵌套目录被拒绝", async () => fixture(async (_root, source, destination) => {
  await assert.rejects(migrateDataHome(source, join(source, "nested")), code("DIRECTORIES_OVERLAP"));
  const index = new Database(join(source, "index.sqlite")); index.pragma("journal_mode=WAL"); index.pragma("wal_autocheckpoint=0");
  index.prepare("INSERT INTO synthetic_values VALUES('wal','committed-wal')").run();
  try {
    await migrateDataHome(source, destination);
    const migrated = new Database(join(destination, "index.sqlite"), { readonly: true });
    try { assert.equal((migrated.prepare("SELECT value FROM synthetic_values WHERE id='wal'").get() as { value: string }).value, "committed-wal"); }
    finally { migrated.close(); }
  } finally { index.close(); }
}));

test("目标父路径通过链接回到原目录时拒绝迁移，不在原目录创建子目录", async () => fixture(async (root, source) => {
  const alias = join(root, "source-alias"); await symlink(source, alias);
  const before = await readdir(source);
  await assert.rejects(migrateDataHome(source, join(alias, "new-parent", "data")), code("DIRECTORIES_OVERLAP"));
  assert.deepEqual(await readdir(source), before);
}));
