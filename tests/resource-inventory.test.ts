import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanResourceInventory } from "../src/resources/inventory.js";

async function fixture(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "manor-resource-inventory-"));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}
async function file(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}
const skill = (name: string) => `---\nname: ${name}\ndescription: >\n  合成资源的\n  多行描述\n---\n# 示例\n不执行此处脚本。\n`;

test("共享目标按真实位置归并，链接入口、同内容副本和断链分别保留", async () => fixture(async home => {
  const target = join(home, "shared", "sample");
  await file(join(target, "SKILL.md"), skill("sample"));
  const codexRoot = join(home, ".agents", "skills");
  const claudeRoot = join(home, ".claude", "skills");
  await mkdir(codexRoot, { recursive: true }); await mkdir(claudeRoot, { recursive: true });
  await symlink(target, join(codexRoot, "linked"));
  await symlink(target, join(claudeRoot, "linked"));
  await file(join(codexRoot, "copy", "SKILL.md"), skill("sample"));
  await symlink(join(home, "gone"), join(codexRoot, "broken"));
  await file(join(home, ".codex", "skills", ".system", "core", "SKILL.md"), skill("core"));
  await symlink(join(home, ".codex", "skills", ".system", "core"), join(codexRoot, "system-alias"));
  const snapshot = await scanResourceInventory({ userHome: home });
  const codex = snapshot.entries.filter(entry => entry.client === "codex");
  const linked = codex.find(entry => entry.entryPath === join(codexRoot, "linked"))!;
  const shared = snapshot.bodies.find(body => body.id === linked.bodyId)!;
  assert.equal(linked.entryType, "symlink");
  assert.equal(linked.targetPath, await realpath(target));
  assert.equal(linked.description, "合成资源的 多行描述\n");
  assert.ok(shared.entryIds.some(id => snapshot.entries.find(entry => entry.id === id)?.client === "claude"));
  const copy = codex.find(entry => entry.entryPath === join(codexRoot, "copy"))!;
  assert.equal(copy.contentFingerprint, linked.contentFingerprint);
  assert.notEqual(copy.bodyId, linked.bodyId);
  assert.equal(codex.find(entry => entry.name === "broken")?.readState, "broken");
  assert.equal(codex.find(entry => entry.name === "core")?.protectionReason, "system");
  assert.equal(codex.find(entry => entry.entryPath === join(codexRoot, "system-alias"))?.protectionReason, "system");
  assert.equal(codex.find(entry => entry.entryPath === join(codexRoot, "system-alias"))?.locator.nativeControl, undefined);
  assert.ok(snapshot.entries.every(entry => !entry.capabilities.disable && !entry.capabilities.standby && !entry.capabilities.trash));
  assert.ok(snapshot.entries.every(entry => entry.observedAt && !Object.hasOwn(entry, "installedAt")));
}));

test("MCP 只投影注册定位和设置状态，不泄露 command、URL、env 或未知字段", async () => fixture(async home => {
  const configPath = join(home, ".codex", "config.toml");
  const original = `unrelated = "keep"\n[mcp_servers.alpha]\ncommand = "synthetic-secret-command"\nenabled = false\n[mcp_servers.alpha.env]\nKEY = "synthetic-secret-env"\n[mcp_servers.beta]\nurl = "https://example.invalid/synthetic-secret-url"\n[mcp_servers.beta.http_headers]\nAuthorization = "synthetic-secret-header"\n`;
  await file(configPath, original);
  const snapshot = await scanResourceInventory({ userHome: home });
  const rows = snapshot.entries.filter(entry => entry.client === "codex" && entry.kind === "mcp");
  assert.equal(rows.length, 2);
  const alpha = rows.find(row => row.name === "alpha")!;
  assert.equal(alpha.nativeState, "disabled"); assert.equal(alpha.transport, "stdio");
  assert.deepEqual(alpha.locator.keyPath, ["mcp_servers", "alpha"]);
  assert.equal(alpha.locator.nativeControl, "codex-mcp");
  assert.equal(rows.find(row => row.name === "beta")?.transport, "http");
  assert.ok(!JSON.stringify(snapshot).includes("synthetic-secret"));
  assert.equal(await readFile(configPath, "utf8"), original);
}));

test("Codex Skill 设置按规范化 SKILL.md 路径匹配，用户规则不冒充项目停用", async () => fixture(async home => {
  const path = join(home, ".agents", "skills", "sample");
  await file(join(path, "SKILL.md"), skill("sample"));
  await file(join(home, ".codex", "config.toml"), `[[skills.config]]\npath = ${JSON.stringify(join(path, "SKILL.md"))}\nenabled = false\n`);
  const project = join(home, "project");
  await file(join(project, ".agents", "skills", "sample", "SKILL.md"), skill("sample"));
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project] });
  const user = snapshot.entries.find(entry => entry.client === "codex" && entry.entryPath === path)!;
  assert.equal(user.nativeState, "disabled"); assert.equal(user.locator.nativeControl, "codex-skill");
  const projectSkill = snapshot.entries.find(entry => entry.client === "codex" && entry.project === project)!;
  assert.equal(projectSkill.locator.nativeControl, undefined);
  assert.equal(projectSkill.nativeState, "unknown");
}));

test("项目、手动来源与缺失项目保留明确范围；未知产品可手动盘点但保持只读", async () => fixture(async home => {
  const project = join(home, "project");
  await file(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { projectServer: { command: "synthetic" } } }));
  await file(join(home, ".claude.json"), JSON.stringify({ projects: { [project]: { disabledMcpServers: ["projectServer"], mcpServers: { privateServer: { command: "synthetic" } } } } }));
  const manualRoot = join(home, "manual");
  await file(join(manualRoot, "custom", "SKILL.md"), skill("custom"));
  const absent = join(home, "missing-project");
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project, absent], manualSources: [{ client: "workbuddy", kind: "skill", path: manualRoot, project }] });
  const shared = snapshot.entries.find(entry => entry.client === "claude" && entry.name === "projectServer")!;
  assert.equal(shared.scope, "project"); assert.equal(shared.project, project); assert.equal(shared.nativeState, "disabled");
  assert.equal(shared.locator.nativeControl, "claude-mcp-project");
  const privateEntry = snapshot.entries.find(entry => entry.name === "privateServer")!;
  assert.deepEqual(privateEntry.locator.keyPath, ["projects", project, "mcpServers", "privateServer"]);
  const manual = snapshot.entries.find(entry => entry.client === "workbuddy")!;
  assert.equal(manual.name, "custom"); assert.equal(snapshot.sources.find(source => source.id === manual.sourceId)?.origin, "manual");
  assert.equal(manual.locator.nativeControl, undefined);
  assert.ok(snapshot.gaps.some(gap => gap.reason === "project_missing"));
  assert.ok(snapshot.sources.some(source => source.client === "zcode" && source.readState === "unsupported"));
}));

test("JSONC 正确解析注释和 URL，优先来源不合并，损坏文件产生缺口", async () => fixture(async home => {
  await file(join(home, ".config", "opencode", "opencode.jsonc"), `{ // comment\n "mcp": { "remote": {"type":"remote", "url":"https://example.invalid/path//keep", "enabled":false,},},}`);
  await file(join(home, ".codebuddy", ".mcp.json"), `{ "mcpServers": {"preferred":{"command":"synthetic"}} }`);
  await file(join(home, ".codebuddy", "mcp.json"), `{ "mcpServers": {"ignored":{"command":"synthetic"}} }`);
  await file(join(home, ".qoder", "settings.json"), `{ "mcpServers": `);
  const snapshot = await scanResourceInventory({ userHome: home });
  assert.equal(snapshot.entries.find(entry => entry.client === "opencode" && entry.name === "remote")?.nativeState, "disabled");
  assert.equal(snapshot.entries.filter(entry => entry.client === "codebuddy").length, 1);
  assert.ok(snapshot.entries.some(entry => entry.name === "preferred"));
  assert.ok(!snapshot.entries.some(entry => entry.name === "ignored"));
  assert.ok(snapshot.sources.some(source => source.client === "qoder" && source.readState === "invalid"));
}));

test("同文件手动注册定位保留各自登记身份，不按路径猜测删除对象", async () => fixture(async home => {
  const path = join(home, "manual.json");
  await file(path, '{"first":{"one":{"command":"synthetic"}},"second":{"two":{"command":"synthetic"}}}');
  const sources = ["first", "second"].map(id => ({ id, client: "codex" as const, kind: "mcp" as const, path, format: "json" as const, keyPath: [id] }));
  const snapshot = await scanResourceInventory({ userHome: home, manualSources: sources });
  assert.deepEqual(snapshot.sources.filter(source => source.origin === "manual").map(source => source.manualSourceId), ["first", "second"]);
  assert.equal(snapshot.entries.find(entry => entry.name === "one")?.sourceId, snapshot.sources.find(source => source.manualSourceId === "first")?.id);
  assert.equal(snapshot.entries.find(entry => entry.name === "two")?.sourceId, snapshot.sources.find(source => source.manualSourceId === "second")?.id);
}));

test("插件入口保留所有者和保护；manifest 逃逸路径不扫描，普通目录不会被顺带遍历", async () => fixture(async home => {
  const plugin = join(home, ".claude", "plugins", "cache", "market", "sample", "1.0");
  await file(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "sample", skills: ["../../../../../../outside"], mcpServers: { inlineServer: { command: "synthetic-secret-plugin" } } }));
  await file(join(plugin, "skills", "plugin-skill", "SKILL.md"), skill("plugin-skill"));
  await file(join(home, "outside", "SKILL.md"), skill("must-not-scan"));
  const snapshot = await scanResourceInventory({ userHome: home });
  const entry = snapshot.entries.find(entry => entry.name === "plugin-skill" && entry.client === "claude")!;
  assert.equal(entry.protectionReason, "plugin"); assert.ok(entry.owner);
  assert.equal(entry.locator.nativeControl, undefined);
  assert.ok(snapshot.entries.find(entry => entry.name === "inlineServer")?.protected);
  assert.ok(!snapshot.entries.some(entry => entry.name === "must-not-scan"));
  assert.ok(!JSON.stringify(snapshot).includes("synthetic-secret-plugin"));
}));

test("DSH 平铺 Markdown 与目录资源同时保留；目录链接循环不会重复扫描", async () => fixture(async home => {
  const root = join(home, ".dsh", "skills");
  await file(join(root, "flat.md"), skill("flat"));
  await file(join(root, "directory", "SKILL.md"), skill("directory"));
  await symlink(root, join(root, "loop"));
  const snapshot = await scanResourceInventory({ userHome: home });
  assert.deepEqual(snapshot.entries.filter(entry => entry.client === "dsh").map(entry => entry.name).sort(), ["directory", "flat"]);
  assert.equal(snapshot.entries.find(entry => entry.name === "flat")?.entryType, "file");
}));
