import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import type { Client, HistoryEvent } from "../../contracts.js";
import { changedFragments, json, number, object, patchFragments, shellEvidence, string } from "../extraction.js";
import type { ToolEvidence } from "../extraction.js";
import type { SourceLocation } from "../types.js";
import { historyRelationships, normalizeHistoryPath } from "./common.js";
import { readJsonlEvidence } from "./jsonl.js";
import type { HistoryAdapter, HistoryAdapterContext } from "./types.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const integer = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && Number(value) >= minimum;

function sourceMetadata(record: Record<string, unknown>, client: Client, path: string): SourceLocation {
  const sessionId = string(record.sessionId);
  const agentId = string(record.agentId);
  return {
    client, path, format: "codeflicker-jsonl", cwd: normalizeHistoryPath(string(record.cwd)),
    sessionId: sessionId && agentId ? `${sessionId}/agent/${agentId}` : sessionId,
    parentSessionId: string(record.parentSessionId) ?? string(record.parent_thread_id) ?? string(record.forked_from_id),
    sourceId: sessionId ? `${client}:${hash(JSON.stringify({ sessionId, agentId })).slice(0, 24)}` : undefined,
  };
}

function readPayload(result: unknown): Record<string, unknown> {
  try { return object(JSON.parse(string(object(result).llmContent) ?? "")); } catch { return {}; }
}

function bashResult(input: unknown, result: unknown): { status: HistoryEvent["status"]; output: string; truncated: boolean } | undefined {
  const command = string(object(input).command);
  const visible = string(object(result).llmContent);
  if (!command || !visible?.startsWith(`Command: ${command}\nDirectory: `)) return undefined;
  const parts = /^Directory: [^\n]*\nStdout: ([\s\S]*)\nStderr: ([\s\S]*)\nError: ([^\n]*)\nExit Code: (-?\d+)(?:\nExit Code Interpretation: [^\n]*)?$/.exec(visible.slice(`Command: ${command}\n`.length));
  if (!parts || (parts[1]!.match(/\nStderr:/g) ?? []).length || (parts[2]!.match(/\nError:/g) ?? []).length) return undefined;
  return { status: Number(parts[4]) === 0 && parts[3] === "(none)" ? "success" : "failure",
    output: parts[1] === "(empty)" ? "" : parts[1]!,
    truncated: /(?:\.\.\. \[\d+ lines truncated\] \.\.\.|\[Output too large|Full output saved to:)/.test(parts[1]!) };
}

function samePath(requested: string | undefined, returned: string | undefined, context: HistoryAdapterContext): boolean {
  if (!requested || !returned) return false;
  const cwd = context.cursor.cwd ?? context.source.cwd;
  const absolute = (path: string) => isAbsolute(path) ? resolve(path) : cwd && isAbsolute(cwd) ? resolve(cwd, path) : path;
  return absolute(requested) === absolute(returned);
}

function patchEvidence(display: Record<string, unknown>, path: string | undefined): ToolEvidence | undefined {
  if (!Array.isArray(display.structuredPatch)) return undefined;
  const fragments = [];
  for (const value of display.structuredPatch) {
    const hunk = object(value);
    if (!integer(hunk.oldStart, 1) || !integer(hunk.newStart, 1) || !integer(hunk.oldLines) || !integer(hunk.newLines)
      || !Array.isArray(hunk.lines) || hunk.lines.some(line => typeof line !== "string" || !/^[ +\-\\]/.test(line))) return undefined;
    const lines = hunk.lines as string[];
    if (lines.filter(line => /^[ -]/.test(line)).length !== hunk.oldLines
      || lines.filter(line => /^[ +]/.test(line)).length !== hunk.newLines) return undefined;
    fragments.push(...patchFragments(lines, Number(hunk.oldStart), Number(hunk.newStart), path));
  }
  return { kind: "edit", path, fragments };
}

function successfulTemplate(tool: string, input: unknown, result: unknown): boolean {
  const value = object(result);
  const requested = string(object(input).file_path);
  if (tool === "read") {
    const read = readPayload(result);
    return read.type === "text" && typeof read.content === "string" && typeof read.filePath === "string"
      && integer(read.offset, 1) && integer(read.limit) && integer(read.totalLines) && integer(read.actualLinesRead);
  }
  if (tool === "write") return requested !== undefined && value.llmContent === `File successfully written to ${requested}`;
  if (tool === "edit") return requested !== undefined && value.llmContent === `File ${requested} successfully edited.`;
  if (["grep", "glob"].includes(tool)) {
    const search = readPayload(result);
    return (integer(search.numFiles) || (integer(search.totalFiles) && integer(search.returnedFiles)))
      && Array.isArray(search.filenames) && search.filenames.every(path => typeof path === "string")
      && typeof search.truncated === "boolean" && (tool === "glob" || ["files_with_matches", "content", "count"].includes(string(search.mode) ?? ""));
  }
  if (tool === "todoWrite") {
    const display = object(value.returnDisplay);
    return display.type === "todo_write" && Array.isArray(display.oldTodos) && Array.isArray(display.newTodos)
      && JSON.stringify(display.newTodos) === JSON.stringify(object(input).todos);
  }
  return false;
}

export const codeflickerAdapter: HistoryAdapter = {
  id: "codeflicker-jsonl",
  discover(record, location) {
    if (!["config", "message"].includes(string(record.type) ?? "") || !record.sessionId) return undefined;
    const candidate = sourceMetadata(record, location.client, location.path);
    if (location.sourceId && candidate.sourceId !== location.sourceId) return undefined;
    const source = { ...location, ...candidate, cwd: candidate.cwd ?? location.cwd };
    return { source, complete: Boolean(source.cwd && isAbsolute(source.cwd)) };
  },
  readEvidence: readJsonlEvidence,
  extract(tool, inputValue, resultValue, _visible, context) {
    const input = object(inputValue);
    const result = object(resultValue);
    const requested = string(input.file_path) ?? string(input.path) ?? string(input.dir_path);
    const display = object(result.returnDisplay);
    const path = samePath(requested, string(display.absoluteFilePath), context) ? string(display.absoluteFilePath) : requested;
    const kind = tool === "read" ? "read" : ["edit", "write"].includes(tool) ? "edit" : ["grep", "glob"].includes(tool) ? "search" : "other";
    const unknown = (message: string): ToolEvidence[] => [{ kind, path, fragments: [], reason: `range_unknown: ${message}` }];
    if (result.truncated === true) return unknown("CodeFlicker 返回截断，未补读旁路内容");
    if (tool === "read") {
      const read = readPayload(resultValue);
      const content = string(read.content);
      const start = number(read.offset);
      const count = number(read.actualLinesRead);
      const total = number(read.totalLines);
      const limit = number(read.limit);
      if (!successfulTemplate(tool, inputValue, resultValue) || content === undefined || start === undefined || count === undefined || total === undefined || limit === undefined
        || !samePath(requested, string(read.filePath), context) || start !== Math.max(1, number(input.offset) ?? 1)
        || count > limit || (number(input.limit) !== undefined && count > Number(input.limit)) || start + count - 1 > total) {
        return unknown("read 返回路径、范围或文本结构无法校验");
      }
      if (count === 0) return content === "" ? [{ kind: "read", path, fragments: [] }] : unknown("read 空范围包含文本");
      const lines = content.replace(/\r\n/g, "\n").split("\n");
      if (lines.length !== count) return unknown("read 实际内容行数与 actualLinesRead 不符");
      // split 的 EOF 空项不是物理源码行；范围内真正的末尾空行仍保留。
      const virtualEof = content.endsWith("\n") && start + count - 1 === total;
      const sourceContent = content.endsWith("\n") && !virtualEof ? `${content}\n` : content;
      return [{ kind: "read", path, fragments: sourceContent ? [{ kind: "read", content: sourceContent, historicalStart: start, completeLines: true, path }] : [] }];
    }
    if (["edit", "write"].includes(tool)) {
      if (display.absoluteFilePath && !samePath(requested, string(display.absoluteFilePath), context)) return unknown(`${tool} 返回路径与请求不符`);
      const patch = patchEvidence(display, path);
      if (patch) return [patch];
      if (tool === "edit") {
        const before = string(input.old_string);
        const after = string(input.new_string);
        return [{ kind: "edit", path, fragments: before !== undefined && after !== undefined
          ? changedFragments(before, after, path).map(fragment => ({ ...fragment, historicalStart: undefined })) : [],
        reason: "range_unknown: edit 缺少有效 structuredPatch；仅保留请求中的变化片段" }];
      }
      const content = string(input.content);
      if (!successfulTemplate(tool, inputValue, resultValue) || content === undefined) return unknown("write 缺少成功写入内容");
      // 原生执行器会补齐末尾 LF；写入证据不表示原文件一定为新建。
      const written = content.endsWith("\n") ? content : `${content}\n`;
      const before = string(display.originalContent);
      return [{ kind: "edit", path, fragments: before !== undefined ? changedFragments(before, written, path)
        : [{ kind: "added", content: written, historicalStart: 1, completeLines: true, path }] }];
    }
    if (tool === "bash") {
      const bash = bashResult(input, result);
      const evidence = shellEvidence(string(input.command) ?? "", bash?.output ?? "");
      return bash?.truncated ? evidence.map(part => ({ ...part, fragments: [], reason: "range_unknown: bash 输出截断或存入旁路文件" })) : evidence;
    }
    if (["grep", "glob", "ls", "todoWrite"].includes(tool)) return [{ kind, path, fragments: [] }];
    return [{ kind: "other", path, fragments: [], reason: `unsupported_tool: ${tool} 未提取代码范围` }];
  },
  processRecord(record, context) {
    const { client, path, source, cursor, row, raw, occurredAt, gap, reference, findEvent, createEvent, finish, pair } = context;
    if (["config", "message"].includes(string(record.type) ?? "") && record.sessionId) {
      const metadata = sourceMetadata(record, client, path);
      if (source.sessionId.startsWith("unknown:")) {
        source.sourceId = metadata.sourceId ?? source.sourceId;
        source.sessionId = metadata.sessionId ?? source.sessionId;
        source.parentSessionId = metadata.parentSessionId;
        cursor.relationships = historyRelationships(record);
        source.relationships = cursor.relationships;
        if (basename(path).startsWith("agent-") && !source.parentSessionId) gap("ambiguous", "子会话候选缺少可确认的父关系，独立保留调用而不合并父历史");
      }
      if (metadata.sourceId === source.sourceId && metadata.cwd && isAbsolute(metadata.cwd)) {
        source.cwd ??= metadata.cwd;
        cursor.cwd = metadata.cwd;
      }
    }
    if (record.type !== "message") {
      if (!["config", "snapshot"].includes(string(record.type) ?? "")) gap("unsupported_format", `物理记录 ${row} 的顶层类型 ${string(record.type) ?? "<缺少类型>"} 尚未适配`);
      return;
    }
    const blocks = Array.isArray(record.content) ? record.content : [];
    blocks.forEach((value, index) => {
      const block = object(value);
      if (record.role === "assistant" && block.type === "tool_use") {
        const tool = string(block.name) ?? "unknown";
        const callId = string(block.id) ?? `record:${row}:${index}`;
        const uuid = string(record.uuid);
        const key = uuid ? `request:${uuid}:${index}:${callId}:${hash(JSON.stringify(block))}` : undefined;
        if (key && cursor.seen[key]) { findEvent(cursor.seen[key])?.sources.push(reference(row, raw, callId)); return; }
        const event = createEvent(tool, block.input, row, raw, occurredAt, string(record.cwd), key);
        event.sources[0]!.callId = callId;
        if (key) cursor.seen[key] = event.id;
        cursor.pending.push({ eventId: event.id, callId, requestUuid: uuid, tool, input: json(block.input), recordLine: row });
      } else if (record.role === "tool" && block.type === "tool-result") {
        const callId = string(block.toolCallId) ?? "";
        const key = `result:${record.uuid ?? row}:${index}:${callId}:${hash(JSON.stringify(block))}`;
        if (cursor.seen[key]) { findEvent(cursor.seen[key])?.sources.push(reference(row, raw, callId)); return; }
        const call = pair(callId, string(record.sourceToolAssistantUUID));
        if (!call) return;
        const result = object(block.result);
        const visible = string(result.llmContent) ?? "";
        const bash = call.tool === "bash" ? bashResult(call.input, result) : undefined;
        const mismatchedTool = block.toolName !== undefined && block.toolName !== call.tool;
        const status: HistoryEvent["status"] = mismatchedTool ? "unknown" : result.isError === true ? "failure"
          : bash?.status ?? (result.isError === false || successfulTemplate(call.tool, call.input, result) ? "success" : "unknown");
        const reason = mismatchedTool ? "range_unknown: CodeFlicker 结果工具名与请求不符"
          : result.truncated === true ? "range_unknown: CodeFlicker 返回截断，未补读旁路内容"
          : status === "unknown" ? "range_unknown: CodeFlicker 结果未确认成功终态" : undefined;
        finish(call, result, visible, status, row, raw, reason);
        cursor.seen[key] = call.eventId;
      }
    });
  },
};
