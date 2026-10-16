import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { parseDocument } from "yaml";
import type { SessionMessage, SessionResource } from "../session-contracts.js";
import { normalizeHistoryPath, defaultToolEvidence } from "../history/adapters/common.js";
import type { HistoryAdapter } from "../history/adapters/types.js";
import { object, returnedText, shellEvidence, shellParts, string, textContent, words } from "../history/extraction.js";

/** 保留原生消息身份，同次调用的相同资源只展开一次。 */
export function messageResources(message: Pick<SessionMessage, "resource" | "resources">): SessionResource[] {
  return [...new Map([...(message.resource ? [message.resource] : []), ...(message.resources ?? [])]
    .map(resource => [JSON.stringify([resource.kind, resource.name, resource.server, resource.path]), resource])).values()];
}

/** 合并输出只确认 Skill 身份，不反推各文件正文或代码行范围。 */
function bundledSkillPaths(command: string, visible: string): string[] {
  const parts = shellParts(command);
  if (!parts?.length || parts.some(part => part.next === "||")) return [];
  for (const part of parts) {
    const tokens = words(part.command);
    if (!tokens?.length) return [];
    const executable = basename(tokens[0]!);
    if (["cat", "sed", "head", "tail", "nl"].includes(executable)) continue;
    if (executable === "cd" && tokens.length === 2 && part.next === "&&") continue;
    if (executable === "rg" && tokens.some(token => token === "--files" || token === "--line-number" || /^-[^-]*n/.test(token))) continue;
    if (executable === "git" && [tokens[1], tokens[1] === "-C" ? tokens[3] : undefined].some(value => value === "status" || value === "rev-parse")) continue;
    return [];
  }
  const candidates = [...new Set(shellEvidence(command, "").flatMap(part => part.kind === "read" && part.path && basename(part.path) === "SKILL.md" ? [part.path] : []))];
  if (!candidates.length) return [];
  const names = new Set<string>();
  const lines = returnedText(visible).content.split(/\r?\n/);
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(lines[index]!);
    if (marker) { if (!fence) fence = marker[1]![0]; else if (fence === marker[1]![0]) fence = undefined; continue; }
    if (fence || lines[index] !== "---") continue;
    const end = lines.indexOf("---", index + 1);
    if (end < 0) break;
    const document = parseDocument(lines.slice(index + 1, end).join("\n"), { uniqueKeys: true });
    if (!document.errors.length) {
      try { const name = string(object(document.toJS({ maxAliasCount: 20 })).name); if (name?.trim()) names.add(name); }
      catch { /* 不以超量引用或无效元信息确认资源身份。 */ }
    }
    index = end;
  }
  return candidates.filter(path => names.has(basename(dirname(path)))
    && candidates.filter(other => basename(dirname(other)) === basename(dirname(path))).length === 1);
}

/** 原生调用身份与成功读取分开；普通参数和消息中提及资源名不算调用。 */
export function callResource(tool: string, input: unknown, cwd?: string): SessionMessage["resource"] {
  const name = tool.replace(/^functions\./, "");
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name) ?? /^mcp__([^.]+)\.(.+)$/.exec(name);
  if (mcp) return { kind: "mcp", name: mcp[2]!, server: mcp[1] };
  if (/^(?:Skill|skill|use_skill)$/.test(name)) {
    const value = object(input);
    const directory = string(value.skill_directory);
    const skill = string(value.skill) ?? string(value.name) ?? directory?.split(/[/\\]/).filter(Boolean).at(-1);
    const path = directory?.trim() ? absolutePath(directory, string(value.workdir) ?? string(value.cwd) ?? cwd) : undefined;
    return { kind: "skill_call", name: skill?.trim() ? skill : "未记录名称",
      ...(path ? { path } : {}),
      ...(!skill?.trim() ? { nameDescriptor: { key: "sessions.resource.nameUnrecorded" } as const } : {}) };
  }
  return undefined;
}

function absolutePath(path: string, cwd?: string): string | undefined {
  const normalized = normalizeHistoryPath(path);
  if (!normalized) return undefined;
  if (normalized.startsWith("~/")) return resolve(homedir(), normalized.slice(2));
  return isAbsolute(normalized) ? normalized : cwd && isAbsolute(cwd) ? resolve(cwd, normalized) : normalized;
}

/** 复用原生返回证据；不从写入目标、文件列举或当前磁盘内容推断 Skill 使用。 */
export function successfulSkillRead(tool: string, input: unknown, result: unknown, visible: string, cwd?: string,
  extract: HistoryAdapter["extract"] = defaultToolEvidence): { resource?: SessionResource; resources?: SessionResource[]; paths: string[] } {
  const value = object(input);
  const workdir = string(value.workdir) ?? string(value.cwd) ?? cwd;
  const context = { source: { cwd: workdir }, cursor: { cwd: workdir } };
  const name = tool.replace(/^functions\./, "");
  const evidenceInput = name === "CommandExecution" ? { cmd: typeof input === "string" ? input : Array.isArray(input) ? input.at(-1) : value.cmd } : input;
  const evidence = extract(name === "CommandExecution" ? "exec_command" : name, evidenceInput, result, visible, context);
  const paths = [...new Set(evidence.filter(part => part.kind === "read" && part.fragments.some(fragment => fragment.content.trim()))
    .map(part => part.path && absolutePath(part.path, workdir)).filter((path): path is string => !!path))];
  if (["CommandExecution", "exec_command", "shell_command", "Bash", "bash"].includes(name)) {
    const command = name === "CommandExecution" ? typeof input === "string" ? input : Array.isArray(input) ? input.at(-1) : value.cmd
      : string(value.cmd) ?? string(value.command);
    if (typeof command === "string") for (const path of bundledSkillPaths(command, visible)) {
      const resolved = absolutePath(path, workdir); if (resolved && !paths.includes(resolved)) paths.push(resolved);
    }
  }
  // 无范围元信息的纯文本 Read 仍能确认使用，不能因此声称精确行覆盖。
  const directRead = /^(?:read|readfile|read_file)$/i.test(name);
  const structured = object(result);
  const plainRead = evidence.every(part => part.kind === "other" || part.reasonDescriptor?.key === "diagnostics.history.extraction.m019");
  if (!paths.length && directRead && plainRead && visible.trim() && !Object.keys(object(structured.file)).length
    && !structured.meta && !structured.details && !structured.returnDisplay) {
    let content: unknown = visible;
    try { content = JSON.parse(visible); } catch { /* 普通文本就是已记录的返回正文。 */ }
    const body = typeof content === "string" ? content : textContent(object(content).content);
    if (returnedText(body).content.trim()) {
      const path = string(value.file_path) ?? string(value.filePath) ?? string(value.path);
      const resolved = path && absolutePath(path, workdir);
      if (resolved) paths.push(resolved);
    }
  }
  const resources: SessionResource[] = paths.filter(path => basename(path) === "SKILL.md").map(path => ({ kind: "skill_read", name: basename(dirname(path)), path }));
  return { paths, resource: resources[0], ...(resources.length > 1 ? { resources } : {}) };
}
