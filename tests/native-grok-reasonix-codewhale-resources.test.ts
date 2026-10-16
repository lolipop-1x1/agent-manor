import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import type { InventorySourcePlan } from "../src/resources/codeflicker-inventory.js";
import { planGrokReasonixCodewhaleInventory, reasonixSimpleDeclarationDigest, reasonixWorkspaceIdentity } from "../src/resources/native-grok-reasonix-codewhale.js";
import { scanResourceInventory } from "../src/resources/inventory.js";

const skill = (name: string) => `---\nname: ${name}\ndescription: 合成技能\n---\n# 合成内容\n`;
async function fixture(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "manor-native-resource-three-"));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}
async function file(path: string, value: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); }
async function plans(home: string, projects: string[] = []) {
  const sources: InventorySourcePlan[] = [];
  await planGrokReasonixCodewhaleInventory({ userHome: home, projects, environment: {}, gaps: [], diagnostics: [],
    add(client, kind, path, format, extra = {}) { const source: InventorySourcePlan = { id: `${client}:${sources.length}`, client, kind, path, format,
      scope: extra.project ? "project" : "user", origin: "standard", readState: "missing", verified: true, observedAt: "2026-09-01T00:00:00Z", ...extra }; sources.push(source); return source; },
    async parseConfig(path, format) { const value = await readFile(path, "utf8"); return format === "toml" ? parseToml(value) : JSON.parse(value); } });
  return sources;
}

test("Grok 普通 Skill 按名字控制，兼容 body 保持只读且共享原生设置", async () => fixture(async home => {
  await file(join(home, ".grok", "config.toml"), '[skills]\ndisabled = ["off"]\n[skills.compat]\nunrelated = true\n');
  const source = await plans(home); const native = source.find(source => source.client === "grok" && source.path === join(home, ".grok", "skills"))!;
  const foreign = source.find(source => source.client === "grok" && source.path === join(home, ".agents", "skills"))!;
  assert.equal(native.native!.stateFor("off").nativeState, "disabled"); assert.equal(native.native!.stateFor("on").nativeState, "enabled");
  assert.deepEqual(native.native!.stateFor("off").rule, { type: "name-list", format: "toml", keyPath: ["skills", "disabled"], member: "off", effectScope: "client" });
  assert.equal(foreign.verified, false); assert.equal(foreign.native!.stateFor("off").controlPath, join(home, ".grok", "config.toml"));
}));

test("Grok MCP 项目 TOML 完整覆盖用户，同名 disabled 沿实际注册保留", async () => fixture(async home => {
  const project = join(home, "workspace"); await mkdir(project, { recursive: true });
  await file(join(home, ".grok", "config.toml"), '[mcp_servers.same]\ncommand = "example-server"\nenabled = false\n');
  await file(join(project, ".grok", "config.toml"), '[mcp_servers.same]\ncommand = "other-server"\n');
  await file(join(home, ".grok", "trusted_folders.toml"), `[folders."${project}"]\ntrusted = true\n`);
  const source = await plans(home, [project]); const user = source.find(source => source.client === "grok" && source.kind === "mcp" && source.path === join(home, ".grok", "config.toml"))!;
  const local = source.find(source => source.client === "grok" && source.kind === "mcp" && source.project === project && source.format === "toml")!;
  assert.ok(local.native!.priority > user.native!.priority); assert.equal(user.native!.stateFor("same").nativeState, "disabled");
  assert.equal(local.native!.eligibleFor?.(project), true);
  assert.equal(local.native!.stateFor("same").nativeState, "enabled");
  assert.deepEqual(user.native!.stateFor("same").rule?.keyPath, ["disabled_mcp_servers"]);
}));

test("Reasonix 原生工作区身份将 linked worktree 合并到共享 Git 目录", async () => fixture(async home => {
  const main = join(home, "main"); const child = join(home, "child"); const git = join(main, ".git");
  await mkdir(join(git, "worktrees", "child"), { recursive: true }); await file(join(child, ".git"), `gitdir: ${git}/worktrees/child\n`);
  const parentIdentity = await reasonixWorkspaceIdentity(main); const childIdentity = await reasonixWorkspaceIdentity(child);
  assert.equal(parentIdentity.key, childIdentity.key); assert.notEqual(parentIdentity.legacyKey, childIdentity.legacyKey); assert.ok(parentIdentity.key.startsWith("repo:"));
}));

test("Reasonix Skill project activation 优先global，清除后的继承和user-only可核对", async () => fixture(async home => {
  const project = join(home, "workspace"); await mkdir(project, { recursive: true }); const identity = await reasonixWorkspaceIdentity(project);
  await file(join(home, ".reasonix", "config.toml"), '[skills]\ndisable_implicit_invocation = true\n');
  await file(join(home, ".reasonix", "capability-activation.json"), JSON.stringify({ version: 2, overrides: [
    { kind: "skill", scope: "global", name: "sample", enabled: false }, { kind: "skill", scope: "project", key: identity.key, name: "sample", enabled: true }] }));
  const source = await plans(home, [project]); const native = source.find(source => source.client === "reasonix" && source.kind === "skill" && !source.project && source.verified)!;
  assert.equal(native.native!.stateFor("sample").nativeState, "disabled");
  const local = native.native!.stateFor("sample", project); assert.equal(local.nativeState, "enabled"); assert.equal(local.invocationMode, "user-only");
  assert.deepEqual(local.rule?.identity, { kind: "skill", scope: "project", key: identity.key, name: "sample" });
}));

test("Reasonix user MCP activation源身份完整，project声明摘要未核验时保持unknown/只读", async () => fixture(async home => {
  const project = join(home, "workspace"); await mkdir(project, { recursive: true }); const identity = await reasonixWorkspaceIdentity(project);
  await file(join(home, ".reasonix", "config.toml"), '[[plugins]]\nname = "sample"\ncommand = "example-server"\nauto_start = false\n');
  await file(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { repository: { command: "node", args: ["./example-server.js"] } } }));
  await file(join(home, ".reasonix", "capability-activation.json"), JSON.stringify({ version: 2, overrides: [
    { kind: "mcp", scope: "global", source: "user_config", name: "sample", enabled: true },
    { kind: "mcp", scope: "project", key: identity.key, source: "project_mcp_json", name: "repository", enabled: true, identity: "stale-declaration" }] }));
  const source = await plans(home, [project]); const native = source.find(source => source.client === "reasonix" && source.kind === "mcp" && !source.project)!;
  assert.equal(native.native!.stateFor("sample").nativeState, "enabled"); assert.equal(native.native!.registrationWritable, false);
  assert.deepEqual(native.native!.stateFor("sample").rule?.identity, { kind: "mcp", scope: "global", source: "user_config", name: "sample" });
  const repository = source.find(source => source.client === "reasonix" && source.path === join(project, ".mcp.json"))!;
  assert.equal(repository.native!.stateFor("repository").nativeState, "unknown"); assert.equal(repository.native!.stateFor("repository").rule, undefined);
}));

test("Reasonix 无展开或脚本依赖的声明可精确核验，改变声明使旧enable无效", async () => fixture(async home => {
  const project = join(home, "workspace"); await mkdir(project, { recursive: true }); const identity = await reasonixWorkspaceIdentity(project);
  const declaration = { command: "example-server" }; const digest = await reasonixSimpleDeclarationDigest(declaration, project);
  assert.ok(digest); assert.equal(await reasonixSimpleDeclarationDigest({ command: "node", args: ["./server.js"] }, project), undefined);
  await file(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { sample: declaration } }));
  await file(join(home, ".reasonix", "capability-activation.json"), JSON.stringify({ version: 2, overrides: [{ kind: "mcp", scope: "project", source: "project_mcp_json", key: identity.key, name: "sample", enabled: true, identity: digest }] }));
  let sources = await plans(home, [project]); let native = sources.find(source => source.client === "reasonix" && source.path === join(project, ".mcp.json"))!;
  assert.equal(native.native!.stateFor("sample").nativeState, "enabled"); assert.equal(native.native!.stateFor("sample").rule?.identity?.key, identity.key);
  await file(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { sample: { command: "changed-server" } } }));
  sources = await plans(home, [project]); native = sources.find(source => source.client === "reasonix" && source.path === join(project, ".mcp.json"))!;
  assert.equal(native.native!.stateFor("sample").nativeState, "disabled");
}));

test("三方 Skill 名称按原生回退规则解析，不接受原生拒绝的元信息", async () => fixture(async home => {
  await file(join(home, ".grok", "skills", "Valid_Fallback", "SKILL.md"), "---\nname: 中文\n---\n# 文本\n");
  await file(join(home, ".reasonix", "skills", "ascii-stem", "SKILL.md"), "---\nname: 中文\ndescription: 合成技能\n---\n# 文本\n");
  await file(join(home, ".codewhale", "skills", "missing-name", "SKILL.md"), "---\ndescription: 合成技能\n---\n# 文本\n");
  await file(join(home, ".codewhale", "skills", "plain", "SKILL.md"), "# Plain Heading\n正文\n");
  const snapshot = await scanResourceInventory({ userHome: home, environment: {} });
  assert.ok(snapshot.entries.some(entry => entry.client === "grok" && entry.name === "valid-fallback"));
  assert.ok(snapshot.entries.some(entry => entry.client === "reasonix" && entry.name === "ascii-stem"));
  assert.ok(snapshot.entries.some(entry => entry.client === "codewhale" && entry.name === "plain-heading"));
  assert.ok(!snapshot.entries.some(entry => entry.client === "codewhale" && entry.name === "missing-name"));
}));

test("插件Skill及MCP归属所有者，批准链未核验时保护原始入口", async () => fixture(async home => {
  const grok = join(home, ".grok", "plugins", "bundle"); const reasonix = join(home, ".reasonix", "plugins", "bundle"); const whale = join(home, ".codewhale", "plugins", "bundle");
  await file(join(grok, "plugin.json"), JSON.stringify({ name: "bundle", skills: "skills", mcpServers: { "grok-plugin-server": { command: "example-server" } } }));
  await file(join(reasonix, "reasonix-plugin.json"), JSON.stringify({ name: "bundle", skills: ["skills"], mcpServers: { "reasonix-plugin-server": { command: "example-server" } } }));
  await file(join(home, ".reasonix", "plugin-packages.json"), JSON.stringify({ version: 1, plugins: [{ name: "bundle", root: "plugins/bundle", enabled: true }] }));
  await file(join(whale, "plugin.toml"), '[plugin]\nname = "bundle"\nversion = "1.0.0"\n[mcp_servers.codewhale-plugin-server]\ncommand = "example-server"\n');
  for (const root of [grok, reasonix, whale]) await file(join(root, "skills", "check", "SKILL.md"), skill("check"));
  const snapshot = await scanResourceInventory({ userHome: home, environment: {} });
  for (const client of ["grok", "reasonix", "codewhale"]) {
    const entries = snapshot.entries.filter(entry => entry.client === client && entry.owner === "bundle"); assert.ok(entries.some(entry => entry.kind === "skill")); assert.ok(entries.some(entry => entry.kind === "mcp"));
    assert.ok(entries.every(entry => entry.protected && !entry.locator.nativeRule && entry.nativeState === "unknown"));
  }
}));

test("插件Skill目录与MCP注册文件越界链接不能进入盘点", async () => fixture(async home => {
  const plugin = join(home, ".grok", "plugins", "bundle"); const outside = join(home, "outside");
  await file(join(plugin, "plugin.json"), JSON.stringify({ name: "bundle", skills: "skills", mcpServers: "mcp.json" }));
  await file(join(outside, "skill", "SKILL.md"), skill("external-skill"));
  await file(join(outside, "mcp.json"), JSON.stringify({ mcpServers: { "external-mcp": { command: "example-server" } } }));
  await mkdir(join(plugin, "skills"), { recursive: true }); await symlink(join(outside, "skill"), join(plugin, "skills", "linked")); await symlink(join(outside, "mcp.json"), join(plugin, "mcp.json"));
  const snapshot = await scanResourceInventory({ userHome: home, environment: {} });
  assert.ok(!snapshot.entries.some(entry => entry.client === "grok" && ["bundle:external-skill", "external-mcp"].includes(entry.name)));
  assert.ok(snapshot.diagnostics?.some(diagnostic => diagnostic.client === "grok" && diagnostic.reason === "invalid_reference"));
}));

test("三方插件内部SKILL.md自身越界链接不能进入盘点", async () => fixture(async home => {
  const outside = join(home, "outside", "SKILL.md"); await file(outside, skill("external-file"));
  for (const client of ["grok", "reasonix", "codewhale"]) {
    const plugin = join(home, `.${client}`, "plugins", "bundle");
    const manifest = client === "reasonix" ? "reasonix-plugin.json" : "plugin.json";
    await file(join(plugin, manifest), JSON.stringify({ name: "bundle", skills: ["skills"] }));
    await mkdir(join(plugin, "skills", "file-linked"), { recursive: true });
    await symlink(outside, join(plugin, "skills", "file-linked", "SKILL.md"));
  }
  await file(join(home, ".reasonix", "plugin-packages.json"), JSON.stringify({ version: 1, plugins: [{ name: "bundle", root: "plugins/bundle", enabled: true }] }));
  const snapshot = await scanResourceInventory({ userHome: home, environment: {} });
  for (const client of ["grok", "reasonix", "codewhale"]) {
    assert.ok(!snapshot.entries.some(entry => entry.client === client && entry.owner === "bundle" && entry.kind === "skill"));
    assert.ok(snapshot.diagnostics?.some(diagnostic => diagnostic.client === client && diagnostic.reason === "invalid_reference"));
  }
}));

test("Codewhale 普通Skill没有停用开关，兼容根只读，MCP flags按原生字段", async () => fixture(async home => {
  await file(join(home, ".codewhale", "mcp.json"), JSON.stringify({ servers: { enabled: { command: "example-server" }, disabled: { command: "example-server", disabled: true } } }));
  const source = await plans(home); const native = source.find(source => source.client === "codewhale" && source.path === join(home, ".codewhale", "skills"))!;
  const foreign = source.find(source => source.client === "codewhale" && source.path === join(home, ".claude", "skills"))!;
  assert.equal(native.native!.stateFor("ordinary").rule, undefined); assert.equal(native.native!.stateFor("ordinary").nativeState, "enabled"); assert.equal(foreign.verified, false);
  const mcp = source.find(source => source.client === "codewhale" && source.kind === "mcp" && !source.project)!;
  assert.equal(mcp.native!.stateFor("enabled").nativeState, "enabled"); assert.equal(mcp.native!.stateFor("disabled").nativeState, "disabled");
  assert.equal(mcp.native!.stateFor("disabled").rule?.disabledValue, true); assert.deepEqual(mcp.native!.stateFor("disabled").rule?.keyPath, ["servers", "disabled", "disabled"]);
}));

test("Codewhale project资源只在用户配置可信时覆盖global，项目自信任无效", async () => fixture(async home => {
  const project = join(home, "workspace"); await mkdir(project, { recursive: true });
  await file(join(project, ".codewhale", "config.toml"), `[projects."${project}"]\ntrust_level = "trusted"\n`);
  let source = await plans(home, [project]); let local = source.find(source => source.client === "codewhale" && source.project === project)!;
  assert.equal(local.native!.eligibleFor?.(project), false);
  await file(join(home, ".codewhale", "config.toml"), `[projects."${project}"]\ntrust_level = "trusted"\n`);
  source = await plans(home, [project]); local = source.find(source => source.client === "codewhale" && source.project === project)!;
  assert.equal(local.native!.eligibleFor?.(project), true);
}));

test("本组原生资源完整扫描只投影定位与状态，不暴露注册值", async () => fixture(async home => {
  for (const client of ["grok", "reasonix", "codewhale"]) await file(join(home, `.${client}`, "skills", "native-sample", "SKILL.md"), skill("native-sample"));
  await file(join(home, ".grok", "config.toml"), '[mcp_servers.sample]\ncommand = "synthetic-private-command"\n');
  await file(join(home, ".reasonix", "config.toml"), '[[plugins]]\nname = "sample"\ncommand = "synthetic-private-command"\n');
  await file(join(home, ".codewhale", "mcp.json"), JSON.stringify({ servers: { sample: { command: "synthetic-private-command" } } }));
  const snapshot = await scanResourceInventory({ userHome: home, environment: {} });
  for (const client of ["grok", "reasonix", "codewhale"]) {
    assert.ok(snapshot.entries.some(entry => entry.client === client && entry.kind === "skill")); assert.ok(snapshot.entries.some(entry => entry.client === client && entry.kind === "mcp"));
  }
  assert.ok(!JSON.stringify(snapshot).includes("synthetic-private-command"));
}));
