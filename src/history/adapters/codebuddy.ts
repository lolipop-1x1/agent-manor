import { isAbsolute } from "node:path";
import type { Gap } from "../../contracts.js";
import { object, string } from "../extraction.js";
import type { SourceLocation } from "../types.js";
import type { HistoryAdapter } from "./types.js";
import { createNormalizedAdapter, normalizedRecord, normalizedSnapshot } from "./normalized.js";
import type { NormalizedEvent, NormalizedSnapshot } from "./normalized.js";
import { addGap, eventTime, nativeSourceId, readJsonlHeader, readJsonlRows, sessionIds, sourceFor, textOf } from "./native-jsonl.js";

export const CODEBUDDY_FORMAT = "codebuddy-jsonl";

async function discoverCodebuddyFile(location: SourceLocation): Promise<SourceLocation[]> {
  if (!location.path.endsWith(".jsonl")) return [];
  const rows = await readJsonlHeader(location.path);
  const ids = sessionIds(rows);
  const sessionId = ids.length === 1 ? ids[0] : undefined;
  const cwdValues = [...new Set(rows.map(row => string(row.record.cwd)).filter((value): value is string => typeof value === "string" && isAbsolute(value)))];
  const source = sourceFor(location, "codebuddy", CODEBUDDY_FORMAT, sessionId, cwdValues.length === 1 ? cwdValues[0] : undefined);
  source.selector = sessionId;
  return [source];
}

async function readCodebuddySnapshot(location: SourceLocation): Promise<NormalizedSnapshot> {
  const gaps: Gap[] = [];
  const rows = await readJsonlRows(location.path, gaps);
  const bodyIds = sessionIds(rows);
  const sessionId = bodyIds.length > 1 ? undefined : location.sessionId ?? location.selector ?? (bodyIds.length === 1 ? bodyIds[0] : undefined);
  if (bodyIds.length > 1) addGap(gaps, "ambiguous", "单个 CodeBuddy 文件包含多个 sessionId，未合并跨会话正文", { key: "diagnostics.history.adapters.codebuddy.m001" });
  if (sessionId && bodyIds.some(id => id !== sessionId)) addGap(gaps, "ambiguous", "CodeBuddy 正文身份与发现身份不一致，仅保留匹配记录", { key: "diagnostics.history.adapters.codebuddy.m002" });
  if (!sessionId) addGap(gaps, "unassociated", "CodeBuddy 正文缺少可确认的原生 sessionId", { key: "diagnostics.history.adapters.codebuddy.m003" });
  const selected = bodyIds.length > 1 ? [] : sessionId
    ? rows.filter(row => !string(row.record.sessionId) || row.record.sessionId === sessionId) : rows;
  const cwdValues = [...new Set(selected.map(row => string(row.record.cwd)).filter((value): value is string => typeof value === "string" && isAbsolute(value)))];
  const cwd = location.cwd && isAbsolute(location.cwd) ? location.cwd : cwdValues.length === 1 ? cwdValues[0] : undefined;
  if (cwdValues.length > 1) addGap(gaps, "ambiguous", "CodeBuddy 正文记录了多个 cwd，无法确认单一项目目录", { key: "diagnostics.history.adapters.codebuddy.m004" });
  if (location.cwd && cwdValues.some(value => value !== location.cwd)) addGap(gaps, "ambiguous", "CodeBuddy 发现阶段 cwd 与正文 cwd 不一致", { key: "diagnostics.history.adapters.codebuddy.m005" });
  const source = sourceFor(location, "codebuddy", CODEBUDDY_FORMAT, sessionId, cwd);
  source.selector = sessionId;
  const records = [];
  for (const row of selected) {
    const type = string(row.record.type);
    if (type !== "message") {
      addGap(gaps, "unsupported_format", `CodeBuddy 记录类型 ${type ?? "<缺少类型>"} 尚未适配`, (type) !== undefined ? { key: "diagnostics.history.adapters.codebuddy.m006", params: { p0: String(type) } } : { key: "diagnostics.history.adapters.codebuddy.m007" });
      records.push(normalizedRecord({ key: `unknown:${row.line}`, kind: "context",
        text: `未适配记录类型 ${type ?? "<缺少类型>"}` }, row.raw, row.line));
      continue;
    }
    const role = string(row.record.role);
    if (role === "user") {
      const event: NormalizedEvent = {
        key: string(row.record.id) ?? `user:${row.line}`,
        kind: "user",
        text: textOf(row.record.content),
        occurredAt: eventTime(row.record.timestamp),
      };
      records.push(normalizedRecord(event, row.raw, row.line));
      continue;
    }
    // 当前本机样本只有 user；未知角色保留为 context 并显式留下缺口。
    addGap(gaps, "unsupported_format", `CodeBuddy 消息角色 ${role ?? "<缺少角色>"} 尚未由样本或格式源码确认`, (role) !== undefined ? { key: "diagnostics.history.adapters.codebuddy.m008", params: { p0: String(role) } } : { key: "diagnostics.history.adapters.codebuddy.m009" });
    records.push(normalizedRecord({
      key: string(row.record.id) ?? `context:${row.line}`,
      kind: "context",
      text: textOf(row.record.content),
      occurredAt: eventTime(row.record.timestamp),
    }, row.raw, row.line));
    const provider = object(row.record.providerData);
    if (Object.keys(provider).some(key => ["model", "usage", "rawUsage"].includes(key))) {
      addGap(gaps, "unsupported_format", "CodeBuddy 样本未确认模型与用量字段口径，未归一化该记录", { key: "diagnostics.history.adapters.codebuddy.m010" });
    }
  }
  return normalizedSnapshot(source, records, { gaps }, JSON.stringify([bodyIds, cwdValues]));
}

export const codebuddyAdapter: HistoryAdapter = createNormalizedAdapter({
  id: CODEBUDDY_FORMAT,
  quickCheck: { version: "1", dependencies: () => [] },
  discoverFile: discoverCodebuddyFile,
  readSnapshot: readCodebuddySnapshot,
});

export function codebuddySourceIdentity(sessionId: string): string {
  return nativeSourceId("codebuddy", sessionId);
}
