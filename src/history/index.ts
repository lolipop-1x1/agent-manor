import { createHash } from "node:crypto";
import { open, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Baseline, Client, EvidenceFragment, Gap, HistoryEvent, JsonValue, ParsedSource, SourceReference } from "../contracts.js";
import { PARSER_RULE_VERSION } from "../version.js";
import { json, number, object, physicalLines, returnedText, shellEvidence, shellResult, string, textContent, toolEvidence, unifiedFragments } from "./extraction.js";
import type { DiscoverRoots, HistoryCursor, HistoryRelationship, ParsedHistorySource, PendingCall, SharedHistoryResult, SourceAssociation, SourceLocation } from "./types.js";

export type { DiscoverRoots, HistoryRelationship, ParsedHistorySource, SharedHistoryResult, SourceAssociation, SourceLocation } from "./types.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const git = promisify(execFile);

export function normalizeHistoryPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("file:")) {
    try { return fileURLToPath(value); } catch { return undefined; }
  }
  return isAbsolute(value) ? resolve(value) : value;
}

function sourceMetadata(raw: unknown, client: Client, path: string): SourceLocation {
  const record = object(raw);
  const payload = client === "codex" ? object(record.payload) : record;
  const sessionId = client === "codex" ? string(payload.id) ?? string(payload.session_id) : string(record.sessionId);
  const agentId = string(record.agentId);
  const cwd = normalizeHistoryPath(string(payload.cwd));
  const parentSessionId = string(payload.forked_from_id) ?? string(payload.parent_thread_id) ?? string(record.parentSessionId);
  return {
    path, client, cwd, sessionId: agentId && sessionId ? `${sessionId}/agent/${agentId}` : sessionId,
    parentSessionId,
    sourceId: sessionId ? `${client}:${hash(JSON.stringify({ sessionId, agentId, timestamp: client === "codex" ? payload.timestamp ?? record.timestamp : undefined, cwd: client === "codex" ? cwd : undefined })).slice(0, 24)}` : undefined,
  };
}

/** 发现只读至多 64 KiB 的头部；正文留给已选来源的 parseSource。 */
export async function discoverSources(roots: DiscoverRoots = {}): Promise<SourceLocation[]> {
  const codex = roots.codex ?? (process.env.AGENT_MANOR_CODEX_DIR ? [process.env.AGENT_MANOR_CODEX_DIR] : [join(homedir(), ".codex/sessions"), join(homedir(), ".codex/archived_sessions")]);
  const claude = roots.claude ?? (process.env.AGENT_MANOR_CLAUDE_DIR ? [process.env.AGENT_MANOR_CLAUDE_DIR] : [join(homedir(), ".claude/projects")]);
  const found: SourceLocation[] = [];
  const paths = new Set<string>();
  async function walk(path: string, client: Client): Promise<void> {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if (object(error).code === "ENOENT") return; throw error; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child, client);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && !paths.has(child)) {
        paths.add(child);
        const handle = await open(child, "r");
        let metadata: SourceLocation = { path: child, client };
        try {
          const buffer = Buffer.alloc(65_536);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n").slice(0, 32)) {
            try {
              const record = object(JSON.parse(line));
              if (client === "codex" && record.type === "session_meta") {
                metadata = sourceMetadata(record, client, child); break;
              }
              if (client === "claude" && record.sessionId) {
                const candidate = sourceMetadata(record, client, child);
                if (!candidate.sourceId) continue;
                if (!metadata.sourceId) metadata = { ...candidate, cwd: undefined };
                if (candidate.sourceId !== metadata.sourceId) continue;
                if (candidate.cwd && isAbsolute(candidate.cwd)) { metadata.cwd = candidate.cwd; break; }
              }
            } catch { /* 发现阶段不把坏行误认为有效元数据。 */ }
          }
        } finally { await handle.close(); }
        found.push(metadata);
      }
    }
  }
  for (const root of typeof codex === "string" ? [codex] : codex) await walk(resolve(root), "codex");
  for (const root of typeof claude === "string" ? [claude] : claude) await walk(resolve(root), "claude");
  return found;
}

function cursorOf(source: ParsedSource | undefined): HistoryCursor | undefined {
  const cursor = object(source?.cursor);
  if (cursor.ruleVersion !== PARSER_RULE_VERSION || typeof cursor.prefixHash !== "string" || !Array.isArray(cursor.pending)
    || !Array.isArray(cursor.recordEnds) || !Array.isArray(cursor.relationships)) return undefined;
  return cursor as unknown as HistoryCursor;
}

function relations(record: Record<string, unknown>): HistoryRelationship[] {
  const payload = object(record.payload);
  const history = object(payload.history_base);
  const forkParent = string(history.thread_id) ?? string(payload.forked_from_id);
  if (forkParent) return [{ kind: "fork", parentSessionId: forkParent, endByteOffset: number(history.end_byte_offset), endOrdinalExclusive: number(history.end_ordinal_exclusive) ?? number(payload.forked_from_ordinal_exclusive) }];
  const source = object(payload.source);
  const spawn = object(object(source.subagent).thread_spawn);
  const parent = string(payload.parent_thread_id) ?? string(spawn.parent_thread_id) ?? string(record.parentSessionId);
  return parent ? [{ kind: "subagent", parentSessionId: parent, agentId: string(record.agentId) }] : [];
}

/** prefixHash 验证完整旧前缀后只解析追加记录；尾部不完整 JSONL 保留至下一轮。 */
export async function parseSource(path: string, client: Client, previous?: ParsedSource): Promise<ParsedHistorySource> {
  const absolutePath = resolve(path);
  const bytes = await readFile(absolutePath);
  const oldCursor = cursorOf(previous);
  const appended = oldCursor && previous?.client === client && bytes.length >= oldCursor.completeBytes
    && hash(bytes.subarray(0, oldCursor.completeBytes)) === oldCursor.prefixHash;
  const cursor: HistoryCursor = appended ? structuredClone(oldCursor) : {
    ruleVersion: PARSER_RULE_VERSION, prefixHash: hash(""), completeBytes: 0, recordLine: 0,
    pending: [], seen: {}, occurrences: {}, recordEnds: [], relationships: [], parsedRecords: 0,
  };
  cursor.parsedRecords = 0;
  const source: ParsedHistorySource = appended && previous ? {
    ...structuredClone(previous), path: absolutePath, hash: hash(bytes), relationships: cursor.relationships,
    gaps: previous.gaps.filter((gap) => !["unpaired_call", "incomplete_record"].includes(gap.kind)),
  } : { sourceId: `${client}:unidentified:${hash(absolutePath).slice(0, 24)}`, client, path: absolutePath, hash: hash(bytes), sessionId: `unknown:${hash(absolutePath).slice(0, 16)}`, events: [], gaps: [], completeBytes: 0, relationships: [] };
  for (const event of source.events) for (const reference of event.sources) reference.path = absolutePath;
  const eventById = new Map(source.events.map((event) => [event.id, event]));
  const gap = (kind: Gap["kind"], message: string) => source.gaps.push({ kind, message, sourceId: source.sourceId });
  const reference = (recordLine: number, raw: string, callId?: string): SourceReference => ({ sourceId: source.sourceId, path: absolutePath, recordLine, hash: hash(raw), callId });
  const findEvent = (id: string) => eventById.get(id);
  const identity = (key: string): string => {
    const occurrence = (cursor.occurrences[key] ?? 0) + 1;
    cursor.occurrences[key] = occurrence;
    return `${source.sourceId}:${hash(`${key}:${occurrence}`).slice(0, 24)}`;
  };
  function createEvent(tool: string, input: unknown, row: number, raw: string, occurredAt?: string, cwd?: string, key?: string): HistoryEvent {
    const extracted = tool === "apply_patch" ? patchEvidence(string(input) ?? string(object(input).patch) ?? "")[0]! : toolEvidence(tool, input, {}, "")[0]!;
    const event: HistoryEvent = {
      id: identity(key ?? `${tool}:${row}:${hash(raw)}`), client, sessionId: source.sessionId, parentSessionId: source.parentSessionId,
      occurredAt, tool, kind: extracted.kind, status: "unknown", cwd: normalizeHistoryPath(cwd) ?? cursor.cwd ?? source.cwd,
      path: extracted.path, fragments: [], sources: [reference(row, raw)], input: json(input), reason: "调用结果尚未配对",
    };
    source.events.push(event);
    eventById.set(event.id, event);
    return event;
  }
  function finish(call: PendingCall, result: unknown, visible: string, status: HistoryEvent["status"], row: number, raw: string, reason?: string) {
    const event = findEvent(call.eventId);
    if (!event) return;
    const resultRef = reference(row, raw, call.callId);
    event.sources.push(resultRef);
    event.output = json({ result, visibleOutput: visible });
    event.status = status;
    if (call.wrapper) {
      const concrete = source.events.filter((candidate) => candidate.id !== event.id && ["CommandExecution", "FileChange"].includes(candidate.tool)
        && candidate.sources.some((ref) => ref.recordLine > call.recordLine && ref.recordLine < row));
      if (concrete.length) {
        for (const candidate of concrete) candidate.sources.push(...event.sources);
        source.events = source.events.filter((candidate) => candidate.id !== event.id);
      } else {
        event.reason = "unsupported_tool: exec 包装未发现具体事件，未执行或猜测 JavaScript";
        gap("unsupported_tool", event.reason);
      }
      return;
    }
    if (["shell_command", "exec_command"].includes(call.tool)) {
      const requested = string(object(call.input).cmd) ?? string(object(call.input).command);
      const concrete = source.events.filter((candidate) => candidate.tool === "CommandExecution"
        && candidate.sources.some((ref) => ref.recordLine > call.recordLine && ref.recordLine < row)
        && string((Array.isArray(object(candidate.input).command) ? object(candidate.input).command as unknown[] : []).at(-1)) === requested
        && candidate.cwd === event.cwd
        && returnedText(string(object(candidate.output).formatted_output) ?? "").content === returnedText(visible).content);
      if (concrete.length === 1) {
        concrete[0]!.sources.push(...event.sources);
        source.events = source.events.filter((candidate) => candidate.id !== event.id);
        return;
      }
      if (concrete.length > 1) gap("ambiguous", "直接调用与具体命令事件存在多个对应候选，未合并身份");
    }
    let extracted = toolEvidence(call.tool, call.input, result, visible);
    if (call.tool === "apply_patch") extracted = patchEvidence(string(call.input) ?? string(object(call.input).patch) ?? "");
    extracted.forEach((evidence, index) => {
      const target = index === 0 ? event : { ...event, id: `${event.id}:file:${index}`, sources: [...event.sources] };
      target.kind = evidence.kind;
      target.path = evidence.path;
      target.fragments = status === "success" ? evidence.fragments : [];
      target.reason = reason ?? (status === "success" ? evidence.reason : status === "failure" ? "工具执行失败" : "未确认工具成功终态");
      if (index) source.events.push(target);
      if (target.reason?.startsWith("range_unknown:")) gap("range_unknown", target.reason);
      if (target.reason?.startsWith("unsupported_tool:")) gap("unsupported_tool", target.reason);
    });
  }
  function pair(callId: string, requestUuid?: string): PendingCall | undefined {
    const matching = cursor.pending.filter((call) => call.callId === callId && (!requestUuid || call.requestUuid === requestUuid));
    if (matching.length !== 1) {
      gap(matching.length ? "ambiguous" : "unpaired_call", matching.length ? `调用 ${callId} 有多个待配对出现位置` : `结果 ${callId} 没有请求`);
      return undefined;
    }
    const call = matching[0]!;
    cursor.pending = cursor.pending.filter((candidate) => candidate !== call);
    return call;
  }
  let position = cursor.completeBytes;
  while (position < bytes.length) {
    const newline = bytes.indexOf(10, position);
    if (newline < 0) break;
    const raw = bytes.subarray(position, newline).toString("utf8");
    position = newline + 1;
    cursor.recordLine += 1;
    cursor.parsedRecords += 1;
    cursor.recordEnds.push(position);
    const row = cursor.recordLine;
    let record: Record<string, unknown>;
    try { record = object(JSON.parse(raw)); }
    catch { gap("parse_error", `物理记录 ${row} 不是有效 JSON`); continue; }
    const payload = object(record.payload);
    const occurredAt = string(record.timestamp);
    if (client === "codex" && record.type === "session_meta") {
      const metadata = sourceMetadata(record, client, absolutePath);
      source.sourceId = metadata.sourceId ?? source.sourceId;
      source.sessionId = metadata.sessionId ?? source.sessionId;
      source.cwd = metadata.cwd;
      source.parentSessionId = metadata.parentSessionId;
      cursor.cwd = metadata.cwd;
      cursor.relationships = relations(record);
      source.relationships = cursor.relationships;
      continue;
    }
    if (client === "codex" && record.type === "turn_context") { cursor.cwd = normalizeHistoryPath(string(payload.cwd)) ?? cursor.cwd; continue; }
    if (client === "claude" && record.sessionId) {
      const metadata = sourceMetadata(record, client, absolutePath);
      if (source.sessionId.startsWith("unknown:")) {
        source.sourceId = metadata.sourceId ?? source.sourceId;
        source.sessionId = metadata.sessionId ?? source.sessionId;
        source.cwd = metadata.cwd && isAbsolute(metadata.cwd) ? metadata.cwd : undefined;
        source.parentSessionId = metadata.parentSessionId;
        cursor.relationships = relations(record);
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
    if (client === "codex" && record.type === "event_msg" && payload.type === "item_completed") {
      const item = object(payload.item);
      if (!["CommandExecution", "FileChange"].includes(string(item.type) ?? "")) continue;
      const key = `concrete:${string(payload.thread_id) ?? source.sessionId}:${string(item.id) ?? row}:${payload.started_at_ms ?? ""}:${payload.completed_at_ms ?? ""}:${occurredAt ?? ""}:${hash(JSON.stringify(item))}`;
      const existingId = cursor.seen[key];
      if (existingId) { findEvent(existingId)?.sources.push(reference(row, raw)); continue; }
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
        evidence.forEach((part, index) => {
          const target = index ? { ...event, id: `${event.id}:file:${index}`, sources: [...event.sources] } : event;
          target.kind = part.kind; target.path = part.path;
          target.fragments = event.status === "success" && output !== undefined ? part.fragments : [];
          target.reason = output === undefined ? "range_unknown: 具体命令缺少 formatted_output；未采用 stdout 补足" : event.status !== "success" ? "命令未成功完成" : part.reason;
          if (index) source.events.push(target);
          if (target.reason?.startsWith("range_unknown:")) gap("range_unknown", target.reason);
          if (target.reason?.startsWith("unsupported_tool:")) gap("unsupported_tool", target.reason);
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
          target.reason = event.status !== "success" ? "文件修改未成功" : change.type === "delete" ? "range_unknown: 文件删除保留编辑活动，无当前新增行" : change.move_path ? "range_unknown: move_path 关系保留在输入；路径移动不证明当前内容对应" : undefined;
          if (index) source.events.push(target);
          if (target.reason) gap("range_unknown", target.reason);
        });
      }
      continue;
    }
    if (client === "codex" && record.type === "response_item") {
      const type = string(payload.type);
      if (type === "function_call" || type === "custom_tool_call") {
        const tool = string(payload.name) ?? "unknown";
        const callId = string(payload.call_id) ?? `record:${row}`;
        let input: unknown = payload.input ?? {};
        if (typeof payload.arguments === "string") {
          try { input = JSON.parse(payload.arguments); } catch { gap("unsupported_format", `调用 ${row} arguments 不是有效 JSON`); }
        }
        const key = payload.id ? `request:${payload.id}:${callId}:${hash(JSON.stringify(input))}` : undefined;
        if (key && cursor.seen[key]) { findEvent(cursor.seen[key])?.sources.push(reference(row, raw, callId)); continue; }
        const event = createEvent(tool, input, row, raw, occurredAt, string(object(input).workdir), key);
        event.sources[0]!.callId = callId;
        if (key) cursor.seen[key] = event.id;
        cursor.pending.push({ eventId: event.id, callId, tool, input: json(input), recordLine: row, wrapper: tool === "exec", turnId: string(payload.turn_id) });
      } else if (type === "function_call_output" || type === "custom_tool_call_output") {
        const callId = string(payload.call_id) ?? "";
        const outputKey = `output:${callId}:${hash(raw)}`;
        if (cursor.seen[outputKey] && !cursor.pending.some((pending) => pending.callId === callId)) { findEvent(cursor.seen[outputKey])?.sources.push(reference(row, raw, callId)); continue; }
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
          finish(call, structuredOutput, result.output || textContent(payload.output), status, row, raw, status === "unknown" ? result.reason : undefined);
          cursor.seen[outputKey] = call.eventId;
        }
      }
      continue;
    }
    if (client === "claude") {
      const message = object(record.message);
      const blocks = Array.isArray(message.content) ? message.content : [];
      const results = blocks.filter((block) => object(block).type === "tool_result");
      blocks.forEach((value, index) => {
        const block = object(value);
        if (block.type === "tool_use") {
          const callId = string(block.id) ?? `record:${row}:${index}`;
          const uuid = string(record.uuid);
          const key = uuid ? `request:${uuid}:${callId}:${index}:${hash(JSON.stringify(block))}` : undefined;
          if (key && cursor.seen[key]) { findEvent(cursor.seen[key])?.sources.push(reference(row, raw, callId)); return; }
          const tool = string(block.name) ?? "unknown";
          const event = createEvent(tool, block.input, row, raw, occurredAt, string(record.cwd), key);
          event.sources[0]!.callId = callId;
          if (key) cursor.seen[key] = event.id;
          cursor.pending.push({ eventId: event.id, callId, requestUuid: uuid, tool, input: json(block.input), recordLine: row });
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
    }
    const supportedRecords = client === "codex" ? ["session_meta", "turn_context", "event_msg", "response_item", "compacted", "compaction"]
      : ["assistant", "user", "system", "progress", "summary", "file-history-snapshot", "file-history-delta", "attachment", "mode", "permission-mode", "last-prompt", "queue-operation"];
    if (!supportedRecords.includes(string(record.type) ?? "")) gap("unsupported_format", `物理记录 ${row} 的顶层类型尚未适配`);
  }
  cursor.completeBytes = position;
  cursor.prefixHash = hash(bytes.subarray(0, position));
  source.completeBytes = position;
  source.cursor = json(cursor);
  if (position < bytes.length) gap("incomplete_record", "末尾记录尚未以换行完成，等待下一轮补齐");
  for (const call of cursor.pending) gap("unpaired_call", `调用 ${call.callId} 的出现位置 ${call.recordLine} 尚无可确认结果`);
  return source;
}

function patchEvidence(patch: string) {
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

function inside(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate));
}

async function commonDir(path: string): Promise<string | undefined> {
  try {
    const result = await git("git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 5_000 });
    return canonicalPath(resolve(result.stdout.trim()));
  } catch { return undefined; }
}

async function canonicalPath(path: string): Promise<string> {
  let ancestor = path;
  while (true) {
    try { return resolve(await realpath(ancestor), relative(ancestor, path)); }
    catch { const parent = dirname(ancestor); if (parent === ancestor) return resolve(path); ancestor = parent; }
  }
}

/** 仅映射实际属于基线的路径；同 commonDir worktree 以相对路径映射。 */
export async function associateSource(source: ParsedSource, baseline: Baseline): Promise<SourceAssociation> {
  const parsed: ParsedHistorySource = { ...source, relationships: (source as ParsedHistorySource).relationships ?? cursorOf(source)?.relationships ?? [] };
  const events: HistoryEvent[] = [];
  const gaps: Gap[] = [];
  const root = await canonicalPath(resolve(baseline.repository.path));
  const repositoryCommonDir = await canonicalPath(resolve(baseline.repository.commonDir));
  const available = new Set(baseline.files.map((file) => file.path));
  const commonCache = new Map<string, string | undefined>();
  const worktreeRootCache = new Map<string, string>();
  async function relativePath(path: string | undefined, cwd: string | undefined): Promise<string | undefined> {
    const normalized = normalizeHistoryPath(path);
    const working = normalizeHistoryPath(cwd);
    if (!normalized) return undefined;
    const rawAbsolute = isAbsolute(normalized) ? normalized : working && isAbsolute(working) ? resolve(working, normalized) : undefined;
    if (!rawAbsolute) return undefined;
    const absolute = await canonicalPath(rawAbsolute);
    if (inside(root, absolute)) return relative(root, absolute).split(sep).join("/");
    if (working && isAbsolute(working)) {
      if (!commonCache.has(working)) commonCache.set(working, await commonDir(working));
      if (commonCache.get(working) === repositoryCommonDir) {
        let worktreeRoot = worktreeRootCache.get(working);
        if (!worktreeRoot) {
          try { worktreeRoot = (await git("git", ["-C", working, "rev-parse", "--show-toplevel"], { timeout: 5_000 })).stdout.trim(); } catch { return undefined; }
          if (worktreeRoot) {
            worktreeRoot = await canonicalPath(worktreeRoot);
            worktreeRootCache.set(working, worktreeRoot);
          }
        }
        if (worktreeRoot && inside(worktreeRoot, absolute)) return relative(worktreeRoot, absolute).split(sep).join("/");
      }
    }
    return undefined;
  }
  for (const event of source.events) {
    if (!event.path) {
      const cwd = normalizeHistoryPath(event.cwd ?? source.cwd);
      if (cwd && isAbsolute(cwd) && inside(root, await canonicalPath(cwd))) events.push({ ...event, fragments: [] });
      continue;
    }
    const path = await relativePath(event.path, event.cwd ?? source.cwd);
    if (path === undefined) continue;
    const fragments: EvidenceFragment[] = [];
    for (const fragment of event.fragments) {
      const fragmentPath = fragment.path ? await relativePath(fragment.path, event.cwd ?? source.cwd) : path;
      if (fragmentPath !== undefined) fragments.push({ ...fragment, path: fragmentPath });
    }
    events.push({ ...event, path, fragments });
    if (!available.has(path)) gaps.push({ kind: "range_unknown", message: `历史文件 ${path} 不在当前仓库基线中`, sourceId: source.sourceId });
  }
  const cwd = normalizeHistoryPath(source.cwd);
  const belongsByCwd = Boolean(cwd && isAbsolute(cwd) && inside(root, await canonicalPath(cwd)));
  const associated = events.length > 0 || belongsByCwd;
  if (!associated) gaps.push({ kind: "unassociated", message: "来源工作目录与逐事件路径无法可靠归属仓库", sourceId: source.sourceId });
  return { associated, source: parsed, events, gaps, reason: events.length ? "逐事件路径或 Git commonDir 确认" : belongsByCwd ? "来源 cwd 属于仓库，外部路径活动已排除" : "归属未知" };
}

/** 只有明确 fork 来源与完整父字节边界能证明共享历史；文本相同不去重。 */
export function resolveSharedHistory(sources: ParsedSource[]): SharedHistoryResult {
  const bySession = new Map<string, ParsedSource[]>();
  for (const source of sources) bySession.set(source.sessionId, [...(bySession.get(source.sessionId) ?? []), source]);
  const events = new Map<string, HistoryEvent>();
  const gaps: Gap[] = [];
  const relationships: SharedHistoryResult["relationships"] = [];
  const identities = new Map<ParsedSource, Map<string, string>>();
  function eventIdentity(source: ParsedSource, event: HistoryEvent): string | undefined {
    if (!identities.has(source)) {
      identities.set(source, new Map(Object.entries(cursorOf(source)?.seen ?? {}).filter(([key]) => key.startsWith("concrete:") || key.startsWith("request:")).map(([key, id]) => [id, key])));
    }
    return identities.get(source)!.get(event.id.replace(/:file:\d+$/, ""));
  }
  for (const source of sources) {
    const cursor = cursorOf(source);
    const shared = (source as ParsedHistorySource).relationships ?? cursor?.relationships ?? [];
    const copied = new Map<string, { event: HistoryEvent; identity?: string }>();
    for (const relationship of shared) {
      const parents = bySession.get(relationship.parentSessionId) ?? [];
      const parent = parents.find((candidate) => relationship.endByteOffset !== undefined && cursorOf(candidate)?.recordEnds.includes(relationship.endByteOffset));
      const resolved = relationship.kind === "subagent" ? parents.length > 0 : Boolean(parent);
      relationships.push({ sourceId: source.sourceId, relationship, resolved });
      if (!resolved) gaps.push({ kind: parents.length ? "ambiguous" : "source_missing", sourceId: source.sourceId, message: relationship.kind === "fork" ? "fork 父来源缺失或引用字节位置不是完整记录边界；未重造共享调用" : "子会话父来源缺失" });
      if (parent && relationship.kind === "fork") {
        const endRow = cursorOf(parent)!.recordEnds.indexOf(relationship.endByteOffset!) + 1;
        for (const event of parent.events) {
          const parentRefs = event.sources.filter((reference) => reference.sourceId === parent.sourceId);
          if (parentRefs.length && parentRefs.every((reference) => reference.recordLine <= endRow)) {
            const proof = [...new Set(parentRefs.map((reference) => reference.hash))].sort().join(":");
            copied.set(proof, { event, identity: eventIdentity(parent, event) });
            mergeEvent(events, event, gaps);
          }
        }
      }
    }
    for (const event of source.events) {
      const proof = [...new Set(event.sources.filter((reference) => reference.sourceId === source.sourceId).map((reference) => reference.hash))].sort().join(":");
      const candidate = copied.get(proof);
      const identity = candidate ? eventIdentity(source, event) : undefined;
      const original = candidate?.identity && identity === candidate.identity ? candidate.event : undefined;
      if (candidate && !original) gaps.push({ kind: "ambiguous", sourceId: source.sourceId, message: "fork 记录内容相同但缺少可确认的原事件身份，未按文本去重" });
      mergeEvent(events, original ? { ...event, id: original.id, sessionId: original.sessionId } : event, gaps);
    }
  }
  return { events: [...events.values()], gaps, relationships };
}

function mergeEvent(events: Map<string, HistoryEvent>, event: HistoryEvent, gaps: Gap[]) {
  const existing = events.get(event.id);
  if (!existing) { events.set(event.id, structuredClone(event)); return; }
  const seen = new Set(existing.sources.map((reference) => `${reference.path}:${reference.recordLine}:${reference.hash}`));
  if (existing.status === "unknown" && event.status !== "unknown") {
    existing.status = event.status;
    existing.fragments = structuredClone(event.fragments);
    existing.output = event.output;
    existing.reason = event.reason;
  } else if (existing.status !== "unknown" && event.status !== "unknown" && existing.status !== event.status) {
    existing.status = "unknown";
    existing.fragments = [];
    existing.reason = "ambiguous: 同一事件身份存在相互矛盾的成功与失败结果";
    gaps.push({ kind: "ambiguous", message: existing.reason });
  }
  for (const reference of event.sources) {
    const key = `${reference.path}:${reference.recordLine}:${reference.hash}`;
    if (!seen.has(key)) { existing.sources.push(reference); seen.add(key); }
  }
}
