import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { HistoryEvent } from "../../contracts.js";
import type { SourceLocation } from "../types.js";
import { number, object, physicalLines, returnedText, string, textContent, toolEvidence } from "../extraction.js";
import { normalizeHistoryPath, registerRequest } from "./common.js";
import { readJsonlEvidence } from "./jsonl.js";
import type { HistoryAdapter } from "./types.js";

export const DESKTOP_FORMAT = "codeflicker-desktop-jsonl";
export const desktopIdentity = (value: unknown): string | undefined => string(value)
  ?? (Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : undefined);
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
export const desktopSessionDirectory = (path: string) => dirname(dirname(path));

/** 目录保存的是桌面会话 ID，不是可逆的项目路径编码。 */
export async function desktopSourceMetadata(location: SourceLocation): Promise<SourceLocation> {
  const directory = desktopSessionDirectory(location.path);
  const sessionId = basename(directory);
  let cwd: string | undefined;
  try {
    const registry = object(JSON.parse(await readFile(join(directory, "checkpoints", "registry.json"), "utf8")));
    // 身份矛盾时不能把另一个会话的工作目录带入。
    if (!registry.sessionId || registry.sessionId === sessionId) cwd = normalizeHistoryPath(string(registry.cwd));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return { ...location, format: DESKTOP_FORMAT, sessionId, sourceId: `${location.client}:${hash(sessionId)}`,
    cwd: cwd && isAbsolute(cwd) ? cwd : undefined };
}

export function desktopTimestamp(record: Record<string, unknown>): string | undefined {
  const value = record.timestamp ?? record.finishedAt;
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : string(value);
}

export function desktopCalls(record: Record<string, unknown>): { id: string; name: string; input: unknown }[] {
  return (Array.isArray(record.toolCalls) ? record.toolCalls : []).flatMap(value => {
    const call = object(value);
    const fn = object(call.function);
    const id = string(call.id);
    const name = string(fn.name);
    if (!id || !name) return [];
    let input: unknown = fn.arguments;
    if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* 非 JSON 参数原样保留。 */ } }
    return [{ id, name, input }];
  });
}

export function desktopResult(record: Record<string, unknown>): { result: unknown; visible: string; status: HistoryEvent["status"] } {
  const extra = object(record.extra);
  let result: unknown = extra.output;
  if (result === undefined && typeof record.content === "string") {
    try { result = JSON.parse(record.content); } catch { /* 文本不视为成功证明。 */ }
  }
  const value = object(result);
  const context = object(record.context);
  const blocks = Array.isArray(context.content) ? context.content.map(object) : [];
  const error = record.isError ?? extra.isError ?? value.is_error ?? value.isError ?? blocks.find(block => block.type === "tool_result")?.is_error;
  let status: HistoryEvent["status"] = error === true || value.success === false || string(value.error) ? "failure" : "unknown";
  if (status !== "failure" && value.interrupted !== true && !value.backgroundTaskId) {
    if (typeof value.exit_code === "number") status = value.exit_code === 0 ? "success" : "failure";
    else if (error === false || value.success === true) status = "success";
    else if (extra.toolName === "replace_in_file" && value.replaced === true && string(value.file_path)) status = "success";
    // 已核对的 read_file 返回包装，用实际编号内容和计数共同确认成功。
    else if (extra.toolName === "read_file" && typeof value.content === "string" && Number.isInteger(value.line_count)
      && value.line_count === physicalLines(value.content).length
      && (/^\s*\d+\t/m.test(value.content) || Number.isInteger(value.start_line) && Number(value.start_line) >= 1)) status = "success";
  }
  const visible = string(value.stdout) ?? string(value.content) ?? textContent(record.content);
  return { result, visible, status };
}

export const codeflickerDesktopAdapter: HistoryAdapter = {
  id: DESKTOP_FORMAT,
  quickCheck: { version: "1", dependencies: location => [join(desktopSessionDirectory(location.path), "checkpoints", "registry.json")] },
  discover(_record, location) {
    const sessionId = basename(desktopSessionDirectory(location.path));
    return { source: { ...location, sessionId, sourceId: `${location.client}:${hash(sessionId)}` }, complete: true };
  },
  readSourceMetadata: desktopSourceMetadata,
  readEvidence: readJsonlEvidence,
  extract(tool, inputValue, resultValue, visible) {
    const input = object(inputValue);
    const result = object(resultValue);
    const toolName = tool === "execute_command" ? "Bash" : ["grep_search", "search_file", "list_files", "list_directory"].includes(tool) ? "Grep"
      : tool === "replace_in_file" ? "Edit" : tool === "write_to_file" || tool === "create_file" ? "Write" : tool;
    if (tool === "read_file") {
      const lines = physicalLines(visible);
      const start = number(input.start_line);
      const count = number(input.line_count);
      const numbered = /^\s*\d+\t/m.test(visible);
      const actualStart = numbered ? Number(/^\s*(\d+)\t/.exec(lines[0] ?? "")?.[1]) : number(result.start_line);
      if (returnedText(visible).truncated || result.truncated === true || result.line_count !== lines.length
        || (start !== undefined && actualStart !== start) || (count !== undefined && lines.length > count)
        || (number(result.end_line) !== undefined && actualStart !== undefined && Number(result.end_line) !== actualStart + lines.length - 1)
        || (number(input.end_line) !== undefined && actualStart !== undefined && actualStart + lines.length - 1 > Number(input.end_line))) {
        return [{ kind: "read", path: string(input.path), fragments: [], reason: "range_unknown: 桌面读取实际行范围与请求或计数不符" }];
      }
      return numbered ? toolEvidence(tool, input, result, visible) : toolEvidence("Read", { file_path: input.path, offset: input.start_line, limit: input.line_count },
        { file: { content: visible, startLine: result.start_line, numLines: result.line_count, totalLines: result.total_lines, filePath: input.path } }, visible);
    }
    if (["write_to_file", "create_file"].includes(tool) && result.success === true && result.path === input.path && typeof input.content === "string") {
      // 成功覆盖写入确认写入快照，不把它解释为相对原文件的净差异。
      return [{ kind: "edit", path: string(input.path), fragments: input.content ? [{ kind: "added", content: input.content, historicalStart: 1, completeLines: true }] : [] }];
    }
    if (tool === "replace_in_file" && result.file_path !== undefined && result.file_path !== input.path) {
      return [{ kind: "edit", path: string(input.path), fragments: [], reason: "range_unknown: 桌面替换返回路径与请求不符" }];
    }
    return toolEvidence(toolName, input, result, visible);
  },
  processRecord(record, context) {
    const { cursor, row, raw, findEvent, reference, pair, finish, gap } = context;
    context.occurredAt = desktopTimestamp(record);
    if (record.op === "turn_terminal") return;
    if (record.kind !== "message" && !record.role) { gap("unsupported_format", `物理记录 ${row} 的桌面记录类型尚未适配`); return; }
    for (const call of desktopCalls(record)) registerRequest(context, { callId: call.id, tool: call.name, input: call.input,
      key: `request:${record.id ?? row}:${call.id}`, cwd: context.source.cwd });
    if (record.role !== "tool") return;
    const callId = string(record.toolCallId);
    if (!callId) { gap("unpaired_call", "桌面工具结果没有调用身份"); return; }
    const key = `result:${record.id ?? row}:${callId}`;
    if (cursor.seen[key]) { findEvent(cursor.seen[key])?.sources.push(reference(row, raw, callId)); return; }
    const call = pair(callId);
    if (!call) return;
    const { result, visible, status } = desktopResult(record);
    finish(call, result, visible, status, row, raw);
    cursor.seen[key] = call.eventId;
  },
};
