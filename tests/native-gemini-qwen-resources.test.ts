import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { ResourceInventoryDiagnostic, ResourceInventoryGap } from "../src/resource-inventory-contracts.js";
import type { InventorySourcePlan } from "../src/resources/codeflicker-inventory.js";
import { planGeminiQwenInventory, qwenMcpApprovalHash } from "../src/resources/native-gemini-qwen.js";
import { scanResourceInventory } from "../src/resources/inventory.js";

const write = async (path: string, value: unknown) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, typeof value === "string" ? value : JSON.stringify(value)); };

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-native-resources-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function planner(directory: string, projects: string[] = [], extra: Record<string, string> = {}) {
  const userHome = join(directory, "user"); const sources: InventorySourcePlan[] = []; const gaps: ResourceInventoryGap[] = []; const diagnostics: ResourceInventoryDiagnostic[] = [];
  const environment = { GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(directory, "system", "gemini.json"), QWEN_CODE_SYSTEM_SETTINGS_PATH: join(directory, "system", "qwen.json"), ...extra };
  await planGeminiQwenInventory({ userHome, projects, environment, gaps, diagnostics,
    add(client, kind, path, format, extra = {}) {
      const id = JSON.stringify([client, kind, path, extra.project, extra.owner, extra.keyPath]);
      const existing = sources.find(source => source.id === id);
      const source: InventorySourcePlan = { id, client, kind, path, format, project: extra.project, scope: extra.project ? "project" : "user", origin: "standard", verified: true, readState: "missing", observedAt: "2026-10-14T01:00:00.000Z", ...extra };
      if (!existing) sources.push(source); return source;
    },
    async parseConfig(path) {
      const text = await readFile(path, "utf8"); const errors: ParseError[] = []; const value = parseJsonc(text, errors, { allowTrailingComma: true });
      if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("configuration_invalid");
      return value;
    } });
  return { sources, gaps, diagnostics, userHome };
}

test("Gemini .agents 优先级、信任、技能总开关和名字级控制沿实际来源生效", async () => temporary(async directory => {
  const home = join(directory, "user"); const project = join(directory, "project");
  await write(join(home, ".gemini", "settings.json"), { skills: { disabled: ["synthetic-disabled"] }, security: { folderTrust: { enabled: true } } });
  await write(join(home, ".gemini", "trustedFolders.json"), { [project]: "DO_NOT_TRUST" });
  await write(join(project, ".gemini", "settings.json"), { skills: { enabled: false } });
  const result = await planner(directory, [project]);
  const native = result.sources.find(source => source.client === "gemini" && source.kind === "skill" && source.path === join(home, ".gemini", "skills"))!;
  const alias = result.sources.find(source => source.client === "gemini" && source.kind === "skill" && source.path === join(home, ".agents", "skills"))!;
  assert.ok(alias.native!.priority > native.native!.priority); assert.equal(alias.verified, false);
  assert.equal(native.native!.stateFor("synthetic-disabled").nativeState, "disabled");
  assert.deepEqual(native.native!.stateFor("synthetic-disabled").rule?.keyPath, ["skills", "disabled"]);
  assert.equal(native.native!.stateFor("ordinary", project).nativeState, "enabled", "不可信项目设置不能影响用户 Skill");
  const workspace = result.sources.find(source => source.client === "gemini" && source.kind === "skill" && source.project === project)!;
  assert.equal(workspace.native!.eligibleFor!(project), false); assert.equal(workspace.native!.stateFor("ordinary", project).nativeState, "disabled");
  const trusted = await planner(directory, [project], { GEMINI_CLI_TRUST_WORKSPACE: "true" });
  assert.equal(trusted.sources.find(source => source.id === native.id)!.native!.stateFor("ordinary", project).nativeState, "disabled");
}));

test("Gemini MCP 全局 enablement、允许列表交集与上层禁用不冒充可局部恢复", async () => temporary(async directory => {
  const home = join(directory, "user"); const userSettings = join(home, ".gemini", "settings.json");
  await write(userSettings, { mcpServers: { one: { command: "synthetic" }, two: { command: "synthetic" }, three: { command: "synthetic" } }, mcp: { allowed: ["one", "two", "three"] } });
  await write(join(directory, "system", "gemini.json"), { mcp: { allowed: ["one", "two"] } });
  await write(join(home, ".gemini", "mcp-server-enablement.json"), { one: { enabled: false } });
  const result = await planner(directory); const source = result.sources.find(source => source.path === userSettings && source.client === "gemini")!;
  assert.equal(source.metadataOnly, false); assert.equal(source.native!.rows!.length, 3);
  const one = source.native!.stateFor("one"); assert.equal(one.nativeState, "disabled");
  assert.equal(one.controlPath, join(home, ".gemini", "mcp-server-enablement.json")); assert.deepEqual(one.rule?.keyPath, ["one", "enabled"]);
  assert.equal(source.native!.stateFor("two").nativeState, "enabled"); assert.equal(source.native!.stateFor("three").rule, undefined);
  await write(userSettings, { mcpServers: { one: { command: "synthetic" } }, mcp: { excluded: ["one"] } });
  const blocked = (await planner(directory)).sources.find(source => source.path === userSettings && source.client === "gemini")!.native!.stateFor("one");
  assert.equal(blocked.controlPath, userSettings); assert.deepEqual(blocked.rule?.keyPath, ["mcp", "excluded"]);
}));

test("Qwen Skill 的硬禁用、默认禁用授权、disabledLevels 和用户触发模式保留", async () => temporary(async directory => {
  const home = join(directory, "user"); const project = join(directory, "project");
  await write(join(home, ".qwen", "settings.json"), { skills: { disabled: ["hard"], defaultDisabled: ["default", "granted"], enabled: ["granted"], disabledLevels: ["extension"] } });
  await write(join(project, ".qwen", "settings.json"), { skills: { enabled: ["hard"] } });
  const result = await planner(directory, [project]);
  const source = result.sources.find(source => source.client === "qwen" && source.kind === "skill" && source.path === join(home, ".qwen", "skills"))!;
  assert.equal(source.native!.stateFor("hard", project).nativeState, "disabled");
  assert.equal(source.native!.stateFor("default", project).nativeState, "disabled"); assert.deepEqual(source.native!.stateFor("default", project).rule?.keyPath, ["skills", "defaultDisabled"]);
  assert.equal(source.native!.stateFor("granted", project).nativeState, "enabled");
  assert.equal(source.native!.stateFor("ordinary", project, { "disable-model-invocation": true }).invocationMode, "user-only");
  assert.equal(source.native!.stateFor("ordinary", project).invocationMode, undefined);
  await write(join(directory, "system", "qwen.json"), { skills: { disabled: ["locked"] } });
  const locked = (await planner(directory, [project])).sources.find(value => value.id === source.id)!.native!.stateFor("locked", project);
  assert.equal(locked.nativeState, "disabled"); assert.equal(locked.rule, undefined);
}));

test("Qwen 原生来源优先级与项目 MCP 审批绑定实际配置摘要", async () => temporary(async directory => {
  const home = join(directory, "user"); const project = join(directory, "project"); const registration = { command: "synthetic", args: ["server"], env: { SYNTHETIC: "value" } };
  await write(join(home, ".qwen", "settings.json"), { mcpServers: { shared: registration } });
  await write(join(project, ".mcp.json"), { mcpServers: { shared: registration } });
  await write(join(project, ".qwen", "settings.json"), { mcpServers: { workspace: registration } });
  await write(join(home, ".qwen", "mcpApprovals.json"), { [project]: { shared: { hash: qwenMcpApprovalHash(registration), status: "approved" } } });
  const result = await planner(directory, [project]);
  const user = result.sources.find(source => source.client === "qwen" && source.path === join(home, ".qwen", "settings.json"))!;
  const local = result.sources.find(source => source.client === "qwen" && source.path === join(project, ".mcp.json"))!;
  const workspace = result.sources.find(source => source.client === "qwen" && source.path === join(project, ".qwen", "settings.json"))!;
  assert.ok(local.native!.priority > user.native!.priority); assert.ok(workspace.native!.priority > local.native!.priority);
  assert.equal(local.native!.stateFor("shared", project).nativeState, "enabled"); assert.equal(workspace.native!.stateFor("workspace", project).nativeState, "disabled");
  await write(join(project, ".mcp.json"), { mcpServers: { shared: { ...registration, args: ["changed"] } } });
  assert.equal((await planner(directory, [project])).sources.find(source => source.id === local.id)!.native!.stateFor("shared", project).nativeState, "disabled");
  assert.equal(qwenMcpApprovalHash({ ...registration, description: "cosmetic", scope: "project" }), qwenMcpApprovalHash(registration));
  assert.notEqual(qwenMcpApprovalHash({ ...registration, env: { description: "behavior" } }), qwenMcpApprovalHash(registration));
  await write(join(project, ".mcp.json"), { mcpServers: { http: { type: "http", url: "https://example.invalid/mcp" } } });
  await write(join(home, ".qwen", "mcpApprovals.json"), { [project]: { http: { hash: qwenMcpApprovalHash({ httpUrl: "https://example.invalid/mcp" }), status: "approved" } } });
  assert.equal((await planner(directory, [project])).sources.find(source => source.id === local.id)!.native!.stateFor("http", project).nativeState, "enabled");
}));

test("Qwen Agent Plugins v1 的技能与独立 mcp.json 以插件身份只读盘点", async () => temporary(async directory => {
  const home = join(directory, "user"); const extension = join(home, ".qwen", "extensions", "synthetic-v1");
  await write(join(extension, "plugin.json"), { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "synthetic-v1", version: "1.0.0" });
  await write(join(extension, "mcp.json"), { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { server: { type: "http", url: "https://example.invalid/mcp" } } });
  const result = await planner(directory); const skill = result.sources.find(source => source.client === "qwen" && source.kind === "skill" && source.owner === "synthetic-v1")!;
  assert.equal(skill.native!.namespace, "synthetic-v1"); assert.equal(skill.origin, "plugin");
  const mcp = result.sources.find(source => source.client === "qwen" && source.path === join(extension, "mcp.json") && source.native)!;
  assert.equal(mcp.native!.registrationWritable, false); assert.equal(mcp.native!.rows![0]?.name, "server");
}));

test("扩展 Skill 与 MCP 采用原生归属、store 状态和独立偏好，保护源不能直接写注册", async () => temporary(async directory => {
  const home = join(directory, "user"); const project = join(directory, "project"); const extensionRoot = join(home, ".qwen", "extensions", "synthetic-extension");
  await write(join(extensionRoot, "qwen-extension.json"), { name: "synthetic-extension", version: "1", skillStates: { inherited: false }, mcpServers: { server: { command: "synthetic" } } });
  await write(join(home, ".qwen", "extensions", "extension-preferences.json"), { disabledMcpServers: { "synthetic-extension": ["server"] } });
  await write(join(home, ".qwen", "extension-store", "state.json"), { version: 2, generation: 1, extensions: { "synthetic-identity": { name: "synthetic-extension", defaultActivation: "enabled", workspaceOverrides: {}, skillWorkspaceOverrides: { [project]: { local: false } } } } });
  const result = await planner(directory, [project]); const skill = result.sources.find(source => source.client === "qwen" && source.kind === "skill" && source.owner === "synthetic-extension")!;
  assert.equal(skill.origin, "plugin"); assert.equal(skill.native!.namespace, "synthetic-extension");
  assert.equal(skill.native!.stateFor("synthetic-extension:inherited", project).nativeState, "disabled"); assert.equal(skill.native!.stateFor("synthetic-extension:local", project).nativeState, "disabled");
  const mcp = result.sources.find(source => source.kind === "mcp" && source.path === join(extensionRoot, "qwen-extension.json") && source.native)!;
  assert.equal(mcp.native!.registrationWritable, false); const state = mcp.native!.stateFor("server", project);
  assert.equal(state.nativeState, "disabled"); assert.deepEqual(state.rule?.keyPath, ["disabledMcpServers", "synthetic-extension"]);
  assert.ok(result.sources.some(source => source.origin === "system" && source.format === "unsupported")); assert.ok(result.gaps.some(gap => gap.reason === "unsupported"));
}));

test("不完整配置和未知信任分别保留未知，不以缺省值确认已启用", async () => temporary(async directory => {
  const home = join(directory, "user"); const project = join(directory, "project");
  await write(join(home, ".gemini", "settings.json"), "{bad");
  const result = await planner(directory, [project]);
  const user = result.sources.find(source => source.client === "gemini" && source.kind === "skill" && source.path === join(home, ".gemini", "skills"))!;
  assert.equal(user.native!.stateFor("ordinary").nativeState, "unknown"); assert.ok(result.gaps.some(gap => gap.reason === "invalid"));
  await write(join(home, ".gemini", "settings.json"), {});
  const clean = await planner(directory, [project]); const source = clean.sources.find(source => source.client === "gemini" && source.kind === "skill" && source.project === project)!;
  assert.equal(source.native!.stateFor("ordinary", project).nativeState, "unknown"); assert.equal(source.native!.eligibleFor!(project), undefined);
}));

test("真实盘点入口共享原生选择、触发模式、插件保护与去除配置密钥投影", async () => temporary(async directory => {
  const home = join(directory, "user"); const project = join(directory, "project"); await mkdir(project, { recursive: true });
  const skill = (name: string, userOnly = false) => `---\nname: ${name}\ndescription: Synthetic skill\n${userOnly ? "disable-model-invocation: true\n" : ""}---\n\nSynthetic body\n`;
  await write(join(home, ".gemini", "settings.json"), { security: { folderTrust: { enabled: false } }, mcpServers: { "synthetic-gemini-server": { command: "synthetic", env: { SYNTHETIC_TOKEN: "private-synthetic-value" } } } });
  await write(join(home, ".gemini", "skills", "shared", "SKILL.md"), skill("shared"));
  await write(join(home, ".agents", "skills", "shared", "SKILL.md"), skill("shared"));
  await write(join(project, ".gemini", "skills", "shared", "SKILL.md"), skill("shared"));
  await write(join(home, ".qwen", "skills", "manual-only", "SKILL.md"), skill("manual-only", true));
  await write(join(home, ".qwen", "extensions", "synthetic-ext", "qwen-extension.json"), { name: "synthetic-ext", version: "1", mcpServers: { "plugin-server": { command: "synthetic" } } });
  await write(join(home, ".qwen", "extensions", "synthetic-ext", "skills", "extension-skill", "SKILL.md"), skill("extension-skill"));
  const result = await scanResourceInventory({ userHome: home, projects: [project], environment: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(directory, "system", "gemini.json"), QWEN_CODE_SYSTEM_SETTINGS_PATH: join(directory, "system", "qwen.json") } });
  const gemini = result.entries.filter(entry => entry.client === "gemini" && entry.name === "shared"); assert.equal(gemini.length, 2);
  assert.ok(gemini.some(entry => !entry.project && entry.entryPath.startsWith(join(home, ".agents"))));
  assert.ok(gemini.some(entry => entry.project === project)); assert.ok(result.diagnostics?.some(row => row.client === "gemini" && row.reason === "shadowed"));
  const qwen = result.entries.find(entry => entry.client === "qwen" && entry.name === "manual-only")!; assert.equal(qwen.invocationMode, "user-only"); assert.equal(qwen.locator.nativeControl, "native-rule");
  const plugin = result.entries.find(entry => entry.client === "qwen" && entry.name === "synthetic-ext:extension-skill")!;
  assert.equal(plugin.protected, true); assert.equal(plugin.protectionReason, "plugin"); assert.equal(plugin.locator.nativeRule, undefined);
  assert.ok(result.entries.some(entry => entry.client === "gemini" && entry.kind === "mcp" && entry.nativeState === "enabled"));
  const output = JSON.stringify(result); assert.ok(!output.includes("private-synthetic-value")); assert.ok(!output.includes("stateFor")); assert.ok(!output.includes('"rows"'));
}));

test("原生 Skill loader 字段、名称归一化及目录深度不采用通用兜底", async () => temporary(async directory => {
  const home = join(directory, "user");
  await write(join(home, ".gemini", "skills", "valid", "SKILL.md"), "---\nname: synthetic:name\ndescription: Synthetic description\n---\nBody\n");
  await write(join(home, ".gemini", "skills", "SKILL.md"), "---\nname: root-valid\ndescription: Synthetic description\n---\nBody\n");
  await write(join(home, ".gemini", "skills", "fallback", "SKILL.md"), "---\nname: simple:fallback\ndescription: Native fallback: colon value\n---\nBody\n");
  await write(join(home, ".gemini", "skills", "missing", "SKILL.md"), "No frontmatter\n");
  await write(join(home, ".gemini", "skills", "deep", "nested", "SKILL.md"), "---\nname: too-deep\ndescription: Synthetic description\n---\nBody\n");
  await write(join(home, ".qwen", "skills", "unicode", "SKILL.md"), "---\nname: 合成技能\ndescription: Synthetic description\n---\nBody\n");
  await write(join(home, ".qwen", "skills", "SKILL.md"), "---\nname: root-ignored\ndescription: Synthetic description\n---\nBody\n");
  const result = await scanResourceInventory({ userHome: home, environment: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(directory, "system", "gemini.json"), QWEN_CODE_SYSTEM_SETTINGS_PATH: join(directory, "system", "qwen.json") } });
  assert.ok(result.entries.some(entry => entry.client === "gemini" && entry.name === "synthetic-name"));
  assert.ok(result.entries.some(entry => entry.client === "gemini" && entry.name === "root-valid"));
  assert.ok(result.entries.some(entry => entry.client === "gemini" && entry.name === "simple-fallback"));
  assert.ok(result.entries.some(entry => entry.client === "qwen" && entry.name === "合成技能"));
  assert.ok(!result.entries.some(entry => entry.client === "gemini" && ["missing", "too-deep"].includes(entry.name)));
  assert.ok(!result.entries.some(entry => entry.client === "qwen" && entry.name === "root-ignored"));
  assert.ok(result.diagnostics?.some(row => row.client === "gemini" && row.reason === "invalid_reference"));
}));
