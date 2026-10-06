import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Client, HistoryEvent } from "../../contracts.js";
import { object, returnedText, string, textContent } from "../extraction.js";
import type { SourceLocation } from "../types.js";
import { defaultToolEvidence, historyRelationships, normalizeHistoryPath, registerRequest } from "./common.js";
import { readJsonlEvidence } from "./jsonl.js";
import type { HistoryAdapter } from "./types.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function sourceMetadata(raw: unknown, client: Client, path: string): SourceLocation {
  const record = object(raw);
  const sessionId = string(record.sessionId);
  const agentId = string(record.agentId);
  const cwd = normalizeHistoryPath(string(record.cwd));
  const parentSessionId = historyRelationships(record)[0]?.parentSessionId;
  return {
    path, client, format: "claude-jsonl", cwd, sessionId: agentId && sessionId ? `${sessionId}/agent/${agentId}` : sessionId,
    parentSessionId,
    sourceId: sessionId ? `${client}:${hash(JSON.stringify({ sessionId, agentId })).slice(0, 24)}` : undefined,
  };
}

export const claudeAdapter: HistoryAdapter = {
  id: "claude-jsonl",
  quickCheck: { version: "1", dependencies: () => [] },
  discover(record, location) {
    if (!record.sessionId) return undefined;
    const candidate = sourceMetadata(record, location.client, location.path);
    if (!candidate.sourceId) return undefined;
    const source = location.sourceId ? { ...location } : { ...candidate, cwd: undefined };
    if (candidate.sourceId !== source.sourceId) return undefined;
    if (candidate.cwd && isAbsolute(candidate.cwd)) return { source: { ...source, cwd: candidate.cwd }, complete: true };
    return { source };
  },
  extract: defaultToolEvidence,
  readEvidence: readJsonlEvidence,
  processRecord(record, context) {
    const { client, path: absolutePath, source, cursor, row, raw, gap, reference, findEvent, finish, pair } = context;
    if (record.sessionId) {
      const metadata = sourceMetadata(record, client, absolutePath);
      if (source.sessionId.startsWith("unknown:")) {
        source.sourceId = metadata.sourceId ?? source.sourceId;
        source.sessionId = metadata.sessionId ?? source.sessionId;
        source.cwd = metadata.cwd && isAbsolute(metadata.cwd) ? metadata.cwd : undefined;
        source.parentSessionId = metadata.parentSessionId;
        cursor.relationships = historyRelationships(record);
        source.relationships = cursor.relationships;
        if (record.agentId && !source.parentSessionId) {
          source.parentSessionId = string(record.sessionId);
          cursor.relationships.push({ kind: "subagent", parentSessionId: string(record.sessionId)!, agentId: string(record.agentId) });
        }
      }
      if (metadata.sourceId === source.sourceId && metadata.cwd && isAbsolute(metadata.cwd)) {
        source.cwd ??= metadata.cwd;
        cursor.cwd = metadata.cwd;
      }
    }
    const message = object(record.message);
    const blocks = Array.isArray(message.content) ? message.content : [];
    const results = blocks.filter((block) => object(block).type === "tool_result");
    blocks.forEach((value, index) => {
      const block = object(value);
      if (block.type === "tool_use") {
        const callId = string(block.id) ?? `record:${row}:${index}`;
        const uuid = string(record.uuid);
        const key = uuid ? `request:${uuid}:${callId}:${index}:${hash(JSON.stringify(block))}` : undefined;
        const tool = string(block.name) ?? "unknown";
        registerRequest(context, { callId, requestUuid: uuid, tool, input: block.input, cwd: string(record.cwd), key });
      } else if (block.type === "tool_result") {
        const callId = string(block.tool_use_id) ?? "";
        const key = `result:${record.uuid ?? row}:${callId}:${hash(JSON.stringify(block))}`;
        if (cursor.seen[key]) { findEvent(cursor.seen[key])?.sources.push(reference(row, raw, callId)); return; }
        const call = pair(callId, string(record.sourceToolAssistantUUID));
        if (!call) return;
        const result = results.length === 1 ? record.toolUseResult : undefined;
        const structured = object(result);
        const visible = textContent(block.content);
        let status: HistoryEvent["status"] = block.is_error === true ? "failure" : block.is_error === false ? "success" : "unknown";
        if (block.is_error !== true && (structured.file || Array.isArray(structured.structuredPatch) || ["create", "update"].includes(string(structured.type) ?? ""))) status = "success";
        if (structured.backgroundTaskId || structured.timedOutAfterMs || structured.interrupted === true) status = "unknown";
        const reason = structured.backgroundTaskId ? "后台任务尚无完成结果" : returnedText(visible).truncated ? "range_unknown: 持久化或截断输出未补读旁路文件" : undefined;
        finish(call, result, visible, status, row, raw, reason);
        if (structured.backgroundTaskId) gap("unpaired_call", "后台任务返回仅确认已接收；后续通知形态未适配，当前活动保持 unknown");
        cursor.seen[key] = call.eventId;
      }
    });
    const supportedRecords = ["assistant", "user", "system", "progress", "summary", "file-history-snapshot", "file-history-delta", "attachment", "mode", "permission-mode", "last-prompt", "queue-operation"];
    const recordType = string(record.type) ?? "<缺少类型>";
    if (!supportedRecords.includes(recordType)) gap("unsupported_format", `物理记录 ${row} 的顶层类型 ${recordType} 尚未适配`);
  },
};
