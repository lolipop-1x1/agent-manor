import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanResourceInventory } from "../src/resources/inventory.js";

async function fixture(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "manor-flicker-inventory-"));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}
async function file(path: string, text: string): Promise<void> { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, text); }
const skill = (name: string) => `---\nname: ${name}\ndescription: Synthetic skill\n---\n# Fixture\n`;

test("CLI 与桌面根分别发现，名称覆盖按用户默认和项目上下文计算", async () => fixture(async home => {
  const user = join(home, ".codeflicker", "skills", "sample");
  const desktop = join(home, ".myflicker", "skills", "sample");
  const project = join(home, "workspace");
  const local = join(project, ".codeflicker", "skills", "sample");
  await file(join(user, "SKILL.md"), skill("sample")); await file(join(desktop, "SKILL.md"), skill("sample"));
  await file(join(local, "SKILL.md"), skill("sample"));
  await file(join(home, ".codeflicker", "config.json"), JSON.stringify({ claudeImport: false, remoteSkills: false, skills: { userOnly: ["sample"] } }));
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project] });
  const cli = snapshot.entries.filter(entry => entry.client === "codeflicker" && entry.kind === "skill");
  assert.equal(cli.length, 2);
  assert.equal(cli.find(entry => !entry.project)?.entryPath, user);
  assert.equal(cli.find(entry => entry.project)?.entryPath, local);
  assert.ok(cli.every(entry => entry.nativeState === "enabled" && entry.invocationMode === "user-only"));
  assert.equal(cli.find(entry => entry.project)?.locator.controlPath, join(project, ".codeflicker", "config.local.json"));
  assert.ok(snapshot.diagnostics?.some(row => row.reason === "shadowed" && row.project === project && row.path === user && row.selectedPath === local));
  assert.equal(snapshot.entries.find(entry => entry.client === "codeflicker-desktop")?.entryPath, desktop);
  assert.ok(!snapshot.sources.some(source => ["codeflicker", "codeflicker-desktop"].includes(source.client) && source.format === "unsupported"));
}));

test("CLI 数组状态累计且disabled优先，MCP层覆盖整体注册且不公开敏感值", async () => fixture(async home => {
  const project = join(home, "workspace");
  await file(join(home, ".codeflicker", "skills", "sample", "SKILL.md"), skill("sample"));
  const globalPath = join(home, ".codeflicker", "config.json");
  const global = JSON.stringify({ skills: { disabled: ["sample"] }, mcpServers: { alpha: { command: "synthetic-secret-global", disable: true, env: { VALUE: "synthetic-secret-env" } }, beta: { url: "https://example.invalid/synthetic-secret-url" } } });
  await file(globalPath, global);
  await file(join(project, ".codeflicker", "config.json"), JSON.stringify({ skills: { enabled: ["sample"] }, mcpServers: { alpha: { command: "synthetic-secret-project" } } }));
  await file(join(project, ".codeflicker", "config.local.json"), JSON.stringify({ skills: { userOnly: ["sample"] } }));
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project] });
  assert.ok(snapshot.entries.filter(entry => entry.client === "codeflicker" && entry.kind === "skill").every(entry => entry.nativeState === "disabled"));
  const alpha = snapshot.entries.filter(entry => entry.client === "codeflicker" && entry.name === "alpha");
  assert.equal(alpha.length, 2); assert.equal(alpha.find(entry => entry.project)?.nativeState, "enabled");
  assert.equal(alpha.find(entry => !entry.project)?.nativeState, "disabled");
  assert.equal(alpha.find(entry => entry.project)?.locator.configPath, join(project, ".codeflicker", "config.json"));
  assert.ok(!JSON.stringify(snapshot).includes("synthetic-secret")); assert.equal(await readFile(globalPath, "utf8"), global);
}));

test("显式自定义路径按项目cwd核验，旧数组兼容、无上下文相对引用保留缺口", async () => fixture(async home => {
  const project = join(home, "workspace");
  const explicit = join(home, "custom", "sample");
  await file(join(explicit, "SKILL.md"), skill("explicit"));
  await file(join(home, ".codeflicker", "config.json"), JSON.stringify({ skills: [explicit, "custom/project", join(home, "absent")] }));
  await file(join(project, "custom", "project", "SKILL.md"), skill("relative"));
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project] });
  assert.equal(snapshot.entries.filter(entry => entry.client === "codeflicker" && entry.name === "explicit").length, 1);
  assert.equal(snapshot.entries.find(entry => entry.client === "codeflicker" && entry.name === "relative")?.project, project);
  assert.ok(snapshot.diagnostics?.some(row => row.reason === "invalid_reference" && row.path === "custom/project"));
  assert.ok(snapshot.gaps.some(row => row.reason === "missing" && snapshot.sources.find(source => source.id === row.sourceId)?.path === join(home, "absent")));
}));

test("插件只读取安装登记引用，保留命名空间和停用，旧版本缓存仅诊断，路径越界不扫描", async () => fixture(async home => {
  const root = join(home, ".codeflicker", "plugins", "cache", "catalog", "sample", "2");
  const stale = join(home, ".codeflicker", "plugins", "cache", "catalog", "sample", "1");
  await file(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "sample-plugin", skills: ["../../../../../outside"], mcpServers: { server: { command: "synthetic-secret-plugin" } } }));
  await file(join(root, "skills", "sample", "SKILL.md"), skill("sample"));
  await file(join(stale, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "sample-plugin" }));
  await file(join(stale, "skills", "stale", "SKILL.md"), skill("stale"));
  await file(join(home, ".codeflicker", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "sample-plugin@catalog": { name: "sample-plugin", scope: "global", installPath: root } } }));
  await file(join(home, ".codeflicker", "config.json"), JSON.stringify({ enabledPlugins: { "sample-plugin@catalog": false } }));
  const snapshot = await scanResourceInventory({ userHome: home });
  const plugin = snapshot.entries.find(entry => entry.client === "codeflicker" && entry.name === "sample-plugin:sample")!;
  assert.equal(plugin.nativeState, "disabled"); assert.equal(plugin.protectionReason, "plugin");
  assert.deepEqual(plugin.nativeNames, ["sample-plugin:sample", "sample"]);
  assert.equal(snapshot.entries.find(entry => entry.client === "codeflicker" && entry.name === "server")?.nativeState, "disabled");
  assert.ok(!snapshot.entries.some(entry => entry.client === "codeflicker" && entry.name === "stale"));
  assert.ok(snapshot.diagnostics?.some(row => row.reason === "residual" && row.path === stale));
  assert.ok(snapshot.diagnostics?.some(row => row.reason === "invalid_reference"));
  assert.ok(!JSON.stringify(snapshot).includes("synthetic-secret"));
}));

test("桌面精确目录保留同名，marker独立，自定义YAML和托管保护正确，MCP歧义字段状态未知", async () => fixture(async home => {
  const desktopRoot = join(home, "desktop-data");
  const first = join(desktopRoot, "skills", "first"), second = join(desktopRoot, "user-skills", "second"), custom = join(home, "custom");
  await file(join(first, "SKILL.md"), skill("same")); await file(join(second, "SKILL.md"), skill("same")); await file(join(second, ".disable"), "");
  await file(join(custom, "third", "SKILL.md"), skill("custom"));
  await file(join(desktopRoot, "agent-settings.yaml"), `userCustomSkillDirs:\n  value:\n    - ${JSON.stringify(custom)}\n  updatedAt: 1\n`);
  await file(join(desktopRoot, "internal", "skills", "builtin", "SKILL.md"), skill("builtin"));
  await file(join(desktopRoot, "skills", "market", "SKILL.md"), skill("market"));
  await file(join(desktopRoot, "skills", "market", "manifest.json"), JSON.stringify({ name: "market", version: "1.0" }));
  await file(join(desktopRoot, "config", "mcp.json"), JSON.stringify({ mcpServers: { known: { command: "synthetic-secret", disable: true }, ambiguous: { url: "https://example.invalid", disabled: true }, available: { command: "synthetic" } } }));
  const snapshot = await scanResourceInventory({ userHome: home, environment: { MYFLICKER_HOME: desktopRoot } });
  const desktop = snapshot.entries.filter(entry => entry.client === "codeflicker-desktop");
  assert.equal(desktop.filter(entry => entry.name === "same").length, 2);
  assert.equal(desktop.find(entry => entry.entryPath === first)?.nativeState, "enabled");
  assert.equal(desktop.find(entry => entry.entryPath === second)?.nativeState, "disabled");
  assert.equal(desktop.find(entry => entry.entryPath === second)?.locator.controlPath, join(await realpath(second), ".disable"));
  assert.ok(desktop.some(entry => entry.name === "custom"));
  assert.equal(desktop.find(entry => entry.name === "builtin")?.protectionReason, "system");
  assert.equal(desktop.find(entry => entry.name === "market")?.protectionReason, "managed");
  assert.equal(desktop.find(entry => entry.name === "known")?.nativeState, "disabled");
  assert.equal(desktop.find(entry => entry.name === "ambiguous")?.nativeState, "unknown");
  assert.equal(desktop.find(entry => entry.name === "available")?.locator.nativeControl, undefined);
  assert.ok(!JSON.stringify(snapshot).includes("synthetic-secret"));
}));

test("共享路径按真实目标归并，读取失败与同级冲突不冒充已选中或停用", async () => fixture(async home => {
  const shared = join(home, "shared");
  await file(join(shared, "SKILL.md"), skill("shared"));
  for (const root of [join(home, ".codeflicker", "skills"), join(home, ".myflicker", "skills")]) { await mkdir(root, { recursive: true }); await symlink(shared, join(root, "shared")); }
  await file(join(home, ".codeflicker", "skills", "a", "SKILL.md"), skill("collision"));
  await file(join(home, ".codeflicker", "skills", "b", "SKILL.md"), skill("collision"));
  await file(join(home, ".codeflicker", "config.json"), JSON.stringify({ skills: { disabled: "invalid" } }));
  const snapshot = await scanResourceInventory({ userHome: home });
  const sharedEntries = snapshot.entries.filter(entry => entry.name === "shared");
  assert.equal(new Set(sharedEntries.map(entry => entry.bodyId)).size, 1);
  assert.equal(snapshot.entries.filter(entry => entry.client === "codeflicker" && entry.name === "collision").length, 2);
  assert.ok(snapshot.entries.filter(entry => entry.client === "codeflicker").every(entry => entry.nativeState === "unknown"));
  assert.ok(snapshot.diagnostics?.some(row => row.reason === "conflict"));
  assert.ok(snapshot.sources.some(source => source.client === "codeflicker" && source.readState === "invalid"));
}));

test("插件flat MCP和显式文件入口支持静态读取，注册中的symlink逃逸不读取", async () => fixture(async home => {
  const root = join(home, "installed-plugin");
  const outside = join(home, "outside");
  await file(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "plugin", skills: ["linked"] }));
  await file(join(root, ".mcp.json"), JSON.stringify({ flatServer: { command: "synthetic", type: "stdio" } }));
  await file(join(outside, "SKILL.md"), skill("outside")); await symlink(outside, join(root, "linked"));
  await file(join(home, ".codeflicker", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { plugin: { name: "plugin", installPath: root, scope: "global" } } }));
  const explicitFile = join(home, "explicit.md"); await file(explicitFile, skill("file"));
  await file(join(home, ".codeflicker", "config.json"), JSON.stringify({ enabledPlugins: { plugin: true }, skillPaths: [explicitFile] }));
  const snapshot = await scanResourceInventory({ userHome: home });
  const rows = snapshot.entries.filter(entry => entry.client === "codeflicker");
  assert.ok(rows.some(entry => entry.name === "file" && entry.entryType === "file"));
  const server = rows.find(entry => entry.name === "flatServer")!;
  assert.deepEqual(server.locator.keyPath, ["flatServer"]); assert.equal(server.protected, true);
  assert.ok(!rows.some(entry => entry.name === "plugin:outside"));
  assert.ok(snapshot.diagnostics?.some(row => row.reason === "invalid_reference" && row.path === join(root, "linked")));
}));

test("未知格式和损坏来源显式记录，桌面自定义引用缺失不等于空资源完整确认", async () => fixture(async home => {
  const desktop = join(home, ".myflicker");
  const absent = join(home, "absent-custom");
  await file(join(desktop, "agent-settings.yaml"), `userCustomSkillDirs:\n  value: [${JSON.stringify(absent)}]\n`);
  await file(join(desktop, "config", "mcp.json"), "{ malformed");
  await file(join(home, ".codeflicker", "skills", "invalid", "SKILL.md"), "---\nname: invalid\n---\nmissing description\n");
  const snapshot = await scanResourceInventory({ userHome: home });
  assert.ok(snapshot.gaps.some(row => row.reason === "missing" && snapshot.sources.find(source => source.id === row.sourceId)?.path === absent));
  assert.ok(snapshot.sources.some(source => source.client === "codeflicker-desktop" && source.kind === "mcp" && source.readState === "invalid"));
  assert.ok(!snapshot.entries.some(entry => entry.client === "codeflicker" && entry.name === "invalid"));
  assert.ok(snapshot.diagnostics?.some(row => row.reason === "dynamic"));
}));

test("50个项目不复制用户入口，项目选择状态保留且入口身份稳定", async () => fixture(async home => {
  const userPath = join(home, ".codeflicker", "skills", "sample");
  await file(join(userPath, "SKILL.md"), skill("sample"));
  await file(join(home, ".codeflicker", "config.json"), JSON.stringify({ claudeImport: false, remoteSkills: false }));
  const baseline = await scanResourceInventory({ userHome: home });
  const original = baseline.entries.find(entry => entry.client === "codeflicker" && entry.name === "sample")!;
  const projects = Array.from({ length: 50 }, (_, index) => join(home, "workspaces", `project-${index}`));
  for (const project of projects) await mkdir(project, { recursive: true });
  await file(join(projects[0]!, ".codeflicker", "skills", "sample", "SKILL.md"), skill("sample"));
  await file(join(projects[1]!, ".codeflicker", "config.local.json"), JSON.stringify({ skills: { disabled: ["sample"] } }));
  await file(join(projects[2]!, ".codeflicker", "config.local.json"), JSON.stringify({ skills: { userOnly: ["sample"] } }));
  const snapshot = await scanResourceInventory({ userHome: home, projects });
  const entries = snapshot.entries.filter(entry => entry.client === "codeflicker" && entry.kind === "skill");
  assert.equal(entries.length, 2);
  const user = entries.find(entry => entry.entryPath === userPath)!;
  assert.equal(user.id, original.id); assert.equal(user.sourceId, original.sourceId);
  assert.equal(user.scope, "user"); assert.equal(user.project, undefined); assert.equal(user.nativeState, "enabled");
  assert.equal(user.locator.controlPath, join(home, ".codeflicker", "config.json"));
  assert.equal(user.selectionScopes?.length, 50);
  assert.ok(!user.selectionScopes?.some(scope => scope.project === projects[0]));
  assert.equal(user.selectionScopes?.find(scope => scope.project === projects[1])?.nativeState, "disabled");
  assert.equal(user.selectionScopes?.find(scope => scope.project === projects[2])?.invocationMode, "user-only");
  assert.equal(user.selectionScopes?.find(scope => scope.project === projects[1])?.controlPath, join(projects[1]!, ".codeflicker", "config.local.json"));
  assert.equal(snapshot.sources.filter(source => source.client === "codeflicker" && source.path === join(home, ".codeflicker", "skills")).length, 1);
  assert.ok(snapshot.diagnostics?.some(row => row.project === projects[0] && row.entryId === user.id && row.reason === "shadowed"));
}));

test("只在项目上下文有效的用户目录仍保留真实用户来源与有效项目列表", async () => fixture(async home => {
  const project = join(home, "workspace");
  const userPath = join(home, ".codeflicker", "skills", "sample");
  const remote = join(home, ".codeflicker", "remote-skills", "sample");
  await file(join(userPath, "SKILL.md"), skill("sample")); await file(join(remote, "SKILL.md"), skill("sample"));
  await file(join(project, ".codeflicker", "config.json"), JSON.stringify({ remoteSkills: false }));
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project] });
  const user = snapshot.entries.find(entry => entry.client === "codeflicker" && entry.entryPath === userPath)!;
  assert.equal(user.scope, "user"); assert.equal(user.project, undefined);
  assert.deepEqual(user.selectionScopes?.map(scope => scope.project), [project]);
  assert.equal(snapshot.sources.find(source => source.id === user.sourceId)?.scope, "user");
  assert.ok(snapshot.diagnostics?.some(row => row.reason === "shadowed" && row.path === userPath && !row.project));
}));

test("插件manifest可引用单Skill或立即子目录容器，容器本身不制造不可读本体", async () => fixture(async home => {
  const root = join(home, "installed");
  await file(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "example", skills: ["./skills", "./specific", "./empty"] }));
  await file(join(root, "skills", "plugin-guide", "SKILL.md"), skill("plugin-guide"));
  await file(join(root, "specific", "SKILL.md"), skill("specific")); await mkdir(join(root, "empty"));
  await file(join(root, "skills", "deep", "nested", "SKILL.md"), skill("not-immediate"));
  await file(join(home, ".codeflicker", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { example: { name: "example", installPath: root, scope: "global" } } }));
  await file(join(home, ".codeflicker", "config.json"), JSON.stringify({ enabledPlugins: { example: true } }));
  const snapshot = await scanResourceInventory({ userHome: home });
  const plugin = snapshot.entries.filter(entry => entry.client === "codeflicker" && entry.owner === "example");
  assert.deepEqual(plugin.map(entry => entry.name).sort(), ["example:plugin-guide", "example:specific"]);
  assert.ok(plugin.every(entry => entry.readState === "present"));
  assert.ok(!snapshot.diagnostics?.some(row => row.reason === "shadowed" && row.name === "example:plugin-guide"));
}));
