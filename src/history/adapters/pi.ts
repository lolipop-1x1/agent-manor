import { createReadStream } from "node:fs";
import { isAbsolute, basename, dirname } from "node:path";
import type { SessionMessage } from "../../session-contracts.js";
import { changedFragments, number, object, physicalLines, shellEvidence, string, textContent, toolEvidence, unifiedFragments } from "../extraction.js";
import { normalizeHistoryPath } from "./common.js";
import { createNormalizedAdapter, normalizedHash, normalizedRecord, normalizedSnapshot, readBoundedJsonl, type NormalizedEvent, type NormalizedSessionMetadata, type NormalizedSnapshot, type RawHistoryRecord } from "./normalized.js";
import type { SourceLocation } from "../types.js";

const PI_FORMAT = "pi-jsonl";
type NativeRow = RawHistoryRecord & { record: Record<string, unknown> };

function dateValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function tokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function piUsage(value: unknown): NormalizedEvent["usage"] {
  const usage = object(value);
  const input = tokenCount(usage.input);
  const cacheRead = tokenCount(usage.cacheRead);
  const cacheWrite = tokenCount(usage.cacheWrite);
  const output = tokenCount(usage.output);
  const reasoning = tokenCount(usage.reasoning);
  const normalized = {
    ...(input !== undefined && cacheRead !== undefined && cacheWrite !== undefined
      ? { inputTokens: input + cacheRead + cacheWrite } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cacheRead !== undefined ? { cachedInputTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
  };
  return Object.keys(normalized).length ? normalized : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.map(item => string(object(item).text) ?? "").filter(Boolean).join("\n") : "";
}

/** Pi 原生 /skill 展开包已经包含读取的正文；普通 /skill 字样不作为使用证据。 */
function expandedSkill(text: string): SessionMessage["resource"] {
  const match = /^<skill name="([^"\n]+)" location="([^"\n]+)">\nReferences are relative to ([^\n]+)\.\n\n([\s\S]+)\n<\/skill>(?:\n\n[\s\S]+)?$/.exec(text);
  if (!match || !isAbsolute(match[2]!) || basename(match[2]!) !== "SKILL.md"
    || dirname(match[2]!) !== match[3] || !match[4]!.trim() || /<\/?skill\b/.test(match[4]!)) return undefined;
  return { kind: "skill_read", name: match[1]!, path: match[2] };
}

function parentSessionId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const name = basename(value, ".jsonl");
  const match = /_([A-Za-z0-9-]{8,})$/.exec(name);
  return match?.[1];
}

function hasToolCalls(message: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(message.content) ? message.content.map(object).filter(block => block.type === "toolCall") : [];
}

function assistantUsage(message: Record<string, unknown>): NormalizedEvent["usage"] {
  return piUsage(message.usage);
}

function readEvidence(inputValue: unknown, resultValue: unknown): ReturnType<typeof toolEvidence> {
  const input = object(inputValue);
  const result = object(resultValue);
  const path = string(input.path);
  const details = object(result.details);
  const truncation = object(details.truncation);
  const text = textContent(result.content);
  if (result.isError === true) return [{ kind: "read", path, fragments: [], reason: "range_unknown: Pi read 执行失败", reasonDescriptor: { key: "diagnostics.history.adapters.pi.m001" } }];
  const offset = number(input.offset) ?? 1;
  if (!path || !Number.isSafeInteger(offset) || offset < 1) return [{ kind: "read", path, fragments: [], reason: "range_unknown: Pi read 缺少可核验路径或起始行", reasonDescriptor: { key: "diagnostics.history.adapters.pi.m002" } }];
  if (truncation.firstLineExceedsLimit === true || /^\[Line \d+ is .+ exceeds .+ limit\./.test(text)) {
    return [{ kind: "read", path, fragments: [], reason: "range_unknown: Pi read 首行超过返回上限", reasonDescriptor: { key: "diagnostics.history.adapters.pi.m003" } }];
  }
  let body = text;
  const footer = /\n\n\[(?:\d+ more lines in file\. Use offset=\d+ to continue\.|Showing lines \d+-\d+ of \d+(?: \([^\]]+\))?\. Use offset=\d+ to continue\.)\]$/;
  body = body.replace(footer, "");
  const lines = physicalLines(body);
  const partial = truncation.lastLinePartial === true;
  const fragments = lines.length && !partial ? [{ kind: "read" as const, content: `${body}${body && !body.endsWith("\n") ? "\n" : ""}`, historicalStart: offset, completeLines: true }] : [];
  const truncated = truncation.truncated === true || footer.test(text) || partial;
  return [{ kind: "read", path, fragments, ...(truncated ? { reason: "range_unknown: Pi read 只保留返回窗口，完整文件内容未记录", reasonDescriptor: { key: "diagnostics.history.adapters.pi.m004" } } : {}) }];
}

function editEvidence(inputValue: unknown, resultValue: unknown): ReturnType<typeof toolEvidence> {
  const input = object(inputValue);
  const result = object(resultValue);
  const path = string(input.path);
  if (result.isError === true) return [{ kind: "edit", path, fragments: [], reason: "range_unknown: Pi edit 执行失败", reasonDescriptor: { key: "diagnostics.history.adapters.pi.m005" } }];
  const details = object(result.details);
  const patch = string(details.patch) ?? string(details.diff);
  if (!patch) return [{ kind: "edit", path, fragments: [], reason: "range_unknown: Pi edit 结果缺少实际 patch", reasonDescriptor: { key: "diagnostics.history.adapters.pi.m006" } }];
  const fragments = unifiedFragments(patch, path);
  return [{ kind: "edit", path, fragments, ...fragments.length ? {} : { reason: "range_unknown: Pi edit patch 没有可定位 hunk", reasonDescriptor: { key: "diagnostics.history.adapters.pi.m007" } } }];
}

function piExtract(tool: string, input: unknown, result: unknown, visible: string): ReturnType<typeof toolEvidence> {
  const lower = tool.toLowerCase();
  if (lower === "read") return readEvidence(input, result);
  if (lower === "edit") return editEvidence(input, result);
  if (lower === "bash") {
    const details = object(object(result).details);
    if (object(details.truncation).truncated === true) {
      return [{ kind: "other", fragments: [], reason: "range_unknown: Pi bash 输出被截断，未推断读取范围", reasonDescriptor: { key: "diagnostics.history.adapters.pi.m008" } }];
    }
    const output = visible.replace(/\n\nCommand (?:exited with code -?\d+|timed out after .+|aborted|terminated without an exit code)$/s, "");
    return shellEvidence(string(object(input).command) ?? "", output);
  }
  if (lower === "write") {
    const call = object(input);
    const details = object(object(result).details);
    const patch = string(details.patch) ?? string(details.diff);
    if (object(result).isError === true) return [{ kind: "edit", path: string(call.path), fragments: [], reason: "range_unknown: Pi write 执行失败", reasonDescriptor: { key: "diagnostics.history.adapters.pi.m009" } }];
    if (patch) return [{ kind: "edit", path: string(call.path), fragments: unifiedFragments(patch, string(call.path)) }];
    const content = string(call.content);
    return content === undefined ? [{ kind: "edit", path: string(call.path), fragments: [], reason: "range_unknown: Pi write 缺少实际写入内容", reasonDescriptor: { key: "diagnostics.history.adapters.pi.m010" } }]
      : [{ kind: "edit", path: string(call.path), fragments: content ? [{ kind: "added", content, historicalStart: 1, completeLines: true, path: string(call.path) }] : [] }];
  }
  return toolEvidence(tool, input, result, visible);
}

function messageTimestamp(message: Record<string, unknown>, row: Record<string, unknown>): string | undefined {
  return dateValue(message.timestamp) ?? dateValue(row.timestamp);
}

function inheritedParentIds(parentPath: string, gaps: NonNullable<NormalizedSessionMetadata["gaps"]>): Promise<{ ids: Set<string>; fingerprint: string }> {
  return (async () => {
    const parentRows = await readBoundedJsonl(parentPath, gaps, createReadStream(parentPath)) as NativeRow[];
    const ids = new Set(parentRows.filter(row => row.record.type !== "session").map(row => string(row.record.id)).filter((id): id is string => Boolean(id)));
    return { ids, fingerprint: [...ids].sort().join("\u0000") };
  })();
}

async function snapshot(location: SourceLocation): Promise<NormalizedSnapshot> {
  const gaps: NonNullable<NormalizedSessionMetadata["gaps"]> = [];
  const rows = await readBoundedJsonl(location.path, gaps, createReadStream(location.path)) as NativeRow[];
  const header = rows[0]?.record.type === "session" ? rows[0]!.record : undefined;
  if (!header) {
    gaps.push({ kind: "unsupported_format", message: "Pi 来源缺少会话头记录", messageDescriptor: { key: "diagnostics.history.adapters.pi.m011" } });
    return normalizedSnapshot(location, [], { gaps });
  }
  const id = string(header.id) ?? location.sessionId;
  const parentPath = string(header.parentSession);
  const parentId = parentSessionId(parentPath);
  const cwd = normalizeHistoryPath(string(header.cwd));
  const source: SourceLocation = { ...location, format: PI_FORMAT, sessionId: id, cwd, parentSessionId: parentId };
  let inheritedIds = new Set<string>();
  let parentFingerprint = "";
  if (parentPath && isAbsolute(parentPath) && parentPath !== location.path) {
    try {
      const parent = await inheritedParentIds(parentPath, []);
      inheritedIds = parent.ids;
      parentFingerprint = parent.fingerprint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      gaps.push({ kind: "source_missing", message: "Pi 分叉父文件已缺失，无法核验复制记录", messageDescriptor: { key: "diagnostics.history.adapters.pi.m012" } });
    }
  } else if (parentPath) gaps.push({ kind: "source_missing", message: "Pi 分叉父文件路径缺少可核验的绝对来源", messageDescriptor: { key: "diagnostics.history.adapters.pi.m013" } });
  if (parentPath && !parentId) gaps.push({ kind: "ambiguous", message: "Pi 分叉父文件名不能解析成原生会话身份", messageDescriptor: { key: "diagnostics.history.adapters.pi.m014" } });
  const entries = rows.slice(1).filter(row => string(row.record.id));
  const byId = new Map<string, NativeRow>();
  for (const row of entries) {
    const entryId = string(row.record.id)!;
    if (byId.has(entryId)) gaps.push({ kind: "ambiguous", message: "Pi 会话包含重复事件身份，按首次记录建立分支", messageDescriptor: { key: "diagnostics.history.adapters.pi.m015" } });
    else byId.set(entryId, row);
  }
  const children = new Set(entries.map(row => string(row.record.parentId)).filter((value): value is string => Boolean(value)));
  const leaves = entries.filter(row => !children.has(string(row.record.id)!));
  const lastId = string(entries.at(-1)?.record.id);
  if (lastId && !leaves.some(row => row.record.id === lastId)) gaps.push({ kind: "ambiguous", message: "Pi 最后保存事件不是树叶，当前分支定位不完整", messageDescriptor: { key: "diagnostics.history.adapters.pi.m016" } });
  const branchPaths = new Map<string, NativeRow[]>();
  for (const leaf of leaves) {
    const path: NativeRow[] = [];
    const seen = new Set<string>();
    let current: NativeRow | undefined = leaf;
    while (current) {
      const currentId = string(current.record.id)!;
      if (seen.has(currentId)) { gaps.push({ kind: "parse_error", message: "Pi 事件树含循环父链", messageDescriptor: { key: "diagnostics.history.adapters.pi.m017" } }); break; }
      seen.add(currentId);
      path.push(current);
      const parent = string(current.record.parentId);
      if (!parent) break;
      const parentRow = byId.get(parent);
      if (!parentRow) { gaps.push({ kind: "source_missing", message: "Pi 事件树父身份不在来源内", messageDescriptor: { key: "diagnostics.history.adapters.pi.m018" } }); break; }
      current = parentRow;
    }
    branchPaths.set(string(leaf.record.id)!, path.reverse());
  }
  const memberships = new Map<string, string[]>();
  for (const [leafId, path] of branchPaths) for (const row of path) {
    const entryId = string(row.record.id)!;
    memberships.set(entryId, [...(memberships.get(entryId) ?? []), leafId]);
  }
  const currentPath = branchPaths.get(lastId ?? "") ?? [];
  const turnKeys = new Map<string, string>();
  for (const path of branchPaths.values()) {
    let turnKey: string | undefined;
    for (const row of path) {
      const entryId = string(row.record.id)!;
      if (row.record.type === "message" && object(row.record.message).role === "user") turnKey = entryId;
      turnKeys.set(entryId, turnKey ?? "");
    }
  }
  const finalIds = new Set<string>();
  const interruptedIds = new Set<string>();
  for (const path of branchPaths.values()) {
    let turnKey: string | undefined;
    const callsByTurn = new Map<string, Set<string>>();
    const callTurn = new Map<string, string>();
    const candidates = new Map<string, { id: string; stopReason: string; hasCalls: boolean }>();
    for (const row of path) {
      const entry = row.record;
      const entryId = string(entry.id)!;
      if (entry.type === "message") {
        const message = object(entry.message);
        if (message.role === "user") { turnKey = entryId; continue; }
        if (message.role === "assistant") {
          const blocks = hasToolCalls(message);
          if (turnKey) {
            const calls = callsByTurn.get(turnKey) ?? new Set<string>();
            for (const block of blocks) {
              const callId = string(block.id);
              if (callId) { calls.add(callId); callTurn.set(callId, turnKey); }
            }
            callsByTurn.set(turnKey, calls);
            candidates.set(turnKey, { id: entryId, stopReason: string(message.stopReason) ?? "", hasCalls: blocks.length > 0 });
          }
        } else if (message.role === "toolResult") {
          const callId = string(message.toolCallId);
          const owner = callId ? callTurn.get(callId) : undefined;
          if (callId && owner) callsByTurn.get(owner)?.delete(callId);
        }
      }
    }
    for (const [candidateTurn, candidate] of candidates) {
      const pendingCalls = callsByTurn.get(candidateTurn)?.size ?? 0;
      if (candidate.stopReason === "stop" && !candidate.hasCalls && pendingCalls === 0) finalIds.add(candidate.id);
      else if (["error", "aborted", "length"].includes(candidate.stopReason) || pendingCalls > 0) interruptedIds.add(candidate.id);
    }
  }
  const branches = [...branchPaths.keys()].map((branchId, index) => ({ id: branchId,
    label: branchId === lastId ? "当前分支" : `分支 ${index + 1}`,
    labelDescriptor: { key: branchId === lastId ? "sessions.branch.current" : "sessions.branch.number", params: { number: index + 1 } }, current: branchId === lastId }));
  let title: string | undefined;
  for (const row of entries) if (row.record.type === "session_info") title = string(row.record.name)?.trim() || title;
  const metadata: NormalizedSessionMetadata = {
    ...(title ? { title, titleOrigin: "recorded" as const } : {}),
    ...(parentId ? { parentSessionId: parentId, relationship: "fork" as const, relationships: [{ kind: "fork" as const, parentSessionId: parentId,
      ...(inheritedIds.size ? { copiedRecordIdentityHashes: [...inheritedIds].map(normalizedHash) } : {}) }] } : {}),
    branches,
    gaps,
  };
  const records = [] as ReturnType<typeof normalizedRecord>[];
  for (const row of entries) {
    const entry = row.record;
    const id = string(entry.id)!;
    const treeBranches = memberships.get(id) ?? [];
    const currentBranch = currentPath.some(item => item.record.id === id);
    const turnKey = turnKeys.get(id) || undefined;
    const occurredAt = dateValue(entry.timestamp);
    const copied = inheritedIds.has(id);
    const base = { occurredAt, turnKey, branchIds: treeBranches, currentBranch, copied, nativeIdentityHash: normalizedHash(id) };
    const add = (event: NormalizedEvent, keySuffix = "") => records.push(normalizedRecord({ ...base, ...event, key: `pi:${id}${keySuffix}` }, row.raw, row.line));
    if (entry.type === "message") {
      const message = object(entry.message);
      const role = string(message.role);
      const time = messageTimestamp(message, entry);
      if (role === "user") {
        const text = contentText(message.content);
        const resource = expandedSkill(text);
        add({ key: "", kind: "user", text, resource, status: resource ? "success" : undefined, occurredAt: time, turnKey: id });
      } else if (role === "assistant") {
        const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
        const visible = blocks.filter(block => block.type === "text").map(block => string(block.text) ?? "").filter(Boolean).join("\n");
        const thinking = blocks.filter(block => block.type === "thinking").map(block => string(block.thinking) ?? "").filter(Boolean).join("\n");
        const usage = assistantUsage(message);
        const model = string(message.model);
        const final = finalIds.has(id) ? "inferred" : undefined;
        add({ key: "", kind: "assistant", ...(visible ? { text: visible } : {}), model, final, allowInferredFinal: false,
          interrupted: interruptedIds.has(id) || undefined, status: ["error"].includes(string(message.stopReason) ?? "") ? "failure" : undefined,
          usageKey: usage ? `${id}:usage` : undefined, usage }, ":assistant");
        if (thinking) add({ key: "", kind: "thinking", text: thinking, model }, ":thinking");
        for (const block of hasToolCalls(message)) {
          const callId = string(block.id);
          if (!callId) continue;
          add({ key: "", kind: "tool_call", callId, tool: string(block.name) ?? "unknown", input: block.arguments }, `:call:${callId}`);
        }
      } else if (role === "toolResult") {
        const callId = string(message.toolCallId);
        if (!callId) { gaps.push({ kind: "unpaired_call", message: "Pi 工具结果缺少原生 toolCallId", messageDescriptor: { key: "diagnostics.history.adapters.pi.m019" } }); continue; }
        const usage = piUsage(message.usage);
        add({ key: "", kind: "tool_result", callId, tool: string(message.toolName), text: contentText(message.content), result: message,
          status: message.isError === true ? "failure" : message.isError === false ? "success" : "unknown" }, ":tool-result");
        if (usage) gaps.push({ kind: "unsupported_format", message: "Pi 工具结果包含工具专用 usage，未并入模型 Token 汇总", messageDescriptor: { key: "diagnostics.history.adapters.pi.m020" } });
      } else if (role === "system") {
        add({ key: "", kind: "system", text: contentText(message.content), occurredAt: time });
      } else if (role === "custom") {
        add({ key: "", kind: "context", text: contentText(message.content), occurredAt: time });
      } else if (role === "bashExecution") {
        const callId = id;
        const command = string(message.command) ?? "";
        const status = message.cancelled === true ? "unknown" : typeof message.exitCode === "number" ? message.exitCode === 0 ? "success" : "failure" : "unknown";
        add({ key: "", kind: "tool_call", callId, tool: "bash", input: { command }, occurredAt: time }, ":bash-call");
        add({ key: "", kind: "tool_result", callId, tool: "bash", result: message, text: string(message.output) ?? "", status, occurredAt: time }, ":bash-result");
      } else if (role === "compactionSummary" || role === "branchSummary") {
        add({ key: "", kind: "compression", text: string(message.summary) ?? "", occurredAt: time });
      } else {
        add({ key: "", kind: "context", text: role ?? "unknown Pi message role", occurredAt: time });
        gaps.push({ kind: "unsupported_format", message: "Pi 消息包含尚未适配的原生 role", messageDescriptor: { key: "diagnostics.history.adapters.pi.m021" } });
      }
      continue;
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      const usage = piUsage(entry.usage);
      add({ key: "", kind: "compression", text: string(entry.summary) ?? "", usageKey: usage ? `${id}:usage` : undefined, usage }, ":summary");
      continue;
    }
    if (entry.type === "usage") {
      const usage = piUsage(entry.usage);
      add({ key: "", kind: "context", text: string(entry.kind) ?? "usage", model: string(entry.model), usageKey: usage ? `${id}:usage` : undefined, usage }, ":usage");
      continue;
    }
    if (entry.type === "custom_message") {
      add({ key: "", kind: "context", text: contentText(entry.content) });
      continue;
    }
    if (entry.type === "context_edit") {
      const replacement = entry.replacement === null ? undefined : object(entry.replacement).content;
      add({ key: "", kind: "context", ...(replacement === undefined ? {} : { text: contentText(replacement) }) });
      continue;
    }
    if (entry.type === "session_info") {
      add({ key: "", kind: "context", ...(string(entry.name) ? { text: string(entry.name) } : {}) });
      continue;
    }
    if (entry.type === "model_change") {
      add({ key: "", kind: "context", text: `${string(entry.provider) ?? ""}/${string(entry.modelId) ?? ""}`, model: string(entry.modelId) }, ":model");
      continue;
    }
    if (entry.type === "thinking_level_change") {
      add({ key: "", kind: "context", text: string(entry.thinkingLevel) ?? "" }, ":thinking-level");
      continue;
    }
    if (entry.type === "label") {
      add({ key: "", kind: "context", ...(string(entry.label) ? { text: string(entry.label) } : {}) }, ":label");
      continue;
    }
    if (entry.type === "custom") {
      add({ key: "", kind: "context", text: string(entry.customType) ?? "custom" }, ":custom");
      continue;
    }
    add({ key: "", kind: "context", text: string(entry.type) ?? "unknown Pi entry" }, ":entry");
    gaps.push({ kind: "unsupported_format", message: "Pi 来源包含尚未适配的原生事件类型", messageDescriptor: { key: "diagnostics.history.adapters.pi.m022" } });
  }
  return normalizedSnapshot(source, records, metadata, parentFingerprint);
}

const piBaseAdapter = createNormalizedAdapter({
  id: PI_FORMAT,
  async readSnapshot(location) { return snapshot(location); },
  extract: piExtract,
});

export const piAdapter = {
  ...piBaseAdapter,
  discover(record: Record<string, unknown>, location: SourceLocation) {
    if (record.type !== "session") return undefined;
    const id = string(record.id);
    const parentPath = string(record.parentSession);
    return { source: { ...location, format: PI_FORMAT, sessionId: id, cwd: normalizeHistoryPath(string(record.cwd)), parentSessionId: parentSessionId(parentPath) }, complete: true };
  },
};
