import type { HistoryRecordSnapshot } from "./types.js";
import { object, string, tokens } from "../../sessions/parser-usage.js";

type Row = HistoryRecordSnapshot["records"][number];
export interface IdeUsageSidecar { path: string; key: string; value: unknown }
interface Group { key: string; chatId: string; start: number; rows: Row[]; model?: string }
interface Candidate { group: Group; usage: Record<string, number | undefined>; at: number; after: number; model?: string; raw: string }

function normalized(raw: unknown): Record<string, number | undefined> | undefined {
  const value = object(raw);
  const input = tokens(value.prompt_tokens ?? value.promptTokens), output = tokens(value.completion_tokens ?? value.completionTokens);
  if (input === undefined && output === undefined) return undefined;
  const read = tokens(value.cached_read_input_tokens ?? value.cache_read_input_tokens ?? value.cachedReadInputTokens);
  const write = tokens(value.cached_creation_input_tokens ?? value.cache_creation_input_tokens ?? value.cachedCreationInputTokens);
  const validCache = input === undefined || (read ?? 0) + (write ?? 0) <= input;
  return { input_tokens: input, output_tokens: output,
    cache_read_input_tokens: validCache ? read : undefined, cache_creation_input_tokens: validCache ? write : undefined };
}

function matches(content: unknown[], rows: Row[]): boolean {
  if (content.length !== rows.length) return false;
  return content.every((value, index) => {
    const block = object(value), record = rows[index]!.record, type = string(record.say ?? record.ask);
    if (block.type === "text") return type === "text" && typeof block.text === "string" && block.text === record.text;
    if (block.type === "thinking") return type === "thinking" && typeof (block.thinking ?? block.text) === "string" && (block.thinking ?? block.text) === record.text;
    return false;
  });
}

/** 旁路只补用量；请求身份来自主 UI 的 api_req_started，不重放 API 上下文正文。 */
export function ideUsageRecords(sessionId: string, rows: Row[], sidecars: IdeUsageSidecar[]): { records: Row[]; incomplete: boolean } {
  const groups: Group[] = [];
  let current: Group | undefined;
  for (const row of rows) {
    const record = row.record, chatId = string(record.chatId), at = tokens(record.ts);
    if (record.role === "user") current = undefined;
    if (record.say === "api_req_started") {
      current = chatId && at !== undefined ? { key: `ide-request:${chatId}:${at}:${row.line}`, chatId, start: at, rows: [], model: string(record.chatModel) } : undefined;
      if (current) groups.push(current);
    }
    if (current) current.rows.push(row);
  }
  const candidates = new Map<string, Candidate[]>();
  let incomplete = groups.length === 0;
  const add = (candidate: Candidate) => candidates.set(candidate.group.key, [...(candidates.get(candidate.group.key) ?? []), candidate]);
  for (const sidecar of sidecars) {
    if (!Array.isArray(sidecar.value)) { incomplete = true; continue; }
    const history = sidecar.key.startsWith("token_usage_history_");
    for (const [index, raw] of sidecar.value.entries()) {
      const value = object(raw), usage = normalized(value.usage), chatId = string(value.chatId);
      if (!usage || !chatId || history && value.sessionId !== sessionId) { if (value.usage) incomplete = true; continue; }
      const origin = JSON.stringify({ path: sidecar.path, key: sidecar.key, index, record: raw });
      if (history) {
        const at = tokens(value.timestamp);
        if (at === undefined || !Number.isFinite(new Date(at).getTime())) { incomplete = true; continue; }
        const group = groups.filter(item => item.chatId === chatId && item.start <= at).at(-1);
        if (!group) { incomplete = true; continue; }
        const after = group.rows.filter(row => typeof row.record.ts === "number" && row.record.ts <= at).at(-1)?.line ?? group.rows[0]!.line;
        add({ group, usage, at, after, model: string(value.modelName), raw: origin });
      } else {
        if (value.role !== "assistant" || !Array.isArray(value.content) || !value.content.length) { incomplete = true; continue; }
        const content = value.content;
        const aiRows = (group: Group) => group.rows.filter(row => row.record.role !== "user" && ["text", "thinking"].includes(string(row.record.say ?? row.record.ask) ?? ""));
        const matched = groups.filter(group => group.chatId === chatId && matches(content, aiRows(group)));
        if (matched.length !== 1) { incomplete = true; continue; }
        const group = matched[0]!, matchedRows = aiRows(group);
        const last = matchedRows.at(-1)!, at = tokens(last.record.ts);
        if (at === undefined || !Number.isFinite(new Date(at).getTime())) { incomplete = true; continue; }
        add({ group, usage, at, after: last.line, model: group.model, raw: origin });
      }
    }
  }
  const records: Row[] = [];
  for (const group of groups) {
    const entries = candidates.get(group.key) ?? [];
    const usage: Record<string, number> = {};
    let conflict = false;
    for (const entry of entries) for (const [key, value] of Object.entries(entry.usage)) if (value !== undefined) {
      if (usage[key] !== undefined && usage[key] !== value) conflict = true;
      usage[key] = value;
    }
    if (conflict || !entries.length) {
      incomplete = true;
      for (const key of Object.keys(usage)) delete usage[key];
    }
    const entry = conflict || !entries.length ? { at: group.start, after: group.rows[0]!.line,
      model: group.model, raw: group.rows[0]!.raw }
      : entries.find(item => JSON.parse(item.raw).key.startsWith("token_usage_history_")) ?? entries[0]!;
    records.push({ line: rows.length + records.length + 1, raw: entry.raw,
      record: { op: "request_usage", id: group.key, turnId: group.chatId, timestamp: entry.at, model: entry.model ?? group.model,
        usage, __ideUsageAfterLine: entry.after } });
  }
  return { records, incomplete };
}
