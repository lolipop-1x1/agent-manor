import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseJsonc } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import { parseDocument } from "yaml";
import { clientIds } from "../clients.js";
import type { Client } from "../clients.js";
import type { ResourceKind } from "../resource-contracts.js";
import type { ResourceInventoryBody, ResourceInventoryEntry, ResourceInventoryGap, ResourceInventoryOptions,
  ResourceInventorySnapshot, ResourceInventorySource, ResourceSourceFormat } from "../resource-inventory-contracts.js";

type ObjectValue = Record<string, unknown>;
type SourcePlan = ResourceInventorySource & { keyPath?: string[]; flat?: boolean; nativeControl?: ResourceInventoryEntry["locator"]["nativeControl"]; controlPath?: string };
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
const identity = (prefix: string, values: unknown[]): string => `${prefix}:${createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 32)}`;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const writeDisabled = { inventory: true, associate: true, disable: false, standby: false, restore: false, trash: false, purge: false };
const missing = (error: unknown): boolean => object(error)?.code === "ENOENT" || object(error)?.code === "ENOTDIR";
const contained = (root: string, path: string): boolean => { const value = relative(root, path); return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value)); };

/** 只读取已声明来源；不执行资源、连接服务，也不将注册值复制到快照。 */
export async function scanResourceInventory(options: ResourceInventoryOptions = {}): Promise<ResourceInventorySnapshot> {
  const userHome = resolve(options.userHome ?? homedir());
  const observedAt = options.observedAt ?? new Date().toISOString();
  const environment = options.environment ?? {};
  const projects = [...new Set((options.projects ?? []).filter(isAbsolute).map(path => resolve(path)))];
  const sources: SourcePlan[] = [], entries: ResourceInventoryEntry[] = [], gaps: ResourceInventoryGap[] = [];
  const sourceKeys = new Set<string>();
  const add = (client: Client, kind: ResourceKind, path: string, format: ResourceSourceFormat, extra: Partial<SourcePlan> = {}): SourcePlan => {
    const scope = extra.project ? "project" : "user";
    const parts = [client, kind, resolve(path), scope, extra.project, extra.keyPath, extra.owner];
    if (extra.origin === "manual") parts.push("manual", extra.manualSourceId);
    const id = identity("source", parts);
    const plan: SourcePlan = { id, client, kind, path: resolve(path), scope, format, origin: "standard", readState: "missing", observedAt, verified: true, ...extra };
    if (!sourceKeys.has(id)) { sourceKeys.add(id); sources.push(plan); }
    return plan;
  };
  const skills = (client: Client, path: string, extra: Partial<SourcePlan> = {}) => add(client, "skill", path, "skill-directory", extra);
  const config = (client: Client, path: string, format: "json" | "jsonc" | "toml", keyPath: string[], extra: Partial<SourcePlan> = {}) => add(client, "mcp", path, format, { keyPath, ...extra });
  const configCache = new Map<string, Promise<ObjectValue | undefined>>();
  const skillTextCache = new Map<string, Promise<string>>();
  const parseConfig = (path: string, format: ResourceSourceFormat): Promise<ObjectValue | undefined> => {
    const key = `${format}:${path}`;
    let result = configCache.get(key);
    if (!result) {
      result = (async () => {
        const stat = await lstat(path);
        if (stat.size > 16 * 1024 * 1024) throw new Error("configuration_limit");
        const text = await readFile(path, "utf8");
        if (format === "toml") return object(parseToml(text));
        if (format === "jsonc") {
          const errors: ParseError[] = [];
          const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
          if (errors.length) throw new Error("configuration_invalid");
          const result = object(value); if (!result) throw new Error("configuration_invalid"); return result;
        }
        const result = object(JSON.parse(text)); if (!result) throw new Error("configuration_invalid"); return result;
      })();
      configCache.set(key, result);
    }
    return result;
  };
  const codexHome = resolve(environment.CODEX_HOME ?? join(userHome, ".codex"));
  const codexConfig = join(codexHome, "config.toml");
  skills("codex", join(userHome, ".agents", "skills"), { nativeControl: "codex-skill", controlPath: codexConfig });
  skills("codex", join(codexHome, "skills"), { origin: "compatibility", nativeControl: "codex-skill", controlPath: codexConfig });
  config("codex", codexConfig, "toml", ["mcp_servers"], { nativeControl: "codex-mcp", controlPath: codexConfig });
  skills("claude", join(userHome, ".claude", "skills"), { nativeControl: "claude-skill", controlPath: join(userHome, ".claude", "settings.json") });
  config("claude", join(userHome, ".claude.json"), "json", ["mcpServers"]);
  const dshHome = resolve(environment.DSH_HOME ?? join(userHome, ".dsh"));
  skills("dsh", join(dshHome, "skills"), { flat: true });
  skills("dsh", join(resolve(environment.DSH_AGENTS_HOME ?? join(userHome, ".agents")), "skills"), { flat: true });
  add("dsh", "mcp", join(dshHome, "cordis.patch.yml"), "unsupported", { verified: false });
  const piHome = resolve(environment.PI_CODING_AGENT_DIR ?? join(userHome, ".pi", "agent"));
  skills("pi", join(piHome, "skills")); skills("pi", join(userHome, ".agents", "skills"));
  config("pi", join(piHome, "mcp.json"), "json", ["mcpServers"]);
  const opencodeHome = join(resolve(environment.XDG_CONFIG_HOME ?? join(userHome, ".config")), "opencode");
  skills("opencode", join(opencodeHome, "skills")); skills("opencode", join(opencodeHome, "skill"));
  skills("opencode", join(userHome, ".agents", "skills")); skills("opencode", join(userHome, ".claude", "skills"), { origin: "compatibility" });
  config("opencode", join(opencodeHome, "opencode.json"), "json", ["mcp"]);
  config("opencode", join(opencodeHome, "opencode.jsonc"), "jsonc", ["mcp"]);
  skills("codebuddy", join(userHome, ".codebuddy", "skills"));
  skills("qoder", join(userHome, ".qoder", "skills"));
  config("qoder", join(userHome, ".qoder", "settings.json"), "json", ["mcpServers"]);
  // 未核验的产品目录不自动猜测；用户可显式登记只读来源。
  for (const client of ["codeflicker", "codeflicker-desktop", "workbuddy", "zcode"] as const) {
    add(client, "skill", userHome, "unsupported", { verified: false });
    add(client, "mcp", userHome, "unsupported", { verified: false });
  }
  const exists = async (path: string): Promise<boolean> => { try { await lstat(path); return true; } catch (error) { return !missing(error); } };
  const firstConfig = async (client: Client, paths: string[], keyPath: string[], extra: Partial<SourcePlan> = {}) => {
    const path = await (async () => { for (const value of paths) if (await exists(value)) return value; return paths[0]!; })();
    config(client, path, "jsonc", keyPath, extra);
  };
  await firstConfig("codebuddy", [join(userHome, ".codebuddy", ".mcp.json"), join(userHome, ".codebuddy", "mcp.json"), join(userHome, ".codebuddy.json")], ["mcpServers"]);
  for (const project of projects) {
    try { if (!(await lstat(project)).isDirectory()) throw new Error("project_not_directory"); }
    catch { for (const client of clientIds) { const source = add(client, "skill", project, "unsupported", { project, verified: false }); gaps.push({ sourceId: source.id, client, reason: "project_missing" }); } continue; }
    skills("codex", join(project, ".agents", "skills"), { project });
    config("codex", join(project, ".codex", "config.toml"), "toml", ["mcp_servers"], { project });
    skills("claude", join(project, ".claude", "skills"), { project, nativeControl: "claude-skill", controlPath: join(project, ".claude", "settings.json") });
    config("claude", join(project, ".mcp.json"), "json", ["mcpServers"], { project, nativeControl: "claude-mcp-project", controlPath: join(userHome, ".claude.json") });
    config("claude", join(userHome, ".claude.json"), "json", ["projects", project, "mcpServers"], { project, nativeControl: "claude-mcp-project", controlPath: join(userHome, ".claude.json") });
    skills("dsh", join(project, ".dsh", "skills"), { project, flat: true }); skills("dsh", join(project, ".agents", "skills"), { project, flat: true });
    skills("pi", join(project, ".pi", "skills"), { project }); skills("pi", join(project, ".agents", "skills"), { project });
    config("pi", join(project, ".pi", "mcp.json"), "json", ["mcpServers"], { project });
    for (const path of [join(project, ".opencode", "skills"), join(project, ".opencode", "skill"), join(project, ".claude", "skills"), join(project, ".agents", "skills")]) skills("opencode", path, { project });
    config("opencode", join(project, "opencode.json"), "json", ["mcp"], { project }); config("opencode", join(project, "opencode.jsonc"), "jsonc", ["mcp"], { project });
    skills("codebuddy", join(project, ".codebuddy", "skills"), { project });
    await firstConfig("codebuddy", [join(project, ".mcp.json"), join(project, "mcp.json")], ["mcpServers"], { project });
    config("codebuddy", join(userHome, ".codebuddy.json"), "jsonc", ["projects", project, "mcpServers"], { project });
    skills("qoder", join(project, ".qoder", "skills"), { project });
    for (const path of [join(project, ".qoder", "settings.json"), join(project, ".mcp.json"), join(project, ".qoder", "settings.local.json")]) config("qoder", path, "json", ["mcpServers"], { project });
  }
  for (const manual of options.manualSources ?? []) {
    const extra = { project: manual.project, origin: "manual" as const, verified: false, keyPath: manual.keyPath, manualSourceId: manual.id };
    const format = manual.format ?? (manual.kind === "skill" ? "skill-directory" : manual.path.endsWith(".toml") ? "toml" : manual.path.endsWith(".jsonc") ? "jsonc" : "json");
    add(manual.client, manual.kind, manual.path, format, { ...extra, keyPath: manual.keyPath ?? (manual.client === "codex" ? ["mcp_servers"] : manual.client === "opencode" ? ["mcp"] : ["mcpServers"]) });
  }

  const fail = (source: SourcePlan, error: unknown) => {
    source.readState = missing(error) ? "missing" : object(error)?.code === "EACCES" || object(error)?.code === "EPERM" ? "unreadable" : "invalid";
    if (source.readState !== "missing") gaps.push({ sourceId: source.id, client: source.client, reason: source.readState });
  };
  const skillState = async (source: SourcePlan, skillFile: string, name: string): Promise<ResourceInventoryEntry["nativeState"]> => {
    if (source.owner || source.origin === "system" || !source.controlPath) return "unknown";
    try {
      const config = await parseConfig(source.controlPath, source.client === "codex" ? "toml" : "json");
      if (source.client === "claude") return object(config?.skillOverrides)?.[name] === "off" ? "disabled" : "enabled";
      const rules = object(config?.skills)?.config;
      if (!Array.isArray(rules)) return "enabled";
      const target = await realpath(skillFile);
      let state: ResourceInventoryEntry["nativeState"] = "enabled";
      for (const rule of rules) {
        const row = object(rule);
        if (!row || typeof row.enabled !== "boolean") continue;
        if (row.name === name && !row.path) state = row.enabled ? "enabled" : "disabled";
        if (typeof row.path === "string" && !row.name) {
          try { if (await realpath(row.path) === target) state = row.enabled ? "enabled" : "disabled"; } catch { /* 已失效的 selector 不匹配当前资源。 */ }
        }
      }
      return state;
    } catch (error) { return missing(error) ? "enabled" : "unknown"; }
  };
  const appendSkill = async (source: SourcePlan, path: string, skillFile: string, protectedSystem: boolean): Promise<void> => {
    let linkTarget: string | undefined, targetPath: string | undefined;
    const info = await lstat(path);
    const entryType: ResourceInventoryEntry["entryType"] = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : "file";
    if (info.isSymbolicLink()) linkTarget = await readlink(path);
    try { targetPath = await realpath(path); } catch (error) { if (!missing(error) && object(error)?.code !== "ELOOP") throw error; }
    const base = { id: identity("entry", [source.id, path]), kind: "skill" as const, client: source.client, project: source.project, scope: source.scope,
      sourceId: source.id, entryPath: path, targetPath, entryType, linkTarget, observedAt, sourceFormat: source.format,
      owner: source.owner, protected: Boolean(source.owner) || protectedSystem, protectionReason: source.owner ? "plugin" as const : protectedSystem ? "system" as const : undefined,
      locator: { type: "skill" as const, skillFile, nativeControl: source.owner || protectedSystem ? undefined : source.nativeControl, controlPath: source.controlPath }, capabilities: { ...writeDisabled } };
    if (!targetPath) {
      entries.push({ ...base, bodyId: identity("body", ["broken", source.id, path]), name: basename(path), readState: "broken", nativeState: "unknown" });
      return;
    }
    let text: string;
    try {
      const canonicalFile = await realpath(skillFile);
      let pending = skillTextCache.get(canonicalFile);
      if (!pending) {
        pending = (async () => { const file = await open(canonicalFile, "r"); try { const info = await file.stat(); if (info.size > 1024 * 1024) throw new Error("skill_limit"); return await file.readFile("utf8"); } finally { await file.close(); } })();
        skillTextCache.set(canonicalFile, pending);
      }
      text = await pending;
    }
    catch (error) {
      entries.push({ ...base, bodyId: identity("body", ["skill", targetPath]), name: basename(path), readState: "unreadable", nativeState: "unknown" });
      if (!missing(error)) gaps.push({ sourceId: source.id, client: source.client, reason: "unreadable" });
      return;
    }
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
    let metadata: ObjectValue | undefined;
    if (frontmatter) {
      const document = parseDocument(frontmatter, { uniqueKeys: true });
      if (!document.errors.length) { try { metadata = object(document.toJS({ maxAliasCount: 20 })); } catch { /* 超量 alias 不能当作可信元信息。 */ } }
      if (!metadata) gaps.push({ sourceId: source.id, client: source.client, reason: "invalid" });
    }
    const field = (key: string): string | undefined => typeof metadata?.[key] === "string" ? metadata[key] as string : undefined;
    const name = field("name") ?? basename(entryType === "file" ? path.replace(/\.md$/i, "") : path);
    const fingerprint = hash(text);
    entries.push({ ...base, bodyId: identity("body", ["skill", targetPath]), name, description: field("description"), readState: "present",
      nativeState: await skillState(source, skillFile, name), modifiedAt: info.mtime.toISOString(), contentFingerprint: fingerprint, fingerprintScope: "skill-document" });
  };
  const scanSkills = async (source: SourcePlan): Promise<void> => {
    const root = source.path;
    const rootInfo = await lstat(root);
    if (rootInfo.isFile() && source.origin === "manual") { await appendSkill(source, root, root, false); source.readState = "ok"; return; }
    const seen = new Set<string>();
    let visited = 0;
    const visit = async (path: string, depth: number, system: boolean): Promise<void> => {
      if (++visited > 10000 || depth > 16) { if (!gaps.some(gap => gap.sourceId === source.id && gap.reason === "limit")) gaps.push({ sourceId: source.id, client: source.client, reason: "limit" }); return; }
      let info;
      try { info = await lstat(path); } catch (error) { if (depth === 0) throw error; gaps.push({ sourceId: source.id, client: source.client, reason: "unreadable" }); return; }
      if (info.isSymbolicLink()) {
        try { await realpath(path); } catch (error) { if (missing(error) || object(error)?.code === "ELOOP") { await appendSkill(source, path, join(path, "SKILL.md"), system); return; } throw error; }
      }
      if (info.isFile()) { if (source.flat && depth === 1 && path.endsWith(".md")) await appendSkill(source, path, path, system); return; }
      const skillFile = join(path, "SKILL.md");
      if (await exists(skillFile)) { await appendSkill(source, path, skillFile, system); return; }
      const canonical = await realpath(path);
      if (seen.has(canonical)) return;
      seen.add(canonical);
      for (const child of await readdir(path, { withFileTypes: true })) {
        if (child.name.startsWith(".") && child.name !== ".system") continue;
        if (child.isDirectory() || child.isSymbolicLink() || (source.flat && child.isFile() && child.name.endsWith(".md"))) await visit(join(path, child.name), depth + 1, system || child.name === ".system");
      }
    };
    await visit(root, 0, source.origin === "system"); source.readState = "ok";
  };
  const scanMcp = async (source: SourcePlan): Promise<void> => {
    let config = await parseConfig(source.path, source.format);
    let keyPath = source.keyPath ?? [];
    if (source.origin === "plugin" && keyPath.length === 1 && keyPath[0] === "mcpServers" && !config?.mcpServers) keyPath = [];
    for (const key of keyPath) {
      const value: unknown = config?.[key];
      if (value !== undefined && !object(value)) throw new Error("configuration_invalid");
      config = object(value);
    }
    source.readState = "ok";
    if (!config) return;
    for (const [server, raw] of Object.entries(config)) {
      const value = object(raw); if (!value) { gaps.push({ sourceId: source.id, client: source.client, reason: "invalid" }); continue; }
      const transport = value.type === "sse" ? "sse" : typeof value.url === "string" || value.type === "http" || value.type === "remote" ? "http"
        : typeof value.command === "string" || Array.isArray(value.command) || value.type === "local" ? "stdio" : "unknown";
      const hasEnabledField = ["codex", "pi", "opencode"].includes(source.client);
      let nativeState: ResourceInventoryEntry["nativeState"] = hasEnabledField ? value.enabled === false ? "disabled" : "enabled" : "unknown";
      if (source.client === "claude" && source.project) {
        try {
          const preferences = await parseConfig(join(userHome, ".claude.json"), "json");
          const disabled = object(object(preferences?.projects)?.[source.project])?.disabledMcpServers;
          if (Array.isArray(disabled)) nativeState = disabled.includes(server) ? "disabled" : "enabled";
        } catch { /* 缺少可确认的项目选择时保留未知。 */ }
      }
      const id = identity("entry", [source.id, server]);
      entries.push({ id, kind: "mcp", name: server, server, client: source.client, project: source.project, scope: source.scope,
        sourceId: source.id, bodyId: identity("body", ["mcp", source.client, source.path, keyPath, server]), entryPath: source.path,
        entryType: "registration", readState: "present", nativeState, sourceFormat: source.format, observedAt, owner: source.owner,
        protected: Boolean(source.owner) || source.origin === "system", protectionReason: source.owner ? "plugin" : source.origin === "system" ? "system" : undefined,
        transport, locator: { type: "mcp", configPath: source.path, format: source.format === "toml" ? "toml" : source.format === "jsonc" ? "jsonc" : "json",
          keyPath: [...keyPath, server], nativeControl: source.nativeControl, controlPath: source.controlPath }, capabilities: { ...writeDisabled } });
    }
  };

  // 插件只从已知 cache 根中的 manifest 或安装登记引用盘点，不修改缓存。
  const pluginRoots = new Set<string>();
  const plugin = async (client: "codex" | "claude", root: string, owner: string, project?: string): Promise<void> => {
    let canonical: string; try { canonical = await realpath(root); } catch { return; }
    const pluginKey = `${client}:${canonical}:${project ?? ""}`;
    if (pluginRoots.has(pluginKey)) return; pluginRoots.add(pluginKey);
    const marker = [join(root, ".codex-plugin", "plugin.json"), join(root, ".claude-plugin", "plugin.json")];
    let manifest: ObjectValue | undefined;
    let manifestPath: string | undefined;
    for (const path of marker) if (await exists(path)) { manifestPath = path; try { manifest = await parseConfig(path, "json"); } catch { /* 错误 manifest 会保留为只读缺口。 */ } break; }
    const extra = { origin: "plugin" as const, owner, project };
    const skillPaths = typeof manifest?.skills === "string" ? [manifest.skills] : Array.isArray(manifest?.skills) ? manifest.skills.filter((value): value is string => typeof value === "string") : [];
    for (const path of ["skills", ...skillPaths]) {
      const resolved = resolve(root, path);
      if (contained(root, resolved)) skills(client, resolved, extra);
      else { const source = add(client, "skill", manifestPath ?? root, "unsupported", { ...extra, verified: false }); gaps.push({ sourceId: source.id, client, reason: "invalid" }); }
    }
    if (await exists(join(root, ".mcp.json"))) config(client, join(root, ".mcp.json"), "json", ["mcpServers"], extra);
    const mcp = manifest?.mcpServers;
    if (typeof mcp === "string" && !/^https?:/.test(mcp)) {
      const resolved = resolve(root, mcp); if (contained(root, resolved) && resolved.endsWith(".json")) config(client, resolved, "json", ["mcpServers"], extra);
    } else if (object(mcp) && manifestPath) add(client, "mcp", manifestPath, "json", { ...extra, keyPath: ["mcpServers"] });
    else if (mcp !== undefined && manifestPath) add(client, "mcp", manifestPath, "unsupported", { ...extra, verified: false });
  };
  for (const client of ["codex", "claude"] as const) {
    const cacheRoot = join(client === "codex" ? codexHome : join(userHome, ".claude"), "plugins", "cache");
    const cacheSource = add(client, "skill", cacheRoot, "plugin", { origin: "plugin" });
    let canonicalRoot = cacheRoot;
    try { canonicalRoot = await realpath(cacheRoot); } catch { /* 缺失根由下方 readState 表达。 */ }
    const seen = new Set<string>(); let count = 0;
    const visit = async (path: string, depth: number): Promise<void> => {
      if (++count > 5000 || depth > 6) { if (!gaps.some(gap => gap.sourceId === cacheSource.id && gap.reason === "limit")) gaps.push({ sourceId: cacheSource.id, client, reason: "limit" }); return; }
      let canonical: string; try { canonical = await realpath(path); } catch { return; }
      if (seen.has(canonical) || !contained(canonicalRoot, canonical)) return; seen.add(canonical);
      if (await exists(join(path, ".codex-plugin", "plugin.json")) || await exists(join(path, ".claude-plugin", "plugin.json"))) { await plugin(client, path, relative(cacheRoot, path)); return; }
      try { for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await visit(join(path, entry.name), depth + 1); }
      catch (error) { fail(cacheSource, error); }
    };
    if (await exists(cacheRoot)) { cacheSource.readState = "ok"; await visit(cacheRoot, 0); }
  }
  const installedSource = add("claude", "skill", join(userHome, ".claude", "plugins", "installed_plugins.json"), "plugin", { origin: "plugin" });
  try {
    const installed = await parseConfig(installedSource.path, "json");
    installedSource.readState = "ok";
    for (const [owner, records] of Object.entries(object(installed?.plugins) ?? {})) {
      for (const record of Array.isArray(records) ? records : [records]) {
        const value = object(record);
        if (typeof value?.installPath === "string" && isAbsolute(value.installPath)) await plugin("claude", value.installPath, owner, typeof value.projectPath === "string" ? value.projectPath : undefined);
      }
    }
  } catch (error) { fail(installedSource, error); }

  for (const source of sources) {
    if (source.format === "plugin") continue;
    if (source.format === "unsupported") {
      source.readState = "unsupported"; gaps.push({ sourceId: source.id, client: source.client, reason: "unsupported" }); continue;
    }
    try { if (source.kind === "skill") await scanSkills(source); else await scanMcp(source); }
    catch (error) { fail(source, error); }
  }
  // 普通入口指向已确认受管理本体时，保护不能被一个别名绕过。
  const managedBodies = new Map<string, ResourceInventoryEntry>();
  for (const entry of entries) if (entry.protected && (!managedBodies.has(entry.bodyId) || entry.protectionReason === "system")) managedBodies.set(entry.bodyId, entry);
  for (const entry of entries) {
    const managed = managedBodies.get(entry.bodyId);
    if (managed) {
      entry.protected = true; entry.protectionReason = managed.protectionReason; entry.owner ??= managed.owner;
      entry.locator.nativeControl = undefined;
    }
  }
  const bodies = new Map<string, ResourceInventoryBody>();
  for (const entry of entries) {
    let body = bodies.get(entry.bodyId);
    if (!body) { body = { id: entry.bodyId, kind: entry.kind, name: entry.name, targetPath: entry.targetPath, entryIds: [], contentFingerprint: entry.contentFingerprint, fingerprintScope: entry.fingerprintScope }; bodies.set(body.id, body); }
    body.entryIds.push(entry.id);
  }
  const publicSources = sources.map(({ keyPath: _keyPath, flat: _flat, nativeControl: _nativeControl, controlPath: _controlPath, ...source }) => source);
  return { observedAt, sources: publicSources, entries, bodies: [...bodies.values()], gaps };
}
