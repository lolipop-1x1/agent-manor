import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { object, string } from "../history/extraction.js";
import type { InventorySourcePlan } from "./codeflicker-inventory.js";
import type { NativePlannerOptions, NativeResourceState } from "./native-inventory.js";

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes(String(object(error).code));
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { return !missing(error); } }
function setting(config: Record<string, unknown>, key: string): unknown {
  if (key in config) return config[key];
  return key.split(".").reduce<unknown>((value, part) => object(value)[part], config);
}
function merge(lower: Record<string, unknown>, higher: Record<string, unknown>): Record<string, unknown> {
  const result = { ...lower };
  for (const [key, value] of Object.entries(higher)) result[key] = value && typeof value === "object" && !Array.isArray(value)
    ? merge(object(result[key]), object(value)) : value;
  return result;
}
function expand(path: string, home: string, cwd: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : isAbsolute(path) ? path : resolve(cwd, path);
}
async function repoRoot(project: string): Promise<string> {
  let current = project;
  while (dirname(current) !== current) { if (await exists(join(current, ".git"))) return current; current = dirname(current); }
  return project;
}
async function ancestors(project: string, home: string): Promise<string[]> {
  const root = await repoRoot(project); const result: string[] = []; let current = project;
  while (current !== home && result.length < 32) { result.push(current); if (current === root || dirname(current) === current) break; current = dirname(current); }
  return result;
}
async function containedPath(root: string, value: string): Promise<string | undefined> {
  try {
    const [canonicalRoot, path] = await Promise.all([realpath(root), realpath(value)]); const difference = relative(canonicalRoot, path);
    return difference === "" || difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference) ? path : undefined;
  } catch { return undefined; }
}

/** 仅盘点原生持久来源；运行时参数和内嵌 builtin 没有可管理文件入口。 */
export async function planKimiOmpInventory(options: NativePlannerOptions): Promise<void> {
  const { userHome, projects, environment, add, parseConfig, gaps, diagnostics } = options;
  const parsed = async (path: string, format: "json" | "jsonc" | "toml" | "yaml", source?: InventorySourcePlan): Promise<Record<string, unknown>> => {
    try { const config = await parseConfig(path, format); if (source) source.readState = "ok"; return config ?? {}; }
    catch (error) {
      if (source) { source.readState = missing(error) ? "missing" : ["EACCES", "EPERM"].includes(String(object(error).code)) ? "unreadable" : "invalid";
        if (source.readState !== "missing") gaps.push({ sourceId: source.id, client: source.client, reason: source.readState }); }
      return {};
    }
  };
  const metadata = (client: "kimi" | "omp", path: string, format: "json" | "toml" | "yaml", project?: string, origin: InventorySourcePlan["origin"] = "standard") =>
    add(client, "skill", path, format, { metadataOnly: true, project, origin });
  const kimiHome = environment.KIMI_CODE_HOME ?? join(userHome, ".kimi-code");
  const kimiConfigPath = join(kimiHome, "config.toml"); const kimiConfigSource = metadata("kimi", kimiConfigPath, "toml");
  const kimiConfig = await parsed(kimiConfigPath, "toml", kimiConfigSource);
  const kimiSkillState = (_name: string, _project?: string, frontmatter?: Record<string, unknown>): NativeResourceState => ({ nativeState: kimiConfigSource.readState === "invalid" || kimiConfigSource.readState === "unreadable" ? "unknown" : "enabled",
    invocationMode: frontmatter?.["disable-model-invocation"] === true ? "user-only" : "auto" });
  const kimiSkillPlans: InventorySourcePlan[] = [];
  const kimiAcceptsSkill = (metadata: Record<string, unknown> | undefined) => !!string(metadata?.name)?.trim() && !!string(metadata?.description)?.trim()
    && (metadata?.type === undefined || ["prompt", "inline", "flow"].includes(string(metadata.type) ?? ""));
  const kimiSkill = (path: string, priority: number, project?: string, extra: Partial<InventorySourcePlan> = {}) => {
    const source = add("kimi", "skill", path, "skill-directory", {
      project, ...extra, native: { priority, depth: 1, skipRootSkill: true, acceptsSkill: kimiAcceptsSkill, dependencyPaths: [kimiConfigPath, ...(project ? [join(project, ".kimi-code", "local.toml")] : [])], stateFor: kimiSkillState, ...extra.native },
    });
    kimiSkillPlans.push(source); return source;
  };
  kimiSkill(join(kimiHome, "skills"), 20);
  kimiSkill(join(userHome, ".agents", "skills"), 19, undefined, { origin: "compatibility" });
  const kimiMcp = async (path: string, priority: number, project?: string, extra: Partial<InventorySourcePlan> = {}) => {
    const source = add("kimi", "mcp", path, "json", { project, keyPath: ["mcpServers"], ...extra }); const config = await parsed(path, "json", source);
    source.native = { priority, dependencyPaths: [path], registrationWritable: !source.owner,
      stateFor: name => ({ nativeState: object(object(config.mcpServers)[name]).enabled === false ? "disabled" : "enabled",
        ...(!source.owner ? { controlPath: path, rule: { format: "json" as const, type: "boolean" as const, keyPath: ["mcpServers", name, "enabled"], disabledValue: false } } : {}) }), ...extra.native };
    return source;
  };
  await kimiMcp(join(kimiHome, "mcp.json"), 20);
  for (const project of projects) {
    const root = await repoRoot(project); const localPath = join(root, ".kimi-code", "local.toml"); const localSource = metadata("kimi", localPath, "toml", project);
    const config = merge(kimiConfig, await parsed(localPath, "toml", localSource));
    kimiSkill(join(root, ".kimi-code", "skills"), 30, project);
    kimiSkill(join(root, ".agents", "skills"), 29, project, { origin: "compatibility" });
    for (const [index, path] of strings(config.extraSkillDirs).entries()) kimiSkill(expand(path, userHome, root), 10 - index / 100, project);
    await kimiMcp(join(root, ".mcp.json"), 30, project);
    await kimiMcp(join(project, ".kimi-code", "mcp.json"), 40, project);
  }
  if (!projects.length) for (const [index, path] of strings(kimiConfig.extraSkillDirs).entries()) kimiSkill(expand(path, userHome, userHome), 10 - index / 100);
  const installedPath = join(kimiHome, "plugins", "installed.json"); const installedSource = metadata("kimi", installedPath, "json", undefined, "plugin");
  const installed = await parsed(installedPath, "json", installedSource);
  for (const value of Array.isArray(installed.plugins) ? installed.plugins : []) {
    const record = object(value); const root = string(record.root); const owner = string(record.id); if (!root || !owner) continue;
    const manifestPath = await exists(join(root, "kimi.plugin.json")) ? join(root, "kimi.plugin.json") : join(root, ".kimi-plugin", "plugin.json");
    const manifestSource = metadata("kimi", manifestPath, "json", undefined, "plugin"); manifestSource.owner = owner;
    const manifest = await parsed(manifestPath, "json", manifestSource);
    const roots = manifest.skills === undefined && await exists(join(root, "SKILL.md")) ? ["."] : typeof manifest.skills === "string" ? [manifest.skills] : strings(manifest.skills);
    for (const path of roots) {
      const resolved = path === "." || path.startsWith("./") ? await containedPath(root, resolve(root, path)) : undefined;
      if (!resolved) { diagnostics.push({ sourceId: manifestSource.id, client: "kimi", kind: "skill", scope: "user", reason: "invalid_reference", path: resolve(root, path) }); continue; }
      kimiSkill(resolved, 5, undefined, { origin: "plugin", owner, native: { priority: 5, direct: path === ".", dependencyPaths: [installedPath, manifestPath],
        containmentRoot: root, stateFor: () => ({ nativeState: record.enabled === false ? "disabled" : "enabled" }) } });
    }
    let servers = object(manifest.mcpServers); let mcpPath = manifestPath;
    if (typeof manifest.mcpServers === "string") {
      const target = await containedPath(root, resolve(root, manifest.mcpServers)); if (target) { mcpPath = target; servers = object((await parsed(target, "json")).mcpServers); }
    }
    if (Object.keys(servers).length) {
      const source = add("kimi", "mcp", mcpPath, "json", { origin: "plugin", owner, keyPath: ["mcpServers"] });
      source.native = { priority: 5, dependencyPaths: [installedPath, manifestPath, mcpPath], registrationWritable: false, containmentRoot: root,
        rows: Object.entries(servers).map(([name, config]) => ({ name: `plugin-${owner}:${name}`, value: object(config), keyPath: ["mcpServers", name] })),
        stateFor: name => ({ nativeState: record.enabled === false || object(object(object(record.capabilities).mcpServers)[name.replace(`plugin-${owner}:`, "")]).enabled === false ? "disabled" : "enabled" }) };
    }
  }

  for (const source of kimiSkillPlans) {
    if (source.native?.direct) continue;
    const visited = new Set<string>(); let total = 0;
    const walk = async (path: string, depth: number, parentName?: string): Promise<void> => {
      if (depth > 8 || ++total > 10000) return;
      let canonical: string; try { canonical = await realpath(path); } catch { return; }
      if (visited.has(canonical)) return; visited.add(canonical);
      let entries; try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.name === "node_modules" || entry.name.startsWith(".") || !entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const child = join(path, entry.name); const document = join(child, "SKILL.md"); const hasSkill = await exists(document);
        let metadata: Record<string, unknown> = {}; let name = entry.name;
        if (hasSkill) {
          try { const text = await readFile(document, "utf8"); const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
            if (frontmatter) { const parsed = parseDocument(frontmatter, { uniqueKeys: true }); if (!parsed.errors.length) metadata = object(parsed.toJS({ maxAliasCount: 20 })); }
          } catch { return; }
          if (!kimiAcceptsSkill(metadata)) continue;
          name = string(metadata.name) ?? name;
          const registered = parentName && name !== parentName && !name.startsWith(`${parentName}.`) ? `${parentName}.${name}` : name;
          if (depth > 0 || parentName) add("kimi", "skill", child, "skill-directory", { project: source.project, origin: source.origin, owner: source.owner,
            native: { ...source.native!, direct: true, nameFor: () => registered } });
          const nested = object(metadata.metadata);
          if (metadata["has-sub-skill"] === true || metadata.hasSubSkill === true || nested["has-sub-skill"] === true || nested.hasSubSkill === true) await walk(child, depth + 1, registered);
        } else await walk(child, depth + 1, parentName);
      }
    };
    await walk(source.path, 0);
  }

  // skills/config 属于 agent dir，XDG 仅将会话与数据库等 data 入口摊平。
  const selectedProfile = (environment.OMP_PROFILE !== undefined ? environment.OMP_PROFILE : environment.PI_PROFILE)?.trim();
  const profile = selectedProfile && selectedProfile !== "default" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(selectedProfile) && !selectedProfile.endsWith(".")
    && !/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(selectedProfile) ? selectedProfile : undefined;
  const ompRoot = join(userHome, environment.PI_CONFIG_DIR || ".omp");
  const profileRoot = profile ? join(ompRoot, "profiles", profile) : ompRoot;
  const defaultAgent = join(profileRoot, "agent");
  const ompAgent = !profile && environment.PI_CODING_AGENT_DIR ? resolve(environment.PI_CODING_AGENT_DIR) : defaultAgent;
  const xdgData = ["linux", "darwin"].includes(process.platform) && ompAgent === defaultAgent && environment.XDG_DATA_HOME
    ? join(environment.XDG_DATA_HOME, "omp", ...(profile ? ["profiles", profile] : [])) : undefined;
  const ompPluginsRoot = join(xdgData && await exists(xdgData) ? xdgData : profileRoot, "plugins");
  const projectPluginRoots = new Map<string, string>();
  for (const project of projects) {
    let current = project; let anchor: string | undefined;
    while (current !== userHome) {
      if (await exists(join(current, environment.PI_CONFIG_DIR || ".omp"))) { anchor = current; break; }
      if (dirname(current) === current) break; current = dirname(current);
    }
    if (!anchor) { const root = await repoRoot(project); if (await exists(join(root, ".git"))) anchor = root; }
    if (anchor) projectPluginRoots.set(project, join(anchor, environment.PI_CONFIG_DIR || ".omp", "plugins"));
  }
  const ompConfigPath = await exists(join(ompAgent, "config.yml")) || !await exists(join(ompAgent, "config.yaml")) ? join(ompAgent, "config.yml") : join(ompAgent, "config.yaml");
  const ompConfigSource = metadata("omp", ompConfigPath, "yaml"); let ompConfig = await parsed(ompConfigPath, "yaml", ompConfigSource);
  const ompLegacyConfigPath = join(ompAgent, "settings.json"); const ompLegacyConfigSource = metadata("omp", ompLegacyConfigPath, "json");
  if (ompConfigSource.readState === "missing") ompConfig = await parsed(ompLegacyConfigPath, "json", ompLegacyConfigSource);
  const ompUserMcpPath = join(ompAgent, "mcp.json"); const ompUserMcpSource = add("omp", "mcp", ompUserMcpPath, "json", { keyPath: ["mcpServers"] });
  const ompMcpConfig = await parsed(ompUserMcpPath, "json", ompUserMcpSource);
  const globalControl = ompConfigSource.readState === "missing" && ompLegacyConfigSource.readState === "ok" ? ompLegacyConfigPath : ompConfigPath;
  const projectSettings = new Map<string, { config: Record<string, unknown>; paths: string[]; control: string }>();
  for (const project of projects) {
    const legacyPath = join(project, ".omp", "settings.json"); const legacySource = metadata("omp", legacyPath, "json", project); const legacy = await parsed(legacyPath, "json", legacySource);
    const path = join(project, ".omp", "config.yml"); const source = metadata("omp", path, "yaml", project); const native = await parsed(path, "yaml", source);
    projectSettings.set(project, { config: merge(merge(ompConfig, legacy), native), paths: [legacyPath, path], control: setting(native, "disabledExtensions") !== undefined ? path
      : setting(legacy, "disabledExtensions") !== undefined ? legacyPath : globalControl });
  }
  const effective = (project?: string) => project && projectSettings.has(project) ? projectSettings.get(project)!.config : ompConfig;
  const optedIn = (provider: string, project?: string) => {
    const config = effective(project); const providers = strings(config.enabledProviders);
    return providers.includes(provider) || providers.includes("*") || providers.includes("all")
      || provider === "claude" && !!environment.CLAUDE_CONFIG_DIR?.trim()
      || provider === "claude-plugins" && providers.includes("claude");
  };
  const foreignProviders = new Set(["claude", "claude-plugins", "codex", "opencode", "gemini", "cursor", "windsurf", "github"]);
  const providerEnabled = (provider: string, project?: string, foreignUser = false) => !strings(effective(project).disabledProviders).includes(provider)
    && (!foreignUser || optedIn(provider, project));
  const wildcard = (pattern: string, name: string) => matchesGlob(name, pattern);
  const skillProviderEligible = (provider: string, sourceProject?: string, context?: string, foreignUser = false) => {
    const config = effective(context ?? sourceProject); const scope = sourceProject ? "Project" : "User";
    const toggle = provider === "native" ? `skills.enablePi${scope}` : provider === "agents" ? `skills.enableAgents${scope}`
      : provider === "claude" ? `skills.enableClaude${scope}` : provider === "codex" && !sourceProject ? "skills.enableCodexUser" : undefined;
    return setting(config, "skills.enabled") !== false && !strings(config.disabledProviders).includes(provider)
      && (!toggle || setting(config, toggle) !== false)
      && (!foreignUser || optedIn(provider, context ?? sourceProject) || ["claude", "codex"].includes(provider) && setting(config, toggle ?? "") === true);
  };
  const skillState = (provider: string, project?: string, foreignUser = false) => (name: string, context?: string, frontmatter?: Record<string, unknown>): NativeResourceState => {
    const selectedProject = context ?? project; const config = effective(selectedProject); const rawName = string(frontmatter?.name) ?? name;
    if (ompConfigSource.readState === "invalid" || ompConfigSource.readState === "unreadable") return { nativeState: "unknown" };
    const disabled = strings(config.disabledExtensions); const included = strings(setting(config, "skills.includeSkills")); const ignored = strings(setting(config, "skills.ignoredSkills"));
    const scope = project ? "Project" : "User"; const sourceToggle = provider === "native" ? `skills.enablePi${scope}` : provider === "agents" ? `skills.enableAgents${scope}` : provider === "claude" ? `skills.enableClaude${scope}` : provider === "codex" && !project ? "skills.enableCodexUser" : undefined;
    const allowForeign = foreignUser && (["claude", "codex"].includes(provider) && setting(config, sourceToggle ?? "") === true || optedIn(provider, selectedProject));
    const hardDisabled = setting(config, "skills.enabled") === false || strings(config.disabledProviders).includes(provider)
      || sourceToggle && setting(config, sourceToggle) === false || foreignUser && !allowForeign;
    const excluded = disabled.includes(`skill:${name}`) || disabled.includes(`skill:${rawName}`) || ignored.some(pattern => wildcard(pattern, rawName))
      || included.length > 0 && !included.some(pattern => wildcard(pattern, name));
    const control = selectedProject ? projectSettings.get(selectedProject)?.control ?? globalControl : globalControl;
    return { nativeState: hardDisabled || excluded ? "disabled" : "enabled", invocationMode: frontmatter?.hide === true || frontmatter?.["disable-model-invocation"] === true ? "user-only" : "auto",
      ...(!hardDisabled ? { controlPath: control, rule: { format: control.endsWith(".json") ? "json" as const : "yaml" as const, type: "name-list" as const, keyPath: ["disabledExtensions"], member: `skill:${name}` } } : {}) };
  };
  const ompSkill = (path: string, provider: string, priority: number, project?: string, extra: Partial<InventorySourcePlan> = {}) => {
    const pathRoot = basename(path) === "skills" ? basename(dirname(path)) : basename(path);
    const rawNamespace = pathRoot.startsWith(".") ? provider : pathRoot;
    const collisionNamespace = rawNamespace.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || provider;
    return add("omp", "skill", path, "skill-directory", {
      project, origin: provider === "native" || provider === "custom" ? "standard" : "compatibility", verified: !foreignProviders.has(provider), ...extra,
      native: { priority, depth: 1, skipRootSkill: true, collisionPolicy: "omp-skill", collisionNamespace,
        acceptsSkill: metadata => metadata?.enabled !== false && !/[\\/]/.test(string(metadata?.name) ?? "")
          && (!["native", "omp-managed", "custom", "github", "omp-plugins"].includes(provider) || !!metadata?.description),
        dependencyPaths: [ompConfigPath, ...(project ? projectSettings.get(project)?.paths ?? [] : [])],
        eligibleFor: context => skillProviderEligible(provider, project, context, !project && foreignProviders.has(provider)),
        stateFor: skillState(provider, project, !project && foreignProviders.has(provider)), ...extra.native },
    });
  };
  ompSkill(join(ompAgent, "skills"), "native", 10000);
  ompSkill(join(ompAgent, "managed-skills"), "omp-managed", 500, undefined, { origin: "managed" });
  const compatibilitySkills = [
    { provider: "claude", priority: 80, user: environment.CLAUDE_CONFIG_DIR ? environment.CLAUDE_CONFIG_DIR : join(userHome, ".claude"), project: ".claude" },
    { provider: "codex", priority: 70, user: join(userHome, ".codex"), project: ".codex" },
    { provider: "opencode", priority: 55, user: join(userHome, ".config", "opencode"), project: ".opencode" },
  ];
  for (const provider of compatibilitySkills) ompSkill(join(provider.user, "skills"), provider.provider, provider.priority * 100 + (provider.provider === "claude" ? 0 : 50));
  for (const [index, dir] of [".agents", ".agent"].entries()) ompSkill(join(userHome, dir, "skills"), "agents", 7000 - index);
  for (const project of projects) {
    const dirs = await ancestors(project, userHome);
    for (const [index, dir] of dirs.entries()) {
      ompSkill(join(dir, ".omp", "skills"), "native", 10050 - index, project);
      for (const [order, generic] of [".agents", ".agent"].entries()) ompSkill(join(dir, generic, "skills"), "agents", 7050 - index - order / 10, project);
      ompSkill(join(dir, ".claude", "skills"), "claude", 8050 - index, project);
    }
    for (const provider of compatibilitySkills.filter(value => value.provider !== "claude")) ompSkill(join(project, provider.project, "skills"), provider.provider, provider.priority * 100, project);
    ompSkill(join(project, ".github", "skills"), "github", 3000, project);
  }
  for (const project of [undefined, ...projects]) {
    const config = effective(project);
    for (const [index, path] of strings(setting(config, "skills.customDirectories")).entries()) ompSkill(expand(path, userHome, project ?? userHome), "custom", 20000 - index, project);
  }
  const configureOmpMcp = (source: InventorySourcePlan, config: Record<string, unknown>, provider: string, priority: number, writable: boolean) => {
    source.native = { priority, dependencyPaths: [source.path, ompUserMcpPath, ompConfigPath], registrationWritable: writable,
      eligibleFor: project => providerEnabled(provider, project, source.scope === "user" && foreignProviders.has(provider)),
      stateFor: (name, project) => {
        const declared = source.keyPath?.reduce<unknown>((value, key) => object(value)[key], config);
        const server = object(object(declared ?? config.mcpServers ?? config.mcp_servers ?? config.mcp ?? config.servers ?? config)[name]);
        const denied = strings(ompMcpConfig.disabledServers).includes(name); const forced = strings(ompMcpConfig.enabledServers).includes(name);
        const disabled = !providerEnabled(provider, project, source.scope === "user" && foreignProviders.has(provider)) || denied || !forced && (server.enabled === false || server.disabled === true || server.active === false);
        return { nativeState: disabled ? "disabled" : "enabled", controlPath: writable ? source.path : ompUserMcpPath,
          rule: writable ? { format: "json", type: "boolean", keyPath: ["mcpServers", name, "enabled"], disabledValue: false }
            : { format: "json", type: "name-list", keyPath: ["disabledServers"], member: name } };
      } };
  };
  configureOmpMcp(ompUserMcpSource, ompMcpConfig, "native", 10000, true);
  const ompMcp = async (path: string, provider: string, priority: number, project?: string, keyPath = ["mcpServers"], format: "json" | "jsonc" | "toml" = "json", extra: Partial<InventorySourcePlan> = {}) => {
    const writable = provider === "native" || provider === "mcp-json";
    const source = add("omp", "mcp", path, format, { project, keyPath, origin: writable ? "standard" : "compatibility", verified: writable, ...extra });
    const config = await parsed(path, format, source); configureOmpMcp(source, config, provider, priority, writable); return source;
  };
  await ompMcp(join(ompAgent, ".mcp.json"), "native", 9999);
  const foreignMcp = [
    { provider: "gemini", priority: 60, user: join(userHome, ".gemini", "settings.json"), project: ".gemini/settings.json" },
    { provider: "cursor", priority: 50, user: join(userHome, ".cursor", "mcp.json"), project: ".cursor/mcp.json" },
    { provider: "windsurf", priority: 50, user: join(userHome, ".codeium", "windsurf", "mcp_config.json"), project: ".windsurf/mcp_config.json" },
  ];
  const claudeUserPaths = [environment.CLAUDE_CONFIG_DIR?.trim() ? join(resolve(environment.CLAUDE_CONFIG_DIR), ".claude.json") : join(userHome, ".claude.json"), join(compatibilitySkills[0]!.user, "mcp.json")];
  const firstClaudeMcp = async (paths: string[], project?: string) => {
    let selected = false;
    for (const [index, path] of paths.entries()) {
      const source = await ompMcp(path, "claude", 8000 + (project ? 50 : 0) - index, project);
      const config = await parsed(path, "json"); const rows = Object.entries(object(config.mcpServers)).map(([name, value]) => ({ name, value: object(value), keyPath: ["mcpServers", name] }));
      source.native!.rows = selected ? [] : rows; selected ||= rows.length > 0;
    }
  };
  await firstClaudeMcp(claudeUserPaths);
  for (const provider of foreignMcp) await ompMcp(provider.user, provider.provider, provider.priority * 100);
  await ompMcp(join(join(userHome, ".codex"), "config.toml"), "codex", 7000, undefined, ["mcp_servers"], "toml");
  const openCodeSources: { source: InventorySourcePlan; config: Record<string, unknown> }[] = [];
  const openCodeMcp = async (path: string, priority: number, project?: string) => {
    const source = await ompMcp(path, "opencode", priority, project, ["mcp"], "jsonc");
    openCodeSources.push({ source, config: await parsed(path, "jsonc") });
  };
  await openCodeMcp(join(userHome, ".config", "opencode", "opencode.json"), 5500);
  await openCodeMcp(join(userHome, ".config", "opencode", "opencode.jsonc"), 5501);
  for (const project of projects) {
    await ompMcp(join(project, ".omp", "mcp.json"), "native", 10050, project); await ompMcp(join(project, ".omp", ".mcp.json"), "native", 10049, project);
    await ompMcp(join(project, "mcp.json"), "mcp-json", 550, project); await ompMcp(join(project, ".mcp.json"), "mcp-json", 549, project);
    for (const provider of foreignMcp) await ompMcp(join(project, provider.project), provider.provider, provider.priority * 100 + 50, project);
    await firstClaudeMcp([join(project, ".claude", ".mcp.json"), join(project, ".claude", "mcp.json")], project);
    await ompMcp(join(project, ".codex", "config.toml"), "codex", 7050, project, ["mcp_servers"], "toml");
    await openCodeMcp(join(project, "opencode.json"), 5549, project);
    await openCodeMcp(join(project, "opencode.jsonc"), 5549.5, project);
    await openCodeMcp(join(project, ".opencode", "opencode.json"), 5550, project);
    await openCodeMcp(join(project, ".opencode", "opencode.jsonc"), 5551, project);
    await ompMcp(join(project, ".vscode", "mcp.json"), "vscode", 2050, project, ["mcp", "servers"]);
  }
  // OpenCode 每个服务器逐层深合并；归属仍是最后声明该服务器的原生文件。
  for (const project of [undefined, ...projects]) {
    const layers = openCodeSources.filter(({ source }) => source.project === project || project && !source.project && optedIn("opencode", project));
    const merged = new Map<string, Record<string, unknown>>(); const owners = new Map<string, InventorySourcePlan>();
    for (const { source, config } of layers) for (const [name, value] of Object.entries(object(config.mcp))) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      merged.set(name, merge(merged.get(name) ?? {}, object(value))); owners.set(name, source);
    }
    for (const { source } of layers.filter(({ source }) => source.project === project)) {
      const rows = [...merged].filter(([name]) => owners.get(name) === source).map(([name, value]) => ({ name, value, keyPath: ["mcp", name] }));
      configureOmpMcp(source, { mcp: Object.fromEntries(rows.map(row => [row.name, row.value])) }, "opencode", source.native!.priority, false);
      source.native!.rows = rows; source.native!.dependencyPaths = [...new Set([...source.native!.dependencyPaths, ...layers.map(layer => layer.source.path)])];
    }
  }
  // 持久插件包与注册锁的来源保持保护；没有执行扩展代码来枚举动态 hook。
  const pluginRoots = new Set<string>();
  const ompPlugin = async (root: string, owner: string, provider: string, project: string | undefined, dependencies: string[], enabled = true, enabledFor?: (context?: string) => boolean) => {
    const key = JSON.stringify([root, owner, project]); if (pluginRoots.has(key)) return; pluginRoots.add(key);
    const portablePath = await containedPath(root, join(root, "plugin.json")); const portable = portablePath ? await parsed(portablePath, "json") : {};
    const schema = string(portable.$schema); const standard = schema?.startsWith("https://agent-plugins.org/schemas/");
    const portableName = string(portable.name) ?? "";
    const validPortable = schema === "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" && portableName.length > 0 && portableName.length <= 64
      && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(portableName) && !portableName.includes("--") && !portableName.includes("..")
      && ["version", "description", "homepage", "repository", "license"].every(field => portable[field] === undefined || typeof portable[field] === "string")
      && (portable.keywords === undefined || Array.isArray(portable.keywords) && portable.keywords.every(value => typeof value === "string"))
      && (portable.author === undefined || Object.entries(object(portable.author)).every(([key, value]) => ["name", "email", "url"].includes(key) && typeof value === "string"));
    if (standard && !validPortable) {
      const source = add("omp", "skill", portablePath!, "unsupported", { origin: "plugin", owner, project }); source.readState = "unsupported";
      gaps.push({ sourceId: source.id, client: "omp", reason: "unsupported" }); return;
    }
    let manifestPath: string | undefined; let manifest: Record<string, unknown> = {};
    const marketplace = provider === "claude-plugins" || provider === "omp-marketplace";
    if (!standard && marketplace) for (const directory of [".omp-plugin", ".claude-plugin"]) {
      const path = await containedPath(root, join(root, directory, "plugin.json"));
      if (path) { manifestPath = path; manifest = await parsed(path, "json"); break; }
    }
    const priority = (standard ? 7500 : marketplace ? 7000 : 9000) + (project ? 50 : 0);
    const actualProvider = standard ? "agent-plugins" : marketplace ? "claude-plugins" : provider;
    const collisionNamespace = (standard ? string(portable.name) : owner.split("@")[0]) ?? basename(root);
    const dependencyPaths = [...dependencies, ...(portablePath ? [portablePath] : []), ...(manifestPath ? [manifestPath] : [])];
    const skillManifestPath = marketplace ? await containedPath(root, join(root, ".claude-plugin", "plugin.json")) : undefined;
    const skillManifest = skillManifestPath ? await parsed(skillManifestPath, "json") : {};
    const skillPaths = standard ? ["skills"] : ["skills", ...(typeof skillManifest.skills === "string" ? [skillManifest.skills] : strings(skillManifest.skills))];
    for (const path of [...new Set(skillPaths)]) {
      const skills = await containedPath(root, resolve(root, path)); if (!skills) continue;
      const direct = await exists(join(skills, "SKILL.md"));
      ompSkill(skills, actualProvider, priority, project, { origin: "plugin", owner, native: { priority, collisionNamespace, dependencyPaths, containmentRoot: root,
        direct: marketplace && direct, eligibleFor: context => enabled && (!enabledFor || enabledFor(context)) && providerEnabled(provider, context, !project && provider === "claude-plugins")
          && providerEnabled(actualProvider, context),
        stateFor: skillState(actualProvider, project),
        ...(standard ? { acceptsSkill: (metadata, skillPath) => {
          const name = string(metadata?.name)?.trim().normalize("NFKC"); const description = string(metadata?.description); const fields = ["name", "description", "license", "allowed-tools", "metadata", "compatibility"];
          return !!name && Array.from(name).length <= 64 && name === name.toLowerCase() && !name.startsWith("-") && !name.endsWith("-") && !name.includes("--") && /^[\p{L}\p{N}-]+$/u.test(name)
            && name === basename(skillPath).normalize("NFKC") && !!description?.trim() && description.length <= 1024 && Object.keys(metadata ?? {}).every(field => fields.includes(field))
            && ["license", "allowed-tools"].every(field => metadata?.[field] === undefined || typeof metadata[field] === "string")
            && (metadata?.compatibility === undefined || typeof metadata.compatibility === "string" && metadata.compatibility.length <= 500)
            && (metadata?.metadata === undefined || Object.values(object(metadata.metadata)).every(value => typeof value === "string"));
        } } : {}) } });
    }
    const mcpDeclaration = manifest.mcpServers;
    if (!standard && mcpDeclaration && typeof mcpDeclaration === "object" && !Array.isArray(mcpDeclaration) && manifestPath) {
      const source = await ompMcp(manifestPath, actualProvider, priority, project, ["mcpServers"], "json", { origin: "plugin", owner });
      source.native!.dependencyPaths = dependencyPaths; source.native!.registrationWritable = false;
      source.native!.containmentRoot = root;
      source.native!.eligibleFor = context => enabled && (!enabledFor || enabledFor(context)) && providerEnabled(provider, context, !project && provider === "claude-plugins")
        && providerEnabled(actualProvider, context);
    } else {
      const filenames = standard ? ["mcp.json"] : typeof mcpDeclaration === "string" ? [mcpDeclaration] : [".mcp.json", "mcp.json"];
      for (const filename of filenames) {
        const mcpPath = await containedPath(root, resolve(root, filename)); if (!mcpPath) continue;
        const source = await ompMcp(mcpPath, actualProvider, priority, project, ["mcpServers"], "json", { origin: "plugin", owner });
        source.native!.dependencyPaths = [...dependencyPaths, mcpPath]; source.native!.registrationWritable = false;
        source.native!.containmentRoot = root;
        const config = await parsed(mcpPath, "json");
        source.native!.eligibleFor = context => enabled && (!enabledFor || enabledFor(context)) && providerEnabled(provider, context, !project && provider === "claude-plugins")
          && providerEnabled(actualProvider, context)
          && (!standard || config.$schema === "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" && Object.keys(config).every(field => ["$schema", "mcpServers"].includes(field)));
        if (standard) {
          source.native!.rows = [];
          for (const [name, value] of Object.entries(object(config.mcpServers))) {
            const server = object(value); const type = string(server.type); let valid = false;
            if (type === "stdio") {
              const command = string(server.command); const env = object(server.env); const cwd = string(server.cwd);
              valid = !!command && Object.keys(server).every(field => ["type", "command", "args", "env", "cwd"].includes(field))
                && (server.args === undefined || Array.isArray(server.args) && server.args.every(item => typeof item === "string"))
                && (server.env === undefined || Object.entries(env).every(([key, item]) => typeof item === "string" && !["PLUGIN_ROOT", "PLUGIN_DATA"].includes(key)));
              if (command?.startsWith("./")) valid &&= await containedPath(root, resolve(root, command)) !== undefined;
              else if (command && /[\s/\\]/.test(command)) valid = false;
              if (cwd) {
                const rooted = cwd === "${PLUGIN_ROOT}" || cwd.startsWith("${PLUGIN_ROOT}/"); const data = cwd === "${PLUGIN_DATA}" || cwd.startsWith("${PLUGIN_DATA}/");
                if (!rooted && !data && !cwd.startsWith("./")) valid = false;
                if (cwd.split(/[\\/]/).includes("..")) valid = false;
              }
            } else if (type === "streamable-http" || type === "sse") {
              const url = string(server.url); const seenHeaders = new Set<string>();
              valid = Object.keys(server).every(field => ["type", "url", "headers"].includes(field))
                && (server.headers === undefined || Object.entries(object(server.headers)).every(([key, item]) => {
                  const normalized = key.toLowerCase(); const duplicate = seenHeaders.has(normalized); seenHeaders.add(normalized);
                  return !duplicate && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) && typeof item === "string" && !/[\0\r\n]/.test(item);
                }));
              try {
                const parsedUrl = new URL(url ?? ""); valid &&= ["http:", "https:"].includes(parsedUrl.protocol) && !parsedUrl.username && !parsedUrl.password && !parsedUrl.hash
                  && (parsedUrl.protocol === "https:" || ["localhost", "[::1]", "::1"].includes(parsedUrl.hostname) || /^127\./.test(parsedUrl.hostname));
              } catch { valid = false; }
            }
            if (valid) source.native!.rows.push({ name, value: server, keyPath: ["mcpServers", name] });
          }
        }
      }
    }
  };
  const pluginRegistryPaths = [{ path: join(ompPluginsRoot, "installed_plugins.json"), project: undefined, provider: "omp-marketplace" },
    { path: join(compatibilitySkills[0]!.user, "plugins", "installed_plugins.json"), project: undefined, provider: "claude-plugins" },
    ...[...projectPluginRoots].map(([project, root]) => ({ path: join(root, "installed_plugins.json"), project, provider: "omp-marketplace" }))];
  for (const { path, project, provider } of pluginRegistryPaths) {
    const source = metadata("omp", path, "json", project, "plugin"); const registry = await parsed(path, "json", source);
    for (const [owner, values] of Object.entries(object(registry.plugins))) for (const value of Array.isArray(values) ? values : []) {
      const plugin = object(value); const root = string(plugin.installPath); if (!root) continue;
      await ompPlugin(root, owner, provider, project, [path], plugin.enabled !== false);
    }
  }
  const npmPackages: { root: string; name: string; project?: string; paths: string[]; enabled: boolean }[] = [];
  const npmProjectNames = new Map<string, Set<string>>(); const npmProjectDisabled = new Map<string, string[]>();
  for (const project of [undefined, ...projects]) {
    const root = project ? projectPluginRoots.get(project) : ompPluginsRoot; if (!root) continue;
    const packagePath = join(root, "package.json"); const packageSource = metadata("omp", packagePath, "json", project, "plugin");
    const packageConfig = await parsed(packagePath, "json", packageSource); const lockPath = join(root, "omp-plugins.lock.json"); const lockSource = metadata("omp", lockPath, "json", project, "plugin");
    const lock = await parsed(lockPath, "json", lockSource);
    const overridePath = project ? join(project, ".omp", "plugin-overrides.json") : undefined; const overrides = overridePath ? await parsed(overridePath, "json") : {};
    if (project) npmProjectDisabled.set(project, strings(overrides.disabled));
    const names = new Set([...Object.keys(object(packageConfig.dependencies)), ...Object.keys(object(lock.plugins))]);
    for (const name of names) {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || name.includes("..")) continue;
      const packageRoot = join(root, "node_modules", name); const path = join(packageRoot, "package.json");
      if (packageSource.readState === "ok" && !Object.hasOwn(object(packageConfig.dependencies), name)) {
        try { if (!(await lstat(packageRoot)).isSymbolicLink()) continue; } catch { continue; }
      }
      const installedPackage = await parsed(path, "json"); if (!installedPackage.omp && !installedPackage.pi) continue;
      const runtime = object(object(lock.plugins)[name]); const enabled = (!Object.hasOwn(object(lock.plugins), name) || runtime.enabled === true) && !strings(overrides.disabled).includes(name);
      if (project && enabled) { const names = npmProjectNames.get(project) ?? new Set<string>(); names.add(name); npmProjectNames.set(project, names); }
      npmPackages.push({ root: packageRoot, name, project, paths: [packagePath, lockPath, path, ...(overridePath ? [overridePath] : [])], enabled });
    }
  }
  for (const plugin of npmPackages) await ompPlugin(plugin.root, plugin.name, "omp-plugins", plugin.project, plugin.paths, plugin.enabled,
    context => !context || !npmProjectDisabled.get(context)?.includes(plugin.name) && (plugin.project !== undefined || !npmProjectNames.get(context)?.has(plugin.name)));
  for (const project of [undefined, ...projects]) {
    const config = effective(project);
    for (const path of strings(config.extensions)) {
      const root = expand(path, userHome, project ?? userHome); if (!await exists(root)) continue;
      await ompPlugin(root, basename(root), "omp-plugins", project, [ompConfigPath, ...(project ? projectSettings.get(project)?.paths ?? [] : [])]);
    }
    const lockPaths = project ? (await ancestors(project, userHome)).map(dir => join(dir, ".omp", "skills.lock.json")) : [join(ompAgent, "skills.lock.json")];
    for (const [lockIndex, lockPath] of lockPaths.entries()) {
      const lockSource = metadata("omp", lockPath, "json", project, "managed"); const lock = await parsed(lockPath, "json", lockSource);
      if (lockSource.readState === "missing") continue;
      if (lock.version !== 1) { gaps.push({ sourceId: lockSource.id, client: "omp", reason: "unsupported" }); continue; }
      for (const [id, value] of Object.entries(object(lock.skills))) {
        const match = /^@([a-z0-9][a-z0-9_]{2,31})\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(id); const entry = object(value); const version = string(entry.version); const integrity = string(entry.integrity);
        if (!match || !version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) || version.includes("..") || !integrity || typeof entry.resolved !== "string") continue;
        const store = join(dirname(ompAgent), "skillshare", `@${match[1]}`, match[2]!, version); const marker = join(store, ".skillshare-integrity");
        let actual: string | undefined; try { actual = (await readFile(marker, "utf8")).trim(); } catch { /* 尚未解包完成的包不能作为已加载资源。 */ }
        if (actual !== integrity) continue;
        const priority = 9500 + (project ? 50 - lockIndex : 0);
        ompSkill(store, "skillshare", priority, project, { origin: "managed", owner: id, native: { priority, direct: true, dependencyPaths: [lockPath, marker],
          containmentRoot: store, collisionNamespace: match[2], skillNameFor: metadata => string(metadata?.name)?.trim() || match[2], stateFor: skillState("skillshare", project) } });
      }
    }
  }
}
