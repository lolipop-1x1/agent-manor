import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ResourceInventoryEntry, ResourceSourceFormat } from "../resource-inventory-contracts.js";
import type { InventorySourcePlan } from "./codeflicker-inventory.js";
import type { NativeInventoryMetadata, NativePlannerOptions, NativeResourceState } from "./native-inventory.js";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const canonical = async (path: string) => realpath(path).catch(() => resolve(path));
const contained = (root: string, path: string) => { const value = relative(root, path); return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value); };
const expand = (home: string, value: string) => value.startsWith("~/") ? join(home, value.slice(2)) : value;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const asciiLower = (value: string) => value.replace(/[A-Z]/g, character => character.toLowerCase());
const slug = (value: string) => asciiLower(value.trim()).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const skillStem = (path: string) => basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path).replace(/\.md$/, "");
const validReasonixName = (value: string) => Array.from(value).length <= 64 && /^[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]*$/u.test(value) && !/\p{Default_Ignorable_Code_Point}/u.test(value);
function nativeSkillName(client: "grok" | "reasonix" | "codewhale", frontmatter: Record<string, unknown> | undefined, path: string, raw: string): string | undefined {
  const stem = skillStem(path); const declared = text(frontmatter?.name);
  if (client === "grok") {
    const name = [declared, stem].filter((value): value is string => typeof value === "string").map(slug).find(value => value.length > 0 && value.length <= 64);
    return name;
  }
  if (client === "reasonix") {
    if (!validReasonixName(stem)) return undefined;
    const name = declared && validReasonixName(declared) && (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(declared) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(stem)) ? declared : stem;
    return name.normalize("NFC");
  }
  if (!frontmatter && /^---\r?\n/.test(raw)) return undefined;
  const original = frontmatter ? declared?.trim() : /^#\s+(.+)$/m.exec(raw)?.[1]?.trim();
  if (!original) return undefined;
  const segment = (value: string) => {
    const legacy = slug(value).slice(0, 64).replace(/-$/, "") || "skill";
    return /^[\x00-\x7f]*$/.test(value) ? legacy : `${legacy.slice(0, 31).replace(/-$/, "")}-${hash(asciiLower(value.trim())).slice(0, 32)}`;
  };
  const pieces = original.split(":"); return pieces.length === 2 && pieces.every(Boolean) ? pieces.map(segment).join(":") : segment(original);
}

/** 与原生 workspaceid 一致：linked worktree 归属共享 Git 目录，普通目录按真实路径。 */
export async function reasonixWorkspaceIdentity(project: string): Promise<{ key: string; legacyKey: string; dependencies: string[] }> {
  const base = await canonical(project); let dir = base; const dependencies: string[] = [];
  while (true) {
    const marker = join(dir, ".git");
    try {
      const info = await lstat(marker); let gitDir: string | undefined;
      if (info.isDirectory()) gitDir = await canonical(marker);
      else if (info.isFile()) {
        const body = await readFile(marker, "utf8"); const match = /^\s*gitdir:\s*(.+)$/m.exec(body);
        if (match) gitDir = await canonical(isAbsolute(match[1]!) ? match[1]! : join(dir, match[1]!));
      }
      if (gitDir) {
        dependencies.push(marker); const pieces = gitDir.split(sep); const index = pieces.lastIndexOf("worktrees");
        const common = index > 0 ? pieces.slice(0, index).join(sep) || sep : gitDir;
        return { key: `repo:${hash(await canonical(common)).slice(0, 16)}`, legacyKey: `legacy:${hash(base)}`, dependencies };
      }
    } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(String(object(error).code))) throw error; }
    const parent = dirname(dir); if (parent === dir) break; dir = parent;
  }
  return { key: `path:${hash(base).slice(0, 16)}`, legacyKey: `legacy:${hash(base)}`, dependencies };
}

/** 仅无变量展开、环境注入或工作区文件引用的声明可按固定版 Go 序列化核验。 */
export async function reasonixSimpleDeclarationDigest(value: Record<string, unknown>, project: string): Promise<string | undefined> {
  const command = text(value.command) ?? ""; const args = strings(value.args); const url = text(value.url) ?? "";
  if (Object.keys(object(value.env)).length || Object.keys(object(value.headers)).length || /\s|[/$\\.]/.test(command)
    || args.some(arg => /\s|[/$\\.=]/.test(arg)) || url.includes("$")) return undefined;
  for (const word of [command, ...args].filter(Boolean)) {
    try { if ((await lstat(join(project, word))).isFile()) return undefined; }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes(String(object(error).code))) return undefined; }
  }
  const declaration = { Type: (text(value.type) ?? "").trim().toLowerCase(), Command: command, URL: url, Args: args.length ? args : null, Env: null, Headers: null };
  const goJson = JSON.stringify({ Declaration: declaration, DotEnv: {}, Files: {} }).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return hash(goJson);
}

export async function planGrokReasonixCodewhaleInventory(options: NativePlannerOptions): Promise<void> {
  const { userHome, projects, environment, add, diagnostics } = options;
  const parseConfig = async (path: string, format: ResourceSourceFormat): Promise<Record<string, unknown> | undefined> => {
    try { return await options.parseConfig(path, format); }
    catch (error) { return ["ENOENT", "ENOTDIR"].includes(String(object(error).code)) ? {} : undefined; }
  };
  const homeFor = (variable: string, fallback: string) => {
    const supplied = environment[variable]?.trim(); const root = expand(userHome, supplied || join(userHome, fallback));
    return isAbsolute(root) ? root : undefined;
  };
  const identities = new Map<string, Awaited<ReturnType<typeof reasonixWorkspaceIdentity>>>();
  const canonicalProjects = new Map<string, string>();
  for (const project of projects) { identities.set(project, await reasonixWorkspaceIdentity(project)); canonicalProjects.set(project, await canonical(project)); }
  const constant = (nativeState: ResourceInventoryEntry["nativeState"]): NativeResourceState => ({ nativeState });
  const flag = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : ["true", "yes", "on", "1"].includes(String(value).toLowerCase()) ? true : ["false", "no", "off", "0"].includes(String(value).toLowerCase()) ? false : undefined;
  const skill = (client: "grok" | "reasonix" | "codewhale", path: string, priority: number, stateFor: NativeInventoryMetadata["stateFor"], extra: Partial<InventorySourcePlan> = {}, dependencies: string[] = []) => {
    const wrapped: NativeInventoryMetadata["stateFor"] = (name, project, frontmatter) => {
      const state = stateFor(name, project, frontmatter);
      const modelDisabled = frontmatter?.["disable-model-invocation"] !== undefined && flag(frontmatter["disable-model-invocation"]) !== false;
      const userDisabled = flag(frontmatter?.["user-invocable"]) === false;
      return { ...state, invocationMode: modelDisabled ? "user-only" : state.invocationMode,
        nativeState: modelDisabled && userDisabled ? "disabled" : state.nativeState };
    };
    return add(client, "skill", path, "skill-directory", { ...extra, native: { priority, dependencyPaths: dependencies,
      skillNameFor: (frontmatter, file, raw) => nativeSkillName(client, frontmatter, file, raw),
      ...(client === "reasonix" ? { depth: 3, acceptsSkill: (frontmatter: Record<string, unknown> | undefined, file: string) => relative(path, dirname(file)).split(sep).length < 2 || Boolean(text(frontmatter?.description)?.trim()) } : {}),
      ...extra.native, stateFor: wrapped } });
  };
  const map = async (client: "grok" | "reasonix" | "codewhale", path: string, format: ResourceSourceFormat, keyPath: string[], priority: number,
    stateFor: NativeInventoryMetadata["stateFor"], extra: Partial<InventorySourcePlan> = {}, rows?: NativeInventoryMetadata["rows"]) => {
    add(client, "mcp", path, format, { keyPath, ...extra, native: { priority, dependencyPaths: [path], stateFor, registrationWritable: extra.verified !== false && extra.origin !== "plugin", rows, ...extra.native } });
  };
  const pluginSkill = (client: "grok" | "reasonix" | "codewhale", path: string, owner: string, priority: number, dependencies: string[], state: ResourceInventoryEntry["nativeState"] = "unknown") =>
    skill(client, path, priority, () => constant(state), { origin: "plugin", owner, verified: false,
      native: { priority, namespace: owner, dependencyPaths: dependencies, stateFor: () => constant(state) } }, dependencies);
  const exists = async (path: string) => { try { return (await lstat(path)).isFile(); } catch { return false; } };
  const bundle = async (client: "grok" | "reasonix" | "codewhale", root: string, suppliedOwner?: string, state: ResourceInventoryEntry["nativeState"] = "unknown", project?: string) => {
    const markers = client === "reasonix" ? ["reasonix-plugin.json", ".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]
      : client === "grok" ? ["plugin.json", ".grok-plugin/plugin.json", ".claude-plugin/plugin.json"]
        : ["plugin.json", "kimi.plugin.json", "plugin.toml", ".claude-plugin/plugin.json"];
    let manifestPath: string | undefined; let manifest: Record<string, unknown> | undefined;
    for (const marker of markers) if (await exists(join(root, marker))) { manifestPath = join(root, marker); manifest = await parseConfig(manifestPath, marker.endsWith("toml") ? "toml" : "json"); break; }
    if (!manifestPath || !manifest) return;
    const owner = suppliedOwner ?? text(manifest.name) ?? text(object(manifest.plugin).name) ?? "native-plugin";
    const declared = manifest.skills; const paths = typeof declared === "string" ? [declared] : Array.isArray(declared) ? strings(declared) : ["skills"];
    for (const path of paths) {
      const target = resolve(root, path); if (!contained(root, target)) continue;
      const source = pluginSkill(client, target, owner, 100, [manifestPath], state); source.project = project; source.scope = project ? "project" : "user"; source.native!.containmentRoot = root;
    }
    const servers = manifest.mcpServers ?? manifest.mcp_servers;
    if (typeof servers === "string") {
      const target = resolve(root, servers); if (contained(root, target)) await map(client, target, "json", ["mcpServers"], 100, () => constant(state), { project, origin: "plugin", owner, verified: false,
        native: { priority: 100, dependencyPaths: [manifestPath], containmentRoot: root, stateFor: () => constant(state), registrationWritable: false } });
    } else if (Object.keys(object(servers)).length) {
      const key = manifest.mcpServers ? "mcpServers" : "mcp_servers";
      await map(client, manifestPath, manifestPath.endsWith("toml") ? "toml" : "json", [key], 100, () => constant(state), { project, origin: "plugin", owner, verified: false,
        native: { priority: 100, dependencyPaths: [manifestPath], containmentRoot: root, stateFor: () => constant(state), registrationWritable: false } });
    } else if (await exists(join(root, ".mcp.json"))) await map(client, join(root, ".mcp.json"), "json", ["mcpServers"], 100, () => constant(state), { project, origin: "plugin", owner, verified: false,
      native: { priority: 100, dependencyPaths: [manifestPath], containmentRoot: root, stateFor: () => constant(state), registrationWritable: false } });
  };
  const bundles = async (client: "grok" | "codewhale", path: string, project?: string) => {
    try { for (const entry of (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 128)) await bundle(client, join(path, entry.name), undefined, "unknown", project); }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes(String(object(error).code))) throw error; }
  };

  const grokHome = homeFor("GROK_HOME", ".grok");
  if (grokHome) {
    const configPath = join(grokHome, "config.toml"); const config = await parseConfig(configPath, "toml"); const skills = object(config?.skills);
    const trustedPath = join(grokHome, "trusted_folders.toml"); const trust = await parseConfig(trustedPath, "toml");
    const compat = object(config?.compat); const claude = object(compat.claude).skills !== false; const cursor = object(compat.cursor).skills === true;
    const disabled = new Set(strings(skills.disabled));
    const skillState = (name: string): NativeResourceState => ({ nativeState: config === undefined ? "unknown" : disabled.has(name) ? "disabled" : "enabled",
      controlPath: configPath, rule: { type: "name-list", format: "toml", keyPath: ["skills", "disabled"], member: name } });
    skill("grok", join(grokHome, "skills"), 500, skillState, {}, [configPath]);
    add("grok", "skill", join(grokHome, "commands"), "skill-files", { native: { priority: 490, dependencyPaths: [configPath], stateFor: skillState,
      skillNameFor: (frontmatter, path, raw) => nativeSkillName("grok", frontmatter, path, raw) } });
    for (const [index, dir] of [".agents", ...(claude ? [".claude"] : []), ...(cursor ? [".cursor"] : [])].entries()) skill("grok", join(userHome, dir, "skills"), 400 - index, skillState, { origin: "compatibility", verified: false }, [configPath]);
    for (const [index, path] of strings(skills.paths).entries()) skill("grok", expand(userHome, path), 600 - index, skillState, { origin: "manual", verified: false }, [configPath]);
    for (const path of strings(skills.server_skill_dirs)) skill("grok", expand(userHome, path), 200, () => constant("enabled"), { origin: "managed", owner: "grok-managed", verified: false }, [configPath]);
    for (const path of strings(skills.bundled_skill_dirs)) skill("grok", expand(userHome, path), 100, () => constant("enabled"), { origin: "system", verified: false }, [configPath]);
    const grokMcpState = (source: Record<string, unknown>) => (name: string): NativeResourceState => {
      const row = object(source[name]); const disabledNames = strings(config?.disabled_mcp_servers);
      return { nativeState: config === undefined ? "unknown" : row.enabled === false || row.disabled === true || disabledNames.includes(name) ? "disabled" : "enabled", controlPath: configPath,
        ...(config !== undefined ? { rule: { type: "name-list" as const, format: "toml" as const, keyPath: ["disabled_mcp_servers"], member: name } } : {}) };
    };
    await map("grok", configPath, "toml", ["mcp_servers"], 1000, grokMcpState(object(config?.mcp_servers)));
    const folders = object(trust?.folders);
    for (const project of projects) {
      const directories = [project]; let current = project; let repository = false;
      while (current !== userHome) {
        try { const marker = await lstat(join(current, ".git")); if (marker.isDirectory() || marker.isFile()) { repository = true; break; } }
        catch (error) { if (!["ENOENT", "ENOTDIR"].includes(String(object(error).code))) throw error; }
        const parent = dirname(current); if (parent === current || parent === userHome) break;
        directories.push(parent); current = parent;
      }
      const projectConfigPaths = (repository ? directories.reverse() : [project]).map(dir => join(dir, ".grok", "config.toml"));
      const projectConfigPath = join(project, ".grok", "config.toml");
      let trusted = false;
      const actual = canonicalProjects.get(project)!;
      const candidates: { path: string; trusted: boolean }[] = [];
      for (const [path, value] of Object.entries(folders)) if (isAbsolute(path)) {
        const canonicalPath = await canonical(path);
        if (contained(canonicalPath, actual)) {
          const identity = await reasonixWorkspaceIdentity(canonicalPath); if (identity.key === identities.get(project)!.key) candidates.push({ path: canonicalPath, trusted: object(value).trusted === true });
        }
      }
      candidates.sort((left, right) => right.path.length - left.path.length); if (candidates.length) trusted = candidates[0]!.trusted;
      for (const [index, dir] of [".grok", ".agents", ...(claude ? [".claude"] : []), ...(cursor ? [".cursor"] : [])].entries()) {
        skill("grok", join(project, dir, "skills"), 900 - index, skillState, { project, origin: dir === ".grok" ? "standard" : "compatibility", verified: dir === ".grok",
          native: { priority: 900 - index, dependencyPaths: [configPath, projectConfigPath, trustedPath], stateFor: skillState, eligibleFor: () => trusted } }, [configPath, trustedPath]);
      }
      // 项目注册从仓库根到 cwd 完整覆盖；个人名字停用始终写用户配置。
      for (const [index, path] of projectConfigPaths.entries()) {
        if (await canonical(path) === await canonical(configPath)) continue;
        const value = await parseConfig(path, "toml"); const priority = 1100 + index;
        await map("grok", path, "toml", ["mcp_servers"], priority, grokMcpState(object(value?.mcp_servers)),
          { project, native: { priority, dependencyPaths: [configPath, ...projectConfigPaths, trustedPath], stateFor: grokMcpState(object(value?.mcp_servers)), eligibleFor: () => trusted } });
      }
      const compatPath = join(project, ".mcp.json"); const compatConfig = await parseConfig(compatPath, "json");
      await map("grok", compatPath, "json", ["mcpServers"], 100, grokMcpState(object(compatConfig?.mcpServers)), { project, origin: "compatibility", verified: false,
        native: { priority: 100, dependencyPaths: [configPath, compatPath, trustedPath], stateFor: grokMcpState(object(compatConfig?.mcpServers)), eligibleFor: () => trusted, registrationWritable: false } });
    }
    for (const path of strings(object(config?.plugins).paths)) await bundle("grok", expand(userHome, path));
    await bundles("grok", join(grokHome, "plugins")); await bundles("grok", join(grokHome, "installed-plugins"));
    for (const project of projects) await bundles("grok", join(project, ".grok", "plugins"), project);
  }

  const reasonixHome = homeFor("REASONIX_HOME", ".reasonix");
  if (reasonixHome) {
    const configPath = join(reasonixHome, "config.toml"); const config = await parseConfig(configPath, "toml");
    const activationPath = join(reasonixHome, "capability-activation.json"); const activation = await parseConfig(activationPath, "json");
    const rows = Array.isArray(activation?.overrides) ? activation.overrides.map(object) : [];
    const declarationDigests = new Map<string, string | undefined>();
    const decide = (kind: "skill" | "mcp", name: string, project: string | undefined, source = "", declared = true): NativeResourceState => {
      const normal = kind === "skill" ? name.trim().normalize("NFC") : name.trim();
      const identity = project ? identities.get(project) : undefined;
      const matches = (scope: "global" | "project", key?: string) => rows.filter(row => row.kind === kind && row.scope === scope && (text(row.key) ?? "") === (key ?? "") && row.name === normal
        && (text(row.source) ?? "") === source && !row.owner).at(-1);
      const row = identity ? matches("project", identity.key) ?? matches("project", identity.legacyKey) ?? (source.startsWith("project_") ? undefined : matches("global")) : matches("global");
      const projectMcp = kind === "mcp" && source.startsWith("project_");
      const scope = projectMcp || row?.scope === "project" ? "project" : "global";
      const digest = project ? declarationDigests.get(JSON.stringify([project, source, name])) : undefined;
      const nativeState = activation === undefined ? "unknown" : projectMcp && row?.enabled === true ? digest === undefined ? "unknown" : row.identity === digest ? "enabled" : "disabled"
        : row ? row.enabled === true ? "enabled" : "disabled" : declared && !projectMcp ? "enabled" : "disabled";
      // 项目声明摘要还包含被命令引用文件与 dotenv；未核验其完整展开时不写入批准。
      return { nativeState, controlPath: activationPath,
        ...projectMcp && digest === undefined ? {} : { rule: { type: "activation", format: "json", keyPath: ["overrides"], identity: { kind, scope, ...(scope === "project" && identity ? { key: identity.key } : {}), ...(source ? { source } : {}), name: normal } } } };
    };
    const reasonixSkills = object(config?.skills);
    const skillState = (name: string, project?: string) => ({ ...decide("skill", name, project, "", !strings(reasonixSkills.disabled_skills).includes(name)), invocationMode: reasonixSkills.disable_implicit_invocation === true ? "user-only" as const : "auto" as const });
    for (const [index, dir] of [reasonixHome, join(userHome, ".agents"), join(userHome, ".agent"), join(userHome, ".claude")].entries()) skill("reasonix", join(dir, "skills"), 400 - index, skillState,
      { origin: index === 0 ? "standard" : "compatibility", verified: index === 0 }, [configPath, activationPath]);
    for (const [index, path] of strings(reasonixSkills.paths).entries()) skill("reasonix", expand(userHome, path), 600 - index, skillState, { origin: "manual", verified: false }, [configPath, activationPath]);
    const mcpRows = (value: Record<string, unknown> | undefined) => (Array.isArray(value?.plugins) ? value.plugins : []).map((raw, index) => ({ name: text(object(raw).name) ?? "", value: object(raw), keyPath: ["plugins", String(index)] })).filter(row => Boolean(row.name));
    const userServers = mcpRows(config);
    await map("reasonix", configPath, "toml", [], 300, (name, project) => decide("mcp", name, project, "user_config", userServers.find(row => row.name === name)?.value.auto_start !== false),
      { native: { priority: 300, dependencyPaths: [configPath, activationPath], registrationWritable: false, stateFor: (name, project) => decide("mcp", name, project, "user_config", userServers.find(row => row.name === name)?.value.auto_start !== false), rows: userServers } }, userServers);
    for (const project of projects) {
      const projectConfigPath = join(project, ".reasonix", "config.toml"); const projectConfig = await parseConfig(projectConfigPath, "toml");
      const projectSkillSettings = object(projectConfig?.skills);
      const projectSkillState = (name: string, context?: string) => ({ ...decide("skill", name, context, "", !strings(projectSkillSettings.disabled_skills ?? reasonixSkills.disabled_skills).includes(name)), invocationMode: projectSkillSettings.disable_implicit_invocation === true || reasonixSkills.disable_implicit_invocation === true ? "user-only" as const : "auto" as const });
      for (const [index, dir] of [".reasonix", ".agents", ".agent", ".claude"].entries()) skill("reasonix", join(project, dir, "skills"), 900 - index, projectSkillState,
        { project, origin: index === 0 ? "standard" : "compatibility", verified: index === 0 }, [configPath, projectConfigPath, activationPath, ...identities.get(project)!.dependencies]);
      const servers = mcpRows(projectConfig);
      for (const row of servers) declarationDigests.set(JSON.stringify([project, "project_config", row.name]), await reasonixSimpleDeclarationDigest(row.value, project));
      await map("reasonix", projectConfigPath, "toml", [], 1000, name => decide("mcp", name, project, "project_config", false), { project,
        native: { priority: 1000, dependencyPaths: [projectConfigPath, activationPath], stateFor: name => decide("mcp", name, project, "project_config", false), rows: servers, registrationWritable: false } }, servers);
      const projectMcp = join(project, ".mcp.json");
      const declaration = await parseConfig(projectMcp, "json");
      for (const [name, value] of Object.entries(object(declaration?.mcpServers))) declarationDigests.set(JSON.stringify([project, "project_mcp_json", name]), await reasonixSimpleDeclarationDigest(object(value), project));
      await map("reasonix", projectMcp, "json", ["mcpServers"], 900, name => decide("mcp", name, project, "project_mcp_json", false), { project, origin: "compatibility", verified: false,
        native: { priority: 900, dependencyPaths: [projectMcp, activationPath], stateFor: name => decide("mcp", name, project, "project_mcp_json", false), registrationWritable: false } });
    }
    // 包清单仍属于插件所有者；未完整验证加载批准链时只登记受保护来源。
    const packagePath = join(reasonixHome, "plugin-packages.json"); const packages = await parseConfig(packagePath, "json");
    for (const item of Array.isArray(packages?.plugins) ? packages.plugins : []) {
      const record = object(item); const path = text(record.root);
      if (path) await bundle("reasonix", isAbsolute(path) ? path : resolve(reasonixHome, path), text(record.name), record.enabled === false ? "disabled" : "unknown");
    }
  }

  const whaleHome = homeFor("CODEWHALE_HOME", ".codewhale");
  if (whaleHome) {
    const configPath = environment.CODEWHALE_CONFIG_PATH ? expand(userHome, environment.CODEWHALE_CONFIG_PATH) : join(whaleHome, "config.toml");
    const config = await parseConfig(configPath, "toml"); const mcpPath = text(config?.mcp_config_path) ? expand(userHome, text(config?.mcp_config_path)!) : join(whaleHome, "mcp.json");
    const mcp = await parseConfig(mcpPath, "json"); const rootKey = mcp?.servers ? "servers" : "mcpServers";
    const mcpState = (value: Record<string, unknown> | undefined, path: string, key: string) => (name: string): NativeResourceState => {
      const row = object(object(value?.[key])[name]); const field = row.disabled === true ? "disabled" : "enabled";
      return { nativeState: value === undefined ? "unknown" : row.enabled === false || row.disabled === true ? "disabled" : "enabled", controlPath: path,
        rule: { type: "boolean", format: "json", keyPath: [key, name, field], disabledValue: field === "disabled" } };
    };
    skill("codewhale", join(whaleHome, "skills"), 500, () => constant("enabled"), {}, [configPath]);
    for (const [index, dir] of [".agents", ".claude", ".deepseek"].entries()) skill("codewhale", join(userHome, dir, "skills"), 400 - index, () => constant("enabled"), { origin: "compatibility", verified: false }, [configPath]);
    if (text(config?.skills_dir)) skill("codewhale", expand(userHome, text(config?.skills_dir)!), 600, () => constant("enabled"), { origin: "manual", verified: false }, [configPath]);
    await map("codewhale", mcpPath, "json", [rootKey], 500, mcpState(mcp, mcpPath, rootKey));
    for (const project of projects) {
      let scope = config; let trusted = false;
      while (scope) {
        for (const [path, value] of Object.entries(object(scope.projects))) if (await canonical(expand(userHome, path)) === canonicalProjects.get(project)) trusted = text(object(value).trust_level)?.trim().toLowerCase() === "trusted";
        scope = Object.keys(object(scope.extras)).length ? object(scope.extras) : undefined;
      }
      for (const [index, dir] of [".codewhale", ".agents", ".claude", ".opencode", ".cursor"].entries()) skill("codewhale", join(project, dir, "skills"), 900 - index, () => constant(trusted ? "enabled" : "unknown"),
        { project, origin: index === 0 ? "standard" : "compatibility", verified: index === 0,
          native: { priority: 900 - index, dependencyPaths: [configPath], stateFor: () => constant(trusted ? "enabled" : "unknown"), eligibleFor: () => trusted } }, [configPath]);
      const projectMcpPath = join(project, ".codewhale", "mcp.json"); const projectMcp = await parseConfig(projectMcpPath, "json"); const key = projectMcp?.servers ? "servers" : "mcpServers";
      await map("codewhale", projectMcpPath, "json", [key], 1000, mcpState(projectMcp, projectMcpPath, key), { project,
        native: { priority: 1000, dependencyPaths: [configPath, projectMcpPath], stateFor: mcpState(projectMcp, projectMcpPath, key), eligibleFor: () => trusted, registrationWritable: true } });
    }
    const pluginPath = join(whaleHome, "plugins", "state.json"); const pluginState = await parseConfig(pluginPath, "json");
    await bundles("codewhale", join(whaleHome, "plugins")); for (const project of projects) await bundles("codewhale", join(project, ".codewhale", "plugins"), project);
    if (Object.keys(pluginState ?? {}).length) diagnostics.push({ sourceId: add("codewhale", "skill", pluginPath, "unsupported", { origin: "plugin", owner: "codewhale-plugin", verified: false }).id,
      client: "codewhale", kind: "skill", scope: "user", reason: "dynamic", path: pluginPath });
  }
}
