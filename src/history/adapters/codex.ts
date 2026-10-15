import { createHash } from "node:crypto";
import type { Client } from "../../contracts.js";
import { json, number, object, returnedText, shellEvidence, shellResult, string, textContent, unifiedFragments } from "../extraction.js";
import type { SourceLocation } from "../types.js";
import { defaultToolEvidence, historyRelationships, normalizeHistoryPath, registerRequest } from "./common.js";
import { readJsonlEvidence } from "./jsonl.js";
import type { HistoryAdapter } from "./types.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function sourceMetadata(raw: unknown, client: Client, path: string): SourceLocation {
  const record = object(raw);
  const payload = object(record.payload);
  const sessionId = string(payload.id) ?? string(payload.session_id);
  const agentId = string(record.agentId);
  const cwd = normalizeHistoryPath(string(payload.cwd));
  const parentSessionId = historyRelationships(record)[0]?.parentSessionId;
  return {
    path, client, format: "codex-jsonl", cwd, sessionId: agentId && sessionId ? `${sessionId}/agent/${agentId}` : sessionId,
    parentSessionId,
    sourceId: sessionId ? `${client}:${hash(JSON.stringify({ sessionId, agentId, timestamp: payload.timestamp ?? record.timestamp, cwd })).slice(0, 24)}` : undefined,
  };
}

export const codexAdapter: HistoryAdapter = {
  id: "codex-jsonl",
  quickCheck: { version: "1", dependencies: () => [] },
  discover(record, location) {
    return record.type === "session_meta" ? { source: sourceMetadata(record, location.client, location.path), complete: true } : undefined;
  },
  extract: defaultToolEvidence,
  readEvidence: readJsonlEvidence,
  finalizeCall(context, call, event, _result, visible, row) {
    const { source, gap } = context;
    if (call.wrapper) {
      const concrete = source.events.filter((candidate) => candidate.id !== event.id && ["CommandExecution", "FileChange"].includes(candidate.tool)
        && candidate.sources.some((ref) => ref.recordLine > call.recordLine && ref.recordLine < row));
      if (concrete.length) {
        for (const candidate of concrete) candidate.sources.push(...event.sources);
        source.events = source.events.filter((candidate) => candidate.id !== event.id);
      } else {
        event.reason = "unsupported_tool: exec 包装未发现具体事件，未执行或猜测 JavaScript"; event.reasonDescriptor = { key: "diagnostics.history.adapters.codex.m001" };
        gap("unsupported_tool", event.reason, event.reasonDescriptor);
      }
      return true;
    }
    if (["shell_command", "exec_command"].includes(call.tool)) {
      const requested = string(object(call.input).cmd) ?? string(object(call.input).command);
      const concrete = source.events.filter((candidate) => candidate.tool === "CommandExecution"
        && candidate.sources.some((ref) => ref.recordLine > call.recordLine && ref.recordLine < row)
        && string((Array.isArray(object(candidate.input).command) ? object(candidate.input).command as unknown[] : []).at(-1)) === requested
        && candidate.cwd === event.cwd
        && returnedText(string(object(candidate.output).formatted_output) ?? "").content === returnedText(visible).content);
      const identities = new Set(concrete.map(candidate => candidate.id.replace(/:file:\d+$/, "")));
      if (identities.size === 1) {
        for (const candidate of concrete) candidate.sources.push(...event.sources);
        source.events = source.events.filter((candidate) => candidate.id !== event.id);
        return true;
      }
      if (identities.size > 1) gap("ambiguous", "直接调用与具体命令事件存在多个对应候选，未合并身份", { key: "diagnostics.history.adapters.codex.m002" });
    }
    return false;
  },
  processRecord(record, context) {
    const { client, path: absolutePath, source, cursor, row, raw, occurredAt, gap, reference, findEvent, createEvent, finish, pair } = context;
    const payload = object(record.payload);
    if (record.type === "session_meta") {
      const metadata = sourceMetadata(record, client, absolutePath);
      // 复制的父头部属于继承上下文，不能将当前子来源改成父来源。
      if (!source.sessionId.startsWith("unknown:") && metadata.sessionId !== source.sessionId) return;
      source.sourceId = metadata.sourceId ?? source.sourceId;
      source.sessionId = metadata.sessionId ?? source.sessionId;
      source.cwd = metadata.cwd;
      source.parentSessionId = metadata.parentSessionId;
      cursor.cwd = metadata.cwd;
      cursor.relationships = historyRelationships(record);
      source.relationships = cursor.relationships;
      return;
    }
    if (record.type === "turn_context") { cursor.cwd = normalizeHistoryPath(string(payload.cwd)) ?? cursor.cwd; return; }
    if (record.type === "event_msg" && payload.type === "item_completed") {
      const item = object(payload.item);
      if (!["CommandExecution", "FileChange"].includes(string(item.type) ?? "")) return;
      const key = `concrete:${string(payload.thread_id) ?? source.sessionId}:${string(item.id) ?? row}:${payload.started_at_ms ?? ""}:${payload.completed_at_ms ?? ""}:${occurredAt ?? ""}:${hash(JSON.stringify(item))}`;
      const existingId = cursor.seen[key];
      if (existingId) { findEvent(existingId)?.sources.push(reference(row, raw)); return; }
      const event = createEvent(string(item.type)!, {}, row, raw, occurredAt, string(item.cwd), key);
      cursor.seen[key] = event.id;
      event.input = json(item.type === "CommandExecution" ? { command: item.command, cwd: item.cwd } : item.changes);
      const exitCode = number(item.exit_code);
      event.status = item.status === "failed" || (exitCode !== undefined && exitCode !== 0) ? "failure" : item.status === "completed" && (item.type === "FileChange" || exitCode === 0) ? "success" : "unknown";
      const output = string(item.formatted_output);
      event.output = json({ formatted_output: output, exit_code: exitCode, status: item.status });
      if (item.type === "CommandExecution") {
        const commandArray = Array.isArray(item.command) ? item.command : [];
        const command = string(commandArray.at(-1)) ?? string(item.command) ?? "";
        const evidence = shellEvidence(command, output ?? "");
        const status = event.status;
        evidence.forEach((part, index) => {
          const target = index ? { ...event, id: `${event.id}:file:${index}`, sources: [...event.sources] } : event;
          target.kind = part.kind; target.path = part.path;
          target.status = part.status ?? status;
          target.fragments = target.status === "success" && output !== undefined ? part.fragments : [];
          target.reason = output === undefined ? "range_unknown: 具体命令缺少 formatted_output；未采用 stdout 补足" : part.status || status === "success" ? part.reason : "命令未成功完成"; target.reasonDescriptor = output === undefined ? { key: "diagnostics.history.adapters.codex.m003" } : part.status || status === "success" ? part.reasonDescriptor : { key: "diagnostics.history.adapters.codex.m004" };
          if (index) source.events.push(target);
          if (target.reason?.startsWith("range_unknown:")) gap("range_unknown", target.reason, target.reasonDescriptor);
          if (target.reason?.startsWith("unsupported_tool:")) gap("unsupported_tool", target.reason, target.reasonDescriptor);
        });
      } else {
        event.kind = "edit";
        const changes = object(item.changes);
        const entries = Object.entries(changes);
        entries.forEach(([changedPath, value], index) => {
          const change = object(value);
          const target = index ? { ...event, id: `${event.id}:file:${index}`, sources: [...event.sources] } : event;
          target.kind = "edit"; target.path = normalizeHistoryPath(string(change.move_path)) ?? changedPath;
          target.fragments = event.status === "success" ? change.type === "add" && typeof change.content === "string" ? [{ kind: "added", content: change.content, historicalStart: 1, path: target.path, completeLines: true }]
            : change.type === "update" ? unifiedFragments(string(change.unified_diff) ?? "", target.path) : [] : [];
          target.reason = event.status !== "success" ? "文件修改未成功" : change.type === "delete" ? "range_unknown: 文件删除保留编辑活动，无当前新增行" : change.move_path ? "range_unknown: move_path 关系保留在输入；路径移动不证明当前内容对应" : undefined; target.reasonDescriptor = event.status !== "success" ? { key: "diagnostics.history.adapters.codex.m005" } : change.type === "delete" ? { key: "diagnostics.history.adapters.codex.m006" } : change.move_path ? { key: "diagnostics.history.adapters.codex.m007" } : undefined;
          if (index) source.events.push(target);
          if (target.reason) gap("range_unknown", target.reason, target.reasonDescriptor);
        });
      }
      return;
    }
    if (record.type === "response_item") {
      const type = string(payload.type);
      if (type === "function_call" || type === "custom_tool_call") {
        const tool = string(payload.name) ?? "unknown";
        const callId = string(payload.call_id) ?? `record:${row}`;
        let input: unknown = payload.input ?? {};
        if (typeof payload.arguments === "string") {
          try { input = JSON.parse(payload.arguments); } catch { gap("unsupported_format", `调用 ${row} arguments 不是有效 JSON`, { key: "diagnostics.history.adapters.codex.m008", params: { p0: row } }); }
        }
        const key = payload.id ? `request:${payload.id}:${callId}:${hash(JSON.stringify(input))}` : undefined;
        registerRequest(context, { callId, tool, input, cwd: string(object(input).workdir), key, wrapper: tool === "exec", turnId: string(payload.turn_id) });
      } else if (type === "function_call_output" || type === "custom_tool_call_output") {
        const callId = string(payload.call_id) ?? "";
        const outputKey = `output:${callId}:${hash(raw)}`;
        if (cursor.seen[outputKey] && !cursor.pending.some((pending) => pending.callId === callId)) { findEvent(cursor.seen[outputKey])?.sources.push(reference(row, raw, callId)); return; }
        const call = pair(callId);
        if (call) {
          let structuredOutput: unknown = payload.output;
          if (typeof structuredOutput === "string") {
            try { structuredOutput = JSON.parse(structuredOutput); } catch { /* 旧 shell 输出仍按文本头处理。 */ }
          }
          const result = shellResult(structuredOutput);
          let status = result.status;
          const structured = object(structuredOutput);
          if (structured.is_error === true || structured.success === false) status = "failure";
          else if (structured.success === true || structured.file || Array.isArray(structured.structuredPatch) || structured.type === "create") status = "success";
          if (call.tool === "apply_patch" && /^(?:Success\.|Done!|\{\})/.test(textContent(payload.output))) status = "success";
          finish(call, structuredOutput, result.output || textContent(payload.output), status, row, raw, status === "unknown" ? result.reason : undefined, status === "unknown" ? result.reasonDescriptor : undefined);
          cursor.seen[outputKey] = call.eventId;
        }
      }
      return;
    }
    const supportedRecords = ["session_meta", "turn_context", "event_msg", "response_item", "compacted", "compaction", "token_usage_record", "world_state", "inter_agent_communication_metadata", "retained_context"];
    const recordType = string(record.type) ?? "<缺少类型>";
    if (!supportedRecords.includes(recordType)) gap("unsupported_format", `物理记录 ${row} 的顶层类型 ${recordType} 尚未适配`, { key: "diagnostics.history.adapters.codex.m009", params: { p0: row, p1: String(recordType) } });
  },
};
