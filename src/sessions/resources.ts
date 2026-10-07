import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { SessionMessage } from "../session-contracts.js";
import { normalizeHistoryPath, defaultToolEvidence } from "../history/adapters/common.js";
import type { HistoryAdapter } from "../history/adapters/types.js";
import { object, returnedText, string, textContent } from "../history/extraction.js";

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
  extract: HistoryAdapter["extract"] = defaultToolEvidence): { resource?: SessionMessage["resource"]; paths: string[] } {
  const value = object(input);
  const workdir = string(value.workdir) ?? string(value.cwd) ?? cwd;
  const context = { source: { cwd: workdir }, cursor: { cwd: workdir } };
  const name = tool.replace(/^functions\./, "");
  const evidenceInput = name === "CommandExecution" ? { cmd: typeof input === "string" ? input : Array.isArray(input) ? input.at(-1) : value.cmd } : input;
  const evidence = extract(name === "CommandExecution" ? "exec_command" : name, evidenceInput, result, visible, context);
  const paths = [...new Set(evidence.filter(part => part.kind === "read" && part.fragments.some(fragment => fragment.content.trim()))
    .map(part => part.path && absolutePath(part.path, workdir)).filter((path): path is string => !!path))];
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
  const skill = paths.find(path => basename(path) === "SKILL.md");
  return { paths, resource: skill ? { kind: "skill_read", name: basename(dirname(skill)), path: skill } : undefined };
}
