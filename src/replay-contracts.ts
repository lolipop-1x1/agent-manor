import type { Client, EventKind, EventStatus, FileCategory, Gap, Repository } from "./contracts.js";

export interface ReplaySessionOption {
  id: string;
  client: Client;
  clientSessionId: string;
  title: string;
  titleOrigin?: string;
  relationship?: "child" | "fork";
  updatedAt?: string;
  eventCount: number;
  trackCount: number;
}

export interface ReplayTrack {
  id: string;
  client: Client;
  clientSessionId: string;
  title: string;
  titleOrigin?: string;
  parentId?: string;
  depth: number;
  eventCount: number;
  untimedCount: number;
}

export interface ReplayActivity {
  id: string;
  kind: EventKind;
  status: EventStatus;
  tool: string;
  paths: string[];
  messageId?: string;
}

export interface ReplayStep {
  id: string;
  trackId: string;
  order: number;
  /** false 时仅保留稳定展示位置，不声称来源已经证明活动先后。 */
  orderKnown?: boolean;
  occurredAt?: string;
  time?: number;
  durationMs?: number;
  activities: ReplayActivity[];
}

export interface ReplayFile { path: string; category: FileCategory; lineCount: number }

export interface ReplaySessionsResult {
  version: string;
  sessionVersion: string;
  sessions: ReplaySessionOption[];
}

export interface ReplayResult {
  repository: Repository;
  version: string;
  sessionVersion: string;
  baselineHash: string;
  stale: boolean;
  sessionId: string;
  tracks: ReplayTrack[];
  steps: ReplayStep[];
  files: ReplayFile[];
  range: { start: number; end: number } | null;
  missingChildren: number;
  totalActivities: number;
  gaps: Gap[];
}
