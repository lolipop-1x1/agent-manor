import { lstat, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Gap } from "../../contracts.js";
import type { SourceLocation } from "../types.js";
import { number, object, physicalLines, returnedText, shellEvidence, string, toolEvidence, unifiedFragments } from "../extraction.js";
import { defaultToolEvidence, normalizeHistoryPath } from "./common.js";
import { createNormalizedAdapter, normalizedHash, normalizedRecord, normalizedSnapshot, readBoundedJsonl } from "./normalized.js";
import type { NormalizedEvent, NormalizedSessionMetadata, RawHistoryRecord } from "./normalized.js";

const FORMAT = "codewhale-json";
const gap = (gaps: Gap[], kind: Gap["kind"], message: string, key: string) => gaps.push({ kind, message, messageDescriptor: { key: `diagnostics.history.adapters.codewhale.${key}` } });
const date = (value: unknown): string | undefined => {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : undefined;
};
async function document(path: string): Promise<{ value: Record<string, unknown>; raw: string }> {
  if ((await stat(path)).size > 128 * 1024 * 1024) throw new Error("Codewhale 来源超过有界读取上限");
  const raw = await readFile(path, "utf8"); return { value: object(JSON.parse(raw)), raw };
}
async function archive(path: string, gaps: Gap[]): Promise<RawHistoryRecord[]> {
  try { return await readBoundedJsonl(path, gaps); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return []; }
}
async function lateUsage(path: string, gaps: Gap[]): Promise<{ value: Record<string, unknown>; raw: string; retired?: boolean }> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
      gap(gaps, "source_unavailable", "Codewhale 晚到用量旁路不可用，累计覆盖保持未知", "m013"); return { value: {}, raw: "" };
    }
    const raw = await readFile(path, "utf8");
    if (raw === "codewhale-session-deleted-v1\n") return { value: {}, raw, retired: true };
    try {
      const value = object(JSON.parse(raw));
      if (value.schema_version !== 1) { gap(gaps, "unsupported_format", "Codewhale 晚到用量旁路 schema 尚未适配", "m014"); return { value: {}, raw }; }
      return { value, raw };
    } catch { gap(gaps, "parse_error", "Codewhale 晚到用量旁路尚未形成有效 JSON", "m015"); return { value: {}, raw }; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return { value: {}, raw: "" }; }
}
const text = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(item => string(object(item).text) ?? "").filter(Boolean).join("\n") : "";
/** 原生 Read 的编号返回可定位；普通编辑仍只保留实际 patch。 */
function extract(tool: string, inputValue: unknown, resultValue: unknown, visible: string): ReturnType<typeof toolEvidence> {
  const input = object(inputValue); const result = object(resultValue); const path = string(input.path) ?? string(input.file_path);
  if (["bash", "shell", "run_shell_command"].includes(tool)) return shellEvidence(string(input.command) ?? string(input.cmd) ?? "", visible);
  if (["read_file", "read"].includes(tool) && path) {
    const output = returnedText(visible); const parsed = physicalLines(output.content).map(line => /^\s*(\d+)\s*[→:|\t]\s?(.*)$/.exec(line));
    if (parsed.length && parsed.every((line, index) => line && Number(line[1]) === Number(parsed[0]![1]) + index)) return [{ kind: "read", path,
      fragments: [{ kind: "read", content: parsed.map(line => line![2]).join("\n"), historicalStart: Number(parsed[0]![1]), completeLines: true }] }];
  }
  const patch = string(result.patch) ?? string(result.diff);
  if (patch && ["edit_file", "apply_patch", "write_file"].includes(tool)) return [{ kind: "edit", path, fragments: unifiedFragments(patch, path) }];
  return defaultToolEvidence(tool, inputValue, result, visible);
}

async function snapshot(location: SourceLocation) {
  const gaps: Gap[] = []; const saved = await document(location.path); const value = saved.value;
  const metadata = object(value.metadata); const journal = object(value.journal);
  const ledger = await lateUsage(join(dirname(location.path), ".late-usage", `${basename(location.path, ".json")}.json`), gaps);
  if (ledger.retired) throw Object.assign(new Error("Codewhale 原生会话已删除"), { code: "ENOENT" });
  const sessionId = string(metadata.id) ?? location.sessionId ?? basename(location.path, ".json");
  const cwd = normalizeHistoryPath(string(metadata.workspace)); const parent = string(metadata.parent_session_id);
  const meta: NormalizedSessionMetadata = { title: string(metadata.title), gaps,
    ...(parent ? { parentSessionId: parent, relationship: "fork", relationships: [{ kind: "fork", parentSessionId: parent }] } : {}) };
  const supported = number(value.schema_version) === undefined || value.schema_version === 1;
  if (!supported) gap(gaps, "unsupported_format", "Codewhale 会话 schema 尚未适配", "m001");
  const entries = Array.isArray(journal.entries) ? journal.entries.map(object) : [];
  const archived = await archive(join(dirname(location.path), ".journal-archive", `${basename(location.path, ".json")}.jsonl`), gaps);
  const archivedRaw = new Map<string, RawHistoryRecord>();
  for (const row of archived) {
    const id = string(row.record.id); if (!id) continue;
    const existing = entries.find(entry => entry.id === id);
    if (!existing) { entries.push(row.record); archivedRaw.set(id, row); }
    else if (JSON.stringify(existing) !== JSON.stringify(row.record)) gap(gaps, "ambiguous", "Codewhale journal 包含重复事件身份，保留首次记录", "m004");
  }
  const inherited = new Set<string>(); let parentRaw = "";
  if (parent && !parent.includes("/") && !parent.includes("\\") && parent !== sessionId) {
    try { const source = await document(join(dirname(location.path), `${parent}.json`)); parentRaw = source.raw;
      const parentEntries = object(source.value.journal).entries;
      for (const entry of Array.isArray(parentEntries) ? parentEntries : []) { const id = string(object(entry).id); if (id) inherited.add(id); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; gap(gaps, "source_missing", "Codewhale 分叉父来源缺失，无法核验继承事件", "m002"); }
  }
  if (meta.relationships?.[0] && inherited.size) meta.relationships[0].copiedRecordIdentityHashes = [...inherited].map(normalizedHash);
  const records: RawHistoryRecord[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    const id = string(entry.id);
    if (!id) { gap(gaps, "parse_error", "Codewhale journal 事件缺少身份", "m003"); continue; }
    if (byId.has(id)) { gap(gaps, "ambiguous", "Codewhale journal 包含重复事件身份，保留首次记录", "m004"); continue; }
    byId.set(id, entry);
  }
  const leaf = string(value.leaf_id) ?? string(journal.leaf_id);
  const parents = new Set([...byId.values()].map(entry => string(entry.parent_id)).filter((id): id is string => Boolean(id)));
  const leaves = [...byId.keys()].filter(id => !parents.has(id));
  const branchIds = [...new Set([...leaves, ...(leaf ? [leaf] : [])])];
  const paths = new Map<string, string[]>();
  for (const branch of branchIds) {
    const path: string[] = []; const visited = new Set<string>(); let current: string | undefined = branch;
    while (current) {
      if (visited.has(current)) { gap(gaps, "parse_error", "Codewhale journal 父链存在循环", "m005"); break; }
      visited.add(current); const entry = byId.get(current);
      if (!entry) { gap(gaps, "source_missing", "Codewhale journal 父链来源缺失", "m006"); break; }
      path.push(current); current = string(entry.parent_id);
    }
    paths.set(branch, path.reverse());
  }
  if (entries.length && !leaf && (value.leaf_id !== null || journal.leaf_id !== null)) gap(gaps, "ambiguous", "Codewhale journal 未记录可确认的当前叶节点", "m007");
  meta.branches = branchIds.map((id, index) => ({ id, label: id === leaf ? "当前分支" : `分支 ${index + 1}`, current: id === leaf,
    labelDescriptor: { key: id === leaf ? "sessions.branch.current" : "sessions.branch.number", params: { number: index + 1 } } }));
  const memberships = new Map<string, string[]>(); const turns = new Map<string, string>();
  for (const [branch, path] of paths) {
    let turn: string | undefined;
    for (const id of path) {
      const entry = byId.get(id)!; const message = object(entry.message);
      const content = Array.isArray(message.content) ? message.content.map(object) : [];
      if (entry.kind === "user" || message.role === "user" && content.some(block => block.type === "text")) turn = id;
      memberships.set(id, [...(memberships.get(id) ?? []), branch]); if (turn) turns.set(id, turn);
    }
  }
  const emit = (event: NormalizedEvent, row: RawHistoryRecord, ordinal?: number) => records.push(normalizedRecord(event, row.raw, row.line, ordinal));
  const currentPath = paths.get(leaf ?? "") ?? [];
  const parseMessage = (message: Record<string, unknown>, base: Omit<NormalizedEvent, "kind" | "key">, key: string, row: RawHistoryRecord, ordinal: number) => {
    const role = string(message.role); const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
    const visible = blocks.filter(block => block.type === "text").map(block => string(block.text) ?? "").join("\n");
    const interrupted = role === "assistant_interrupted";
    if (visible || blocks.length === 0) emit({ ...base, key, kind: role === "assistant" || interrupted ? "assistant" : role === "user" ? "user" : role === "system" ? "system" : "context",
      text: visible, allowInferredFinal: false, interrupted: interrupted || undefined }, row, ordinal);
    for (const [index, block] of blocks.entries()) {
      if (block.type === "thinking") emit({ ...base, key: `${key}:thinking:${index}`, kind: "thinking", text: string(block.thinking), interrupted: interrupted || undefined }, row, ordinal);
      if (block.type === "tool_use" || block.type === "server_tool_use") {
        const callId = string(block.execution_id) ? `execution:${block.execution_id}` : string(block.id);
        emit({ ...base, key: `${key}:call:${index}`, kind: "tool_call", callId, tool: string(block.name) ?? "unknown", input: block.input }, row, ordinal);
      }
      if (["tool_result", "tool_search_tool_result", "code_execution_tool_result"].includes(string(block.type) ?? "")) {
        const callId = string(block.execution_id) ? `execution:${block.execution_id}` : string(block.tool_use_id);
        emit({ ...base, key: `${key}:result:${index}`, kind: "tool_result", callId, text: text(block.content), result: block,
          status: block.is_error === true ? "failure" : block.is_error === false ? "success" : "unknown" }, row, ordinal);
      }
      if (!["text", "thinking", "tool_use", "server_tool_use", "tool_result", "tool_search_tool_result", "code_execution_tool_result", "image_url"].includes(string(block.type) ?? "")) gap(gaps, "unsupported_format", "Codewhale 消息包含未知内容块", "m008");
    }
  };
  if (!supported) { /* 未知会话 schema 只保留元信息和原始来源。 */ }
  else if (Object.keys(journal).length && number(journal.schema_version) !== undefined && journal.schema_version !== 1) gap(gaps, "unsupported_format", "Codewhale journal schema 尚未适配，未导入兼容投影", "m009");
  else if (Object.keys(journal).length) {
    const orderedIds = [...new Set([...paths.values()].flat().concat([...byId.keys()]))];
    for (const id of orderedIds) {
      const entry = byId.get(id)!; const ordinal = entries.findIndex(item => item.id === id);
      const row = archivedRaw.get(id) ?? { record: value, raw: saved.raw, line: 1 };
      const base = { occurredAt: date(entry.created_at), model: string(entry.model) ?? string(metadata.model),
        copied: inherited.has(id), nativeIdentityHash: normalizedHash(id), branchIds: memberships.get(id), currentBranch: currentPath.includes(id), turnKey: turns.get(id) };
      const key = `codewhale:${id}`;
      if (entry.kind === "message") parseMessage(object(entry.message), base, key, row, ordinal);
      else if (["compaction", "branch_summary"].includes(string(entry.kind) ?? "")) emit({ ...base, key, kind: "compression", text: string(entry.summary) }, row, ordinal);
      else if (["user", "assistant", "system"].includes(string(entry.kind) ?? "")) emit({ ...base, key, kind: entry.kind as "user" | "assistant" | "system", text: string(entry.text) ?? string(entry.content), allowInferredFinal: false }, row, ordinal);
      else { emit({ ...base, key, kind: "context", text: string(entry.kind) }, row, ordinal); gap(gaps, "unsupported_format", "Codewhale journal 包含未知事件类型", "m010"); }
    }
  } else {
    // 当前加载端仍接收无 journal 的线性快照；不同时加载另一份投影。
    let turn: string | undefined; const boundary = number(metadata.forked_from_message_count);
    for (const [index, item] of (Array.isArray(value.messages) ? value.messages : []).entries()) {
      const message = object(item); if (message.role === "user" && text(message.content)) turn = `projection:${index}`;
      parseMessage(message, { model: string(metadata.model), turnKey: turn, currentBranch: true, copied: boundary !== undefined && index < boundary },
        `codewhale:projection:${index}`, { record: value, raw: saved.raw, line: 1 }, index);
    }
    if (meta.relationships?.[0] && boundary !== undefined) meta.relationships[0].endOrdinalExclusive = boundary;
  }
  const currentMessages = currentPath.filter(id => ["message", "user", "assistant"].includes(string(byId.get(id)?.kind) ?? ""));
  for (const [index, item] of (Array.isArray(value.turn_outcomes) ? value.turn_outcomes : []).entries()) {
    const outcome = object(item); const count = number(outcome.after_message_count);
    const previous = count === undefined ? undefined : currentMessages[Math.max(0, count - 1)];
    emit({ key: `codewhale:outcome:${index}`, kind: "context", text: string(outcome.error), status: "failure", interrupted: true,
      turnKey: previous ? turns.get(previous) : undefined, occurredAt: date(outcome.ended_at), currentBranch: true }, { record: value, raw: saved.raw, line: 1 });
  }
  const cost = object(metadata.cost);
  if (Object.keys(cost).length) {
    meta.usageReports = [{ scope: "session", nativeId: sessionId, model: string(metadata.model), occurredAt: date(metadata.updated_at),
      reportedCostUsd: number(cost.session_cost_usd) === undefined ? undefined : number(cost.session_cost_usd)! + (number(cost.subagent_cost_usd) ?? 0),
      totalTokens: number(metadata.total_tokens) }];
    emit({ key: "codewhale:cost", kind: "context", text: "会话累计费用", textDescriptor: { key: "diagnostics.history.adapters.codewhale.m011" } }, { record: value, raw: saved.raw, line: 1 });
  }
  const lateRecords = Array.isArray(ledger.value.records) ? ledger.value.records.map(object) : [];
  const reportIds = new Set<string>();
  for (const [index, item] of lateRecords.entries()) {
    const id = string(item.source_fingerprint); const usage = object(item.usage);
    if (!id || reportIds.has(id)) continue;
    reportIds.add(id);
    // 旁路是按来源留存的晚到部分报告；它既不是会话总量，也不足以恢复 HTTP 请求分母。
    meta.usageReports = [...(meta.usageReports ?? []), { scope: "turn", nativeId: id, turnKey: string(item.turn_fingerprint),
      inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), cachedInputTokens: number(usage.prompt_cache_hit_tokens),
      cacheWriteTokens: number(usage.prompt_cache_write_tokens), reasoningOutputTokens: number(usage.reasoning_tokens) }];
    emit({ key: `codewhale:late-usage:${id}`, kind: "context", text: "晚到用量部分报告", textDescriptor: { key: "diagnostics.history.adapters.codewhale.m016" } },
      { record: item, raw: JSON.stringify(item), line: entries.length + index + 2 });
  }
  if (lateRecords.length || ledger.value.overflowed === true) gap(gaps, "incomplete_record", "Codewhale 晚到用量仅覆盖部分来源，未并入会话总量或逐请求统计", "m017");
  if (metadata.archived === true) emit({ key: "codewhale:archive", kind: "context", text: "已归档", textDescriptor: { key: "diagnostics.history.adapters.codewhale.m012" } }, { record: value, raw: saved.raw, line: 1 });
  return normalizedSnapshot({ ...location, format: FORMAT, sessionId, cwd, parentSessionId: parent }, records, meta, [saved.raw, parentRaw, ledger.raw, ...archived.map(row => row.raw)].join("\u0000"));
}

export function codewhaleHistoryRoots(home: string, environment: NodeJS.ProcessEnv): string[] {
  const override = environment.CODEWHALE_HOME?.trim();
  if (override) { const root = override.startsWith("~/") ? join(home, override.slice(2)) : override; return isAbsolute(root) ? [join(root, "sessions")] : []; }
  return [join(home, ".codewhale", "sessions"), join(home, ".deepseek", "sessions")];
}
export const codewhaleAdapter = createNormalizedAdapter({ id: FORMAT, readSnapshot: snapshot, extract,
  async discoverFile(location) {
    try { return [(await snapshot(location)).source]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return []; }
  },
  selectSources(locations) {
    const chosen = new Map<string, SourceLocation>();
    for (const location of locations) {
      if (location.client !== "codewhale" || location.format !== FORMAT) continue;
      const key = location.sessionId ?? location.path; const previous = chosen.get(key);
      if (!previous || /[/\\]\.codewhale[/\\]/.test(location.path) && /[/\\]\.deepseek[/\\]/.test(previous.path)) chosen.set(key, location);
    }
    return [...locations.filter(location => location.client !== "codewhale" || location.format !== FORMAT), ...chosen.values()];
  } });
