import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { scanResourceInventory } from "../src/resources/inventory.js";
import { ResourceManager } from "../src/resources/management.js";
import { ServiceError } from "../src/service/input.js";

const workspace = (home: string) => join(home, "Library", "Application Support", "DoubaoWork", "Default", ".doubaowork", "agent_mode", "workspace");
const body = "---\nname: synthetic-guide\ndescription: 合成资源说明\n---\n合成正文\n";
async function file(path: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, body); }
async function temporary(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "manor-paused-resource-"));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test("豆包工作不自动盘点，也不读取显式的豆包手动来源，其他客户端共享入口保持可见", async () => temporary(async home => {
  await file(join(workspace(home), ".skills", "managed", "SKILL.md"));
  await file(join(home, ".agents", "skills", "shared", "SKILL.md"));
  const snapshot = await scanResourceInventory({ userHome: home, manualSources: [{ id: "synthetic-paused-source", client: "doubao-work", kind: "skill", path: workspace(home) }] });
  assert.ok(snapshot.sources.every(source => source.client !== "doubao-work"));
  assert.ok(snapshot.entries.every(entry => entry.client !== "doubao-work"));
  assert.ok(snapshot.gaps.every(gap => gap.client !== "doubao-work"));
  assert.ok(snapshot.diagnostics?.every(value => value.client !== "doubao-work"));
  assert.ok(snapshot.entries.some(entry => entry.client === "codex" && entry.name === "synthetic-guide"));
  assert.equal(await readFile(join(workspace(home), ".skills", "managed", "SKILL.md"), "utf8"), body);
}));

test("停止豆包盘点后，其他客户端指向其托管资源的链接仍禁止回收本体", async () => temporary(async home => {
  const managed = join(workspace(home), ".user_skills", "managed"); await file(join(managed, "SKILL.md"));
  const alias = join(home, ".agents", "skills", "alias"); await mkdir(dirname(alias), { recursive: true }); await symlink(managed, alias);
  const snapshot = await scanResourceInventory({ userHome: home });
  const entry = snapshot.entries.find(entry => entry.client === "codex" && entry.entryPath === alias)!;
  assert.equal(entry.protected, true); assert.equal(entry.protectionReason, "managed");
  const manager = new ResourceManager(join(home, "data"));
  try {
    assert.equal(manager.decorateInventory(snapshot).entries.find(value => value.id === entry.id)?.capabilities.trash, false);
    await assert.rejects(manager.preview({ entryId: entry.id, action: "trash" }, snapshot), (error: unknown) => error instanceof ServiceError && error.code === "FORBIDDEN");
  } finally { manager.close(); }
}));

test("豆包旧手动来源和管理记录隐藏但保留磁盘材料，禁止新增来源", async () => temporary(async home => {
  const data = join(home, "data"); const manager = new ResourceManager(data);
  try {
    assert.throws(() => manager.addManualSource({ client: "doubao-work", kind: "skill", path: home }), ServiceError);
    const database = new Database(manager.dbPath);
    try {
      database.prepare("INSERT INTO resource_manual_sources(id,json) VALUES(?,?)").run("paused", JSON.stringify({ id: "paused", client: "doubao-work", kind: "skill", path: home }));
      for (const client of ["codex", "doubao-work"]) database.prepare("INSERT INTO resource_operations(id,created_at,json) VALUES(?,?,?)").run(client, "2026-10-17", JSON.stringify({ id: client, name: "合成操作", target: "entry", resource: { kind: "skill", client } }));
      for (const client of ["codex", "doubao-work"]) database.prepare("INSERT INTO resource_archives(id,operation_id,state,phase,json) VALUES(?,?,?,?,?)")
        .run(client, client, "trash", "complete", JSON.stringify({ public: { operationId: client, state: "trash", entry: { client }, affectedEntries: [{ client: "codex" }, { client: "doubao-work" }] } }));
      assert.equal(manager.manualSources().length, 0);
      assert.deepEqual(manager.archives().map(archive => archive.entry.client), ["codex"]);
      assert.ok(manager.archives().every(archive => archive.affectedEntries?.every(entry => entry.client !== "doubao-work")));
      assert.deepEqual(manager.operations().operations.map(value => value.resource.client), ["codex"]);
      assert.equal(manager.operations().total, 1);
      assert.equal(manager.operations(1, 50, { client: "doubao-work" }).total, 0);
      assert.ok(manager.clientOptions().every(option => option.client !== "doubao-work"));
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM resource_archives").get() as { count: number }).count, 2);
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM resource_operations").get() as { count: number }).count, 2);
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM resource_manual_sources").get() as { count: number }).count, 1);
    } finally { database.close(); }
  } finally { manager.close(); }
}));
