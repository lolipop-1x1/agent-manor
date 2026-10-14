import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { NativeResourceRule } from "../resource-inventory-contracts.js";
import type { InventorySourcePlan } from "./codeflicker-inventory.js";
import type { NativeInventoryMetadata, NativePlannerOptions, NativeResourceState } from "./native-inventory.js";

type Value = Record<string, unknown>;
type Layer = { path: string; value: Value; unknown: boolean; scope: "systemDefaults" | "user" | "project" | "system" };
type Context = { settings: Value; trusted?: boolean; unknown: boolean; layers: Layer[] };
const object = (value: unknown): Value => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const at = (value: Value, path: string[]): unknown => path.reduce<unknown>((current, key) => object(current)[key], value);
const normalized = (value: string): string => value.trim().toLowerCase();
const contains = (value: unknown, names: string[]): boolean => strings(value).some(item => names.includes(normalized(item)));
const contained = (root: string, path: string): boolean => { const value = relative(root, path); return !isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`); };
const expand = (path: string, home: string): string => resolve(path === "~" ? home : path.startsWith("~/") || path.startsWith("~\\") ? join(home, ...path.slice(2).split(/[/\\]/)) : path);

function merge(lower: Value, higher: Value): Value {
  const result = { ...lower };
  for (const [key, value] of Object.entries(higher)) {
    if (key === "admin") continue;
    if (Array.isArray(value) && Array.isArray(result[key])) result[key] = [...new Set([...result[key] as unknown[], ...value])];
    else if (Object.keys(object(value)).length && Object.keys(object(result[key])).length && key !== "mcpServers") result[key] = merge(object(result[key]), object(value));
    else result[key] = value;
  }
  return result;
}

function trust(project: string | undefined, settings: Value, rules: Value, enabledByDefault: boolean): boolean | undefined {
  if (!project) return true;
  if ((at(settings, ["security", "folderTrust", "enabled"]) ?? enabledByDefault) === false) return true;
  let longest = -1; let selected: unknown;
  for (const [path, value] of Object.entries(rules)) {
    const effective = value === "TRUST_PARENT" ? dirname(path) : path;
    if (isAbsolute(effective) && contained(effective, project) && path.length > longest) { selected = value; longest = path.length; }
  }
  return selected === "DO_NOT_TRUST" ? false : ["TRUST_FOLDER", "TRUST_PARENT"].includes(String(selected)) ? true : undefined;
}

function overridesEnabled(config: Value, name: string, project: string | undefined, fallback = true): boolean {
  let enabled = fallback; const path = `${(project ?? "/").replace(/\\/g, "/").replace(/\/$/, "")}/`;
  for (const rule of strings(object(config[name]).overrides)) {
    const disabled = rule.startsWith("!"); const raw = disabled ? rule.slice(1) : rule;
    const regex = new RegExp(`^${raw.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/(\/?)\*/g, "($1.*)?")}$`);
    if (regex.test(path)) enabled = !disabled;
  }
  return enabled;
}

function matchesName(name: string, patterns: unknown): boolean {
  return strings(patterns).some(pattern => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i").test(name));
}

function normalizedQwenServer(raw: Value): Value {
  if (raw.command || raw.httpUrl || raw.tcp) {
    const { type, ...rest } = raw;
    return type === undefined || type === "sdk" ? raw : rest;
  }
  if (typeof raw.url === "string") {
    const { type, url, ...rest } = raw;
    return { ...rest, ...(type === "sdk" ? { type } : {}), ...(type === "http" ? { httpUrl: url } : { url }) };
  }
  return raw;
}

function listRule(keyPath: string[], member: string): NativeResourceRule {
  return { format: "jsonc", type: "name-list", keyPath, member };
}

function validSettings(value: Value, client: "gemini" | "qwen"): boolean {
  const lists = [["skills", "disabled"], ["mcp", "allowed"], ["mcp", "excluded"], ...(client === "qwen" ? [["skills", "enabled"], ["skills", "defaultDisabled"], ["skills", "disabledLevels"], ["skills", "directories"]] : [])];
  return lists.every(path => { const raw = at(value, path); return raw === undefined || Array.isArray(raw) && raw.every(item => typeof item === "string"); })
    && (value.skills === undefined || value.skills !== null && typeof value.skills === "object" && !Array.isArray(value.skills))
    && (client !== "gemini" || at(value, ["skills", "enabled"]) === undefined || typeof at(value, ["skills", "enabled"]) === "boolean")
    && (at(value, ["security", "folderTrust", "enabled"]) === undefined || typeof at(value, ["security", "folderTrust", "enabled"]) === "boolean");
}

function acceptsSkill(frontmatter: Value | undefined, client: "gemini" | "qwen", path?: string, agentPlugin = false): boolean {
  if (!frontmatter) return false;
  if (client === "gemini") return typeof frontmatter.name === "string" && typeof frontmatter.description === "string";
  if (frontmatter.name === undefined || frontmatter.name === null || frontmatter.name === "" || frontmatter.description === undefined || frontmatter.description === null || frontmatter.description === "") return false;
  const name = String(frontmatter.name); const description = String(frontmatter.description);
  if (!/^[\p{L}\p{N}_:.-]+$/u.test(name)) return false;
  if (agentPlugin && (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string" || name !== basename(path ?? "")
    || name.length > 64 || name.includes("--") || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) || description.length > 1024)) return false;
  // 原生 Qwen 解析器把非空 name/description 转成字符串；原文仍保存在 Skill 文件。
  frontmatter.name = name; frontmatter.description = description;
  return true;
}

function geminiSkillName(frontmatter: Value | undefined, _path: string, text: string): string | undefined {
  if (typeof frontmatter?.name === "string" && typeof frontmatter.description === "string") return frontmatter.name.replace(/[:\\/<>*?"|]/g, "-");
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (header === undefined) return undefined;
  const lines = header.split(/\r?\n/); let name: string | undefined; let description: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const nameMatch = /^\s*name:\s*(.*)$/.exec(lines[index]!);
    if (nameMatch) { name = nameMatch[1]!.trim(); continue; }
    const descriptionMatch = /^\s*description:\s*(.*)$/.exec(lines[index]!);
    if (descriptionMatch) {
      const parts = [descriptionMatch[1]!.trim()];
      while (index + 1 < lines.length && /^[ \t]+\S/.test(lines[index + 1]!)) parts.push(lines[++index]!.trim());
      description = parts.filter(Boolean).join(" ");
    }
  }
  return name !== undefined && description !== undefined ? name.replace(/[:\\/<>*?"|]/g, "-") : undefined;
}

/** 与原生审批相同：只排除顶层来源及展示字段，嵌套配置仍参与摘要。 */
export function qwenMcpApprovalHash(value: Value): string {
  const raw = Object.fromEntries(Object.entries(value).filter(([key]) => !["scope", "extensionName", "description"].includes(key)));
  const stable = JSON.stringify(raw, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item);
  return createHash("sha256").update(stable).digest("hex");
}

/** 仅盘点磁盘配置与安装声明，不运行客户端、扩展或连接 MCP。 */
export async function planGeminiQwenInventory(options: NativePlannerOptions): Promise<void> {
  const { userHome, environment, projects, add, parseConfig, gaps, diagnostics } = options;
  const reads = new Map<string, { value: Value; unknown: boolean }>();
  const sources = new Map<string, InventorySourcePlan>();
  const sourceKey = (client: string, path: string, extra: Partial<InventorySourcePlan>) => JSON.stringify([client, path, extra.project, extra.owner, extra.keyPath ?? ["mcpServers"]]);
  const read = async (path: string, client: "gemini" | "qwen", source?: InventorySourcePlan) => {
    let result = reads.get(path);
    if (!result) {
      try { result = { value: await parseConfig(path, "jsonc") ?? {}, unknown: false }; if (source) source.readState = "ok"; }
      catch (error) {
        const code = String(object(error).code ?? ""); const missing = code === "ENOENT" || code === "ENOTDIR";
        result = { value: {}, unknown: !missing };
        if (source) {
          source.readState = missing ? "missing" : ["EACCES", "EPERM"].includes(code) ? "unreadable" : "invalid";
          if (!missing) gaps.push({ sourceId: source.id, client, reason: source.readState });
        }
      }
      reads.set(path, result);
    }
    return result;
  };
  const sourceRead = async (client: "gemini" | "qwen", path: string, extra: Partial<InventorySourcePlan> = {}) => {
    const source = add(client, "mcp", path, "jsonc", { keyPath: ["mcpServers"], metadataOnly: true, ...extra });
    sources.set(sourceKey(client, path, extra), source);
    const value = await read(path, client, source); return { source, ...value };
  };
  for (const client of ["gemini", "qwen"] as const) {
    const nativeHome = client === "gemini" ? environment.GEMINI_CLI_HOME || userHome : userHome;
    const root = client === "gemini" ? join(nativeHome, ".gemini") : environment.QWEN_HOME ? expand(environment.QWEN_HOME, userHome) : join(userHome, ".qwen");
    const prefix = client === "gemini" ? "GEMINI_CLI" : "QWEN_CODE";
    const systemPath = environment[`${prefix}_SYSTEM_SETTINGS_PATH`] || `/Library/Application Support/${client === "gemini" ? "GeminiCli" : "QwenCode"}/settings.json`;
    const defaultsPath = environment[`${prefix}_SYSTEM_DEFAULTS_PATH`] || join(dirname(systemPath), "system-defaults.json");
    const userPath = join(root, "settings.json");
    const trustPath = client === "gemini" ? join(environment.SANDBOX === "sandbox-exec" ? join(nativeHome, ".cache", ".gemini") : root, "trustedFolders.json")
      : environment.QWEN_CODE_TRUSTED_FOLDERS_PATH || join(root, "trustedFolders.json");
    const trustRead = await sourceRead(client, trustPath, { keyPath: [], metadataOnly: true });
    const layers: Layer[] = [];
    for (const [scope, path] of [["systemDefaults", defaultsPath], ["user", userPath], ["system", systemPath]] as const) {
      const loaded = await sourceRead(client, path, { origin: scope === "user" ? "standard" : "system" });
      if (!validSettings(loaded.value, client)) { loaded.unknown = true; loaded.source.readState = "invalid"; gaps.push({ sourceId: loaded.source.id, client, reason: "invalid" }); }
      layers.push({ scope, path, value: loaded.value, unknown: loaded.unknown });
    }
    const contexts = new Map<string | undefined, Context>();
    const base = layers.reduce((result, layer) => merge(result, layer.value), {} as Value);
    for (const project of [undefined, ...projects]) {
      let trusted = trust(project, base, trustRead.value, client === "gemini");
      if (client === "gemini" && (environment.GEMINI_RESTRICTED_MODE === "true" || environment.GEMINI_CLI_TRUST_WORKSPACE === "false")) trusted = project ? false : true;
      else if (client === "gemini" && environment.GEMINI_CLI_TRUST_WORKSPACE === "true") trusted = true;
      const currentLayers = layers.filter(layer => layer.scope !== "system");
      if (project) {
        const path = join(project, client === "gemini" ? ".gemini" : ".qwen", "settings.json");
        const loaded = await sourceRead(client, path, { project });
        if (!validSettings(loaded.value, client)) { loaded.unknown = true; loaded.source.readState = "invalid"; gaps.push({ sourceId: loaded.source.id, client, reason: "invalid" }); }
        if (trusted === true) currentLayers.push({ scope: "project", path, value: loaded.value, unknown: loaded.unknown });
      }
      currentLayers.push(layers.find(layer => layer.scope === "system")!);
      contexts.set(project, { settings: currentLayers.reduce((result, layer) => merge(result, layer.value), {}), trusted,
        unknown: trustRead.unknown || currentLayers.some(layer => layer.unknown), layers: currentLayers });
    }
    const dependencies = [...new Set([trustPath, ...layers.map(layer => layer.path), ...projects.map(project => join(project, client === "gemini" ? ".gemini" : ".qwen", "settings.json"))])];
    const context = (project?: string) => contexts.get(project) ?? contexts.get(undefined)!;
    const skillState = (level: string, owner?: string, extensionState?: (project?: string) => { enabled: boolean; policy?: Value; unknown?: boolean }, manifest?: Value) =>
      (name: string, project?: string, frontmatter?: Value): NativeResourceState => {
        const current = context(project); const skills = object(current.settings.skills); const names = [normalized(name), ...(owner ? [normalized(name.slice(`${owner}:`.length))] : [])];
        if (current.unknown || current.trusted === undefined && level === "project") return { nativeState: "unknown" };
        if (level === "project" && current.trusted === false || client === "gemini" && skills.enabled === false || contains(skills.disabledLevels, [level])) return { nativeState: "disabled" };
        const extension = extensionState?.(project);
        if (extension?.unknown) return { nativeState: "unknown" };
        if (extension && !extension.enabled) return { nativeState: "disabled" };
        const invocationMode = frontmatter ? frontmatter["disable-model-invocation"] === true || frontmatter["disable-model-invocation"] === "true" ? "user-only" : "auto" : undefined;
        const control = current.layers.slice().reverse().find(layer => contains(at(layer.value, ["skills", "disabled"]), names));
        if (control?.scope === "system" || control?.scope === "systemDefaults") return { nativeState: "disabled", invocationMode };
        const hardDisabled = contains(skills.disabled, names);
        const enabled = strings(skills.enabled).map(normalized);
        const defaultEntry = strings(skills.defaultDisabled).map(normalized).find(entry => names.includes(entry) && !enabled.includes(entry));
        const extensionDefault = owner ? object(manifest?.skillStates)[names[1]!] : undefined;
        const workspaceDefault = owner && project ? object(object(extension?.policy?.skillWorkspaceOverrides)[project])[names[1]!] : undefined;
        const extensionDisabled = owner && !enabled.includes(names[0]!) && (workspaceDefault === false || workspaceDefault === undefined && extensionDefault === false);
        const blockedDefault = defaultEntry ? current.layers.slice().reverse().find(layer => contains(at(layer.value, ["skills", "defaultDisabled"]), [defaultEntry])) : undefined;
        if (blockedDefault?.scope === "system" || blockedDefault?.scope === "systemDefaults" || extensionDisabled) return { nativeState: "disabled", invocationMode };
        const controlPath = control?.path ?? blockedDefault?.path ?? (level === "project" && project ? join(project, client === "gemini" ? ".gemini" : ".qwen", "settings.json") : userPath);
        return { nativeState: hardDisabled || defaultEntry ? "disabled" : "enabled", invocationMode,
          controlPath, rule: listRule(["skills", defaultEntry && !hardDisabled ? "defaultDisabled" : "disabled"], defaultEntry ?? names[0]!) };
      };
    const skill = (path: string, level: "user" | "project" | "extension", priority: number, extra: Partial<InventorySourcePlan> = {}, state = skillState(level)) => {
      const native: NativeInventoryMetadata = { priority, depth: 1, skipRootSkill: client === "qwen", scanRootAndChildren: client === "gemini", skillNameFor: client === "gemini" ? geminiSkillName : undefined,
        acceptsSkill: client === "gemini" ? undefined : frontmatter => acceptsSkill(frontmatter, client), dependencyPaths: dependencies, stateFor: state,
        eligibleFor: project => level === "project" && context(project).trusted === false || contains(at(context(project).settings, ["skills", "disabledLevels"]), [level]) ? false : undefined };
      return add(client, "skill", path, "skill-directory", { native, ...extra });
    };
    skill(join(root, "skills"), "user", 30);
    skill(join(nativeHome, ".agents", "skills"), "user", client === "gemini" ? 31 : 29, { origin: "compatibility", verified: false });
    for (const project of projects) if (client !== "qwen" || resolve(project) !== resolve(userHome)) {
      skill(join(project, client === "gemini" ? ".gemini" : ".qwen", "skills"), "project", 50, { project });
      skill(join(project, ".agents", "skills"), "project", client === "gemini" ? 51 : 49, { project, origin: "compatibility", verified: false });
    }
    if (client === "qwen") for (const path of strings(at(base, ["skills", "directories"]))) {
      if (isAbsolute(path) || path === "~" || /^~[/\\]/.test(path)) skill(expand(path, userHome), "user", 28, { origin: "manual", verified: false });
      else {
        const source = add(client, "skill", userPath, "unsupported", { origin: "manual", metadataOnly: true, readState: "unsupported" });
        gaps.push({ sourceId: source.id, client, reason: "unsupported" });
      }
    }

    const enablementPath = client === "gemini" ? join(root, "mcp-server-enablement.json") : userPath;
    const enablement = client === "gemini" ? await sourceRead(client, enablementPath, { keyPath: [], metadataOnly: true }) : undefined;
    if (enablement && Object.values(enablement.value).some(value => typeof object(value).enabled !== "boolean")) { enablement.unknown = true; gaps.push({ sourceId: enablement.source.id, client, reason: "invalid" }); }
    const approvalsPath = environment.QWEN_CODE_MCP_APPROVALS_PATH || join(root, "mcpApprovals.json");
    const approvals = client === "qwen" ? await sourceRead(client, approvalsPath, { keyPath: [], metadataOnly: true }) : undefined;
    const extensionsRoot = join(root, "extensions"); const extensionEnablementPath = join(extensionsRoot, "extension-enablement.json");
    const extensionEnablement = await sourceRead(client, extensionEnablementPath, { origin: "plugin", metadataOnly: true, keyPath: [] });
    const preferencePath = join(extensionsRoot, "extension-preferences.json");
    const preferences = client === "qwen" ? await sourceRead(client, preferencePath, { origin: "plugin", metadataOnly: true, keyPath: [] }) : undefined;
    const storePath = join(root, "extension-store", "state.json");
    const store = client === "qwen" ? await sourceRead(client, storePath, { origin: "plugin", metadataOnly: true, keyPath: [] }) : undefined;
    const mcpState = (declaredProject?: string, value?: Value, owner?: string, extensionState?: (project?: string) => { enabled: boolean; unknown?: boolean }) => (name: string, project?: string): NativeResourceState => {
      const current = context(project);
      const matches = (patterns: unknown) => client === "qwen" ? matchesName(name, patterns) : contains(patterns, [normalized(name), ...(normalized(name).startsWith("ext:") ? [normalized(name).split(":").at(-1)!] : [])]);
      if (current.unknown || enablement?.unknown || declaredProject && current.trusted === undefined || extensionState?.(project).unknown) return { nativeState: "unknown" };
      if (declaredProject && current.trusted === false || owner && extensionState?.(project).enabled === false) return { nativeState: "disabled" };
      const allowlists = current.layers.map(layer => at(layer.value, ["mcp", "allowed"])).filter(value => value !== undefined);
      if (allowlists.some(value => !matches(value))) return { nativeState: "disabled" };
      const blocked = current.layers.slice().reverse().find(layer => matches(at(layer.value, ["mcp", "excluded"])));
      if (blocked) return blocked.scope === "system" || blocked.scope === "systemDefaults" ? { nativeState: "disabled" }
        : { nativeState: "disabled", controlPath: blocked.path, rule: listRule(["mcp", "excluded"], strings(at(blocked.value, ["mcp", "excluded"])).find(pattern => matches([pattern]))!) };
      if (client === "qwen" && declaredProject && value) {
        const decision = object(object(approvals?.value[resolve(declaredProject)])[name]);
        if (approvals?.unknown) return { nativeState: "unknown" };
        if (decision.hash !== qwenMcpApprovalHash(value) || decision.status !== "approved") return { nativeState: "disabled" };
      }
      const disabled = client === "gemini" ? object(enablement?.value[normalized(name)]).enabled === false
        : owner ? strings(object(preferences?.value.disabledMcpServers)[owner]).includes(name) : false;
      const rule: NativeResourceRule = client === "gemini" ? { format: "json", type: "boolean", keyPath: [normalized(name), "enabled"], disabledValue: false }
        : owner ? { format: "json", type: "name-list", keyPath: ["disabledMcpServers", owner], member: name }
          : listRule(["mcp", "excluded"], name);
      return { nativeState: disabled ? "disabled" : "enabled", controlPath: client === "qwen" && owner ? preferencePath : enablementPath, rule };
    };
    const mcp = (path: string, value: Value, priority: number, extra: Partial<InventorySourcePlan> = {}, owner?: string, active?: (project?: string) => { enabled: boolean; unknown?: boolean }, containmentRoot?: string) => {
      const rows = Object.entries(object(value.mcpServers)).filter(([, server]) => Object.keys(object(server)).length).map(([name, server]) => ({ name,
        value: client === "qwen" && extra.origin === "compatibility" ? normalizedQwenServer(object(server)) : object(server), keyPath: ["mcpServers", name] }));
      const native: NativeInventoryMetadata = { priority, rows, containmentRoot, dependencyPaths: [...dependencies, enablementPath, ...(client === "qwen" ? [approvalsPath, preferencePath, storePath] : [])], registrationWritable: !owner && extra.origin !== "system",
        stateFor: (name, project) => mcpState(extra.project, rows.find(row => row.name === name)?.value, owner, active)(name, project),
        eligibleFor: project => extra.project && context(project).trusted === false ? false : undefined };
      const source = sources.get(sourceKey(client, path, extra)) ?? add(client, "mcp", path, "jsonc", { keyPath: ["mcpServers"], native, ...extra });
      source.native = native;
      source.metadataOnly = false;
      return source;
    };
    for (const layer of layers) mcp(layer.path, layer.value, layer.scope === "system" ? 60 : layer.scope === "user" ? 30 : 10, { origin: layer.scope === "user" ? "standard" : "system" });
    for (const project of projects) {
      const settingsPath = join(project, client === "gemini" ? ".gemini" : ".qwen", "settings.json");
      const loaded = await read(settingsPath, client);
      mcp(settingsPath, loaded.value, 50, { project });
      if (client === "qwen") {
        const path = join(project, ".mcp.json"); const loaded = await sourceRead(client, path, { project, origin: "compatibility" });
        mcp(path, loaded.value, 40, { project, origin: "compatibility" });
      }
    }
    let extensionDirs: string[] = [];
    try { extensionDirs = (await readdir(extensionsRoot, { withFileTypes: true })).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).slice(0, 500).map(entry => entry.name); }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes(String(object(error).code))) gaps.push({ sourceId: extensionEnablement.source.id, client, reason: "unreadable" }); }
    for (const directory of extensionDirs) {
      const extensionRoot = join(extensionsRoot, directory);
      try { if (!contained(await realpath(extensionsRoot), await realpath(extensionRoot))) { diagnostics.push({ sourceId: extensionEnablement.source.id, client, kind: "skill", scope: "user", reason: "invalid_reference", path: extensionRoot }); continue; } }
      catch { continue; }
      const referenceAllowed = async (path: string, kind: "skill" | "mcp") => {
        try { if (contained(await realpath(extensionRoot), await realpath(path))) return true; }
        catch (error) { if (["ENOENT", "ENOTDIR"].includes(String(object(error).code))) return true; }
        diagnostics.push({ sourceId: extensionEnablement.source.id, client, kind, scope: "user", reason: "invalid_reference", path }); return false;
      };
      let manifestPath = join(extensionRoot, client === "gemini" ? "gemini-extension.json" : "qwen-extension.json");
      if (!await referenceAllowed(manifestPath, "skill")) continue;
      let manifest = await sourceRead(client, manifestPath, { owner: directory, origin: "plugin" });
      let agentPlugin = false;
      if (client === "qwen" && !manifest.value.name && !manifest.unknown) {
        const candidatePath = join(extensionRoot, "plugin.json");
        if (!await referenceAllowed(candidatePath, "skill")) continue;
        const candidate = await sourceRead(client, candidatePath, { owner: directory, origin: "plugin" });
        if (candidate.value.$schema === "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") { manifestPath = candidatePath; manifest = candidate; agentPlugin = true; }
      }
      if (typeof manifest.value.name !== "string") {
        gaps.push({ sourceId: manifest.source.id, client, reason: manifest.unknown ? "invalid" : "unsupported" });
        diagnostics.push({ sourceId: manifest.source.id, client, kind: "skill", scope: "user", reason: "invalid_reference", path: manifestPath });
        continue;
      }
      const owner = typeof manifest.value.name === "string" ? manifest.value.name : directory;
      let policy: Value | undefined;
      if (store?.value.version === 2) policy = Object.values(object(store.value.extensions)).map(object).find(item => item.name === owner && (item.artifactDirectory ?? item.name) === directory);
      const active = (project?: string) => {
        const workspace = project ? object(policy?.workspaceOverrides)[project] : undefined;
        const baseEnabled = policy?.defaultActivation !== "disabled";
        const enabled = workspace === "enabled" ? true : workspace === "disabled" ? false : workspace === "inherit" ? baseEnabled
          : policy ? overridesEnabled({ [owner]: { overrides: policy.legacyPathRules } }, owner, project, baseEnabled) : overridesEnabled(extensionEnablement.value, owner, project);
        return { enabled, policy, unknown: extensionEnablement.unknown || store?.unknown || manifest.unknown };
      };
      skill(join(extensionRoot, "skills"), "extension", 20, { owner, origin: "plugin", native: { priority: 20, depth: 1, containmentRoot: extensionRoot, skipRootSkill: client === "qwen", scanRootAndChildren: client === "gemini", namespace: client === "qwen" ? owner : undefined,
        skillNameFor: client === "gemini" ? geminiSkillName : undefined,
        acceptsSkill: client === "gemini" ? undefined : (frontmatter, path) => acceptsSkill(frontmatter, client, path, agentPlugin),
        dependencyPaths: [...dependencies, manifestPath, extensionEnablementPath, ...(client === "qwen" ? [storePath] : [])], stateFor: skillState("extension", client === "qwen" ? owner : undefined, active, manifest.value),
        eligibleFor: project => active(project).enabled === false || contains(at(context(project).settings, ["skills", "disabledLevels"]), ["extension"]) ? false : undefined } }, skillState("extension", client === "qwen" ? owner : undefined, active, manifest.value));
      if (agentPlugin) {
        const path = join(extensionRoot, "mcp.json");
        if (!await referenceAllowed(path, "mcp")) continue;
        const loaded = await sourceRead(client, path, { owner, origin: "plugin" });
        mcp(path, loaded.value, 20, { owner, origin: "plugin" }, owner, active, extensionRoot);
      } else mcp(manifestPath, manifest.value, 20, { owner, origin: "plugin" }, owner, active, extensionRoot);
    }
    // 安装包内置资源与远端管理策略没有本地安装定位，不把空目录当作完整盘点。
    for (const owner of client === "gemini" ? ["builtin", "remote-policy"] : ["bundled"]) {
      const source = add(client, "skill", root, "unsupported", { owner, origin: owner === "remote-policy" ? "managed" : "system", metadataOnly: true, readState: "unsupported" });
      gaps.push({ sourceId: source.id, client, reason: "unsupported" });
      diagnostics.push({ sourceId: source.id, client, kind: "skill", scope: "user", reason: "dynamic", path: root });
      if (owner === "remote-policy") {
        const mcpSource = add(client, "mcp", root, "unsupported", { owner, origin: "managed", metadataOnly: true, readState: "unsupported" });
        gaps.push({ sourceId: mcpSource.id, client, reason: "unsupported" });
        diagnostics.push({ sourceId: mcpSource.id, client, kind: "mcp", scope: "user", reason: "dynamic", path: root });
      }
    }
  }
}
