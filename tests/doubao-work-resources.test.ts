import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { scanResourceInventory } from "../src/resources/inventory.js";
import { ResourceManager } from "../src/resources/management.js";
import { ServiceError } from "../src/service/input.js";

async function fixture(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "manor-doubao-resources-"));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}
async function file(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, content);
}
const skill = (name: string) => `---\nname: ${name}\ndescription: 人工合成的资源说明\n---\n人工合成 Skill 正文。\n`;
const workspace = (home: string) => join(home, "Library", "Application Support", "DoubaoWork", "Default", ".doubaowork", "agent_mode", "workspace");
const entries = (snapshot: Awaited<ReturnType<typeof scanResourceInventory>>) => snapshot.entries.filter(entry => entry.client === "doubao-work");

test("豆包工作盘点托管和共享入口，嵌套文档不重复计数，也不猜测附加目录", async () => fixture(async home => {
  const project = join(home, "project"); await mkdir(project);
  const installed = join(workspace(home), ".skills", "installed");
  await file(join(installed, "SKILL.md"), skill("installed"));
  await file(join(installed, "references", "nested", "SKILL.md"), skill("nested-document"));
  await file(join(workspace(home), ".skills", "unconfirmed", "nested", "SKILL.md"), skill("too-deep"));
  await file(join(workspace(home), ".user_skills", "user", "SKILL.md"), skill("user"));
  await file(join(home, ".agents", "skills", "shared", "SKILL.md"), skill("shared"));
  await file(join(project, ".agents", "skills", "shared", "SKILL.md"), skill("shared"));
  await file(join(home, ".claude", "skills", "additional", "SKILL.md"), skill("unconfirmed-additional"));
  await file(join(home, "DoubaoWork", "skills", "unconfirmed", "SKILL.md"), skill("unconfirmed-download"));
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project] }); const found = entries(snapshot);
  assert.deepEqual(found.map(entry => entry.name).sort(), ["installed", "shared", "shared", "user"]);
  assert.equal(found.find(entry => entry.project === project)?.scope, "project");
  assert.ok(found.every(entry => entry.nativeState === "unknown" && !entry.locator.nativeControl));
  assert.ok(found.every(entry => entry.description === "人工合成的资源说明"));
  assert.equal(snapshot.diagnostics?.filter(value => value.client === "doubao-work" && value.reason === "shadowed").length, 0);
  for (const source of snapshot.sources.filter(source => source.client === "doubao-work")) {
    assert.equal(Object.hasOwn(source, "skillDepth"), false); assert.equal(Object.hasOwn(source, "skillContainmentRoot"), false);
  }
}));

test("豆包托管目录不跟随越界链接，共享入口保留合法链接与本体关系", async () => fixture(async home => {
  const outside = join(home, "outside"); await file(join(outside, "SKILL.md"), skill("shared-body"));
  const managed = join(workspace(home), ".skills"); await mkdir(managed, { recursive: true });
  await symlink(outside, join(managed, "escaped"));
  const escapedManifest = join(managed, "escaped-manifest"); await mkdir(escapedManifest);
  await symlink(join(outside, "SKILL.md"), join(escapedManifest, "SKILL.md"));
  const root = join(home, ".agents", "skills"); await mkdir(root, { recursive: true });
  await symlink(outside, join(root, "first")); await symlink(outside, join(root, "second"));
  const snapshot = await scanResourceInventory({ userHome: home }); const found = entries(snapshot);
  assert.equal(found.length, 2); assert.equal(found[0]?.bodyId, found[1]?.bodyId);
  const canonicalOutside = await realpath(outside);
  assert.ok(found.every(entry => entry.entryType === "symlink" && entry.targetPath === canonicalOutside && entry.linkTarget === outside));
  assert.ok(found.every(entry => !entry.protected));
  assert.equal(snapshot.diagnostics?.filter(value => value.client === "doubao-work" && value.reason === "invalid_reference").length, 2);
}));

test("豆包托管正文及其共享别名都受保护，未核验 MCP 配置不读取注册或凭证", async () => fixture(async home => {
  const managed = join(workspace(home), ".user_skills", "synced"); await file(join(managed, "SKILL.md"), skill("synced"));
  const shared = join(home, ".agents", "skills", "alias"); await mkdir(dirname(shared), { recursive: true }); await symlink(managed, shared);
  const sensitive = "synthetic-secret-must-not-project";
  await file(join(home, "Library", "Application Support", "DoubaoWork", "Default", "mcp.json"), JSON.stringify({ mcpServers: { private: {
    command: "synthetic-command", args: [sensitive], env: { SYNTHETIC_TOKEN: sensitive }, url: `https://example.invalid/${sensitive}`,
  } } }));
  const snapshot = await scanResourceInventory({ userHome: home }); const found = entries(snapshot);
  assert.ok(found.length >= 2); assert.ok(found.every(entry => entry.protected && entry.protectionReason === "managed"));
  assert.ok(!found.some(entry => entry.kind === "mcp")); assert.ok(!JSON.stringify(snapshot).includes(sensitive));
  assert.ok(snapshot.gaps.some(gap => gap.client === "doubao-work" && gap.reason === "unsupported"));
  const manager = new ResourceManager(join(home, "data"));
  try {
    assert.ok(entries(manager.decorateInventory(snapshot)).every(entry => !entry.capabilities.trash && !entry.capabilities.disable));
    await assert.rejects(manager.preview({ entryId: found[0]!.id, action: "trash" }, snapshot), (error: unknown) => error instanceof ServiceError && error.code === "FORBIDDEN");
  } finally { manager.close(); }
}));

test("豆包普通共享 Skill 可预览回收和恢复，保留跨客户端影响及恢复冲突", async () => fixture(async home => {
  const path = join(home, ".agents", "skills", "guide"); const body = skill("guide"); await file(join(path, "SKILL.md"), body);
  const snapshot = await scanResourceInventory({ userHome: home }); const selected = entries(snapshot)[0]!;
  const manager = new ResourceManager(join(home, "data"));
  try {
    const decorated = entries(manager.decorateInventory(snapshot))[0]!;
    assert.equal(decorated.capabilities.trash, true); assert.equal(decorated.capabilities.disable, false); assert.equal(decorated.capabilities.standby, false);
    const preview = await manager.preview({ entryId: selected.id, action: "trash" }, snapshot);
    assert.equal(preview.target, "file"); assert.ok(preview.affectedEntries.some(value => value.client === "codex"));
    assert.equal((await manager.apply(preview.id, true, snapshot)).status, "success");
    await assert.rejects(readFile(join(path, "SKILL.md")));
    const archive = manager.archives("trash")[0]!; const current = await scanResourceInventory({ userHome: home });
    await file(join(path, "SKILL.md"), skill("replacement"));
    await assert.rejects(manager.preview({ operationId: archive.operationId, action: "restore" }, current), ServiceError);
    await rm(path, { recursive: true });
    const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, current);
    assert.equal((await manager.apply(restore.id, true, current)).status, "success");
    assert.equal(await readFile(join(path, "SKILL.md"), "utf8"), body);
    assert.equal(manager.operations(1, 50, { client: "doubao-work" }).total, 2);
  } finally { manager.close(); }
}));

test("豆包共享链接回收只移除链接，恢复保留原始相对链接文本", async () => fixture(async home => {
  const target = join(home, "skill-body"); const body = skill("linked"); await file(join(target, "SKILL.md"), body);
  const path = join(home, ".agents", "skills", "linked"); await mkdir(dirname(path), { recursive: true });
  const link = relative(dirname(path), target); await symlink(link, path);
  const snapshot = await scanResourceInventory({ userHome: home }); const selected = entries(snapshot)[0]!;
  const manager = new ResourceManager(join(home, "data"));
  try {
    const preview = await manager.preview({ entryId: selected.id, action: "trash" }, snapshot);
    assert.equal(preview.target, "entry"); assert.equal((await manager.apply(preview.id, true, snapshot)).status, "success");
    assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), body); await assert.rejects(readlink(path));
    const archive = manager.archives("trash")[0]!; const current = await scanResourceInventory({ userHome: home });
    const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, current);
    assert.equal((await manager.apply(restore.id, true, current)).status, "success"); assert.equal(await readlink(path), link);
  } finally { manager.close(); }
}));

test("豆包共享入口在预览后变更时不执行旧回收计划", async () => fixture(async home => {
  const path = join(home, ".agents", "skills", "changed"); await file(join(path, "SKILL.md"), skill("changed"));
  const snapshot = await scanResourceInventory({ userHome: home }); const selected = entries(snapshot)[0]!;
  const manager = new ResourceManager(join(home, "data"));
  try {
    const preview = await manager.preview({ entryId: selected.id, action: "trash" }, snapshot);
    const changed = skill("changed-after-preview"); await writeFile(join(path, "SKILL.md"), changed);
    const current = await scanResourceInventory({ userHome: home });
    assert.equal((await manager.apply(preview.id, true, current)).status, "conflict");
    assert.equal(await readFile(join(path, "SKILL.md"), "utf8"), changed); assert.equal(manager.archives().length, 0);
  } finally { manager.close(); }
}));
