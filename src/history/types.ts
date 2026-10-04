import type { Client, Gap, HistoryEvent, JsonValue, ParsedSource, SourceReference } from "../contracts.js";

export interface HistoricalWorktree {
  path: string;
  from: number;
  until: number;
  sources: SourceReference[];
}

export interface SourceLocation {
  client: Client;
  format?: string;
  path: string;
  sourceId?: string;
  sessionId?: string;
  cwd?: string;
  parentSessionId?: string;
}

export type DiscoverRoots = Partial<Record<Client, string | string[]>>;

export interface HistoryRelationship {
  kind: "fork" | "subagent";
  parentSessionId: string;
  endByteOffset?: number;
  endOrdinalExclusive?: number;
  agentId?: string;
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
