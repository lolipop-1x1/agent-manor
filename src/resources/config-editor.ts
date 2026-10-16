import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { applyEdits, modify, parse as parseJson } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import { isAlias, isMap, parseDocument, visit } from "yaml";
import type { NativeResourceRule, ResourceInventoryEntry } from "../resource-inventory-contracts.js";
import type { ResourceConfigurationPreview } from "../resource-management-contracts.js";
import { ServiceError } from "../service/input.js";

/** 此契约只保存在受限管理库与恢复材料中，不投影到 API。 */
export interface ConfigChange {
  path: string;
  format: "json" | "jsonc" | "toml" | "yaml";
  keyPath: string[];
  type: "json-key" | "json-skill" | "skill-marker" | "toml-mcp" | "toml-skill" | "native-rule";
  beforeText: string;
  afterText: string;
  before: string;
  after: string;
  enabledBefore?: boolean;
  hadEnabled?: boolean;
  removedText?: string;
  skillPath?: string;
  skillName?: string;
  fileExistedBefore?: boolean;
  hadDisabled?: boolean;
  hadSkills?: boolean;
  nativeRule?: NativeResourceRule;
  hadKey?: boolean;
  existingParents?: string[][];
}
const readonly = (): never => { throw new ServiceError("FORBIDDEN", "当前配置写法未完成保留编辑适配，只读", { key: "diagnostics.resources.configEditor.m001" }); };

/** 从受限变更材料中投影控制字段，注册内容只表达存在性。 */
export function configurationPreview(change: ConfigChange, restore = false): ResourceConfigurationPreview {
  let before: ResourceConfigurationPreview["before"] = "missing", after: ResourceConfigurationPreview["after"] = "present";
  let kind: ResourceConfigurationPreview["kind"] = "boolean";
  let keyPath = change.keyPath;
  let selector: ResourceConfigurationPreview["selector"];
  const parse = (value: string): unknown => value === "missing" ? undefined : JSON.parse(value);
  const boolean = (value: unknown): boolean | "missing" => typeof value === "boolean" ? value : "missing";
  if (change.after === "missing") { kind = "registration"; before = "present"; after = "missing"; }
  else if (change.type === "skill-marker") { kind = "marker"; }
  else if (change.type === "toml-mcp") {
    before = change.hadEnabled ? change.enabledBefore! : "missing"; after = false; keyPath = [...keyPath, "enabled"];
  } else if (change.type === "toml-skill" || change.nativeRule?.type === "activation") {
    const oldRules = parse(change.before) as { enabled?: boolean }[], newRules = parse(change.after) as { enabled?: boolean }[];
    before = boolean(oldRules.at(-1)?.enabled); after = boolean(newRules.at(-1)?.enabled);
    keyPath = [...keyPath, "[]", "enabled"];
    selector = change.skillPath ? { key: "path", value: change.skillPath } : { key: "name", value: change.nativeRule!.identity!.name };
  } else if (change.type === "json-skill" || change.nativeRule?.type === "name-list") {
    kind = "membership";
    const count = (value: string) => change.type === "json-skill" ? (parse(value) as { disabled: number }).disabled : Number(parse(value));
    before = count(change.before) > 0; after = count(change.after) > 0;
    selector = { key: "name", value: change.skillName ?? change.nativeRule!.member! };
  } else { before = boolean(parse(change.before)); after = boolean(parse(change.after)); }
  return { path: change.path, keyPath, kind, selector, before: restore ? after : before, after: restore ? before : after };
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const get = (value: unknown, keys: readonly string[]): unknown => keys.reduce((current: unknown, key) => Object.hasOwn(object(current), key) ? object(current)[key] : undefined, value);
const stable = (value: unknown): string => value === undefined ? "missing" : JSON.stringify(value, (_key, item: unknown) => {
  if (typeof item === "bigint") return { integer: item.toString() };
  if (item && typeof item === "object" && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
  return item;
});

function json(text: string, format: "json" | "jsonc"): unknown {
  const errors: ParseError[] = [];
  const value = parseJson(text, errors, { allowTrailingComma: format === "jsonc", disallowComments: format === "json" });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) return readonly();
  return value;
}
function editJson(text: string, keys: string[], value: unknown, format: "json" | "jsonc"): string {
  const edited = applyEdits(text, modify(text, keys, value, {}));
  json(edited, format); return edited;
}
function toml(text: string): Record<string, unknown> {
  try { return parseToml(text, { integersAsBigInt: "asNeeded", unsafeKeyBehaviour: "throw" }) as Record<string, unknown>; }
  catch { return readonly(); }
}
function yaml(text: string) {
  const document = parseDocument(text || "{}", { uniqueKeys: true });
  if (document.errors.length || !isMap(document.contents)) return readonly();
  visit(document, (_key, node) => { if (isAlias(node)) return readonly(); });
  return document;
}
function nativeValue(text: string, format: ConfigChange["format"]): unknown {
  return format === "yaml" ? yaml(text).toJS({ maxAliasCount: 0 }) : format === "toml" ? toml(text) : json(text || "{}", format);
}
function activationMatches(row: Record<string, unknown>, rule: NativeResourceRule): boolean {
  const identity = rule.identity;
  return !!identity && ["kind", "scope", "key", "source", "owner", "name"].every(key => (row[key] ?? "") === (object(identity)[key] ?? ""));
}

/** 配置中须有当前资源的明确依据，兼容目录和默认启用不构成控制入口。 */
export function hasExplicitResourceControl(text: string, entry: ResourceInventoryEntry, cache = new Map<string, unknown>()): boolean {
  if (!text.trim()) return false;
  const path = entry.locator.controlPath ?? entry.locator.configPath;
  try {
    const format = entry.locator.nativeRule?.format ?? entry.locator.format ?? (entry.client === "codex" ? "toml" : "json");
    const key = `${format}:${path}`;
    if (!cache.has(key)) cache.set(key, nativeValue(text, format));
    const value = cache.get(key);
    if (entry.kind === "mcp" && path === entry.locator.configPath) {
      const registration = entry.locator.keyPath?.length ? get(value, entry.locator.keyPath) : undefined;
      return !!registration && typeof registration === "object" && !Array.isArray(registration);
    }
    if (entry.kind === "mcp" && ["mcpServers", "mcp_servers"].some(key => Object.hasOwn(object(get(value, [key])), entry.server ?? entry.name))) return true;
    const rule = entry.locator.nativeRule;
    if (rule?.type === "boolean") return typeof get(value, rule.keyPath) === "boolean";
    if (rule?.type === "activation") return (get(value, rule.keyPath) as unknown[] | undefined)?.some(row => activationMatches(object(row), rule)) ?? false;
    if (rule?.type === "name-list") return [get(value, rule.keyPath), get(value, ["skills", "enabled"]), get(value, ["enabledServers"])]
      .some(names => Array.isArray(names) && names.includes(rule.member));
    if (entry.locator.nativeControl === "codeflicker-skill") return Object.values(nameRules(value, entry.name)).some(count => count > 0);
    if (entry.locator.nativeControl === "codex-skill") return [entry.locator.skillFile,
      entry.targetPath && (entry.entryType === "file" ? entry.targetPath : join(entry.targetPath, "SKILL.md"))]
      .some(skillPath => skillPath !== undefined && skillRules(value, skillPath).length > 0);
    return false;
  } catch { return false; }
}

function nativeSelection(value: unknown, rule: NativeResourceRule): string {
  const selected = get(value, rule.keyPath);
  if (rule.type === "boolean") {
    if (selected !== undefined && typeof selected !== "boolean") return readonly();
    return stable(selected);
  }
  if (selected !== undefined && !Array.isArray(selected)) return readonly();
  const values = selected as unknown[] | undefined ?? [];
  if (rule.type === "name-list") {
    if (!rule.member || values.some(value => typeof value !== "string")) return readonly();
    return stable(values.filter(value => value === rule.member).length);
  }
  if (!rule.identity || values.some(value => !value || typeof value !== "object" || Array.isArray(value))) return readonly();
  return stable(values.filter(value => activationMatches(object(value), rule)));
}
function tomlSuffix(value: string): string {
  let quote: string | undefined; let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (quote === '"' && char === "\\" && !escaped) { escaped = true; continue; }
      if (char === quote && !escaped) quote = undefined;
      escaped = false;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return value.slice(0, index).match(/\s*$/)![0] + value.slice(index);
  }
  return value.match(/\s*$/)![0];
}
/** 只接受可逐行核验的 TOML 字段；复杂值仍保持只读。 */
function nativeTomlEdit(text: string, keys: string[], value: unknown): string {
  const blocks = validateEditableToml(text); const parent = keys.slice(0, -1); const key = keys.at(-1)!;
  const block = parent.length ? blocks.find(item => !item.array && sameKeys(item.keys, parent)) : undefined;
  if (parent.length && !block) {
    if (value === undefined) return text;
    const result = `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n[${parent.map(key => JSON.stringify(key)).join(".")}]\n${JSON.stringify(key)} = ${JSON.stringify(value)}\n`;
    toml(result); return result;
  }
  const start = block?.headerEnd ?? 0; const end = block?.end ?? blocks[0]?.start ?? text.length;
  let found = false;
  let body = text.slice(start, end).split(/(?<=\n)/).map(line => {
    if (!line.trim() || line.trimStart().startsWith("#") || !Object.hasOwn(toml(line), key)) return line;
    const match = /^(\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*)(.*?)(\r?\n?)$/.exec(line);
    if (!match || Object.keys(toml(line)).length !== 1) return readonly();
    found = true;
    return value === undefined ? "" : `${match[1]}${JSON.stringify(value)}${tomlSuffix(match[2]!)}${match[3]}`;
  }).join("");
  if (!found && value !== undefined) body += `${body && !body.endsWith("\n") ? "\n" : ""}${JSON.stringify(key)} = ${JSON.stringify(value)}\n`;
  const result = text.slice(0, start) + body + text.slice(end); toml(result); return result;
}
function nativeEdit(text: string, format: ConfigChange["format"], keys: string[], value: unknown): string {
  if (format === "toml") return nativeTomlEdit(text, keys, value);
  if (format !== "yaml") return editJson(text || "{}", keys, value, format);
  const document = yaml(text);
  if (value === undefined) document.deleteIn(keys); else document.setIn(keys, value);
  const result = document.toString(); yaml(result); return result;
}
interface Block { start: number; end: number; headerEnd: number; keys: string[]; array: boolean }
function header(line: string): { keys: string[]; array: boolean } | undefined {
  try {
    let value: unknown = parseToml(line);
    const keys: string[] = []; let array = false;
    while (Object.keys(object(value)).length === 1) {
      const key = Object.keys(object(value))[0]!; keys.push(key); value = object(value)[key];
      if (Array.isArray(value)) { if (value.length !== 1) return undefined; array = true; value = value[0]; }
    }
    return keys.length && Object.keys(object(value)).length === 0 ? { keys, array } : undefined;
  } catch { return undefined; }
}
/** 全文由 TOML parser 验证；局部编辑只开放可逐行确认的表与值。 */
export function validateEditableToml(text: string): Block[] {
  toml(text);
  const blocks: Block[] = []; let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) { offset += line.length; continue; }
    const table = line.trimStart().startsWith("[") ? header(line) : undefined;
    if (table) {
      if (blocks.length) blocks.at(-1)!.end = offset;
      blocks.push({ start: offset, end: text.length, headerEnd: offset + line.length, ...table });
    } else {
      // 多行字符串、数组与复合值维持只读，避免把值中的表头当结构。
      try { parseToml(line, { integersAsBigInt: "asNeeded", unsafeKeyBehaviour: "throw" }); }
      catch { return readonly(); }
    }
    offset += line.length;
  }
  return blocks;
}
export function editableConfig(text: string, entry: ResourceInventoryEntry): boolean {
  try {
    if (entry.locator.nativeRule) {
      if (entry.locator.nativeRule.format === "toml") validateEditableToml(text);
      nativeSelection(nativeValue(text, entry.locator.nativeRule.format), entry.locator.nativeRule); return true;
    }
    if (entry.kind === "skill") {
      if (entry.locator.nativeControl === "codeflicker-desktop-skill") return text === "";
      if (entry.locator.nativeControl === "codeflicker-skill") {
        nameRules(json(text || "{}", "json"), entry.name);
        return true;
      }
      validateEditableToml(text);
      toml(`${text}${text.endsWith("\n") || !text ? "" : "\n"}\n[[skills.config]]\npath = "synthetic-format-check"\nenabled = false\n`);
      return true;
    }
    const keys = entry.locator.keyPath;
    if (!keys?.length || !entry.locator.format) return false;
    if (entry.locator.format === "yaml") return false;
    if (entry.locator.format !== "toml") return !!get(json(text, entry.locator.format), keys);
    return validateEditableToml(text).some(block => !block.array && sameKeys(block.keys, keys));
  } catch { return false; }
}
const sameKeys = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((key, index) => key === right[index]);
const prefix = (keys: readonly string[], wanted: readonly string[]) => wanted.every((key, index) => keys[index] === key);
function enabledEdit(text: string, keys: string[], enabled: boolean | undefined): string {
  const block = validateEditableToml(text).find(item => !item.array && sameKeys(item.keys, keys));
  if (!block) return readonly();
  const body = text.slice(block.headerEnd, block.end);
  let found = false;
  const changed = body.split(/(?<=\n)/).map(line => {
    if (!line.trim() || line.trimStart().startsWith("#")) return line;
    const parsed = toml(line);
    if (!Object.hasOwn(parsed, "enabled")) return line;
    if (typeof parsed.enabled !== "boolean") return readonly();
    const match = /^(\s*(?:enabled|"enabled"|'enabled')\s*=\s*)(true|false)(\s*(?:#.*)?)(\r?\n?)$/.exec(line);
    if (!match) return readonly();
    found = true;
    return enabled === undefined ? "" : `${match[1]}${enabled}${match[3]}${match[4]}`;
  }).join("");
  const replacement = changed + (!found && enabled !== undefined ? `${changed.endsWith("\n") || !changed ? "" : "\n"}enabled = ${enabled}\n` : "");
  const result = text.slice(0, block.headerEnd) + replacement + text.slice(block.end);
  toml(result); return result;
}
function removeBlocks(text: string, selected: Block[]): string {
  let result = text;
  for (const block of [...selected].sort((left, right) => right.start - left.start)) result = result.slice(0, block.start) + result.slice(block.end);
  toml(result); return result;
}
function skillRules(value: unknown, path: string): unknown[] {
  const rules = get(value, ["skills", "config"]);
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) return readonly();
  return rules.filter(rule => object(rule).path === path);
}
/** 名称列表的原生优先级与其他名称保持独立，恢复只撤销本次成员。 */
function nameRules(value: unknown, name: string): Record<string, number> {
  const rules = get(value, ["skills"]);
  if (rules !== undefined && (!rules || typeof rules !== "object" || Array.isArray(rules))) return readonly();
  return Object.fromEntries(["disabled", "userOnly", "enabled"].map(key => {
    const names = object(rules)[key];
    if (names !== undefined && (!Array.isArray(names) || names.some(item => typeof item !== "string"))) return readonly();
    return [key, (names as string[] | undefined)?.filter(item => item === name).length ?? 0];
  }));
}
function selected(change: ConfigChange, text: string): string {
  if (change.type === "skill-marker") return stable(text);
  if (change.type === "native-rule") return nativeSelection(nativeValue(text, change.format), change.nativeRule!);
  if (change.format === "yaml") return readonly();
  const parsed = change.format === "toml" ? toml(text) : json(text, change.format);
  return stable(change.type === "toml-skill" ? skillRules(parsed, change.skillPath!)
    : change.type === "json-skill" ? nameRules(parsed, change.skillName!) : get(parsed, change.keyPath));
}

export async function prepareConfig(entry: ResourceInventoryEntry, action: "disable" | "standby" | "trash", skillPath?: string): Promise<ConfigChange> {
  const rule = action === "disable" ? entry.locator.nativeRule : undefined;
  const path = rule || entry.kind === "skill" ? entry.locator.controlPath : entry.locator.configPath;
  if (!path) return readonly();
  let text: string; let fileExistedBefore = true;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if ((entry.kind === "skill" || rule) && (error as NodeJS.ErrnoException).code === "ENOENT") { text = ""; fileExistedBefore = false; } else throw error; }
  if (rule) {
    const value = nativeValue(text, rule.format); const before = nativeSelection(value, rule);
    const previous = get(value, rule.keyPath);
    let next: unknown;
    if (rule.type === "name-list") {
      const members = previous === undefined ? [] : previous as string[];
      if (members.includes(rule.member!)) throw new ServiceError("INVALID_INPUT", "资源已停用，没有新的本地修改", { key: "diagnostics.resources.configEditor.m002" });
      next = [...members, rule.member!];
    } else if (rule.type === "boolean") next = rule.disabledValue ?? false;
    else {
      const rows = previous === undefined ? [] : previous as Record<string, unknown>[];
      next = [...rows.filter(row => !activationMatches(row, rule)), { ...rule.identity, enabled: false }];
    }
    let afterText = nativeEdit(text, rule.format, rule.keyPath, next);
    if (rule.type === "activation") afterText = nativeEdit(afterText, rule.format, ["version"], 2);
    const existingParents = rule.keyPath.slice(0, -1).map((_key, index) => rule.keyPath.slice(0, index + 1)).filter(keys => get(value, keys) !== undefined);
    return { path, format: rule.format, keyPath: rule.keyPath, type: "native-rule", nativeRule: rule, fileExistedBefore, hadKey: previous !== undefined, existingParents,
      beforeText: text, afterText, before, after: nativeSelection(nativeValue(afterText, rule.format), rule) };
  }
  if (entry.kind === "skill") {
    if (action !== "disable") return readonly();
    if (entry.locator.nativeControl === "codeflicker-desktop-skill") {
      if (fileExistedBefore) throw new ServiceError("INVALID_INPUT", "资源已停用，没有新的本地修改", { key: "diagnostics.resources.configEditor.m002" });
      return { path, format: "json", keyPath: [], type: "skill-marker", beforeText: "", afterText: "", before: "missing", after: stable(""), fileExistedBefore: false };
    }
    if (entry.locator.nativeControl === "codeflicker-skill") {
      const value = json(text || "{}", "json"); const beforeRules = nameRules(value, entry.name);
      if (beforeRules.disabled) throw new ServiceError("INVALID_INPUT", "资源已停用，没有新的本地修改", { key: "diagnostics.resources.configEditor.m002" });
      const names = get(value, ["skills", "disabled"]) as string[] | undefined;
      const afterText = editJson(text || "{}", ["skills", "disabled"], [...names ?? [], entry.name], "json");
      return { path, format: "json", keyPath: ["skills", "disabled"], type: "json-skill", skillName: entry.name, fileExistedBefore,
        hadSkills: Object.hasOwn(object(value), "skills"), hadDisabled: Object.hasOwn(object(get(value, ["skills"])), "disabled"),
        beforeText: text, afterText, before: stable(beforeRules), after: stable(nameRules(json(afterText, "json"), entry.name)) };
    }
    if (action !== "disable" || entry.locator.nativeControl !== "codex-skill" || !skillPath) return readonly();
    validateEditableToml(text);
    const beforeRules = skillRules(toml(text), skillPath);
    if (object(beforeRules.at(-1)).enabled === false) throw new ServiceError("INVALID_INPUT", "资源已停用，没有新的本地修改", { key: "diagnostics.resources.configEditor.m002" });
    const addition = `[[skills.config]]\npath = ${JSON.stringify(skillPath)}\nenabled = false\n`;
    const afterText = `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n${addition}`;
    const change: ConfigChange = { path, format: "toml", keyPath: ["skills", "config"], type: "toml-skill", skillPath,
      beforeText: text, afterText, before: stable(beforeRules), after: stable(skillRules(toml(afterText), skillPath)) };
    return change;
  }
  const format = entry.locator.format;
  const keyPath = entry.locator.keyPath;
  if (!format || format === "yaml" || !keyPath?.length) return readonly();
  const parsed = format === "toml" ? toml(text) : json(text, format);
  const beforeValue = get(parsed, keyPath);
  if (!beforeValue || typeof beforeValue !== "object" || Array.isArray(beforeValue)) return readonly();
  if (format !== "toml") {
    if (action === "disable") {
      if (entry.locator.nativeControl !== "codeflicker-mcp") return readonly();
      if (object(beforeValue).disable === true) throw new ServiceError("INVALID_INPUT", "资源已停用，没有新的本地修改", { key: "diagnostics.resources.configEditor.m002" });
      if (object(beforeValue).disable !== undefined && typeof object(beforeValue).disable !== "boolean") return readonly();
      const disablePath = [...keyPath, "disable"];
      const afterText = editJson(text, disablePath, true, format);
      return { path, format, keyPath: disablePath, type: "json-key", beforeText: text, afterText,
        before: stable(get(parsed, disablePath)), after: stable(true) };
    }
    const afterText = editJson(text, keyPath, undefined, format);
    return { path, format, keyPath, type: "json-key", beforeText: text, afterText, before: stable(beforeValue), after: "missing" };
  }
  const blocks = validateEditableToml(text);
  if (!blocks.some(block => !block.array && sameKeys(block.keys, keyPath))) return readonly();
  if (action === "disable") {
    if (object(beforeValue).enabled === false) throw new ServiceError("INVALID_INPUT", "资源已停用，没有新的本地修改", { key: "diagnostics.resources.configEditor.m002" });
    const afterText = enabledEdit(text, keyPath, false);
    return { path, format, keyPath, type: "toml-mcp", beforeText: text, afterText, before: stable(beforeValue),
      after: stable(get(toml(afterText), keyPath)), enabledBefore: object(beforeValue).enabled as boolean | undefined,
      hadEnabled: Object.hasOwn(object(beforeValue), "enabled") };
  }
  const removed = blocks.filter(block => prefix(block.keys, keyPath));
  const afterText = removeBlocks(text, removed);
  if (get(toml(afterText), keyPath) !== undefined) return readonly();
  return { path, format, keyPath, type: "toml-mcp", beforeText: text, afterText, before: stable(beforeValue), after: "missing",
    removedText: removed.map(block => text.slice(block.start, block.end)).join("") };
}

/** 只恢复选中的项；其他配置的后续编辑继续保留，目标项变化则冲突。 */
export function restoreConfig(change: ConfigChange, current: string): string {
  if (selected(change, current) !== change.after) throw new ServiceError("CONTENT_STALE", "所选配置项已变化，恢复不会覆盖当前值", { key: "diagnostics.resources.configEditor.m003" });
  if (current === change.afterText) return change.beforeText;
  let result: string;
  if (change.type === "native-rule") {
    const rule = change.nativeRule!; const value = nativeValue(current, change.format);
    let previous: unknown;
    if (rule.type === "name-list") {
      const remaining = (get(value, rule.keyPath) as string[]).filter(name => name !== rule.member);
      previous = remaining.length || change.hadKey ? remaining : undefined;
    } else if (rule.type === "activation") {
      const rows = (get(value, rule.keyPath) as Record<string, unknown>[]).filter(row => !activationMatches(row, rule));
      previous = [...rows, ...JSON.parse(change.before) as Record<string, unknown>[]];
      if (!(previous as unknown[]).length && !change.hadKey) previous = undefined;
    } else previous = change.before === "missing" ? undefined : JSON.parse(change.before);
    result = nativeEdit(current, change.format, rule.keyPath, previous);
    if (change.format !== "toml") for (let depth = rule.keyPath.length - 1; depth > 0; depth--) {
      const keys = rule.keyPath.slice(0, depth);
      if (!change.existingParents?.some(parent => sameKeys(parent, keys)) && Object.keys(object(get(nativeValue(result, change.format), keys))).length === 0) result = nativeEdit(result, change.format, keys, undefined);
    }
    if (change.fileExistedBefore === false && Object.keys(object(nativeValue(result, change.format))).filter(key => rule.type !== "activation" || key !== "version").length === 0) return "";
  }
  else if (change.type === "json-key") result = editJson(current, change.keyPath, change.before === "missing" ? undefined : JSON.parse(change.before), change.format as "json" | "jsonc");
  else if (change.type === "json-skill") {
    const names = get(json(current, "json"), change.keyPath) as string[];
    const remaining = names.filter(name => name !== change.skillName);
    result = editJson(current, change.keyPath, remaining.length || change.hadDisabled ? remaining : undefined, "json");
    if (!change.hadSkills && Object.keys(object(get(json(result, "json"), ["skills"]))).length === 0) result = editJson(result, ["skills"], undefined, "json");
    if (change.fileExistedBefore === false && Object.keys(object(json(result, "json"))).length === 0) return "";
  }
  else if (change.type === "skill-marker") return change.beforeText;
  else if (change.type === "toml-skill") {
    const matches = validateEditableToml(current).filter(block => block.array && sameKeys(block.keys, ["skills", "config"])
      && object(skillRules(toml(current.slice(block.start, block.end)), change.skillPath!).at(-1)).path === change.skillPath);
    if (!matches.length) return readonly();
    result = removeBlocks(current, [matches.at(-1)!]);
  } else if (change.after === "missing") result = `${current}${current.endsWith("\n") || !current ? "" : "\n"}\n${change.removedText}`;
  else result = enabledEdit(current, change.keyPath, change.hadEnabled ? change.enabledBefore : undefined);
  if (selected(change, result) !== change.before) return readonly();
  return result;
}
