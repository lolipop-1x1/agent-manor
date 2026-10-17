import type { Client, Gap, HistoryEvent, Mapping, Repository } from "../contracts.js";
import type { SessionSummary } from "../session-contracts.js";
import type { ReplayFile } from "../replay-contracts.js";

/** 独立读取回放所需字段，避免解析及搬运覆盖范围、基线正文和历史片段。 */
export interface ReplaySnapshot {
  repository: Repository;
  version: string;
  baselineHash: string;
  files: ReplayFile[];
  events: (Pick<HistoryEvent, "id" | "client" | "sessionId" | "tool" | "kind" | "status" | "occurredAt" | "cwd" | "path" | "sources">
    & { fragments: { path?: string }[] })[];
  mappings: Pick<Mapping, "eventId" | "filePath">[];
  gaps: Gap[];
  /** 分块定位仅供服务内部按需回读单个证据，不进入公共回放响应。 */
  eventParts: Map<string, number>;
}

/** 播放只读取身份、关系和定位元数据，工具正文仍按证据接口读取。 */
export interface ReplaySessionMetadata {
  id: string;
  revision: string;
  client: Client;
  clientSessionId: string;
  title: string;
  titleOrigin: SessionSummary["titleOrigin"];
  relationship?: "child" | "fork";
  parentId?: string;
  childSessionIds: string[];
  updatedAt?: string;
  path: string;
  sourceId: string;
  gaps: Gap[];
}

export interface ReplayMessageMetadata {
  id: string;
  sessionId: string;
  ordinal: number;
  recordLine: number;
  sourcePath: string;
  kind: string;
  callId?: string;
  tool?: string;
  occurredAt?: string;
  durationMs?: number;
}
