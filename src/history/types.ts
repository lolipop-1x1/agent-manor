import type { MessageDescriptor } from "../i18n/types.js";
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
  /** 原生同线程续段声明；偏移按解压后的 JSONL 字节计算。 */
  historyContinuation?: { endByteOffset: number; endOrdinalExclusive: number };
  historyPrefix?: { path: string; hash: string; endByteOffset: number; endOrdinalExclusive: number };
  /** 仅在本次发现中绑定已读取的元信息；不参与持久元信息指纹。 */
  discoveryQuickStamp?: string;
  /** 仅供来源选择器比较副本完整度；解析完成后不写入历史元数据。 */
  sourceCompleteness?: { version?: number; nativeVersion?: string; supported: boolean; complete: boolean; fingerprint: string };
  adapterGap?: Gap;
}

/** 文件路径仍是真实来源路径；多会话容器另用原生选择器区分缓存身份。 */
export const sourceLocationKey = (source: { path: string; selector?: string }): string =>
  source.selector ? JSON.stringify([source.path, source.selector]) : source.path;

export type DiscoverRoots = Partial<Record<Client, string | string[]>>;

export interface DiscoveryProgress {
  client: Client;
  path: string;
  sourceCount: number;
  complete: boolean;
}

export interface DiscoverOptions {
  clients?: readonly Client[];
  /** 同一来源文件的完整发现结果；只在适配器依赖标记未变化时复用。 */
  cachedSources?: readonly { location: SourceLocation; stamp: string }[];
  onProgress?: (progress: DiscoveryProgress) => void;
}

export interface HistoryRelationship {
  kind: "fork" | "subagent";
  parentSessionId: string;
  endByteOffset?: number;
  endOrdinalExclusive?: number;
  copiedRecordIdentityHashes?: string[];
  /** 适配器核验明确版本身份及完整消息前缀后提供，普通父关系没有此证明。 */
  copiedRecordIdentityProof?: "reasonix-superseded-prefix";
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
  reasonDescriptor?: MessageDescriptor;
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
  /** 完整依赖未变时可跳过正文读取；只用于快检，不替代 prefixHash。 */
  quickStamp?: string;
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
