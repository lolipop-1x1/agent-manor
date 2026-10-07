import { readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { applyEdits, modify, parse as parseJson } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import type { ResourceInventoryEntry } from "../resource-inventory-contracts.js";
import { ServiceError } from "../service/input.js";

/** 此契约只保存在受限管理库与恢复材料中，不投影到 API。 */
export interface ConfigChange {
  path: string;
  format: "json" | "jsonc" | "toml";
  keyPath: string[];
  type: "json-key" | "json-skill" | "skill-marker" | "toml-mcp" | "toml-skill";
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
}
const readonly = (): never => { throw new ServiceError("FORBIDDEN", "当前配置写法未完成保留编辑适配，只读", { key: "diagnostics.resources.configEditor.m001" }); };
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
  const parsed = change.format === "toml" ? toml(text) : json(text, change.format);
  return stable(change.type === "toml-skill" ? skillRules(parsed, change.skillPath!)
    : change.type === "json-skill" ? nameRules(parsed, change.skillName!) : get(parsed, change.keyPath));
}

export async function prepareConfig(entry: ResourceInventoryEntry, action: "disable" | "standby" | "trash", skillPath?: string): Promise<ConfigChange> {
  const path = entry.kind === "skill" ? entry.locator.controlPath : entry.locator.configPath;
  if (!path) return readonly();
  let text: string; let fileExistedBefore = true;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if (entry.kind === "skill" && (error as NodeJS.ErrnoException).code === "ENOENT") { text = ""; fileExistedBefore = false; } else throw error; }
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
  if (!format || !keyPath?.length) return readonly();
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
  if (change.type === "json-key") result = editJson(current, change.keyPath, change.before === "missing" ? undefined : JSON.parse(change.before), change.format as "json" | "jsonc");
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
