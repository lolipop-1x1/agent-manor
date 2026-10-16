import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import type { ResourceInventoryDiagnostic, ResourceInventoryEntry, ResourceInventoryGap, ResourceInventorySource, ResourceSourceFormat } from "../resource-inventory-contracts.js";
import type { ResourceKind } from "../resource-contracts.js";
import type { NativeInventoryMetadata } from "./native-inventory.js";

type ObjectValue = Record<string, unknown>;
export interface CodeFlickerMetadata {
  depth?: number;
  direct?: boolean;
  namespace?: string;
  settings?: ObjectValue;
  settingsUnknown?: boolean;
  state?: ResourceInventoryEntry["nativeState"];
  containmentRoot?: string;
  required?: boolean;
  /** 资源的持久声明范围；source.project 在规划阶段表示有效查询上下文。 */
  resourceProject?: string;
  dependencyPaths: string[];
}
export type InventorySourcePlan = ResourceInventorySource & {
  keyPath?: string[]; flat?: boolean;
  /** 仅扫描明确的 Skill 层级，不引入原生同名选择规则。 */
  skillDepth?: number;
  skillContainmentRoot?: string;
  nativeControl?: ResourceInventoryEntry["locator"]["nativeControl"];
  controlPath?: string; codeflicker?: CodeFlickerMetadata; native?: NativeInventoryMetadata; metadataOnly?: boolean;
};
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
const missing = (error: unknown): boolean => object(error)?.code === "ENOENT" || object(error)?.code === "ENOTDIR";
const contained = (root: string, path: string): boolean => { const value = relative(root, path); return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value); };
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const defaultUserOnlySkills = new Set(["docs-shuttle"]);

/** 插件引用的真实目标须位于登记根内，返回核验后的读路径以避免再次跟随引用链接。 */
export async function codeflickerReferencePath(source: InventorySourcePlan): Promise<string | undefined> {
  const containmentRoot = source.native?.containmentRoot ?? source.codeflicker?.containmentRoot;
  if (!containmentRoot) return source.path;
  const [root, path] = await Promise.all([realpath(containmentRoot), realpath(source.path)]);
  return contained(root, path) ? path : undefined;
}
/** 配置数组按原生优先级累计，MCP 注册的整体替换由来源投影处理。 */
function merge(lower: ObjectValue, higher: ObjectValue): ObjectValue {
  const result = { ...lower };
  for (const [key, value] of Object.entries(higher)) {
    if (Array.isArray(value) && Array.isArray(result[key])) result[key] = [...value, ...result[key] as unknown[]];
    else if (object(value) && object(result[key]) && key !== "mcpServers") result[key] = merge(object(result[key])!, object(value)!);
    else result[key] = value;
  }
  return result;
}

export interface CodeFlickerPlannerOptions {
  userHome: string; projects: string[]; environment: Readonly<Record<string, string | undefined>>;
  add: (client: "codeflicker" | "codeflicker-desktop", kind: ResourceKind, path: string, format: ResourceSourceFormat, extra?: Partial<InventorySourcePlan>) => InventorySourcePlan;
  parseConfig: (path: string, format: ResourceSourceFormat) => Promise<ObjectValue | undefined>;
  gaps: ResourceInventoryGap[]; diagnostics: ResourceInventoryDiagnostic[];
}
/** 只构造持久来源；不调用客户端或动态插件 hook。 */
export async function planCodeFlickerInventory(options: CodeFlickerPlannerOptions): Promise<void> {
  const { userHome, projects, environment, add, parseConfig, gaps, diagnostics } = options;
  const exists = async (path: string) => { try { await lstat(path); return true; } catch (error) { return !missing(error); } };
  const fail = (source: InventorySourcePlan, error: unknown) => {
    source.readState = missing(error) ? "missing" : ["EACCES", "EPERM"].includes(String(object(error)?.code)) ? "unreadable" : "invalid";
    if (source.readState !== "missing") gaps.push({ sourceId: source.id, client: source.client, reason: source.readState });
  };
  const diagnostic = (source: InventorySourcePlan, reason: ResourceInventoryDiagnostic["reason"], path = source.path) => {
    diagnostics.push({ sourceId: source.id, client: source.client, kind: source.kind, scope: source.scope, project: source.project, reason, path });
  };
  const readSettings = async (source: InventorySourcePlan): Promise<ObjectValue> => {
    try {
      const path = await codeflickerReferencePath(source);
      if (!path) {
        source.readState = "invalid"; diagnostic(source, "invalid_reference");
        gaps.push({ sourceId: source.id, client: source.client, reason: "invalid" }); return {};
      }
      const value = await parseConfig(path, source.format);
      source.readState = "ok";
      if (value && source.kind === "mcp" && !source.owner && Array.isArray(value.skills)) return { ...value,
        skillPaths: Array.isArray(value.skillPaths) ? [...value.skillPaths, ...value.skills] : value.skills, skills: {} };
      return value ?? {};
    } catch (error) { fail(source, error); return {}; }
  };
  const cliRoot = join(userHome, ".codeflicker");
  const registry = add("codeflicker", "skill", join(cliRoot, "plugins", "installed_plugins.json"), "plugin", { origin: "plugin", metadataOnly: true, codeflicker: { dependencyPaths: [] } });
  const installed = await readSettings(registry);
  const registeredRoots = new Set<string>();
  for (const value of Object.values(object(installed.plugins) ?? {})) for (const row of Array.isArray(value) ? value : [value]) {
    const record = object(row);
    if (typeof record?.installPath === "string" && isAbsolute(record.installPath)) {
      try { registeredRoots.add(await realpath(record.installPath)); } catch { registeredRoots.add(resolve(record.installPath)); }
    }
  }
  const cache = add("codeflicker", "skill", join(cliRoot, "plugins", "cache"), "plugin", { origin: "plugin", metadataOnly: true, codeflicker: { dependencyPaths: [] } });
  let visited = 0;
  const visitCache = async (path: string, depth: number): Promise<void> => {
    if (++visited > 5000 || depth > 6) { if (!gaps.some(gap => gap.sourceId === cache.id && gap.reason === "limit")) gaps.push({ sourceId: cache.id, client: cache.client, reason: "limit" }); return; }
    const canonical = await realpath(path);
    const root = await realpath(cache.path);
    if (!contained(root, canonical)) { diagnostic(cache, "invalid_reference", path); return; }
    if (await exists(join(path, ".claude-plugin", "plugin.json"))) {
      if (!registeredRoots.has(canonical)) diagnostic(cache, "residual", path);
      return;
    }
    for (const child of await readdir(path, { withFileTypes: true })) if (child.isDirectory()) await visitCache(join(path, child.name), depth + 1);
  };
  try { await visitCache(cache.path, 0); cache.readState = "ok"; } catch (error) { fail(cache, error); }

  for (const project of [undefined, ...projects]) {
    const configPaths = [join(cliRoot, "config.json"), ...(project ? [join(project, ".codeflicker", "config.json"), join(project, ".codeflicker", "config.local.json")] : [])];
    const controlPath = configPaths.at(-1)!;
    let settings: ObjectValue = {}, unknown = false;
    let customReferences: { path: string; project?: string }[] = [];
    const contextSources: InventorySourcePlan[] = [];
    for (const path of configPaths) {
      const source = add("codeflicker", "mcp", path, "json", { project, keyPath: ["mcpServers"], nativeControl: "codeflicker-mcp", controlPath: path,
        codeflicker: { dependencyPaths: configPaths, resourceProject: path === configPaths[0] ? undefined : project } });
      const value = await readSettings(source);
      const rules = object(value.skills);
      if (["claudeImport", "remoteSkills"].some(key => value[key] !== undefined && typeof value[key] !== "boolean")
        || value.skillPaths !== undefined && (!Array.isArray(value.skillPaths) || value.skillPaths.some(item => typeof item !== "string"))
        || value.enabledPlugins !== undefined && (!object(value.enabledPlugins) || Object.values(object(value.enabledPlugins)!).some(item => typeof item !== "boolean"))
        || value.disabledMcpServers !== undefined && (!Array.isArray(value.disabledMcpServers) || value.disabledMcpServers.some(item => typeof item !== "string"))
        || value.skills !== undefined && !rules
        || rules && ["disabled", "userOnly", "enabled"].some(key => rules[key] !== undefined && (!Array.isArray(rules[key]) || (rules[key] as unknown[]).some(item => typeof item !== "string")))) {
        source.readState = "invalid"; gaps.push({ sourceId: source.id, client: source.client, reason: "invalid" });
      }
      settings = merge(settings, value);
      customReferences = [...strings(value.skillPaths).map(path => ({ path, project: source.codeflicker?.resourceProject })), ...customReferences];
      unknown ||= source.readState !== "ok" && source.readState !== "missing";
      contextSources.push(source);
    }
    const metadata: CodeFlickerMetadata = { depth: 1, settings, settingsUnknown: unknown, dependencyPaths: configPaths };
    for (const source of contextSources) { source.codeflicker!.settings = settings; source.codeflicker!.settingsUnknown = unknown; }
    const skillSource = (path: string, extra: Partial<InventorySourcePlan> = {}) => add("codeflicker", "skill", path, "skill-directory", {
      project, nativeControl: "codeflicker-skill", controlPath, codeflicker: metadata, ...extra,
    });
    if (settings.remoteSkills !== false) skillSource(join(cliRoot, "remote-personal-skills"), { origin: "managed" });
    // 内置动态元信息和动态插件 hook 不执行；缺口不冒充空的完整清单。
    const dynamic = add("codeflicker", "skill", join(cliRoot, "plugins"), "plugin", { project, origin: "plugin", metadataOnly: true, readState: "ok", codeflicker: { dependencyPaths: configPaths } });
    diagnostic(dynamic, "dynamic"); gaps.push({ sourceId: dynamic.id, client: dynamic.client, reason: "unsupported" });
    for (const [owner, rawRecords] of Object.entries(object(installed.plugins) ?? {})) for (const raw of Array.isArray(rawRecords) ? rawRecords : [rawRecords]) {
      const record = object(raw);
      if (typeof record?.installPath !== "string" || !isAbsolute(record.installPath)) { diagnostic(registry, "invalid_reference"); continue; }
      const root = resolve(record.installPath);
      if (record.scope === "project" || record.scope === "local") {
        if (!project || typeof record.projectPath !== "string" || resolve(record.projectPath) !== project) continue;
      }
      const manifestPath = join(root, ".claude-plugin", "plugin.json");
      const resourceProject = record.scope === "project" || record.scope === "local" ? project : undefined;
      const manifestSource = add("codeflicker", "skill", manifestPath, "plugin", { project, origin: "plugin", owner, metadataOnly: true, codeflicker: { dependencyPaths: configPaths, resourceProject, containmentRoot: root } });
      const manifest = await readSettings(manifestSource);
      if (manifestSource.readState !== "ok") { if (manifestSource.readState === "missing") gaps.push({ sourceId: manifestSource.id, client: manifestSource.client, reason: "missing" }); continue; }
      const enabled = object(settings.enabledPlugins)?.[owner];
      const pluginState: ResourceInventoryEntry["nativeState"] = unknown ? "unknown" : enabled === true ? "enabled" : "disabled";
      const namespace = typeof manifest.name === "string" ? manifest.name : typeof record.name === "string" ? record.name : owner.split("@")[0]!;
      const pluginMetadata = { ...metadata, namespace, state: pluginState, containmentRoot: root, resourceProject };
      const reference = async (path: string, kind: ResourceKind, format: ResourceSourceFormat, keyPath?: string[], direct = false) => {
        const resolved = resolve(root, path);
        if (!contained(root, resolved)) { diagnostic(manifestSource, "invalid_reference", resolved); gaps.push({ sourceId: manifestSource.id, client: manifestSource.client, reason: "invalid" }); return; }
        if (kind === "skill" && direct) {
          try { direct = (await lstat(resolved)).isFile() || await exists(join(resolved, "SKILL.md")); }
          catch { /* 缺失或不可读的显式来源由扫描阶段记录，不能生成虚构 Skill。 */ }
        }
        add("codeflicker", kind, resolved, format, { project, origin: "plugin", owner, keyPath, codeflicker: { ...pluginMetadata, direct } });
      };
      await reference("skills", "skill", "skill-directory");
      for (const path of typeof manifest.skills === "string" ? [manifest.skills] : strings(manifest.skills)) await reference(path, "skill", "skill-directory", undefined, true);
      if (object(manifest.mcpServers)) add("codeflicker", "mcp", manifestPath, "json", { project, origin: "plugin", owner, keyPath: ["mcpServers"], codeflicker: pluginMetadata });
      else if (typeof manifest.mcpServers === "string") {
        if (/^https?:/.test(manifest.mcpServers)) diagnostic(manifestSource, "dynamic");
        else await reference(manifest.mcpServers, "mcp", "json", ["mcpServers"]);
      }
      if (await exists(join(root, ".mcp.json"))) await reference(".mcp.json", "mcp", "json", ["mcpServers"]);
    }
    for (const reference of customReferences) {
      const value = reference.path;
      if (!isAbsolute(value) && !project) { diagnostic(contextSources[0]!, "invalid_reference", value); gaps.push({ sourceId: contextSources[0]!.id, client: "codeflicker", reason: "unsupported" }); continue; }
      skillSource(isAbsolute(value) ? value : resolve(project!, value), { codeflicker: { ...metadata, direct: true, resourceProject: reference.project ?? (isAbsolute(value) ? undefined : project) } });
    }
    if (settings.claudeImport !== false) {
      skillSource(join(userHome, ".claude", "skills"), { origin: "compatibility" });
      skillSource(join(userHome, ".agents", "skills"), { origin: "compatibility" });
    }
    skillSource(join(cliRoot, "skills"));
    if (project) {
      if (settings.claudeImport !== false) {
        skillSource(join(project, ".claude", "skills"), { origin: "compatibility", codeflicker: { ...metadata, resourceProject: project } });
        skillSource(join(project, ".agents", "skills"), { origin: "compatibility", codeflicker: { ...metadata, resourceProject: project } });
      }
      skillSource(join(project, ".codeflicker", "skills"), { codeflicker: { ...metadata, resourceProject: project } });
    }
    if (settings.remoteSkills !== false) skillSource(join(cliRoot, "remote-skills"), { origin: "managed" });
  }

  const desktopRoot = resolve(environment.MYFLICKER_HOME ?? join(userHome, ".myflicker"));
  const desktopSettings = add("codeflicker-desktop", "skill", join(desktopRoot, "agent-settings.yaml"), "yaml", { metadataOnly: true });
  let custom: string[] = [];
  try {
    const stat = await lstat(desktopSettings.path);
    if (stat.size > 1024 * 1024) throw new Error("settings_limit");
    const document = parseDocument(await readFile(desktopSettings.path, "utf8"), { uniqueKeys: true });
    if (document.errors.length) throw new Error("settings_invalid");
    const value = object(document.toJS({ maxAliasCount: 20 }));
    const dirs = object(value?.userCustomSkillDirs)?.value;
    if (dirs !== undefined && (!Array.isArray(dirs) || dirs.some(item => typeof item !== "string"))) throw new Error("settings_invalid");
    custom = strings(dirs); desktopSettings.readState = "ok";
  } catch (error) { fail(desktopSettings, error); }
  const desktopSkill = (path: string, extra: Partial<InventorySourcePlan> = {}) => add("codeflicker-desktop", "skill", path, "skill-directory", {
    nativeControl: "codeflicker-desktop-skill", codeflicker: { dependencyPaths: [desktopSettings.path] }, ...extra,
  });
  desktopSkill(join(desktopRoot, "internal", "skills"), { origin: "system" });
  for (const path of [join(desktopRoot, "skills"), join(userHome, ".agents", "skills"), join(desktopRoot, "user-skills")]) desktopSkill(path);
  for (const path of custom) {
    if (!isAbsolute(path)) { diagnostic(desktopSettings, "invalid_reference", path); gaps.push({ sourceId: desktopSettings.id, client: desktopSettings.client, reason: "unsupported" }); }
      else desktopSkill(path, { codeflicker: { dependencyPaths: [desktopSettings.path], required: true } });
  }
  for (const project of projects) for (const path of [join(project, ".myflicker", "skills"), join(project, ".agents", "skills"), join(project, ".myflicker", "user-skills")]) desktopSkill(path, { project });
  desktopSkill(join(desktopRoot, "remote-personal-skills"), { origin: "managed" });
  add("codeflicker-desktop", "mcp", join(desktopRoot, "config", "mcp.json"), "json", { keyPath: ["mcpServers"], codeflicker: { dependencyPaths: [] } });
}

export function codeflickerSkillState(source: InventorySourcePlan, name: string): { nativeState: ResourceInventoryEntry["nativeState"]; invocationMode: "auto" | "user-only" } {
  const metadata = source.codeflicker!;
  if (metadata.settingsUnknown || metadata.state === "unknown") return { nativeState: "unknown", invocationMode: "auto" };
  if (metadata.state === "disabled") return { nativeState: "disabled", invocationMode: "auto" };
  const rules = object(metadata.settings?.skills);
  if (strings(rules?.disabled).includes(name)) return { nativeState: "disabled", invocationMode: "auto" };
  if (strings(rules?.userOnly).includes(name)) return { nativeState: "enabled", invocationMode: "user-only" };
  if (strings(rules?.enabled).includes(name)) return { nativeState: "enabled", invocationMode: "auto" };
  if (defaultUserOnlySkills.has(name)) return { nativeState: "enabled", invocationMode: "user-only" };
  return { nativeState: "enabled", invocationMode: "auto" };
}

/** CLI 的名称 Map 按来源顺序覆盖；桌面精确目录不采用此规则。 */
export function projectCodeFlickerEntries(entries: ResourceInventoryEntry[], sources: InventorySourcePlan[], diagnostics: ResourceInventoryDiagnostic[]): ResourceInventoryEntry[] {
  const order = new Map(sources.map((source, index) => [source.id, index]));
  const sourceById = new Map(sources.map(source => [source.id, source]));
  const groups = new Map<string, ResourceInventoryEntry[]>();
  for (const entry of entries) if (entry.client === "codeflicker" && sourceById.get(entry.sourceId)?.codeflicker && !(entry.owner && entry.nativeState === "disabled")) {
    const key = JSON.stringify([entry.kind, entry.project, entry.name]);
    const group = groups.get(key) ?? []; group.push(entry); groups.set(key, group);
  }
  const omitted = new Set<string>();
  for (const group of groups.values()) {
    group.sort((a, b) => order.get(a.sourceId)! - order.get(b.sourceId)!);
    const winner = group.at(-1)!;
    const pluginConflict = group.some(entry => entry.owner) && (group.some(entry => !entry.owner) && winner.kind === "mcp" || new Set(group.filter(entry => entry.owner).map(entry => entry.owner)).size > 1);
    const conflicts = pluginConflict ? group : group.filter(entry => entry.sourceId === winner.sourceId);
    if (conflicts.length > 1) {
      for (const entry of conflicts) {
        entry.nativeState = "unknown"; entry.locator.nativeControl = undefined;
        diagnostics.push({ sourceId: entry.sourceId, client: entry.client, kind: entry.kind, scope: entry.scope, project: entry.project, reason: "conflict", path: entry.entryPath, name: entry.name, entryId: entry.id });
      }
    }
    for (const entry of group.slice(0, -1)) {
      if (conflicts.includes(entry)) continue;
      omitted.add(entry.id);
      diagnostics.push({ sourceId: entry.sourceId, client: entry.client, kind: entry.kind, scope: entry.scope, project: entry.project,
        reason: "shadowed", path: entry.entryPath, name: entry.name, entryId: entry.id, selectedEntryId: winner.id, selectedPath: winner.entryPath });
    }
  }
  return entries.filter(entry => !omitted.has(entry.id));
}

/** 有效上下文保留在选择列表；实际用户入口不因已知项目数量而复制。 */
export function compactCodeFlickerInventory(selected: ResourceInventoryEntry[], original: ResourceInventoryEntry[], sources: InventorySourcePlan[],
  identity: (prefix: string, values: unknown[]) => string): { entries: ResourceInventoryEntry[]; sources: InventorySourcePlan[]; sourceIds: Map<string, string>; entryIds: Map<string, string> } {
  const sourceIds = new Map<string, string>();
  const compactSources = new Map<string, InventorySourcePlan>();
  for (const source of sources) {
    if (source.client !== "codeflicker" || !source.codeflicker) { sourceIds.set(source.id, source.id); compactSources.set(source.id, source); continue; }
    const project = source.codeflicker.resourceProject;
    const scope = project ? "project" : "user";
    const id = identity("source", [source.client, source.kind, source.path, scope, project, source.keyPath, source.owner,
      source.origin, source.codeflicker.direct, source.codeflicker.namespace, source.codeflicker.depth]);
    sourceIds.set(source.id, id);
    const prior = compactSources.get(id);
    const dependencyPaths = [...new Set([...(prior?.codeflicker?.dependencyPaths ?? []), ...source.codeflicker.dependencyPaths])];
    const prefer = !prior || source.project === project;
    if (prefer) compactSources.set(id, { ...source, id, project, scope, codeflicker: { ...source.codeflicker, dependencyPaths } });
    else prior.codeflicker!.dependencyPaths = dependencyPaths;
  }
  const bySource = new Map(sources.map(source => [source.id, source]));
  const entryIds = new Map<string, string>();
  const defaults = new Map<string, ResourceInventoryEntry>();
  const canonicalId = (entry: ResourceInventoryEntry): string => {
    if (entry.client !== "codeflicker" || !bySource.get(entry.sourceId)?.codeflicker) return entry.id;
    return identity("entry", [sourceIds.get(entry.sourceId), entry.kind === "mcp" ? entry.server : entry.entryPath]);
  };
  for (const entry of original) {
    const id = canonicalId(entry); entryIds.set(entry.id, id);
    const source = bySource.get(entry.sourceId);
    if (source?.codeflicker && entry.project === source.codeflicker.resourceProject) defaults.set(id, entry);
  }
  const entries = new Map<string, ResourceInventoryEntry>();
  for (const entry of selected) {
    const source = bySource.get(entry.sourceId);
    if (entry.client !== "codeflicker" || !source?.codeflicker) { entries.set(entry.id, entry); continue; }
    const id = entryIds.get(entry.id)!;
    const context = { scope: entry.scope, project: entry.project, nativeState: entry.nativeState, invocationMode: entry.invocationMode, controlPath: entry.locator.controlPath };
    const prior = entries.get(id);
    if (prior) {
      if (!prior.selectionScopes!.some(value => value.scope === context.scope && value.project === context.project)) prior.selectionScopes!.push(context);
      continue;
    }
    const defaultEntry = defaults.get(id);
    const sourceId = sourceIds.get(entry.sourceId)!;
    const actualSource = compactSources.get(sourceId)!;
    const actualProject = source.codeflicker.resourceProject;
    const base = defaultEntry ?? entry;
    entries.set(id, { ...base, id, sourceId, scope: actualProject ? "project" : "user", project: actualProject,
      nativeState: defaultEntry?.nativeState ?? "unknown", invocationMode: defaultEntry?.invocationMode,
      locator: { ...base.locator, controlPath: base.kind === "skill" && !actualProject ? source.codeflicker.dependencyPaths[0] : base.locator.controlPath,
        dependencyPaths: actualSource.codeflicker?.dependencyPaths }, selectionScopes: [context] });
  }
  return { entries: [...entries.values()], sources: [...compactSources.values()], sourceIds, entryIds };
}
