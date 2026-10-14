import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { scanResourceInventory } from "../src/resources/inventory.js";

async function temporary(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "manor-kimi-omp-resources-"));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}
async function file(path: string, body: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, body); }
const skill = (name: string, body = "合成资源正文", fields = "") => `---\nname: ${name}\ndescription: 合成描述\n${fields}---\n${body}\n`;
const server = { command: "node", args: ["synthetic-server.mjs"], enabled: true };

test("Kimi 原生、generic、配置目录与项目范围按发布版选择，普通Skill只提供回收入口", async () => temporary(async home => {
  const project = join(home, "project"); await mkdir(join(project, ".git"), { recursive: true });
  await file(join(home, ".kimi-code", "skills", "native", "SKILL.md"), skill("sample", "用户原生"));
  await file(join(home, ".agents", "skills", "generic", "SKILL.md"), skill("sample", "用户generic"));
  await file(join(project, ".kimi-code", "skills", "native", "SKILL.md"), skill("sample", "项目原生"));
  await file(join(project, ".agents", "skills", "generic", "SKILL.md"), skill("sample", "项目generic"));
  await file(join(home, ".kimi-code", "config.toml"), 'extraSkillDirs = ["./extra"]\n');
  await file(join(project, "extra", "configured", "SKILL.md"), skill("configured", "配置入口"));
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project] }); const entries = snapshot.entries.filter(entry => entry.client === "kimi");
  const user = entries.find(entry => entry.name === "sample" && entry.scope === "user")!; const local = entries.find(entry => entry.name === "sample" && entry.scope === "project")!;
  assert.equal(user.entryPath, join(home, ".kimi-code", "skills", "native")); assert.equal(local.entryPath, join(project, ".kimi-code", "skills", "native"));
  assert.equal(user.locator.nativeRule, undefined); assert.equal(user.protected, false); assert.ok(entries.some(entry => entry.name === "configured"));
  assert.ok(snapshot.diagnostics?.some(item => item.client === "kimi" && item.reason === "shadowed"));
}));

test("Kimi bundle 子Skill只按has-sub-skill继续扫描并保留点号名称", async () => temporary(async home => {
  const root = join(home, ".kimi-code", "skills");
  await file(join(root, "bundle", "SKILL.md"), skill("bundle", "父正文", "metadata:\n  has-sub-skill: true\n"));
  await file(join(root, "bundle", "child", "SKILL.md"), skill("child", "子正文"));
  await file(join(root, "ordinary", "SKILL.md"), skill("ordinary"));
  await file(join(root, "ordinary", "hidden", "SKILL.md"), skill("must-not-load"));
  await file(join(root, "group", "deeper", "SKILL.md"), skill("grouped"));
  const snapshot = await scanResourceInventory({ userHome: home }); const names = snapshot.entries.filter(entry => entry.client === "kimi").map(entry => entry.name);
  assert.ok(names.includes("bundle.child")); assert.ok(names.includes("grouped")); assert.ok(!names.includes("must-not-load"));
}));

test("Kimi MCP三层覆盖与enabled控制，插件Skill/MCP保护及越界引用", async () => temporary(async home => {
  const project = join(home, "project"); await mkdir(join(project, ".git"), { recursive: true });
  await file(join(home, ".kimi-code", "mcp.json"), JSON.stringify({ mcpServers: { sample: server, onlyUser: server } }));
  await file(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { sample: { ...server, enabled: false } } }));
  await file(join(project, ".kimi-code", "mcp.json"), JSON.stringify({ mcpServers: { sample: server } }));
  const pluginRoot = join(home, "plugin"); const outside = join(home, "outside");
  await file(join(pluginRoot, "skills", "protected", "SKILL.md"), skill("protected")); await file(join(outside, "SKILL.md"), skill("outside"));
  await symlink(outside, join(pluginRoot, "outside-link"));
  await file(join(pluginRoot, "kimi.plugin.json"), JSON.stringify({ name: "synthetic-plugin", skills: ["./skills", "./outside-link"], mcpServers: { pluginServer: server } }));
  await file(join(home, ".kimi-code", "plugins", "installed.json"), JSON.stringify({ version: 1, plugins: [{ id: "synthetic-plugin", root: pluginRoot, enabled: true }] }));
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project] }); const entries = snapshot.entries.filter(entry => entry.client === "kimi");
  const mcp = entries.find(entry => entry.kind === "mcp" && entry.name === "sample" && entry.project === project)!;
  assert.equal(mcp.entryPath, join(project, ".kimi-code", "mcp.json")); assert.equal(mcp.nativeState, "enabled");
  assert.deepEqual(mcp.locator.nativeRule?.keyPath, ["mcpServers", "sample", "enabled"]); assert.equal(mcp.locator.registrationWritable, true);
  assert.ok(entries.find(entry => entry.name === "protected")?.protected); const pluginServer = entries.find(entry => entry.name === "plugin-synthetic-plugin:pluginServer");
  assert.ok(pluginServer?.protected); assert.equal(pluginServer?.locator.nativeRule, undefined); assert.ok(!entries.some(entry => entry.name === "outside"));
  assert.ok(snapshot.diagnostics?.some(item => item.client === "kimi" && item.reason === "invalid_reference"));
}));

test("OMP native/foreign/provider开关及隐藏语义使用本客户端原生配置控制", async () => temporary(async home => {
  const configPath = join(home, ".omp", "agent", "config.yml"); const project = join(home, "project"); await mkdir(project);
  await file(configPath, "enabledProviders: [claude]\ndisabledExtensions: [skill:disabled]\n");
  await file(join(home, ".omp", "agent", "skills", "disabled", "SKILL.md"), skill("disabled"));
  await file(join(home, ".omp", "agent", "skills", "hidden", "SKILL.md"), skill("hidden", "隐藏正文", "hide: true\n"));
  await file(join(home, ".claude", "skills", "foreign", "SKILL.md"), skill("foreign"));
  await file(join(home, ".codex", "skills", "opt-out", "SKILL.md"), skill("opt-out"));
  await file(join(home, ".omp", "agent", "skills", "SKILL.md"), skill("root-not-a-skill"));
  await file(join(home, ".omp", "agent", "skills", "group", "deep", "SKILL.md"), skill("nested-not-a-skill"));
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project] }); const entries = snapshot.entries.filter(entry => entry.client === "omp");
  assert.equal(entries.find(entry => entry.name === "disabled")?.nativeState, "disabled"); assert.equal(entries.find(entry => entry.name === "hidden")?.invocationMode, "user-only");
  assert.equal(entries.find(entry => entry.name === "foreign")?.nativeState, "enabled");
  assert.equal(entries.find(entry => entry.name === "opt-out"), undefined);
  const foreign = entries.find(entry => entry.name === "foreign")!; assert.equal(foreign.locator.controlPath, configPath); assert.equal(foreign.locator.nativeRule?.member, "skill:foreign");
  assert.equal(snapshot.sources.find(source => source.id === foreign.sourceId)?.verified, false);
  assert.ok(!entries.some(entry => ["root-not-a-skill", "nested-not-a-skill"].includes(entry.name)));
}));

test("OMP Skill同名不同正文保留别名，相同全文合并，custom目录优先", async () => temporary(async home => {
  const project = join(home, "project"); await mkdir(project);
  await file(join(home, ".omp", "agent", "skills", "sample", "SKILL.md"), skill("sample", "native正文"));
  await file(join(project, ".claude", "skills", "sample", "SKILL.md"), skill("sample", "foreign正文"));
  await file(join(project, ".agents", "skills", "sample", "SKILL.md"), skill("sample", "native正文"));
  const custom = join(home, "custom"); await file(join(custom, "sample", "SKILL.md"), skill("sample", "custom正文"));
  await file(join(home, ".omp", "agent", "config.yml"), `skills:\n  customDirectories:\n    - ${custom}\n`);
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project] }); const entries = snapshot.entries.filter(entry => entry.client === "omp" && entry.kind === "skill");
  assert.equal(entries.find(entry => entry.name === "sample")?.entryPath, join(custom, "sample"));
  assert.ok(entries.some(entry => entry.name === "agent/sample")); assert.ok(entries.some(entry => entry.name === "claude/sample"));
  assert.ok(!entries.some(entry => entry.name === "agents/sample"));
}));
test("OMP 同namespace的不同正文别名使用数字后缀，不覆盖另一个入口", async () => temporary(async home => {
  const project = join(home, "project", "nested"); await mkdir(join(home, "project", ".git"), { recursive: true });
  await file(join(home, ".omp", "agent", "skills", "sample", "SKILL.md"), skill("sample", "裸名正文"));
  await file(join(project, ".claude", "skills", "sample", "SKILL.md"), skill("sample", "最近项目正文"));
  await file(join(home, "project", ".claude", "skills", "sample", "SKILL.md"), skill("sample", "父项目正文"));
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project] });
  const names = snapshot.entries.filter(entry => entry.client === "omp" && entry.kind === "skill").map(entry => entry.name);
  assert.ok(names.includes("claude/sample")); assert.ok(names.includes("claude/sample~2"));
}));

test("原生Skill schema与前台隐藏分开，未加载的无效文档不作为有效入口", async () => temporary(async home => {
  await file(join(home, ".kimi-code", "skills", "missing-name", "SKILL.md"), "---\ndescription: 合成说明\n---\n正文\n");
  await file(join(home, ".kimi-code", "skills", "unsupported", "SKILL.md"), skill("unsupported", "正文", "type: unsupported\n"));
  await file(join(home, ".omp", "agent", "skills", "missing-description", "SKILL.md"), "---\nname: invalid\n---\n正文\n");
  await file(join(home, ".omp", "agent", "skills", "explicit-off", "SKILL.md"), skill("explicit-off", "正文", "enabled: false\n"));
  await file(join(home, ".omp", "agent", "skills", "hidden", "SKILL.md"), skill("hidden", "正文", "disable-model-invocation: true\n"));
  const snapshot = await scanResourceInventory({ userHome: home }); const entries = snapshot.entries.filter(entry => ["kimi", "omp"].includes(entry.client));
  assert.deepEqual(entries.map(entry => entry.name), ["hidden"]); assert.equal(entries[0]?.invocationMode, "user-only");
}));

test("OMP 原生MCP、外部只读注册及名字deny/allow控制保持原生范围", async () => temporary(async home => {
  const project = join(home, "project"); await mkdir(project);
  const nativePath = join(home, ".omp", "agent", "mcp.json");
  await file(join(home, ".omp", "agent", "config.yml"), "enabledProviders: [gemini]\n");
  await file(nativePath, JSON.stringify({ mcpServers: { native: server }, disabledServers: ["denied"], enabledServers: ["forced"] }));
  await file(join(home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { denied: server, forced: { ...server, enabled: false } } }));
  await file(join(project, ".omp", "mcp.json"), JSON.stringify({ mcpServers: { native: { ...server, enabled: false } } }));
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project] }); const entries = snapshot.entries.filter(entry => entry.client === "omp" && entry.kind === "mcp");
  const native = entries.find(entry => entry.name === "native" && entry.project === project)!; assert.equal(native.nativeState, "disabled");
  assert.equal(native.locator.nativeRule?.type, "boolean"); assert.equal(native.locator.registrationWritable, true);
  const denied = entries.find(entry => entry.name === "denied")!; const forced = entries.find(entry => entry.name === "forced")!;
  assert.equal(denied.nativeState, "disabled"); assert.equal(forced.nativeState, "enabled"); assert.equal(denied.locator.registrationWritable, false);
  assert.equal(denied.locator.controlPath, nativePath); assert.equal(denied.locator.nativeRule?.member, "denied"); assert.deepEqual(denied.locator.nativeRule?.keyPath, ["disabledServers"]);
}));

test("OMP 持久插件、managed及skillshare来源保护，包完整性marker必须一致", async () => temporary(async home => {
  const root = join(home, "plugin"); await file(join(root, "skills", "plugin", "SKILL.md"), skill("plugin"));
  await file(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { pluginMcp: server } }));
  await file(join(home, ".omp", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "synthetic@market": [{ scope: "user", installPath: root, enabled: true }] } }));
  await file(join(home, ".omp", "agent", "managed-skills", "managed", "SKILL.md"), skill("managed"));
  const store = join(home, ".omp", "skillshare", "@synthetic", "sample", "1.0.0"); await file(join(store, "SKILL.md"), skill("installed"));
  await file(join(store, ".skillshare-integrity"), "synthetic-integrity");
  await file(join(home, ".omp", "agent", "skills.lock.json"), JSON.stringify({ version: 1, skills: { "@synthetic/sample": { version: "1.0.0", integrity: "synthetic-integrity", resolved: "/synthetic.tgz" } } }));
  let snapshot = await scanResourceInventory({ userHome: home }); let entries = snapshot.entries.filter(entry => entry.client === "omp");
  assert.ok(entries.find(entry => entry.name === "plugin")?.protected); assert.ok(entries.find(entry => entry.name === "pluginMcp")?.protected);
  assert.equal(entries.find(entry => entry.name === "managed")?.protectionReason, "managed"); assert.equal(entries.find(entry => entry.name === "installed")?.protectionReason, "plugin");
  await writeFile(join(store, ".skillshare-integrity"), "different"); snapshot = await scanResourceInventory({ userHome: home }); entries = snapshot.entries.filter(entry => entry.client === "omp");
  assert.ok(!entries.some(entry => entry.name === "installed"));
}));

test("OMP 配置扩展读取约定子目录，marketplace支持声明路径及内嵌MCP，npm只读取声明包", async () => temporary(async home => {
  const extension = join(home, "extension"); await file(join(extension, "skills", "configured", "SKILL.md"), skill("configured-extension"));
  await file(join(extension, ".mcp.json"), JSON.stringify({ mcpServers: { configuredMcp: server } }));
  await file(join(home, ".omp", "agent", "config.yml"), `extensions:\n  - ${extension}\n`);
  const marketRoot = join(home, "market"); await file(join(marketRoot, "custom", "SKILL.md"), skill("marketplace-custom"));
  await file(join(marketRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ skills: "./custom" }));
  await file(join(marketRoot, ".omp-plugin", "plugin.json"), JSON.stringify({ mcpServers: { inlineMcp: { ...server, enabled: false } } }));
  await file(join(home, ".omp", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "synthetic@market": [{ installPath: marketRoot, enabled: true }] } }));
  const npmRoot = join(home, ".omp", "plugins"); const packageRoot = join(npmRoot, "node_modules", "synthetic-package");
  await file(join(npmRoot, "package.json"), JSON.stringify({ dependencies: { "synthetic-package": "1.0.0" } }));
  await file(join(packageRoot, "package.json"), JSON.stringify({ version: "1.0.0", omp: {} }));
  await file(join(packageRoot, "skills", "npm", "SKILL.md"), skill("npm-skill"));
  const staleRoot = join(npmRoot, "node_modules", "stale-package"); await file(join(staleRoot, "package.json"), JSON.stringify({ version: "1.0.0", omp: {} }));
  await file(join(staleRoot, "skills", "stale", "SKILL.md"), skill("stale-skill"));
  await file(join(npmRoot, "omp-plugins.lock.json"), JSON.stringify({ plugins: { "synthetic-package": { enabled: true }, "stale-package": { enabled: true } } }));
  const snapshot = await scanResourceInventory({ userHome: home }); const entries = snapshot.entries.filter(entry => entry.client === "omp");
  assert.ok(entries.find(entry => entry.name === "configured-extension")?.protected); assert.ok(entries.find(entry => entry.name === "marketplace-custom")?.protected);
  assert.equal(entries.find(entry => entry.name === "inlineMcp")?.nativeState, "disabled"); assert.ok(entries.some(entry => entry.name === "configuredMcp"));
  assert.ok(entries.find(entry => entry.name === "npm-skill")?.protected); assert.ok(!entries.some(entry => entry.name === "stale-skill"));
}));

test("OMP portable插件的闭合schema与目录范围，未来版本和逃逸Skill不作为已加载入口", async () => temporary(async home => {
  const plugin = join(home, "portable"); const future = join(home, "future"); const outside = join(home, "outside");
  await file(join(plugin, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "portable" }));
  await file(join(plugin, "skills", "valid", "SKILL.md"), skill("valid"));
  await file(join(plugin, "skills", "extra-field", "SKILL.md"), skill("extra-field", "正文", "hide: true\n"));
  await file(join(outside, "SKILL.md"), skill("escaped")); await symlink(outside, join(plugin, "skills", "escaped"));
  await file(join(plugin, "mcp.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {
    validMcp: { type: "stdio", command: "node", args: [] }, invalidMcp: { type: "stdio", command: "node", enabled: true }, invalidRemote: { type: "streamable-http", url: "http://example.invalid/mcp" },
  } }));
  await file(join(future, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json", name: "future" }));
  await file(join(future, "skills", "future", "SKILL.md"), skill("future"));
  await file(join(home, ".omp", "agent", "config.yml"), `extensions:\n  - ${plugin}\n  - ${future}\n`);
  const snapshot = await scanResourceInventory({ userHome: home }); const entries = snapshot.entries.filter(entry => entry.client === "omp");
  assert.ok(entries.find(entry => entry.name === "valid")?.protected); assert.ok(entries.some(entry => entry.name === "validMcp"));
  assert.ok(!entries.some(entry => ["extra-field", "escaped", "future", "invalidMcp", "invalidRemote"].includes(entry.name)));
  assert.ok(snapshot.gaps.some(gap => gap.client === "omp" && gap.reason === "unsupported"));
}));

test("OMP user配置迁移来源与项目数组替换决定实际写控制位置", async () => temporary(async home => {
  const project = join(home, "project"); await mkdir(project);
  const userSettings = join(home, ".omp", "agent", "settings.json"); const projectSettings = join(project, ".omp", "settings.json");
  await file(userSettings, JSON.stringify({ disabledExtensions: ["skill:sample"] }));
  await file(projectSettings, JSON.stringify({ disabledExtensions: [] }));
  await file(join(home, ".omp", "agent", "skills", "sample", "SKILL.md"), skill("sample"));
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project] }); const entry = snapshot.entries.find(entry => entry.client === "omp" && entry.name === "sample")!;
  assert.equal(entry.nativeState, "disabled"); assert.equal(entry.selectionScopes?.find(scope => scope.project === project)?.nativeState, "enabled");
  assert.equal(entry.selectionScopes?.find(scope => scope.project === project)?.controlPath, projectSettings);
}));

test("OMP OpenCode逐层深合并MCP，部分项目覆盖继承原生状态与transport", async () => temporary(async home => {
  const project = join(home, "project"); await mkdir(project);
  await file(join(home, ".omp", "agent", "config.yml"), "enabledProviders: [opencode]\n");
  await file(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ mcp: {
    inherited: { type: "local", command: ["node", "synthetic-server.mjs"], enabled: false }, remote: { type: "remote", url: "https://example.invalid/mcp", enabled: true },
  } }));
  await file(join(home, ".config", "opencode", "opencode.jsonc"), JSON.stringify({ mcp: { inherited: { environment: { SYNTHETIC: "user" } } } }));
  await file(join(project, "opencode.jsonc"), JSON.stringify({ mcp: { inherited: { timeout: 1000 }, remote: { enabled: false } } }));
  await file(join(project, ".opencode", "opencode.json"), JSON.stringify({ mcp: { inherited: { environment: { PROJECT: "yes" } } } }));
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project] });
  const entries = snapshot.entries.filter(entry => entry.client === "omp" && entry.kind === "mcp" && entry.project === project);
  const inherited = entries.find(entry => entry.name === "inherited")!; assert.equal(inherited.entryPath, join(project, ".opencode", "opencode.json"));
  assert.equal(inherited.nativeState, "disabled"); assert.equal(inherited.transport, "stdio");
  assert.equal(entries.find(entry => entry.name === "remote")?.nativeState, "disabled"); assert.equal(entries.find(entry => entry.name === "remote")?.transport, "http");
  assert.ok(inherited.locator.dependencyPaths?.includes(join(home, ".config", "opencode", "opencode.json")));
}));

test("OMP Claude MCP用户与项目只选择第一个含服务器的文件", async () => temporary(async home => {
  const project = join(home, "project"); await mkdir(project);
  await file(join(home, ".omp", "agent", "config.yml"), "enabledProviders: [claude]\n");
  await file(join(home, ".claude.json"), JSON.stringify({ mcpServers: { firstUser: server } }));
  await file(join(home, ".claude", "mcp.json"), JSON.stringify({ mcpServers: { ignoredUser: server } }));
  await file(join(project, ".claude", ".mcp.json"), JSON.stringify({ mcpServers: { firstProject: { ...server, enabled: false } } }));
  await file(join(project, ".claude", "mcp.json"), JSON.stringify({ mcpServers: { ignoredProject: server } }));
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project] }); const entries = snapshot.entries.filter(entry => entry.client === "omp");
  assert.ok(entries.some(entry => entry.name === "firstUser")); assert.equal(entries.find(entry => entry.name === "firstProject")?.nativeState, "disabled");
  assert.ok(!entries.some(entry => ["ignoredUser", "ignoredProject"].includes(entry.name)));
}));

test("OMP Skillshare优先于兼容来源、低于native，祖先锁与disabledExtensions保留", async () => temporary(async home => {
  const project = join(home, "project", "nested"); await mkdir(join(home, "project", ".git"), { recursive: true });
  await file(join(home, ".omp", "agent", "config.yml"), "enabledProviders: [claude]\ndisabledExtensions: [skill:sample]\n");
  const store = join(home, ".omp", "skillshare", "@synthetic", "sample", "1.0.0");
  await file(join(store, "SKILL.md"), skill("sample", "安装包正文")); await file(join(store, ".skillshare-integrity"), "synthetic-integrity");
  await file(join(home, "project", ".omp", "skills.lock.json"), JSON.stringify({ version: 1, skills: { "@synthetic/sample": { version: "1.0.0", integrity: "synthetic-integrity", resolved: "/synthetic.tgz" } } }));
  await file(join(project, ".claude", "skills", "sample", "SKILL.md"), skill("sample", "兼容正文"));
  let snapshot = await scanResourceInventory({ userHome: home, projects: [project] });
  let selected = snapshot.entries.find(entry => entry.client === "omp" && entry.name === "sample" && entry.project === project)!;
  assert.equal(selected.entryPath, store); assert.equal(selected.nativeState, "disabled"); assert.ok(selected.protected);
  await file(join(project, ".omp", "skills", "sample", "SKILL.md"), skill("sample", "原生正文"));
  snapshot = await scanResourceInventory({ userHome: home, projects: [project] }); selected = snapshot.entries.find(entry => entry.client === "omp" && entry.name === "sample" && entry.project === project)!;
  assert.equal(selected.entryPath, join(project, ".omp", "skills", "sample"));
}));

test("OMP plugins按XDG及最近项目锚点发现，项目同包遮蔽user并应用项目停用", async () => temporary(async home => {
  const project = join(home, "project", "nested"); await mkdir(join(home, "project", ".git"), { recursive: true }); await mkdir(project);
  const userRoot = join(home, "data", "omp", "plugins"); const projectRoot = join(home, "project", ".omp", "plugins");
  for (const [root, label, packages] of [[userRoot, "user", ["synthetic-package", "disabled-package"]], [projectRoot, "project", ["synthetic-package"]]] as const) {
    await file(join(root, "package.json"), JSON.stringify({ dependencies: Object.fromEntries(packages.map(name => [name, "1.0.0"])) }));
    for (const name of packages) {
      await file(join(root, "node_modules", name, "package.json"), JSON.stringify({ version: "1.0.0", omp: {} }));
      await file(join(root, "node_modules", name, "skills", "sample", "SKILL.md"), skill(`${label}-${name}`));
    }
  }
  await file(join(project, ".omp", "plugin-overrides.json"), JSON.stringify({ disabled: ["disabled-package"] }));
  // cwd 的 .omp 是较近锚点，所以此场景将注册目录放到该锚点。
  await file(join(project, ".omp", "plugins", "package.json"), JSON.stringify({ dependencies: { "synthetic-package": "1.0.0" } }));
  await file(join(project, ".omp", "plugins", "node_modules", "synthetic-package", "package.json"), JSON.stringify({ version: "1.0.0", omp: {} }));
  await file(join(project, ".omp", "plugins", "node_modules", "synthetic-package", "skills", "sample", "SKILL.md"), skill("nearest-project"));
  const snapshot = await scanResourceInventory({ userHome: home, projects: [project], environment: { XDG_DATA_HOME: join(home, "data") } });
  const entries = snapshot.entries.filter(entry => entry.client === "omp" && entry.kind === "skill");
  assert.ok(entries.some(entry => entry.name === "nearest-project" && entry.project === project));
  for (const name of ["user-synthetic-package", "user-disabled-package"]) {
    const entry = entries.find(entry => entry.name === name)!; assert.ok(entry); assert.ok(!entry.selectionScopes?.some(scope => scope.project === project));
  }
  assert.ok(!entries.some(entry => entry.name === "project-synthetic-package"));
}));
