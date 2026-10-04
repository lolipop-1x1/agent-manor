import { diffLines } from "diff";
import type { EventKind, EventStatus, EvidenceFragment, JsonValue } from "../contracts.js";

export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
export const number = (value: unknown): number | undefined => typeof value === "number" ? value : undefined;
export const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue;

export interface ToolEvidence {
  kind: EventKind;
  path?: string;
  fragments: EvidenceFragment[];
  reason?: string;
}

export function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => string(object(item).text) ?? "").join("\n");
  return "";
}

export function physicalLines(content: string): string[] {
  if (!content) return [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** 只识别工具包装标记，不把源码里的普通 truncated 单词当作截断。 */
export function returnedText(value: string): { content: string; truncated: boolean } {
  let content = value;
  const truncatedHeader = /^Warning: truncated output[^\n]*$/m.test(value);
  if (/^(?:Chunk ID:|Wall time:|Exit code:|Process exited with code)/.test(content)) {
    const marker = /(?:^|\n)(?:Final output:|Output:)\n/.exec(content);
    if (marker) content = content.slice(marker.index + marker[0].length);
  }
  const marker = /(?:^(?:Warning: truncated output[^\n]*|\[.*output truncated.*\]|<persisted-output>)|(?:\.\.\.|…)\d+ (?:tokens|characters) truncated(?:\.\.\.|…))/m.exec(content);
  if (!marker) return { content: truncatedHeader ? "" : content, truncated: truncatedHeader };
  const before = content.slice(0, marker.index);
  return { content: before.slice(0, before.lastIndexOf("\n") + 1), truncated: true };
}

export function shellResult(value: unknown): { status: EventStatus; output: string; reason?: string } {
  const result = object(value);
  const exitCode = number(result.exit_code) ?? number(result.exitCode);
  if (exitCode !== undefined) return { status: exitCode === 0 ? "success" : "failure", output: string(result.output) ?? "", reason: exitCode === 0 ? undefined : `退出码 ${exitCode}` };
  const text = textContent(value);
  const match = /(?:^|\n)(?:Exit code:|Process exited with code)\s*(-?\d+)/.exec(text);
  return { status: match ? Number(match[1]) === 0 ? "success" : "failure" : "unknown", output: text, reason: match ? undefined : "未找到执行终态" };
}

export function words(command: string, allowAnd = false): string[] | undefined {
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  let active = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) quote = "";
      else if (quote === '"' && /[$`\\]/.test(character)) return undefined;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; active = true; }
    else if (character === "\n" || character === "\r") return undefined;
    else if (/\s/.test(character)) { if (active) { tokens.push(token); token = ""; active = false; } }
    else if (character === "|") { if (active) { tokens.push(token); token = ""; active = false; } tokens.push("|"); }
    else if (allowAnd && character === "&" && command[index + 1] === "&") {
      if (active) { tokens.push(token); token = ""; active = false; }
      tokens.push("&&"); index += 1;
    }
    else if (/[;&<>$`\\()*?{}~]/.test(character)) return undefined;
    else { token += character; active = true; }
  }
  if (quote) return undefined;
  if (active) tokens.push(token);
  return tokens;
}

function read(content: string, path: string, start?: number): ToolEvidence {
  const returned = returnedText(content);
  return {
    kind: "read", path,
    fragments: returned.content ? [{ content: returned.content, kind: "read", historicalStart: start, completeLines: true }] : [],
    reason: returned.truncated ? "range_unknown: 工具返回截断，仅保留截断标记前完整返回行" : undefined,
  };
}

function numberedRead(content: string, path: string, expectedStart?: number): ToolEvidence {
  const returned = returnedText(content);
  const fragments: EvidenceFragment[] = [];
  let last: number | undefined;
  let current: EvidenceFragment | undefined;
  for (const line of physicalLines(returned.content)) {
    const match = /^\s*(\d+)[\t ](.*)$/.exec(line);
    if (!match) return { kind: "read", path, fragments: [], reason: "range_unknown: 行号输出含无法校验的行" };
    const lineNumber = Number(match[1]);
    if (!current || last === undefined || lineNumber !== last + 1) {
      current = { kind: "read", content: `${match[2]}\n`, historicalStart: lineNumber, completeLines: true };
      fragments.push(current);
    } else current.content += `${match[2]}\n`;
    last = lineNumber;
  }
  if (expectedStart !== undefined && fragments[0]?.historicalStart !== expectedStart && fragments.length) {
    return { kind: "read", path, fragments: [], reason: "range_unknown: 返回行号与请求范围不符" };
  }
  return { kind: "read", path, fragments, reason: returned.truncated ? "range_unknown: 返回截断，仅保留完整编号行" : undefined };
}

function visibleReadLines(content: string): { lineNumber: number; content: string }[] | undefined {
  const lines: { lineNumber: number; content: string }[] = [];
  for (const line of physicalLines(content)) {
    const match = /^\s*(\d+)\t(.*)$/.exec(line);
    if (!match || Number(match[1]) < 1) return undefined;
    lines.push({ lineNumber: Number(match[1]), content: match[2]! });
  }
  return lines;
}

export function shellEvidence(command: string, output: string): ToolEvidence[] {
  const tokens = words(command);
  if (!tokens?.length) return [{ kind: "other", fragments: [], reason: "unsupported_tool: 复杂 Shell 语法未解析" }];
  const executable = tokens[0]!.split("/").at(-1)!;
  if (executable === "rg") {
    return [{ kind: tokens.includes("--files") ? "other" : "search", path: tokens.length > 2 && !tokens.at(-1)!.startsWith("-") ? tokens.at(-1) : undefined, fragments: [], reason: tokens.includes("--files") ? "文件列举不属于内容读取" : undefined }];
  }
  if (executable === "cat" && tokens.length === 2 && !tokens[1]!.startsWith("-")) return [read(output, tokens[1]!, 1)];
  if (executable === "cat" && tokens.length > 2 && tokens.slice(1).every((token) => !token.startsWith("-") && token !== "|")) {
    return tokens.slice(1).map((path) => ({ kind: "read", path, fragments: [], reason: "range_unknown: 多文件 cat 无可确认输出边界" }));
  }
  if (executable === "sed" && tokens.length === 4 && tokens[1] === "-n") {
    const range = /^(\d+)(?:,(\d+))?p$/.exec(tokens[2]!);
    if (range && Number(range[1]) >= 1 && Number(range[2] ?? range[1]) >= Number(range[1])) {
      const evidence = read(output, tokens[3]!, Number(range[1]));
      if (evidence.fragments.some((fragment) => physicalLines(fragment.content).length > Number(range[2] ?? range[1]) - Number(range[1]) + 1)) return [{ kind: "read", path: tokens[3], fragments: [], reason: "range_unknown: sed 返回行数超过选择范围" }];
      return [evidence];
    }
  }
  if ((executable === "head" || executable === "tail") && !tokens.includes("|")) {
    const operand = tokens.length === 4 && tokens[1] === "-n" ? tokens[2] : tokens.length === 3 && /^-\d+$/.test(tokens[1]!) ? tokens[1]!.slice(1) : undefined;
    if (operand && /^\+?\d+$/.test(operand) && Number(operand) > 0 && (executable === "tail" || !operand.startsWith("+"))) {
      const evidence = read(output, tokens.at(-1)!, executable === "head" ? 1 : operand.startsWith("+") ? Number(operand.slice(1)) : undefined);
      if (!operand.startsWith("+") && evidence.fragments.some((fragment) => physicalLines(fragment.content).length > Number(operand))) return [{ kind: "read", path: tokens.at(-1), fragments: [], reason: "range_unknown: head/tail 返回行数超过请求" }];
      return [evidence];
    }
  }
  if (executable === "nl" && tokens[1] === "-ba") {
    if (tokens.length === 3) return [numberedRead(output, tokens[2]!, 1)];
    if (tokens.length === 7 && tokens[3] === "|" && tokens[4] === "sed" && tokens[5] === "-n") {
      const range = /^(\d+),(\d+)p$/.exec(tokens[6]!);
      if (range) {
        const evidence = numberedRead(output, tokens[2]!, Number(range[1]));
        if (evidence.fragments.some((fragment) => fragment.historicalStart! + physicalLines(fragment.content).length - 1 > Number(range[2]))) return [{ kind: "read", path: tokens[2], fragments: [], reason: "range_unknown: nl 返回行号超过选择范围" }];
        return [evidence];
      }
    }
  }
  return [{ kind: "other", fragments: [], reason: "unsupported_tool: Shell 参数或组合不在支持矩阵中" }];
}

export function patchFragments(lines: string[], oldStart: number, newStart: number, path?: string): EvidenceFragment[] {
  const fragments: EvidenceFragment[] = [];
  let oldLine = oldStart;
  let newLine = newStart;
  let last: EvidenceFragment | undefined;
  for (const line of lines) {
    const prefix = line[0];
    if (prefix === "\\") { if (last?.content.endsWith("\n")) last.content = last.content.slice(0, -1); continue; }
    if (!["+", "-", " "].includes(prefix ?? "")) continue;
    const kind = prefix === "+" ? "added" : prefix === "-" ? "deleted" : "context";
    const start = prefix === "-" ? oldLine : newLine;
    if (last?.kind === kind && last.historicalStart !== undefined && start === last.historicalStart + physicalLines(last.content).length) last.content += `${line.slice(1)}\n`;
    else { last = { kind, content: `${line.slice(1)}\n`, historicalStart: start, path, completeLines: true }; fragments.push(last); }
    if (prefix !== "+") oldLine += 1;
    if (prefix !== "-") newLine += 1;
  }
  return fragments;
}

export function unifiedFragments(diff: string, path?: string): EvidenceFragment[] {
  const fragments: EvidenceFragment[] = [];
  let lines: string[] = [];
  let oldStart = 1;
  let newStart = 1;
  const flush = () => { fragments.push(...patchFragments(lines, oldStart, newStart, path)); lines = []; };
  for (const line of physicalLines(diff)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { flush(); oldStart = Number(hunk[1]); newStart = Number(hunk[2]); }
    else if (!line.startsWith("---") && !line.startsWith("+++")) lines.push(line);
  }
  flush();
  return fragments;
}

export function changedFragments(before: string, after: string, path?: string): EvidenceFragment[] {
  const fragments: EvidenceFragment[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const part of diffLines(before, after)) {
    const count = physicalLines(part.value).length;
    fragments.push({ content: part.value, kind: part.added ? "added" : part.removed ? "deleted" : "context", historicalStart: part.removed ? oldLine : newLine, completeLines: true, path });
    if (!part.added) oldLine += count;
    if (!part.removed) newLine += count;
  }
  return fragments;
}

export function toolEvidence(tool: string, inputValue: unknown, resultValue: unknown, visibleOutput: string): ToolEvidence[] {
  const input = object(inputValue);
  const result = object(resultValue);
  const path = string(input.file_path) ?? string(input.path) ?? string(result.filePath);
  if (["shell_command", "exec_command", "Bash", "bash"].includes(tool)) return shellEvidence(string(input.cmd) ?? string(input.command) ?? "", visibleOutput);
  if (["Read", "read_file"].includes(tool)) {
    const file = object(result.file);
    if (Object.keys(file).length) {
      const content = string(file.content);
      const start = number(file.startLine);
      const count = number(file.numLines);
      const total = number(file.totalLines);
      const returned = returnedText(visibleOutput);
      const requestedStart = number(input.offset);
      const requestedLimit = number(input.limit);
      const returnedPath = string(file.filePath);
      if (content === undefined || start === undefined || count === undefined || !Number.isInteger(start) || !Number.isInteger(count) || start < 1 || count < 0
        || (total !== undefined && start + count - 1 > total) || returned.truncated || returnedText(content).truncated) {
        return [{ kind: "read", path, fragments: [], reason: "range_unknown: Read 结构化范围与实际返回内容无法校验" }];
      }
      if ((path && returnedPath && path !== returnedPath) || (requestedStart !== undefined && start !== Math.max(1, requestedStart)) || (requestedLimit !== undefined && count > requestedLimit)) {
        return [{ kind: "read", path, fragments: [], reason: "range_unknown: Read 返回路径或范围与请求不一致" }];
      }
      const sourceLines = physicalLines(content);
      const sdkLines = content.replace(/\r\n/g, "\n").split("\n");
      const numbered = /^\s*\d+\t/m.test(visibleOutput) ? visibleReadLines(visibleOutput) : undefined;
      const virtualEof = content.endsWith("\n") && count === sourceLines.length + 1 && total === start + count - 1
        && numbered?.length === count && numbered.at(-1)?.content === ""
        && numbered.every((line, index) => line.lineNumber === start + index && line.content === sdkLines[index]);
      if (count !== sourceLines.length && !virtualEof) {
        return [{ kind: "read", path, fragments: [], reason: "range_unknown: Read 结构化行数不符，未确认 SDK 虚拟 EOF 空行" }];
      }
      const visibleSourceLines = virtualEof ? numbered!.slice(0, -1) : numbered;
      if (/^\s*\d+\t/m.test(visibleOutput) && (!visibleSourceLines || visibleSourceLines.length !== sourceLines.length
        || visibleSourceLines.some((line, index) => line.lineNumber !== start + index || line.content !== sourceLines[index]))) {
        return [{ kind: "read", path, fragments: [], reason: "range_unknown: Read 行号文本与结构化内容不一致" }];
      }
      return [{ kind: "read", path: path ?? string(file.filePath), fragments: content ? [{ content, kind: "read", historicalStart: start, completeLines: true }] : [] }];
    }
    if (path && /^\s*\d+\t/m.test(visibleOutput)) return [numberedRead(visibleOutput, path)];
    return [{ kind: "read", path, fragments: [], reason: "range_unknown: Read 缺少可校验的实际行范围" }];
  }
  if (["Edit", "edit_file"].includes(tool)) {
    if (Array.isArray(result.structuredPatch)) {
      return [{ kind: "edit", path, fragments: result.structuredPatch.flatMap((value) => {
        const hunk = object(value);
        return patchFragments(Array.isArray(hunk.lines) ? hunk.lines.filter((line): line is string => typeof line === "string") : [], number(hunk.oldStart) ?? 1, number(hunk.newStart) ?? 1, path);
      }) }];
    }
    const before = string(input.old_string);
    const after = string(input.new_string);
    return [{ kind: "edit", path, fragments: before !== undefined && after !== undefined ? changedFragments(before, after, path).map((fragment) => ({ ...fragment, historicalStart: undefined })) : [], reason: "range_unknown: Edit 无结构化位置；仅保留变化片段" }];
  }
  if (["Write", "write_file"].includes(tool)) {
    const content = string(result.content) ?? string(input.content);
    if (content === undefined) return [{ kind: "edit", path, fragments: [], reason: "range_unknown: Write 缺少成功写入内容" }];
    const before = string(result.originalFile);
    if (before !== undefined) return [{ kind: "edit", path, fragments: changedFragments(before, content, path) }];
    if (result.type === "create" || result.originalFile === null) return [{ kind: "edit", path, fragments: content ? [{ kind: "added", content, historicalStart: 1, completeLines: true, path }] : [] }];
    return [{ kind: "edit", path, fragments: [], reason: "range_unknown: Write 未确认新建或覆盖前内容" }];
  }
  if (["Grep", "Glob", "search", "rg"].includes(tool)) return [{ kind: "search", path, fragments: [] }];
  return [{ kind: "other", path, fragments: [], reason: `unsupported_tool: ${tool} 未提取代码范围` }];
}
