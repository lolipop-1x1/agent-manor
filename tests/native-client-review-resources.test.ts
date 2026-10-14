import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { scanResourceInventory } from "../src/resources/inventory.js";
import { ResourceManager } from "../src/resources/management.js";

const skill = (name: string, extra = "") => `---\nname: ${name}\ndescription: 合成资源\n${extra}---\n# 正文\n`;
async function file(path: string, value: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); }
async function temporary(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "manor-native-review-resources-"));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test("Grok MCP 从仓库根到 cwd 完整覆盖，个人停用不改共享注册且恢复保留其他名字", async () => temporary(async home => {
  const root = join(home, "repository"); const cwd = join(root, "nested"); await mkdir(join(root, ".git"), { recursive: true }); await mkdir(cwd);
  const userPath = join(home, ".grok", "config.toml"); const rootPath = join(root, ".grok", "config.toml"); const localPath = join(cwd, ".grok", "config.toml");
  const userText = '[mcp_servers.same]\ncommand = "user-server"\nenabled = false\n';
  const rootText = '[mcp_servers.same]\ncommand = "root-server"\nenabled = false\n[mcp_servers.rootOnly]\ncommand = "root-server"\n';
  const localText = '[mcp_servers.same]\ncommand = "local-server"\n[mcp_servers.onlyProject]\ncommand = "local-server"\n';
  await file(userPath, userText); await file(rootPath, rootText); await file(localPath, localText);
  await file(join(home, ".grok", "trusted_folders.toml"), `[folders."${root}"]\ntrusted = true\n`);
  const scan = () => scanResourceInventory({ userHome: home, projects: [cwd], environment: {} });
  const snapshot = await scan(); const selected = snapshot.entries.find(entry => entry.client === "grok" && entry.name === "same" && entry.project === cwd)!;
  assert.equal(selected.entryPath, localPath); assert.equal(selected.nativeState, "enabled");
  assert.ok(snapshot.entries.some(entry => entry.client === "grok" && entry.name === "rootOnly" && entry.entryPath === rootPath));
  assert.equal(selected.locator.controlPath, userPath); assert.equal(selected.locator.nativeRule?.member, "same");
  const manager = new ResourceManager(join(home, "data"));
  try {
    const preview = await manager.preview({ entryId: selected.id, action: "disable" }, snapshot);
    assert.equal(preview.sourcePath, userPath); assert.ok(preview.affectedEntries.some(entry => entry.scope === "user")); assert.ok(preview.affectedEntries.some(entry => entry.project === cwd));
    assert.equal((await manager.apply(preview.id, true, snapshot)).status, "success");
    let updated = await scan(); assert.ok(updated.entries.filter(entry => entry.client === "grok" && entry.name === "same").every(entry => entry.nativeState === "disabled"));
    assert.equal(await readFile(localPath, "utf8"), localText); assert.equal(await readFile(rootPath, "utf8"), rootText);
    assert.deepEqual(parseToml(await readFile(userPath, "utf8")).disabled_mcp_servers, ["same"]);
    await writeFile(userPath, (await readFile(userPath, "utf8")).replace('["same"]', '["same", "later"]'));
    updated = await scan(); const archive = manager.archives("disabled")[0]!;
    const restore = await manager.preview({ operationId: archive.operationId, action: "restore" }, updated);
    assert.equal((await manager.apply(restore.id, true, updated)).status, "success");
    assert.deepEqual(parseToml(await readFile(userPath, "utf8")).disabled_mcp_servers, ["later"]);
    assert.equal((await scan()).entries.find(entry => entry.id === selected.id)?.nativeState, "enabled");
    const onlyProject = (await scan()).entries.find(entry => entry.client === "grok" && entry.name === "onlyProject")!;
    const removal = await manager.preview({ entryId: onlyProject.id, action: "trash" }, await scan());
    assert.equal(removal.sourcePath, localPath);
  } finally { manager.close(); }
}));

test("OMP force enabledServers 的普通 MCP 停用使用用户 denylist，重新盘点与恢复真实生效", async () => temporary(async home => {
  const path = join(home, ".omp", "agent", "mcp.json"); const original = JSON.stringify({ mcpServers: { forced: { command: "fixture", enabled: false } }, enabledServers: ["forced"], disabledServers: ["other"] });
  await file(path, original); const scan = () => scanResourceInventory({ userHome: home, environment: {} });
  const snapshot = await scan(); const selected = snapshot.entries.find(entry => entry.client === "omp" && entry.name === "forced")!;
  assert.equal(selected.nativeState, "enabled"); assert.equal(selected.locator.nativeRule?.type, "name-list");
  const manager = new ResourceManager(join(home, "data"));
  try {
    const preview = await manager.preview({ entryId: selected.id, action: "disable" }, snapshot);
    assert.equal((await manager.apply(preview.id, true, snapshot)).status, "success");
    const disabled = await scan(); assert.equal(disabled.entries.find(entry => entry.id === selected.id)?.nativeState, "disabled");
    const values = JSON.parse(await readFile(path, "utf8")); assert.deepEqual(values.enabledServers, ["forced"]); assert.deepEqual(values.disabledServers, ["other", "forced"]);
    const restore = await manager.preview({ operationId: manager.archives("disabled")[0]!.operationId, action: "restore" }, disabled);
    assert.equal((await manager.apply(restore.id, true, disabled)).status, "success");
    assert.equal((await scan()).entries.find(entry => entry.id === selected.id)?.nativeState, "enabled"); assert.equal(await readFile(path, "utf8"), original);
  } finally { manager.close(); }
}));

test("OMP 项目入口的用户名字控制覆盖其他项目，未知作用范围不能被点击项目绕过", async () => temporary(async home => {
  const first = join(home, "first"); const second = join(home, "second"); await mkdir(first); await mkdir(second);
  await file(join(home, ".omp", "agent", "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "fixture", enabled: false } }, enabledServers: ["shared"] }));
  await file(join(first, ".omp", "mcp.json"), JSON.stringify({ mcpServers: { shared: { command: "local-fixture" } } }));
  await file(join(second, ".omp", "settings.json"), "{invalid");
  const snapshot = await scanResourceInventory({ userHome: home, projects: [first, second], environment: {} });
  const selected = snapshot.entries.find(entry => entry.client === "omp" && entry.name === "shared" && entry.project === first)!;
  assert.equal(selected.nativeState, "enabled"); assert.equal(selected.locator.nativeRule?.type, "name-list");
  const manager = new ResourceManager(join(home, "data"));
  try {
    assert.equal(manager.decorateInventory(snapshot).entries.find(entry => entry.id === selected.id)?.capabilities.disable, false);
    await assert.rejects(manager.preview({ entryId: selected.id, action: "disable" }, snapshot));
  } finally { manager.close(); }
}));

for (const layer of ["legacy-user", "legacy-project", "native-project"] as const) test(`OMP ${layer} 损坏时实际生效状态未知，普通 Skill／MCP 不开放停用`, async () => temporary(async home => {
  const project = join(home, "project"); await mkdir(project);
  await file(join(home, ".omp", "agent", "skills", "guide", "SKILL.md"), skill("guide"));
  await file(join(project, ".omp", "skills", "local", "SKILL.md"), skill("local"));
  await file(join(home, ".omp", "agent", "mcp.json"), JSON.stringify({ mcpServers: { server: { command: "fixture" } } }));
  const path = layer === "legacy-user" ? join(home, ".omp", "agent", "settings.json") : join(project, ".omp", layer === "legacy-project" ? "settings.json" : "config.yml");
  await file(path, layer === "native-project" ? "skills: [unterminated" : "{invalid");
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project], environment: {} });
  const manager = new ResourceManager(join(home, "data"));
  try {
    const entries = manager.decorateInventory(snapshot).entries.filter(entry => entry.client === "omp");
    const local = entries.find(entry => entry.name === "local")!; assert.equal(local.nativeState, "unknown"); assert.equal(local.locator.nativeRule, undefined); assert.equal(local.capabilities.disable, false);
    for (const entry of entries.filter(entry => ["guide", "server"].includes(entry.name))) {
      assert.equal(entry.selectionScopes?.find(scope => scope.project === project)?.nativeState, "unknown"); assert.equal(entry.capabilities.disable, false);
    }
    assert.ok(snapshot.gaps.some(gap => gap.client === "omp" && gap.reason === "invalid"));
    await assert.rejects(manager.preview({ entryId: local.id, action: "disable" }, snapshot));
  } finally { manager.close(); }
}));

for (const client of ["gemini", "qwen"] as const) test(`${client} 扩展 Skill 目录及 SKILL.md 文件的真实路径不能逃出插件根`, async () => temporary(async home => {
  const root = join(home, `.${client}`, "extensions", "bundle"); const outside = join(home, "outside");
  await file(join(root, `${client}-extension.json`), JSON.stringify({ name: "bundle", version: "1.0.0" }));
  await file(join(outside, "directory", "SKILL.md"), skill("external-directory")); await file(join(outside, "SKILL.md"), skill("external-file"));
  await mkdir(join(root, "skills", "linked-file"), { recursive: true });
  await symlink(join(outside, "directory"), join(root, "skills", "linked-directory")); await symlink(join(outside, "SKILL.md"), join(root, "skills", "linked-file", "SKILL.md"));
  const snapshot = await scanResourceInventory({ userHome: home, environment: {} });
  assert.ok(!snapshot.entries.some(entry => entry.client === client && entry.owner === "bundle" && entry.kind === "skill"));
  assert.ok(snapshot.diagnostics?.some(item => item.client === client && item.reason === "invalid_reference"));
}));

test("Qwen agent-plugin MCP 文件逃逸在读取前拒绝，插件内正常文件仍可盘点", async () => temporary(async home => {
  const root = join(home, ".qwen", "extensions", "portable"); const outside = join(home, "outside", "mcp.json");
  await file(join(root, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "portable" }));
  const contents = JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { external: { type: "stdio", command: "fixture" } } });
  await file(outside, contents); await symlink(outside, join(root, "mcp.json"));
  let snapshot = await scanResourceInventory({ userHome: home, environment: {} });
  assert.ok(!snapshot.entries.some(entry => entry.client === "qwen" && entry.owner === "portable" && entry.kind === "mcp"));
  assert.ok(snapshot.diagnostics?.some(item => item.client === "qwen" && item.kind === "mcp" && item.reason === "invalid_reference"));
  await rm(join(root, "mcp.json")); await file(join(root, "mcp.json"), contents);
  snapshot = await scanResourceInventory({ userHome: home, environment: {} }); assert.ok(snapshot.entries.some(entry => entry.client === "qwen" && entry.name === "external" && entry.protected));
}));

test("Kimi 子 Skill 预扫描与 OMP 完整性 marker 超预算保留 limit 缺口", async () => temporary(async home => {
  const oversized = join(home, ".kimi-code", "skills", "oversized", "SKILL.md"); await file(oversized, skill("oversized", "metadata:\n  has-sub-skill: true\n")); await truncate(oversized, 1024 * 1024 + 1);
  const store = join(home, ".omp", "skillshare", "@synthetic", "sample", "1.0.0"); await file(join(store, "SKILL.md"), skill("managed"));
  await file(join(store, ".skillshare-integrity"), "integrity"); await truncate(join(store, ".skillshare-integrity"), 64 * 1024 + 1);
  await file(join(home, ".omp", "agent", "skills.lock.json"), JSON.stringify({ version: 1, skills: { "@synthetic/sample": { version: "1.0.0", integrity: "integrity", resolved: "https://example.invalid/synthetic.tgz" } } }));
  const snapshot = await scanResourceInventory({ userHome: home, environment: {} });
  for (const client of ["kimi", "omp"]) assert.ok(snapshot.gaps.some(gap => gap.client === client && gap.reason === "limit"));
  assert.ok(!snapshot.entries.some(entry => entry.name === "managed")); assert.ok(snapshot.entries.filter(entry => entry.name === "oversized").every(entry => entry.nativeState === "unknown"));
}));


for (const client of ["gemini", "qwen"] as const) test(`${client} 扩展清单自身越界链接不能导入外部 Skill 或 MCP`, async () => temporary(async home => {
  const root = join(home, `.${client}`, "extensions", "bundle"); const outside = join(home, "outside", "manifest.json");
  await file(outside, JSON.stringify({ name: "external-bundle", version: "1.0.0", mcpServers: { external: { command: "fixture" } } })); await mkdir(root, { recursive: true });
  await symlink(outside, join(root, `${client}-extension.json`));
  const snapshot = await scanResourceInventory({ userHome: home, environment: {} });
  assert.ok(!snapshot.entries.some(entry => entry.client === client && entry.name === "external")); assert.ok(snapshot.diagnostics?.some(item => item.client === client && item.reason === "invalid_reference"));
}));


test("OMP legacy global 设置依赖覆盖同名不同正文的损坏项目入口，用户停用预览拒绝", async () => temporary(async home => {
  const project = join(home, "project"); await mkdir(project);
  const global = join(home, ".omp", "agent", "settings.json");
  await file(global, JSON.stringify({ disabledExtensions: [] }));
  await file(join(home, ".omp", "agent", "skills", "guide", "SKILL.md"), skill("guide") + "用户正文\n");
  await file(join(project, ".omp", "skills", "guide", "SKILL.md"), skill("guide") + "项目正文\n");
  await file(join(project, ".omp", "settings.json"), "{invalid");
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project], environment: {} });
  const selected = snapshot.entries.find(entry => entry.client === "omp" && entry.name === "guide" && entry.scope === "user")!;
  const local = snapshot.entries.find(entry => entry.client === "omp" && entry.name === "guide" && entry.project === project)!;
  assert.equal(selected.nativeState, "enabled"); assert.equal(selected.locator.controlPath, global); assert.equal(local.nativeState, "unknown");
  assert.ok(local.locator.dependencyPaths?.includes(global));
  const manager = new ResourceManager(join(home, "data"));
  try {
    assert.equal(manager.decorateInventory(snapshot).entries.find(entry => entry.id === selected.id)?.capabilities.disable, false);
    await assert.rejects(manager.preview({ entryId: selected.id, action: "disable" }, snapshot));
    assert.deepEqual(JSON.parse(await readFile(global, "utf8")).disabledExtensions, []);
  } finally { manager.close(); }
}));
