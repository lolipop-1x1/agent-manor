import type { Client, Gap, HistoryEvent, JsonValue, ParsedSource, SourceReference } from "../contracts.js";

export interface HistoricalWorktree {
  path: string;
  from: number;
  until: number;
  sources: SourceReference[];
}

export interface SourceLocation {
  selector?: string;
  client: Client;
  format?: string;
  path: string;
  sourceId?: string;
  sessionId?: string;
  cwd?: string;
  parentSessionId?: string;
  /** 仅供来源选择器比较副本完整度；解析完成后不写入历史元数据。 */
  sourceCompleteness?: { version?: number; supported: boolean; complete: boolean; fingerprint: string };
  adapterGap?: Gap;
}

/** 文件路径仍是真实来源路径；多会话容器另用原生选择器区分缓存身份。 */
export const sourceLocationKey = (source: { path: string; selector?: string }): string =>
  source.selector ? JSON.stringify([source.path, source.selector]) : source.path;

export type DiscoverRoots = Partial<Record<Client, string | string[]>>;

export interface HistoryRelationship {
  kind: "fork" | "subagent";
  parentSessionId: string;
  endByteOffset?: number;
  endOrdinalExclusive?: number;
  copiedRecordIdentityHashes?: string[];
  agentId?: string;
  /** 证明跨来源关系的原始执行记录，不表示历史调用重放。 */
  sources?: SourceReference[];
}

export interface ParsedHistorySource extends ParsedSource {
  relationships: HistoryRelationship[];
}

export interface SourceAssociation {
  associated: boolean;
  source: ParsedHistorySource;
  events: HistoryEvent[];
  gaps: Gap[];
  reason: string;
}

export interface SharedHistoryResult {
  events: HistoryEvent[];
  gaps: Gap[];
  relationships: { sourceId: string; relationship: HistoryRelationship; resolved: boolean }[];
  /** 矛盾执行证据使当前父关系失效，原始声明仍保存在解析缓存中。 */
  invalidatedParentSourceIds: string[];
}

export interface PendingCall {
  eventId: string;
  callId: string;
  requestUuid?: string;
  tool: string;
  input: JsonValue;
  recordLine: number;
  wrapper?: boolean;
  turnId?: string;
}

export interface HistoryCursor {
  /** 只有归属元数据，不能作为完整证据续读；来源改变或确认相关时重新解析。 */
  associationOnly?: boolean;
  ruleVersion: string;
  format: string;
  adapterState?: JsonValue;
  prefixHash: string;
  completeBytes: number;
  recordLine: number;
  cwd?: string;
  pending: PendingCall[];
  seen: Record<string, string>;
  occurrences: Record<string, number>;
  recordEnds: number[];
  relationships: HistoryRelationship[];
  /** 上一轮已处理记录数；只用于核对真正续读，非来源身份。 */
  parsedRecords: number;
}
