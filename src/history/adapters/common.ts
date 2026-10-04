import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceFragment } from "../../contracts.js";
import { json, number, object, physicalLines, string, toolEvidence, unifiedFragments } from "../extraction.js";
import type { HistoryRelationship, PendingCall } from "../types.js";
import type { ToolEvidence } from "../extraction.js";
import type { HistoryAdapterContext } from "./types.js";

export function normalizeHistoryPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("file:")) {
    try { return fileURLToPath(value); } catch { return undefined; }
  }
  return isAbsolute(value) ? resolve(value) : value;
}

export function historyRelationships(record: Record<string, unknown>): HistoryRelationship[] {
  const payload = object(record.payload);
  const history = object(payload.history_base ?? record.history_base);
  const forkParent = string(history.thread_id) ?? string(payload.forked_from_id) ?? string(record.forked_from_id);
  if (forkParent) return [{ kind: "fork", parentSessionId: forkParent, endByteOffset: number(history.end_byte_offset), endOrdinalExclusive: number(history.end_ordinal_exclusive) ?? number(payload.forked_from_ordinal_exclusive) ?? number(record.forked_from_ordinal_exclusive) }];
  const source = object(payload.source ?? record.source);
  const spawn = object(object(source.subagent).thread_spawn);
  const parent = string(payload.parent_thread_id) ?? string(spawn.parent_thread_id) ?? string(record.parent_thread_id) ?? string(record.parentSessionId);
  return parent ? [{ kind: "subagent", parentSessionId: parent, agentId: string(record.agentId) }] : [];
}

/** 适配器提供原有身份 key；登记集中处理，不改变事件身份或结果语义。 */
export function registerRequest(context: HistoryAdapterContext, request: Omit<PendingCall, "eventId" | "input" | "recordLine"> & { input: unknown; key?: string; cwd?: string }): void {
  const { cursor, row, raw, reference, findEvent, createEvent } = context;
  const { key, cwd, input, ...call } = request;
  if (key && cursor.seen[key]) { findEvent(cursor.seen[key])?.sources.push(reference(row, raw, call.callId)); return; }
  const event = createEvent(call.tool, input, row, raw, context.occurredAt, cwd, key);
  event.sources[0]!.callId = call.callId;
  if (key) cursor.seen[key] = event.id;
  cursor.pending.push({ ...call, eventId: event.id, input: json(input), recordLine: row });
}

export function patchEvidence(patch: string) {
  const evidence: { kind: "edit"; path?: string; fragments: EvidenceFragment[]; reason?: string }[] = [];
  let current: typeof evidence[number] | undefined;
  let diff: string[] = [];
  const flush = () => {
    if (!current) return;
    if (current.reason !== "add") current.fragments = unifiedFragments(diff.join("\n"), current.path).map((fragment) => ({ ...fragment, historicalStart: undefined }));
    else current.fragments = [{ kind: "added", content: diff.filter((line) => line.startsWith("+")).map((line) => `${line.slice(1)}\n`).join(""), historicalStart: 1, path: current.path, completeLines: true }];
    current.reason = current.reason === "delete" ? "range_unknown: 删除文件无当前新增行" : current.reason === "add" ? undefined : "range_unknown: apply_patch 无标准 hunk 行号，仅保留变化内容";
    evidence.push(current); diff = [];
  };
  for (const line of physicalLines(patch)) {
    const file = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (file) { flush(); current = { kind: "edit", path: file[2], fragments: [], reason: file[1]!.toLowerCase() }; }
    else if (current && !line.startsWith("***")) diff.push(line);
  }
  flush();
  return evidence.length ? evidence : [{ kind: "edit" as const, fragments: [], reason: "range_unknown: apply_patch 格式不支持" }];
}

export function defaultToolEvidence(tool: string, input: unknown, result: unknown, visible: string): ToolEvidence[] {
  return tool === "apply_patch" ? patchEvidence(string(input) ?? string(object(input).patch) ?? "") : toolEvidence(tool, input, result, visible);
}
