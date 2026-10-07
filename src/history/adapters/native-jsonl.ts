import type { MessageDescriptor } from "../../i18n/types.js";
import { DiagnosticError } from "../../i18n/diagnostics.js";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Client, Gap } from "../../contracts.js";
import type { NormalizedEvent, RawHistoryRecord } from "./normalized.js";
import { normalizedHash, normalizedSessionKey, readBoundedJsonl } from "./normalized.js";
import type { SourceLocation } from "../types.js";
import { object, string } from "../extraction.js";

export const nativeHash = (value: string): string => normalizedHash(value);
export const nativeSourceId = (client: Client, id: string): string => normalizedSessionKey(client, id);

export function eventTime(value: unknown): string | undefined {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const milliseconds = value > 100_000_000_000 ? value : value * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  const record = object(value);
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.content)) return textOf(record.content);
  if (Array.isArray(record.parts)) return textOf(record.parts);
  return "";
}

export function tokenValue(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

const normalizedTokenKey = (key: string): string => key.replace(/[_-]/g, "").toLowerCase();

export function tokenField(values: readonly Record<string, unknown>[], aliases: readonly string[]): number | undefined {
  const wanted = new Set(aliases.map(normalizedTokenKey));
  for (const value of values) {
    for (const [key, raw] of Object.entries(value)) {
      if (wanted.has(normalizedTokenKey(key))) {
        const parsed = tokenValue(raw);
        if (parsed !== undefined) return parsed;
      }
    }
  }
  return undefined;
}

export function hasTokenField(values: readonly Record<string, unknown>[], aliases: readonly string[]): boolean {
  const wanted = new Set(aliases.map(normalizedTokenKey));
  return values.some(value => Object.keys(value).some(key => wanted.has(normalizedTokenKey(key))));
}

export function normalizeUsage(raws: readonly unknown[], gap: (gap: Gap) => void): NormalizedEvent["usage"] | undefined {
  const direct = raws.map(object).filter(value => Object.keys(value).length > 0);
  const inputDetails = ["prompt_tokens_details", "inputTokensDetails"];
  const outputDetails = ["output_tokens_details", "outputTokensDetails", "completion_tokens_details", "completionTokensDetails"];
  const inputs = [...direct, ...direct.flatMap(value => inputDetails.map(key => object(value[key])).filter(item => Object.keys(item).length > 0))];
  const outputs = [...direct, ...direct.flatMap(value => outputDetails.map(key => object(value[key])).filter(item => Object.keys(item).length > 0))];
  if (!direct.length) return undefined;
  const inputAliases = ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"];
  const readAliases = ["cache_read_input_tokens", "cacheReadInputTokens", "cached_tokens", "cachedTokens", "prompt_cache_hit_tokens"];
  const writeAliases = ["cache_creation_input_tokens", "cacheCreationInputTokens", "cache_write_input_tokens", "cacheWriteInputTokens", "prompt_cache_write_tokens"];
  const outputAliases = ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"];
  const reasoningAliases = ["reasoning_output_tokens", "reasoningOutputTokens", "reasoningTokens", "completion_thinking_tokens"];
  const cacheRead = tokenField(inputs, readAliases);
  const cacheWrite = tokenField(inputs, writeAliases);
  const input = tokenField(direct, inputAliases);
  if (input !== undefined && (hasTokenField(inputs, readAliases) || hasTokenField(inputs, writeAliases))) {
    gap({ kind: "ambiguous", message: "原生输入与缓存桶的分母口径未核验，未计算缓存比例", messageDescriptor: { key: "diagnostics.history.adapters.nativeJsonl.m001" } });
  }
  const usage = {
    inputTokens: input !== undefined && cacheRead === undefined && cacheWrite === undefined ? input : undefined,
    outputTokens: tokenField(direct, outputAliases),
    cachedInputTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningOutputTokens: tokenField(outputs, reasoningAliases),
  };
  return Object.values(usage).some(value => value !== undefined) ? usage : undefined;
}

export async function readJsonlRows(path: string, gaps: Gap[]): Promise<RawHistoryRecord[]> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new DiagnosticError("原生历史必须为普通文件", { key: "diagnostics.history.adapters.nativeJsonl.m002" });
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await readBoundedJsonl(path, gaps, handle.createReadStream({ autoClose: false }));
  } finally {
    await handle.close();
  }
}

export async function readJsonlHeader(path: string, maxBytes = 64 * 1024, maxLines = 32): Promise<RawHistoryRecord[]> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) return [];
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    const rows: RawHistoryRecord[] = [];
    for (const [index, raw] of lines.slice(0, maxLines).entries()) {
      if (!raw) continue;
      try {
        const record = object(JSON.parse(raw));
        if (Object.keys(record).length) rows.push({ record, raw, line: index + 1 });
      } catch {
        // 头部可能恰好截在记录中间；完整解析由有界读取路径报告。
      }
    }
    return rows;
  } finally {
    await handle.close();
  }
}

export function sessionIds(rows: readonly RawHistoryRecord[]): string[] {
  return [...new Set(rows.map(row => string(row.record.sessionId)).filter((value): value is string => Boolean(value)))];
}

export function sourceFor(location: SourceLocation, client: Client, format: string, sessionId?: string, cwd?: string): SourceLocation {
  const nativeId = sessionId;
  return {
    ...location,
    client,
    format,
    sessionId: nativeId,
    sourceId: nativeId ? nativeSourceId(client, nativeId) : `${client}:${nativeHash(location.path).slice(0, 24)}`,
    cwd: cwd && isAbsolute(cwd) ? cwd : undefined,
  };
}

export function fileSessionId(path: string): string | undefined {
  const name = basename(path);
  return name.endsWith(".jsonl") ? name.slice(0, -6) || undefined : undefined;
}

export function addGap(gaps: Gap[], kind: Gap["kind"], message: string, messageDescriptor?: MessageDescriptor, details?: MessageDescriptor[]): void {
  if (!gaps.some(gap => gap.kind === kind && gap.message === message)) gaps.push({ kind, message, messageDescriptor, details });
}

export function absoluteDirectory(value: unknown): string | undefined {
  const candidate = string(value);
  return candidate && isAbsolute(candidate) ? candidate : undefined;
}

export async function siblingDatabase(path: string, databaseName: string): Promise<string | undefined> {
  let directory = dirname(path);
  for (let depth = 0; depth < 7; depth += 1) {
    const candidate = join(directory, databaseName);
    try {
      const info = await lstat(candidate);
      if (info.isFile() && !info.isSymbolicLink()) return candidate;
    } catch {
      // 不存在的候选数据库不是来源缺口。
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}
