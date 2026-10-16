import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { NativeResourceRule, ResourceInventoryEntry, ResourceInventorySnapshot } from "../src/resource-inventory-contracts.js";
import { editableConfig, prepareConfig, restoreConfig } from "../src/resources/config-editor.js";
import { ResourceManager } from "../src/resources/management.js";
import { ServiceError } from "../src/service/input.js";

const capabilities = { inventory: true, associate: true, disable: false, standby: false, restore: false, trash: false, purge: false };
function entry(path: string, rule: NativeResourceRule, extra: Partial<ResourceInventoryEntry> = {}): ResourceInventoryEntry {
  return { id: "synthetic-entry", kind: "skill", name: "guide", client: "gemini", scope: "user", entryPath: join(dirname(path), "skills", "guide"),
    sourceId: "synthetic-source", bodyId: "synthetic-body", entryType: "directory", readState: "present", nativeState: "enabled",
    sourceFormat: "skill-directory", observedAt: "2026-01-01T00:00:00Z", protected: false,
    locator: { type: "skill", skillFile: join(dirname(path), "skills", "guide", "SKILL.md"), nativeControl: "native-rule", nativeRule: rule, controlPath: path }, capabilities, ...extra };
}
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-native-resource-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const parsers = { json: JSON.parse, jsonc: JSON.parse, toml: parseToml, yaml: parseYaml };
for (const format of ["json", "toml", "yaml"] as const) test(`${format} 原生名称停用保留其他名称，恢复保留后续编辑`, async () => fixture(async directory => {
  const path = join(directory, `config.${format}`);
  const text = format === "json" ? '{"skills":{"disabled":["other"]},"theme":"dark"}\n'
    : format === "toml" ? '# 人工配置\n[skills]\ndisabled = ["other"] # 原注释\n'
      : '# 人工配置\ndisabledExtensions:\n  - skill:other\ntheme: dark\n';
  const keys = format === "yaml" ? ["disabledExtensions"] : ["skills", "disabled"];
  const member = format === "yaml" ? "skill:guide" : "guide";
  const selected = entry(path, { format, type: "name-list", keyPath: keys, member });
  await writeFile(path, text);
  assert.equal(editableConfig(text, selected), true);
  const change = await prepareConfig(selected, "disable");
  const value = parsers[format](change.afterText);
  const names = format === "yaml" ? value.disabledExtensions : value.skills.disabled;
  assert.deepEqual(names, [format === "yaml" ? "skill:other" : "other", member]);
  const later = format === "json" ? change.afterText.replace('"other"', '"other","later"')
    : format === "toml" ? change.afterText.replace('"other"', '"other", "later"') : change.afterText.replace("skill:other", "skill:other\n  - skill:later");
  const restored = restoreConfig(change, later);
  const result = parsers[format](restored);
  assert.deepEqual(format === "yaml" ? result.disabledExtensions : result.skills.disabled,
    format === "yaml" ? ["skill:other", "skill:later"] : ["other", "later"]);
  if (format !== "json") assert.match(restored, /人工配置/);
  assert.equal(restoreConfig(change, change.afterText), text);
  const changedTarget = later.replace(member, "different");
  assert.throws(() => restoreConfig(change, changedTarget), ServiceError);
}));

test("Gemini MCP 使用独立全局控制文件，恢复只删除本次名字并保留其他服务", async () => fixture(async directory => {
  const configPath = join(directory, "settings.json"); const controlPath = join(directory, "mcp-server-enablement.json");
  await writeFile(configPath, '{"mcpServers":{"synthetic":{"command":"fixture"}}}\n');
  const selected = entry(controlPath, { format: "json", type: "boolean", keyPath: ["synthetic", "enabled"], disabledValue: false },
    { kind: "mcp", name: "Synthetic", entryType: "registration", entryPath: configPath, sourceFormat: "json" });
  selected.locator = { ...selected.locator, type: "mcp", configPath, format: "json", keyPath: ["mcpServers", "synthetic"] };
  const change = await prepareConfig(selected, "disable");
  assert.equal(change.path, controlPath); assert.equal(change.fileExistedBefore, false);
  assert.equal(JSON.parse(change.afterText).synthetic.enabled, false);
  assert.match(await readFile(configPath, "utf8"), /fixture/);
  const later = JSON.stringify({ ...JSON.parse(change.afterText), other: { enabled: false } });
  assert.deepEqual(JSON.parse(restoreConfig(change, later)), { other: { enabled: false } });
}));

test("Reasonix 原生 activation 恢复完整声明身份，保留其他项目决定", async () => fixture(async directory => {
  const path = join(directory, "capability-activation.json");
  const identity = { kind: "mcp" as const, scope: "project" as const, key: "synthetic-workspace", source: "project_mcp_json", name: "guide" };
  const original = { ...identity, enabled: true, identity: "synthetic-declaration-digest" };
  await writeFile(path, JSON.stringify({ version: 2, overrides: [original] }));
  const selected = entry(path, { format: "json", type: "activation", keyPath: ["overrides"], identity });
  const change = await prepareConfig(selected, "disable");
  assert.equal(JSON.parse(change.afterText).overrides[0].enabled, false);
  const other = { kind: "skill", scope: "global", name: "other", enabled: false };
  const later = JSON.stringify({ version: 2, overrides: [...JSON.parse(change.afterText).overrides, other] });
  const restored = JSON.parse(restoreConfig(change, later));
  assert.deepEqual(restored.overrides, [other, original]);
  assert.throws(() => restoreConfig(change, later.replace('"enabled":false', '"enabled":true')), ServiceError);
}));

test("共享原生名字的管理预览列明用户与项目范围，写入后可恢复", async () => fixture(async directory => {
  const path = join(directory, "config.json"); const selected = entry(path, { format: "json", type: "name-list", keyPath: ["skills", "disabled"], member: "guide", effectScope: "client" });
  await mkdir(dirname(selected.locator.skillFile!), { recursive: true }); await writeFile(selected.locator.skillFile!, "# 合成资源\n");
  await writeFile(path, JSON.stringify({ skills: { enabled: ["guide"] } }));
  const project = { ...selected, id: "project-entry", sourceId: "project-source", bodyId: "project-body", scope: "project" as const, project: join(directory, "project") };
  const snapshot: ResourceInventorySnapshot = { observedAt: selected.observedAt, entries: [selected, project], bodies: [], gaps: [], sources: [selected, project].map(value => ({
    id: value.sourceId, client: value.client, kind: value.kind, scope: value.scope, project: value.project, path: value.entryPath,
    format: "skill-directory", origin: "standard", readState: "ok", observedAt: value.observedAt, verified: true })) };
  const manager = new ResourceManager(join(directory, "data"));
  try {
    assert.equal(manager.decorateInventory(snapshot).entries[0]!.capabilities.disable, true);
    const preview = await manager.preview({ entryId: selected.id, action: "disable" }, snapshot);
    assert.equal(preview.configuration?.controlScope, "client"); assert.equal(preview.affectedEntries.length, 2); assert.equal(preview.clientEffect, "pending_reload");
    assert.equal((await manager.apply(preview.id, true, snapshot)).status, "success");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).skills.disabled, ["guide"]);
    const archive = manager.archives("disabled")[0]!;
    const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, snapshot);
    assert.equal((await manager.apply(restore.id, true, snapshot)).status, "success");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { skills: { enabled: ["guide"] } });
  } finally { manager.close(); }
}));

test("复杂 TOML 与共享 YAML alias 保持只读", () => {
  const rule = { type: "name-list" as const, keyPath: ["skills", "disabled"], member: "guide" };
  assert.equal(editableConfig('[skills]\ndisabled = [\n  "other",\n]\n', entry("/synthetic/config.toml", { ...rule, format: "toml" })), false);
  assert.equal(editableConfig('names: &names [other]\nskills:\n  disabled: *names\n', entry("/synthetic/config.yml", { ...rule, format: "yaml" })), false);
});
