import Database from "better-sqlite3";
import { createReadStream, existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Gap } from "../../contracts.js";
import type { SessionRequestTiming } from "../../session-contracts.js";
import { number, object, physicalLines, shellEvidence, string, textContent, toolEvidence, unifiedFragments } from "../extraction.js";
import type { SourceLocation } from "../types.js";
import { normalizeHistoryPath } from "./common.js";
import { createNormalizedAdapter, normalizedHash, normalizedRecord, normalizedSnapshot, readBoundedJsonl, type NormalizedEvent, type NormalizedSnapshot, type RawHistoryRecord } from "./normalized.js";

const FORMAT = "omp-jsonl";
const diagnostic = (id: number) => ({ key: `diagnostics.history.adapters.omp.m${String(id).padStart(3, "0")}` });
function gap(gaps: Gap[], kind: Gap["kind"], id: number, message: string) { gaps.push({ kind, message, messageDescriptor: diagnostic(id) }); }
function time(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value); return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
function count(value: unknown): number | undefined { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined; }
function text(value: unknown): string { return typeof value === "string" ? value : textContent(value); }
export function ompHistoryRoots(home: string, environment: NodeJS.ProcessEnv): string[] {
  const selected = (environment.OMP_PROFILE !== undefined ? environment.OMP_PROFILE : environment.PI_PROFILE)?.trim();
  const profile = selected && selected !== "default" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(selected) && !selected.endsWith(".")
    && !/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(selected) ? selected : undefined;
  const root = join(home, environment.PI_CONFIG_DIR || ".omp");
  const defaultAgent = profile ? join(root, "profiles", profile, "agent") : join(root, "agent");
  const override = profile ? undefined : environment.PI_CODING_AGENT_DIR;
  const agent = override ? resolve(override) : defaultAgent;
  const xdg = environment.XDG_DATA_HOME ? join(environment.XDG_DATA_HOME, "omp", ...(profile ? ["profiles", profile] : [])) : undefined;
  return [join(agent === defaultAgent && xdg && existsSync(xdg) ? xdg : agent, "sessions")];
}
function usage(value: unknown): NormalizedEvent["usage"] {
  const native = object(value); const input = count(native.input); const cached = count(native.cacheRead); const write = count(native.cacheWrite); const output = count(native.output);
  const cost = number(object(native.cost).total);
  const reasoning = count(native.reasoningTokens); const context = count(native.contextTokens);
  const result = { ...(input !== undefined && cached !== undefined && write !== undefined ? { inputTokens: input + cached + write } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}), ...(cached !== undefined ? { cachedInputTokens: cached } : {}), ...(write !== undefined ? { cacheWriteTokens: write } : {}),
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}), ...(context !== undefined ? { contextTokens: context } : {}),
    ...(cost !== undefined && Number.isFinite(cost) && cost >= 0 ? { nativeReportedCostUsd: cost } : {}) };
  return Object.keys(result).length ? result : undefined;
}
function historyDbPath(path: string): string | undefined {
  let current = dirname(path);
  while (dirname(current) !== current) {
    if (basename(current) === "sessions") return join(dirname(current), "history.db");
    current = dirname(current);
  }
  return undefined;
}
function indexedTitle(path: string, id: string, gaps: Gap[]): string | undefined {
  const databasePath = historyDbPath(path); if (!databasePath) return undefined;
  let database: Database.Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_titles'").get()) return undefined;
    return string(object(database.prepare("SELECT title FROM session_titles WHERE session_id = ?").get(id)).title);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "SQLITE_CANTOPEN") gap(gaps, "parse_error", 1, "Oh My Pi 辅助标题索引不可读取，保留原生日志标题");
    return undefined;
  } finally { database?.close(); }
}

/** read 的显示元信息保存实际行号；列截断和省略行不能当完整源文件。 */
function ompExtract(tool: string, inputValue: unknown, resultValue: unknown, visible: string): ReturnType<typeof toolEvidence> {
  const input = object(inputValue); const result = object(resultValue); const details = object(result.details);
  const path = string(details.resolvedPath) ?? string(input.path); const lower = tool.toLowerCase();
  const missing = (kind: "read" | "edit" | "other", id: number, message: string) => [{ kind, path, fragments: [], reason: `range_unknown: ${message}`, reasonDescriptor: diagnostic(id) }];
  if (result.isError === true) return missing(lower === "read" ? "read" : ["edit", "write"].includes(lower) ? "edit" : "other", 2, "Oh My Pi 工具执行失败，未提取代码范围");
  if (lower === "read") {
    const truncation = object(details.truncation); const meta = object(details.meta); const display = object(details.displayContent);
    if (details.kind === "url" || details.isDirectory === true || details.summary || object(meta.limits).columnTruncated || truncation.firstLineExceedsLimit === true || truncation.lastLinePartial === true
      || /columns?\s+(?:cut|truncat)|maxColumns|column-cut|partial,|Line \d+ is .+ exceeds/i.test(visible + JSON.stringify(meta))) return missing("read", 3, "Oh My Pi read 返回摘要或部分行，完整代码范围未确认");
    const body = string(display.text); const start = count(display.startLine); const lineNumbers = Array.isArray(display.lineNumbers) ? display.lineNumbers : undefined;
    if (path && body !== undefined && start && lineNumbers && physicalLines(body).length === lineNumbers.length) {
      const fragments: ReturnType<typeof toolEvidence>[number]["fragments"] = [];
      const lines = physicalLines(body); let group: string[] = []; let groupStart = start;
      const flush = () => { if (group.length) fragments.push({ kind: "read", content: group.join("\n"), historicalStart: groupStart, completeLines: true }); group = []; };
      for (let index = 0; index < lines.length; index++) {
        const line = count(lineNumbers[index]);
        if (!line || group.length && line !== groupStart + group.length) flush();
        if (!line) continue;
        if (!group.length) groupStart = line; group.push(lines[index]!);
      }
      flush();
      return [{ kind: "read", path, fragments, ...(lineNumbers.includes(null) || truncation.truncated === true ? { reason: "range_unknown: Oh My Pi read 仅保留可确认返回窗口", reasonDescriptor: diagnostic(4) } : {}) }];
    }
    // 无 displayContent 时，只接受原生的编号投影；文件头和继续提示不属于正文。
    const bodyLines = visible.replace(/^\[[^\n]+#[A-Za-z0-9]+\]\n/, "").replace(/\n\n\[[^\n]+\](?:\n.*)?$/s, "").split(/\r?\n/);
    const numbered = bodyLines.map(line => /^(\d+)(?::|\t)(.*)$/.exec(line));
    if (!path || numbered.some(line => !line) || numbered.some((line, index) => index > 0 && Number(line![1]) !== Number(numbered[index - 1]![1]) + 1)) return missing("read", 5, "Oh My Pi read 缺少可核验原生行号");
    return [{ kind: "read", path, fragments: [{ kind: "read", content: numbered.map(line => line![2]).join("\n"), historicalStart: Number(numbered[0]![1]), completeLines: true }] }];
  }
  if (lower === "edit" || lower === "apply_patch") {
    const patch = string(details.diff) ?? string(details.patch);
    if (!patch) return missing("edit", 6, "Oh My Pi edit 未保存实际修改补丁");
    const fragments = unifiedFragments(patch, path);
    return [{ kind: "edit", path, fragments, ...(!fragments.length ? { reason: "range_unknown: Oh My Pi edit 补丁缺少定位 hunk", reasonDescriptor: diagnostic(7) } : {}) }];
  }
  if (lower === "write") {
    const patch = string(details.diff) ?? string(details.patch);
    if (patch) return [{ kind: "edit", path, fragments: unifiedFragments(patch, path) }];
    // 编辑器格式化可以改写最终全文；原生日志的字节数和短 tag 不足以证明请求正文就是最终文件。
    return missing("edit", 8, "Oh My Pi write 未保存格式化后的实际全文或补丁");
  }
  if (lower === "bash") {
    const truncation = object(details.truncation); const asyncState = object(details.async);
    if (truncation.truncated === true || details.truncated === true || asyncState.state === "running"
      || object(object(details.meta).truncation).truncated === true || /\[.*(?:truncated|raw output:|artifact:\/\/)/i.test(visible)) return missing("other", 9, "Oh My Pi bash 未确认完整成功输出");
    const output = visible.replace(/\n\nCommand (?:exited with code -?\d+|timed out after .+|aborted|terminated without an exit code)$/s, "");
    return shellEvidence(string(input.command) ?? "", output);
  }
  return toolEvidence(tool, input, result, visible);
}

async function snapshot(location: SourceLocation): Promise<NormalizedSnapshot> {
  const gaps: Gap[] = []; const rows = await readBoundedJsonl(location.path, gaps, createReadStream(location.path));
  const headerRow = rows.find(row => row.record.type === "session"); const header = headerRow?.record;
  if (!header || header.version !== 3 || !string(header.id)) {
    gap(gaps, "unsupported_format", 10, "Oh My Pi 来源缺少受支持的 v3 会话头"); return normalizedSnapshot(location, [], { gaps });
  }
  const id = string(header.id)!; const cwd = normalizeHistoryPath(string(header.cwd)); const parentPath = string(header.parentSession);
  const entries = rows.filter(row => row.line > headerRow!.line && string(row.record.id)); const byId = new Map<string, RawHistoryRecord>();
  for (const row of entries) {
    const entryId = string(row.record.id)!;
    if (byId.has(entryId)) { gap(gaps, "ambiguous", 11, "Oh My Pi 事件身份重复，按首次记录建立事件树"); continue; }
    byId.set(entryId, row);
  }
  const unique = [...byId.values()]; const childIds = new Set(unique.map(row => string(row.record.parentId)).filter((value): value is string => Boolean(value)));
  const last = unique.at(-1)?.record; let currentId = last?.type === "model_usage" && last.activeLeafId !== undefined ? string(last.activeLeafId) : string(last?.id);
  if (currentId && !byId.has(currentId)) {
    gap(gaps, "source_missing", 12, "Oh My Pi late usage 的当前叶节点已缺失，使用最后自选叶节点");
    currentId = string([...unique].reverse().find(row => row.record.type !== "model_usage" || row.record.activeLeafId === undefined)?.record.id);
  }
  const leaves = new Set(unique.filter(row => !childIds.has(string(row.record.id)!)).map(row => string(row.record.id)!)); if (currentId) leaves.add(currentId);
  const paths = new Map<string, RawHistoryRecord[]>();
  for (const leaf of leaves) {
    const path: RawHistoryRecord[] = []; const seen = new Set<string>(); let row = byId.get(leaf);
    while (row) {
      const entryId = string(row.record.id)!;
      if (seen.has(entryId)) { gap(gaps, "parse_error", 13, "Oh My Pi 事件树父链包含循环"); break; }
      seen.add(entryId); path.push(row); const parentId = string(row.record.parentId); if (!parentId) break;
      row = byId.get(parentId); if (!row) gap(gaps, "source_missing", 14, "Oh My Pi 事件树父身份不在来源内");
    }
    paths.set(leaf, path.reverse());
  }
  const membership = new Map<string, string[]>(); const turns = new Map<string, string>(); const efforts = new Map<string, string | undefined>();
  const finals = new Set<string>(); const interrupted = new Set<string>();
  for (const [branch, path] of paths) {
    let turn: string | undefined; let effort: string | undefined; let candidate: { id: string; reason: string; calls: boolean } | undefined;
    const pending = new Set<string>();
    const settle = () => { if (candidate?.reason === "stop" && !candidate.calls && !pending.size) finals.add(candidate.id);
      else if (candidate && (pending.size || ["error", "aborted", "length"].includes(candidate.reason))) interrupted.add(candidate.id); };
    for (const row of path) {
      const entry = row.record; const entryId = string(entry.id)!; const message = object(entry.message);
      membership.set(entryId, [...(membership.get(entryId) ?? []), branch]);
      if (entry.type === "thinking_level_change") effort = string(entry.thinkingLevel);
      if (entry.type === "message" && message.role === "user" && message.attribution !== "agent"
        || entry.type === "custom_message" && entry.customType === "skill-prompt" && entry.attribution === "user") { settle(); candidate = undefined; pending.clear(); turn = entryId; }
      if (turn) turns.set(entryId, turn); efforts.set(entryId, effort);
      if (entry.type === "message" && message.role === "assistant") {
        const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
        const calls = blocks.filter(block => block.type === "toolCall"); for (const call of calls) if (string(call.id)) pending.add(string(call.id)!);
        candidate = { id: entryId, reason: string(message.stopReason) ?? "", calls: calls.length > 0 };
      } else if (entry.type === "message" && message.role === "toolResult" && string(message.toolCallId)) pending.delete(string(message.toolCallId)!);
    }
    settle();
  }
  let parentId: string | undefined; let parentFingerprint = ""; const inherited = new Set<string>();
  const isChild = unique.some(row => row.record.type === "session_init");
  if (parentPath) {
    if (!isAbsolute(parentPath) || parentPath === location.path) gap(gaps, "source_missing", 15, "Oh My Pi 父来源缺少可核验绝对路径");
    else try {
      const parentRows = await readBoundedJsonl(parentPath, [], createReadStream(parentPath)); const parent = parentRows.find(row => row.record.type === "session")?.record;
      parentId = string(parent?.id); parentFingerprint = parentRows.map(row => row.raw).join("\n");
      if (!isChild) {
        const parentEntries = new Map(parentRows.filter(row => string(row.record.id) && row.record.type !== "session").map(row => [string(row.record.id)!, row.record]));
        for (const row of unique) if (parentEntries.has(string(row.record.id)!)) inherited.add(string(row.record.id)!);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      gap(gaps, "source_missing", 16, "Oh My Pi 父来源缺失，关系及复制边界未核验");
    }
  }
  const source = { ...location, format: FORMAT, sessionId: id, cwd, parentSessionId: parentId };
  const slot = rows.find(row => row.record.type === "title")?.record; let title = string(slot?.title) || string(header.title);
  for (const row of unique) if (row.record.type === "title_change") title = string(row.record.title) || title;
  title ||= indexedTitle(location.path, id, gaps);
  const records: RawHistoryRecord[] = [];
  for (const row of unique) {
    const entry = row.record; const entryId = string(entry.id)!; const branches = membership.get(entryId) ?? [];
    const base = { occurredAt: time(entry.timestamp), turnKey: turns.get(entryId), reasoningEffort: efforts.get(entryId), branchIds: branches,
      currentBranch: currentId ? branches.includes(currentId) : false, copied: inherited.has(entryId) || undefined, nativeIdentityHash: normalizedHash(entryId), nativeOrdinal: row.line };
    const add = (suffix: string, event: Omit<NormalizedEvent, "key">) => records.push(normalizedRecord({ ...base, ...event, key: `omp:${entryId}:${suffix}` }, row.raw, row.line));
    if (entry.type === "message") {
      const message = object(entry.message); const role = string(message.role); const occurredAt = time(message.timestamp) ?? base.occurredAt;
      if (role === "user") { add("user", { kind: message.attribution === "agent" ? "context" : "user", text: text(message.content), occurredAt, turnKey: message.attribution === "agent" ? base.turnKey : entryId }); continue; }
      if (role === "assistant") {
        const blocks = Array.isArray(message.content) ? message.content.map(object) : []; const responseId = string(message.responseId);
        const requestKey = responseId ? `omp:response:${responseId}` : `omp:entry:${entryId}`;
        const start = time(message.timestamp); const end = base.occurredAt; const reason = string(message.stopReason); const partial = ["error", "aborted", "length"].includes(reason ?? "");
        const completed = ["stop", "toolUse"].includes(reason ?? ""); const nativeUsage = usage(message.usage);
        const timing: SessionRequestTiming = { basis: "estimated", method: "omp_message_boundary", window: "response", completion: partial ? "partial" : completed ? "explicit" : "unknown",
          ...(completed ? { completionEvidence: "stop_reason" as const } : partial ? { completionEvidence: "request_interrupted" as const } : {}),
          ...(start ? { start: { occurredAt: start, recordLine: row.line } } : {}), ...(end ? { end: { occurredAt: end, recordLine: row.line } } : {}),
          ...(start && end && end >= start ? { durationMs: Date.parse(end) - Date.parse(start) } : {}) };
        const final = finals.has(entryId) && !interrupted.has(entryId) ? "inferred" as const : undefined;
        add("assistant", { kind: "assistant", text: blocks.filter(block => block.type === "text").map(block => string(block.text) ?? "").join("\n"), occurredAt,
          model: string(message.model), requestKey, requestTiming: timing, usage: nativeUsage ? { ...nativeUsage, provider: string(message.provider) } : undefined,
          usageKey: `${requestKey}:usage`, final, finalEvidence: final ? "normal_stop" : undefined, finalAt: final ? end : undefined,
          allowInferredFinal: false, interrupted: partial || interrupted.has(entryId) || undefined });
        const thinking = blocks.filter(block => block.type === "thinking").map(block => string(block.thinking) ?? "").join("\n");
        if (thinking) add("thinking", { kind: "thinking", text: thinking, occurredAt, model: string(message.model), requestKey });
        for (const block of blocks.filter(block => block.type === "toolCall")) add(`call:${string(block.id) ?? normalizedHash(JSON.stringify(block))}`, { kind: "tool_call", callId: string(block.id), tool: string(block.name), input: block.arguments, occurredAt, model: string(message.model), requestKey });
        continue;
      }
      if (role === "toolResult") {
        const details = object(message.details); const lower = string(message.toolName)?.toLowerCase(); const asyncState = object(details.async);
        const exit = number(details.exitCode);
        const status = message.isError === true || exit !== undefined && exit !== 0 ? "failure" : asyncState.state === "running" || message.isError === undefined ? "unknown" : "success";
        const server = string(details.serverName); const toolName = string(details.mcpToolName);
        if (server && toolName) {
          const call = records.find(candidate => object(candidate.record.normalizedEvent).kind === "tool_call" && object(candidate.record.normalizedEvent).callId === message.toolCallId);
          if (call) (call.record.normalizedEvent as NormalizedEvent).resource = { kind: "mcp", server, name: toolName };
        }
        add("result", { kind: "tool_result", callId: string(message.toolCallId), tool: string(message.toolName), text: text(message.content), result: message, status, occurredAt });
        if (message.usage || details.usage) gap(gaps, "unsupported_format", 17, "Oh My Pi 工具专用或子 Agent 汇总用量未并入父模型请求");
        if (lower === "task") {
          // task 结果可保留子会话来源线索；父关系由子原生日志头确认。
          const results = Array.isArray(details.results) ? details.results.map(object) : [];
          for (const child of results) if (string(child.sessionId)) gap(gaps, "source_missing", 18, "Oh My Pi task 子来源须通过原生会话头确认关系");
        }
        continue;
      }
      if (role === "bashExecution") {
        const status = message.cancelled === true ? "unknown" : number(message.exitCode) === 0 ? "success" : number(message.exitCode) !== undefined ? "failure" : "unknown";
        add("bash-call", { kind: "tool_call", callId: entryId, tool: "bash", input: { command: message.command }, occurredAt });
        add("bash-result", { kind: "tool_result", callId: entryId, tool: "bash", result: { ...message, content: [{ type: "text", text: message.output }], details: { truncation: { truncated: message.truncated } } }, text: string(message.output), status, occurredAt }); continue;
      }
      add("message", { kind: ["compactionSummary", "branchSummary"].includes(role ?? "") ? "compression" : role === "system" ? "system" : "context", text: text(message.content) || string(message.summary), occurredAt });
      if (!["custom", "system", "compactionSummary", "branchSummary", "hook", "developer", "pythonExecution", "fileMention"].includes(role ?? "")) gap(gaps, "unsupported_format", 19, "Oh My Pi 消息包含尚未适配的原生 role");
      continue;
    }
    if (entry.type === "model_usage") {
      const nativeUsage = usage(entry.usage); const purpose = string(entry.purpose); const reason = string(entry.stopReason);
      // model_usage 是非转录模型调用；与 assistant usage 独立，工具中的聚合投影不在这里相加。
      if (!purpose) gap(gaps, "ambiguous", 20, "Oh My Pi 独立模型用量缺少 purpose，未猜测用途");
      add("usage", { kind: "context", text: purpose, model: string(entry.model), requestKey: `omp:model-usage:${entryId}`, usageKey: `omp:model-usage:${entryId}`,
        usage: nativeUsage ? { ...nativeUsage, provider: string(entry.provider) } : undefined,
        requestTiming: { basis: "recorded", method: "omp_message_boundary", completion: ["error", "aborted", "length"].includes(reason ?? "") ? "partial" : ["stop", "toolUse"].includes(reason ?? "") ? "explicit" : "unknown" } }); continue;
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") { add("summary", { kind: "compression", text: string(entry.summary) }); continue; }
    if (entry.type === "session_init") { add("init", { kind: "system", text: Array.isArray(entry.systemPrompt) ? entry.systemPrompt.filter(value => typeof value === "string").join("\n") : string(entry.systemPrompt) }); continue; }
    if (entry.type === "custom_message") {
      const details = object(entry.details); const skillPath = string(details.path); const name = string(details.name);
      const invoked = entry.customType === "skill-prompt" && name && skillPath && text(entry.content).trim();
      add("custom-message", { kind: invoked && entry.attribution === "user" ? "user" : "context", text: text(entry.content),
        ...(invoked ? { resource: { kind: "skill_read" as const, name, path: skillPath }, status: "success" as const, turnKey: entryId } : {}) }); continue;
    }
    if (entry.type === "model_change") { add("model", { kind: "context", model: string(entry.model), text: string(entry.model) }); continue; }
    if (entry.type === "thinking_level_change") { add("thinking", { kind: "context", text: string(entry.thinkingLevel), reasoningEffort: string(entry.thinkingLevel) }); continue; }
    const known = ["title_change", "reset_boundary", "custom", "label", "service_tier_change", "ttsr_injection", "mode_change", "credential_pin"].includes(string(entry.type) ?? "");
    add("context", { kind: "context", text: string(entry.title) ?? string(entry.label) ?? string(entry.type) });
    if (!known) gap(gaps, "unsupported_format", 21, "Oh My Pi 来源包含尚未适配的原生事件类型");
  }
  return normalizedSnapshot(source, records, { title, titleOrigin: "recorded", parentSessionId: parentId, relationship: parentId ? isChild ? "child" : "fork" : undefined,
    relationships: parentId ? [{ kind: isChild ? "subagent" : "fork", parentSessionId: parentId,
      ...(!isChild && inherited.size ? { copiedRecordIdentityHashes: [...inherited].map(normalizedHash) } : {}) }] : [],
    branches: [...paths.keys()].map((branch, index) => ({ id: branch, current: branch === currentId, label: branch === currentId ? "当前分支" : `分支 ${index + 1}`,
      labelDescriptor: { key: branch === currentId ? "sessions.branch.current" : "sessions.branch.number", params: { number: index + 1 } } })), gaps }, `${parentFingerprint}\n${rows.map(row => row.raw).join("\n")}`);
}

export const ompAdapter = createNormalizedAdapter({ id: FORMAT, readSnapshot: snapshot, extract: ompExtract });
