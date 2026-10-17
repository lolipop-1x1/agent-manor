import { createHash } from "node:crypto";
import { DiagnosticError } from "../i18n/diagnostics.js";
import { historyBytes, historyHead } from "./stream.js";
import { number, object, string } from "./extraction.js";
import { historyRelationships } from "./adapters/common.js";
import { sourceQuickStamp } from "./quick-check.js";
import type { SourceLocation } from "./types.js";

export function codexContinuation(record: Record<string, unknown>): SourceLocation["historyContinuation"] {
  const payload = object(record.payload), base = object(payload.history_base);
  const endByteOffset = number(base.end_byte_offset), endOrdinalExclusive = number(base.end_ordinal_exclusive);
  return record.type === "session_meta" && string(base.thread_id) === string(payload.id) && string(payload.id)
    && Number.isSafeInteger(endByteOffset) && endByteOffset! > 0 && Number.isSafeInteger(endOrdinalExclusive)
    && endOrdinalExclusive! > 0 && number(record.ordinal) === endOrdinalExclusive ? { endByteOffset: endByteOffset!, endOrdinalExclusive: endOrdinalExclusive! } : undefined;
}

const invalidPrefix = () => new DiagnosticError("无法唯一核验 Codex 分段历史的前缀及边界", { key: "diagnostics.history.compressed.prefix" });

/** 发现后的头部改写不能沿用旧绑定；普通完整来源没有前缀声明。 */
export function verifyCodexPrefix(record: Record<string, unknown>, source: SourceLocation): void {
  const payload = object(record.payload), base = object(payload.history_base);
  const declared = Boolean(string(payload.id)) && base.thread_id === payload.id;
  if (!declared && !source.historyPrefix) return;
  const continuation = codexContinuation(record), prefix = source.historyPrefix;
  const session = string(record.agentId) ? `${String(payload.id)}/agent/${String(record.agentId)}` : payload.id;
  if (!continuation || !prefix || session !== source.sessionId || continuation.endByteOffset !== prefix.endByteOffset
    || continuation.endOrdinalExclusive !== prefix.endOrdinalExclusive) throw invalidPrefix();
}

/** 声明的字节偏移属于解压正文；核验换行、后续原生 ordinal 以及完整前缀哈希。 */
async function prefixHash(path: string, boundary: NonNullable<SourceLocation["historyContinuation"]>): Promise<string | undefined> {
  const hash = createHash("sha256");
  let offset = 0, lastByte = -1, tail: Buffer[] = [], tailSize = 0;
  let verified: boolean | undefined;
  for await (const chunk of historyBytes(path)) {
    if (verified !== undefined) continue;
    const size = Math.min(chunk.length, Math.max(0, boundary.endByteOffset - offset));
    if (size) { hash.update(chunk.subarray(0, size)); lastByte = chunk[size - 1]!; }
    offset += chunk.length;
    if (offset <= boundary.endByteOffset) continue;
    if (lastByte !== 10) return undefined;
    const remaining = chunk.subarray(size), newline = remaining.indexOf(10);
    const part = newline < 0 ? remaining : remaining.subarray(0, newline);
    tail.push(part); tailSize += part.length;
    if (tailSize > 16 * 1024 * 1024) return undefined;
    if (newline >= 0) {
      try { verified = number(object(JSON.parse(Buffer.concat(tail, tailSize).toString("utf8"))).ordinal) === boundary.endOrdinalExclusive; }
      catch { verified = false; }
    }
  }
  // EOF 本身不能证明后续 ordinal；不猜测只剩前缀的候选是否属于该续段。
  return verified ? hash.digest("hex") : undefined;
}

/** 只拼接同一原生线程、可唯一证明字节边界的前缀；完整副本仍由发布阶段择一。 */
export async function bindCodexPrefixes(sources: SourceLocation[]): Promise<SourceLocation[]> {
  const groups = new Map<string, SourceLocation[]>();
  for (const source of sources) if (source.client === "codex" && source.sessionId) {
    const group = groups.get(source.sessionId) ?? []; group.push(source); groups.set(source.sessionId, group);
  }
  for (const group of groups.values()) {
    // 兼容升级前已缓存的发现元数据，只重新检查重复身份的头部。
    if (group.length > 1) for (const source of group) if (!source.historyContinuation) {
      try {
        const header = object(JSON.parse((await historyHead(source.path)).toString("utf8").split("\n")[0]!));
        const continuation = codexContinuation(header);
        if (continuation) { source.historyContinuation = continuation; source.parentSessionId = historyRelationships(header)[0]?.parentSessionId; }
      } catch { /* 原有发现或解析路径继续报告无效来源。 */ }
    }
    for (const source of group) {
      if (!source.historyContinuation) continue;
      const originalStamp = source.discoveryQuickStamp, originalPrefix = source.historyPrefix;
      const matches = [];
      for (const candidate of group) if (candidate.path !== source.path && !candidate.historyContinuation) {
        const stamp = await sourceQuickStamp(candidate);
        const hash = await prefixHash(candidate.path, source.historyContinuation);
        if (hash && stamp && await sourceQuickStamp(candidate) === stamp) matches.push({ path: candidate.path, hash, stamp });
      }
      if (!matches.length || new Set(matches.map(match => match.hash)).size !== 1) throw invalidPrefix();
      const selected = matches.sort((a, b) => a.path.localeCompare(b.path))[0]!;
      const stable = originalStamp && await sourceQuickStamp({ ...source, historyPrefix: originalPrefix }) === originalStamp;
      source.historyPrefix = { path: selected.path, hash: selected.hash, ...source.historyContinuation };
      const stamp = await sourceQuickStamp(source);
      source.discoveryQuickStamp = stable && await sourceQuickStamp({ ...source, path: selected.path, historyPrefix: undefined }) === selected.stamp ? stamp : undefined;
    }
  }
  return sources;
}

/** 完整消费并校验压缩流，只把声明边界以前的正文交给解析器。 */
export async function* historyPrefixBytes(prefix: NonNullable<SourceLocation["historyPrefix"]>) {
  const { path, endByteOffset: limit } = prefix;
  const hash = createHash("sha256");
  let size = 0, lastByte = -1;
  for await (const chunk of historyBytes(path)) {
    const part = chunk.subarray(0, Math.max(0, limit - size)); size += chunk.length;
    if (part.length) { hash.update(part); lastByte = part[part.length - 1]!; yield part; }
  }
  if (size < limit || lastByte !== 10 || hash.digest("hex") !== prefix.hash) throw invalidPrefix();
}
