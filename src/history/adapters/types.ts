import type { Client, EvidenceRecord, Gap, HistoryEvent, ParsedSource, SourceReference } from "../../contracts.js";
import type { ToolEvidence } from "../extraction.js";
import type { HistoryCursor, HistoryRelationship, ParsedHistorySource, PendingCall, SourceLocation } from "../types.js";

export interface HistoryClient {
  client: Client;
  format: string;
  environmentVariable: string;
  defaultRoots: readonly string[];
  /** 客户端自身的 home 覆盖，优先级低于 AgentManor 的显式 roots。 */
  homeEnvironmentVariable?: string;
  acceptsFile?: (path: string) => boolean;
  containerFormat?: string;
  acceptsContainer?: (path: string) => boolean;
}

export interface HistoryAdapterContext {
  client: Client;
  path: string;
  row: number;
  raw: string;
  occurredAt?: string;
  source: ParsedHistorySource;
  cursor: HistoryCursor;
  hash(value: string | Uint8Array): string;
  gap(kind: Gap["kind"], message: string): void;
  reference(recordLine: number, raw: string, callId?: string): SourceReference;
  findEvent(id: string): HistoryEvent | undefined;
  createEvent(tool: string, input: unknown, row: number, raw: string, occurredAt?: string, cwd?: string, key?: string): HistoryEvent;
  finish(call: PendingCall, result: unknown, visible: string, status: HistoryEvent["status"], row: number, raw: string, reason?: string): void;
  pair(callId: string, requestUuid?: string): PendingCall | undefined;
}

/** 格式适配器接收实际客户端身份，不据格式推断客户端。 */
export interface HistoryAdapter {
  id: string;
  /** 新来源使用共享规范化事件，同时供地图和会话库消费。 */
  normalized?: boolean;
  /** 多会话容器直接发现原生选择器，不按文本文件头猜测。 */
  discoverFile?(location: SourceLocation): Promise<SourceLocation[]>;
  readRecords?(location: SourceLocation): Promise<HistoryRecordSnapshot>;
  selectSources?(locations: SourceLocation[]): SourceLocation[];
  /** 只读旁路元数据；普通 JSONL 格式无需实现。 */
  readSourceMetadata?(location: SourceLocation): Promise<SourceLocation>;
  discover(record: Record<string, unknown>, location: SourceLocation): { source: SourceLocation; complete?: boolean } | undefined;
  processRecord(record: Record<string, unknown>, context: HistoryAdapterContext): void;
  extract(tool: string, input: unknown, result: unknown, visible: string, context: HistoryAdapterContext): ToolEvidence[];
  finalizeCall?(context: HistoryAdapterContext, call: PendingCall, event: HistoryEvent, result: unknown, visible: string, row: number, raw: string): boolean;
  /** 只关联已解析来源；矛盾证据可使原父声明失效，格式规则不散落到核心。 */
  resolveRelationships?(source: ParsedSource, sources: readonly ParsedSource[]): { relationships: HistoryRelationship[]; gaps?: Gap[]; invalidateParent?: boolean };
  /** 未关联来源只保留判断跨会话关系所需的工具字段，正文在确认相关后重新读取。 */
  relationshipEvidence?(event: HistoryEvent): Pick<HistoryEvent, "input" | "output">;
  readEvidence(source: SourceReference): Promise<EvidenceRecord | undefined>;
}

export interface HistoryRecordSnapshot {
  source: SourceLocation;
  hash: string;
  records: { record: Record<string, unknown>; raw: string; line: number }[];
}
