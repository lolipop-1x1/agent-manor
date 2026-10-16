import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ResourceInventoryEntry, ResourceInventorySnapshot } from "../src/resource-inventory-contracts.js";
import { scanResourceInventory } from "../src/resources/inventory.js";
import { ResourceManager } from "../src/resources/management.js";
import { ServiceError } from "../src/service/input.js";

async function fixture(run: (manager: ResourceManager, userHome: string, scan: () => Promise<ResourceInventorySnapshot>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-codeflicker-management-"));
  const userHome = join(directory, "user"); await mkdir(userHome);
  const manager = new ResourceManager(join(directory, "data"));
  try { await run(manager, userHome, () => scanResourceInventory({ userHome, environment: {} })); }
  finally { manager.close(); await rm(directory, { recursive: true, force: true }); }
}
async function skill(path: string, name = "guide") {
  await mkdir(path, { recursive: true }); await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: 人工合成说明\n---\n人工合成资源\n`);
}
async function config(path: string, value: unknown) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2)); }
function selected(snapshot: ResourceInventorySnapshot, client: ResourceInventoryEntry["client"], kind: "skill" | "mcp", name = "guide") {
  const entry = snapshot.entries.find(value => value.client === client && value.kind === kind && value.name === name);
  assert.ok(entry); return entry;
}
async function apply(manager: ResourceManager, snapshot: ResourceInventorySnapshot, entry: ResourceInventoryEntry, action: "disable" | "trash") {
  const preview = await manager.preview({ entryId: entry.id, action }, snapshot);
  const operation = await manager.apply(preview.id, true, snapshot);
  assert.equal(operation.status, "success"); return preview;
}
async function restore(manager: ResourceManager, snapshot: ResourceInventorySnapshot) {
  const archive = manager.archives().find(value => value.restorable)!; assert.ok(archive);
  const preview = await manager.preview({ operationId: archive.operationId, action: "restore" }, snapshot);
  assert.equal((await manager.apply(preview.id, true, snapshot)).status, "success");
}

test("CLI Skill 停用保留仅用户触发与未知字段，恢复只撤销目标名称并保留后续其他名称", async () => fixture(async (manager, userHome, scan) => {
  const path = join(userHome, ".codeflicker", "skills", "guide"); await skill(path);
  const control = join(userHome, ".codeflicker", "config.json");
  await config(control, { claudeImport: false, skills: { userOnly: ["guide"], disabled: ["other"], enabled: ["third"], unknown: "retained" }, unknown: 7 });
  const initial = await scan(); const entry = selected(initial, "codeflicker", "skill");
  assert.equal(entry.invocationMode, "user-only"); assert.equal(manager.decorateInventory(initial).entries.find(value => value.id === entry.id)?.capabilities.disable, true);
  await apply(manager, initial, entry, "disable");
  const after = JSON.parse(await readFile(control, "utf8"));
  assert.deepEqual(after.skills.disabled, ["other", "guide"]); assert.deepEqual(after.skills.userOnly, ["guide"]); assert.equal(after.unknown, 7);
  after.skills.disabled.push("later"); after.unknown = 8; await config(control, after);
  const disabled = await scan(); assert.equal(selected(disabled, "codeflicker", "skill").nativeState, "disabled");
  await restore(manager, disabled);
  const result = JSON.parse(await readFile(control, "utf8"));
  assert.deepEqual(result.skills.disabled, ["other", "later"]); assert.deepEqual(result.skills.userOnly, ["guide"]);
  assert.equal(result.skills.unknown, "retained"); assert.equal(result.unknown, 8);
}));

test("CLI 缺少明确控制配置时不创建规则，已有规则恢复遇到目标变化保留材料", async () => fixture(async (manager, userHome, scan) => {
  await skill(join(userHome, ".codeflicker", "skills", "guide"));
  const control = join(userHome, ".codeflicker", "config.json");
  let initial = await scan(); const resource = selected(initial, "codeflicker", "skill");
  assert.equal(manager.decorateInventory(initial).entries.find(entry => entry.id === resource.id)?.capabilities.disable, false);
  await assert.rejects(manager.preview({ entryId: resource.id, action: "disable" }, initial), ServiceError);
  await assert.rejects(stat(control));
  await config(control, { skills: { enabled: ["guide"] } });
  initial = await scan(); await apply(manager, initial, selected(initial, "codeflicker", "skill"), "disable");
  await config(control, { skills: { disabled: ["guide"], userOnly: ["guide"] }, unknown: 9 });
  const archive = manager.archives("disabled")[0]!;
  await assert.rejects(manager.preview({ operationId: archive.operationId, action: "restore" }, await scan()), (error: unknown) => error instanceof ServiceError && error.code === "CONTENT_STALE");
  assert.equal(manager.archives("disabled")[0]?.restorable, true); assert.equal(JSON.parse(await readFile(control, "utf8")).unknown, 9);
}));

test("CLI 现有控制配置恢复时保留停用后新增的无关设置", async () => fixture(async (manager, userHome, scan) => {
  await skill(join(userHome, ".codeflicker", "skills", "guide"));
  const control = join(userHome, ".codeflicker", "config.json");
  await config(control, { skills: { enabled: ["guide"] } });
  const initial = await scan(); await apply(manager, initial, selected(initial, "codeflicker", "skill"), "disable");
  const after = JSON.parse(await readFile(control, "utf8")); after.language = "synthetic-language"; await config(control, after);
  await restore(manager, await scan()); assert.deepEqual(JSON.parse(await readFile(control, "utf8")), { skills: { enabled: ["guide"] }, language: "synthetic-language" });
}));

test("桌面 Skill 默认目录只开放文件管理，不凭目录创建启停标记", async () => fixture(async (manager, userHome, scan) => {
  const path = join(userHome, ".myflicker", "skills", "guide"); await skill(path);
  const initial = await scan(); const resource = selected(initial, "codeflicker-desktop", "skill");
  const capabilities = manager.decorateInventory(initial).entries.find(entry => entry.id === resource.id)!.capabilities;
  assert.equal(capabilities.disable, false); assert.equal(capabilities.trash, true);
  await assert.rejects(manager.preview({ entryId: resource.id, action: "disable" }, initial), ServiceError);
  await assert.rejects(stat(join(path, ".disable")));
  await apply(manager, initial, resource, "trash"); await assert.rejects(stat(path));
  await restore(manager, await scan()); assert.match(await readFile(join(path, "SKILL.md"), "utf8"), /人工合成/);
}));

test("桌面共享本体不能用标记冒充独立停用，链接可独立回收且不改目标", async () => fixture(async (manager, userHome, scan) => {
  const target = join(userHome, ".codeflicker", "skills", "guide"); await skill(target);
  const link = join(userHome, ".myflicker", "skills", "guide"); await mkdir(dirname(link), { recursive: true }); await symlink(target, link);
  const initial = await scan(); const entry = selected(initial, "codeflicker-desktop", "skill");
  assert.equal(manager.decorateInventory(initial).entries.find(value => value.id === entry.id)?.capabilities.disable, false);
  await assert.rejects(manager.preview({ entryId: entry.id, action: "disable" }, initial), (error: unknown) => error instanceof ServiceError && error.code === "FORBIDDEN");
  await apply(manager, initial, entry, "trash"); await assert.rejects(stat(link)); assert.match(await readFile(join(target, "SKILL.md"), "utf8"), /人工合成/);
  await restore(manager, await scan()); assert.ok((await stat(link)).isDirectory());
}));

test("CLI MCP 停用只编辑单数 disable 并恢复旧值，其他注册和所选注册未知字段不被覆盖", async () => fixture(async (manager, userHome, scan) => {
  const control = join(userHome, ".codeflicker", "config.json");
  await config(control, { mcpServers: { guide: { type: "stdio", command: "synthetic-tool", disable: false, unknown: 1 }, other: { command: "other-tool" } } });
  const initial = await scan(); const entry = selected(initial, "codeflicker", "mcp");
  assert.equal(manager.decorateInventory(initial).entries.find(value => value.id === entry.id)?.capabilities.disable, true);
  const preview = await apply(manager, initial, entry, "disable"); assert.equal(preview.affectedEntries.length, 1);
  const after = JSON.parse(await readFile(control, "utf8")); assert.equal(after.mcpServers.guide.disable, true);
  after.mcpServers.guide.unknown = 2; after.mcpServers.other.command = "later-tool"; await config(control, after);
  await restore(manager, await scan());
  const result = JSON.parse(await readFile(control, "utf8")); assert.equal(result.mcpServers.guide.disable, false);
  assert.equal(result.mcpServers.guide.unknown, 2); assert.equal(result.mcpServers.other.command, "later-tool");
}));

test("CLI MCP 回收恢复和来源变化冲突贯通，桌面 MCP 没有文件写入能力", async () => fixture(async (manager, userHome, scan) => {
  const control = join(userHome, ".codeflicker", "config.json");
  await config(control, { mcpServers: { guide: { command: "synthetic-tool" }, other: { command: "other-tool" } }, unknown: 7 });
  let initial = await scan(); const entry = selected(initial, "codeflicker", "mcp");
  const stale = await manager.preview({ entryId: entry.id, action: "trash" }, initial);
  await config(control, { mcpServers: { guide: { command: "changed-tool" }, other: { command: "other-tool" } }, unknown: 7 });
  assert.equal((await manager.apply(stale.id, true, await scan())).status, "conflict");
  initial = await scan(); await apply(manager, initial, selected(initial, "codeflicker", "mcp"), "trash");
  assert.equal(JSON.parse(await readFile(control, "utf8")).mcpServers.guide, undefined);
  await restore(manager, await scan()); assert.equal(JSON.parse(await readFile(control, "utf8")).mcpServers.guide.command, "changed-tool");
  await config(join(userHome, ".myflicker", "config", "mcp.json"), { mcpServers: { guide: { command: "desktop-tool", disable: false } } });
  const desktop = await scan(); const desktopEntry = selected(desktop, "codeflicker-desktop", "mcp");
  const capabilities = manager.decorateInventory(desktop).entries.find(value => value.id === desktopEntry.id)!.capabilities;
  assert.equal(capabilities.disable, false); assert.equal(capabilities.trash, false);
  await assert.rejects(manager.preview({ entryId: desktopEntry.id, action: "trash" }, desktop), (error: unknown) => error instanceof ServiceError && error.code === "FORBIDDEN");
}));

test("CLI 当前 Skill 回收预览显示下层来源，后续盘点重新显示下层同名入口", async () => fixture(async (manager, userHome, scan) => {
  const current = join(userHome, ".codeflicker", "skills", "guide"); const lower = join(userHome, ".claude", "skills", "guide");
  await skill(current); await skill(lower); const initial = await scan(); const entry = selected(initial, "codeflicker", "skill");
  assert.equal(entry.entryPath, current); const preview = await manager.preview({ entryId: entry.id, action: "trash" }, initial);
  assert.ok(preview.revealedEntries?.some(value => value.entryPath === lower));
  assert.equal((await manager.apply(preview.id, true, initial)).status, "success");
  assert.equal(selected(await scan(), "codeflicker", "skill").entryPath, lower);
  await restore(manager, await scan()); assert.equal(selected(await scan(), "codeflicker", "skill").entryPath, current);
}));

test("CLI 用户名称规则预览列出同名项目与有效作用范围，未知范围不开放原生停用", async () => fixture(async (manager, userHome) => {
  const project = join(userHome, "projects", "synthetic-project");
  await skill(join(userHome, ".codeflicker", "skills", "guide")); await skill(join(project, ".codeflicker", "skills", "guide"));
  await config(join(userHome, ".codeflicker", "config.json"), { skills: { enabled: ["guide"] } });
  const scan = () => scanResourceInventory({ userHome, projects: [project], environment: {} });
  const initial = await scan(); const entry = initial.entries.find(value => value.client === "codeflicker" && value.kind === "skill" && value.scope === "user" && value.name === "guide")!;
  assert.ok(entry);
  const preview = await manager.preview({ entryId: entry.id, action: "disable" }, initial);
  assert.ok(preview.affectedEntries.some(value => value.scope === "project" && value.project === project));
  assert.ok(preview.affectedEntries.some(value => value.scope === "user"));
  await writeFile(join(project, ".codeflicker", "config.local.json"), "{invalid-json");
  const unknown = await scan(); const global = unknown.entries.find(value => value.id === entry.id)!;
  assert.equal(global.nativeState, "enabled");
  assert.equal(manager.decorateInventory(unknown).entries.find(value => value.id === entry.id)?.capabilities.disable, false);
  await assert.rejects(manager.preview({ entryId: entry.id, action: "disable" }, unknown), (error: unknown) => error instanceof ServiceError && error.code === "FORBIDDEN");
  assert.equal((await manager.apply(preview.id, true, unknown)).status, "conflict");
  assert.deepEqual(JSON.parse(await readFile(join(userHome, ".codeflicker", "config.json"), "utf8")), { skills: { enabled: ["guide"] } });
}));

test("CLI 项目 Skill 停用仅修改已有项目规则，恢复保留用户与项目原配置", async () => fixture(async (manager, userHome) => {
  const project = join(userHome, "projects", "synthetic-project");
  await skill(join(project, ".codeflicker", "skills", "project-guide"), "project-guide");
  const globalConfig = join(userHome, ".codeflicker", "config.json");
  const original = { skills: { disabled: ["global-off"], userOnly: ["project-guide"] }, unknown: 7 };
  await config(globalConfig, original);
  const localConfig = join(project, ".codeflicker", "config.local.json");
  const localOriginal = { skills: { userOnly: ["project-guide"] } }; await config(localConfig, localOriginal);
  const scan = () => scanResourceInventory({ userHome, projects: [project], environment: {} });
  const initial = await scan(); const entry = selected(initial, "codeflicker", "skill", "project-guide");
  assert.equal(entry.scope, "project"); assert.equal(entry.invocationMode, "user-only");
  const preview = await apply(manager, initial, entry, "disable"); assert.equal(preview.configuration?.controlScope, "project"); assert.equal(preview.configuration?.controlProject, project); assert.ok(preview.affectedEntries.every(value => value.project === project));
  assert.deepEqual(JSON.parse(await readFile(globalConfig, "utf8")), original);
  assert.deepEqual(JSON.parse(await readFile(localConfig, "utf8")), { skills: { userOnly: ["project-guide"], disabled: ["project-guide"] } });
  assert.equal(selected(await scan(), "codeflicker", "skill", "project-guide").nativeState, "disabled");
  await restore(manager, await scan()); assert.deepEqual(JSON.parse(await readFile(localConfig, "utf8")), localOriginal);
  assert.equal(selected(await scan(), "codeflicker", "skill", "project-guide").invocationMode, "user-only");
}));

test("被同名覆盖的托管本体仍保护桌面共享入口，独立同名目录不受误保护", async () => fixture(async (manager, userHome, scan) => {
  const managed = join(userHome, ".codeflicker", "remote-personal-skills", "guide");
  const ordinary = join(userHome, ".codeflicker", "skills", "guide");
  const linked = join(userHome, ".myflicker", "skills", "linked-guide");
  await skill(managed); await skill(ordinary);
  await mkdir(dirname(linked), { recursive: true }); await symlink(managed, linked);
  const snapshot = await scan();
  const activeCli = snapshot.entries.find(entry => entry.client === "codeflicker" && entry.entryPath === ordinary)!;
  assert.equal(activeCli.protected, false);
  assert.ok(snapshot.diagnostics?.some(row => row.reason === "shadowed" && row.path === managed && row.selectedPath === ordinary));
  const desktop = snapshot.entries.find(entry => entry.client === "codeflicker-desktop" && entry.entryPath === linked)!;
  assert.equal(desktop.protected, true); assert.equal(desktop.protectionReason, "managed");
  assert.equal(desktop.locator.nativeControl, undefined);
  const decorated = manager.decorateInventory(snapshot).entries.find(entry => entry.id === desktop.id)!;
  for (const capability of ["disable", "standby", "trash", "restore", "purge"] as const) assert.equal(decorated.capabilities[capability], false);
  for (const action of ["disable", "trash"] as const) await assert.rejects(manager.preview({ entryId: desktop.id, action }, snapshot),
    (error: unknown) => error instanceof ServiceError && error.code === "FORBIDDEN");
  await assert.rejects(stat(join(managed, ".disable")), { code: "ENOENT" });
  assert.match(await readFile(join(managed, "SKILL.md"), "utf8"), /人工合成/);
  assert.equal(manager.operations().total, 0);
}));
