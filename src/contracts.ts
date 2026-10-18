import type { MessageDescriptor } from "./i18n/types.js";
import type { Client } from "./clients.js";
export type { Client } from "./clients.js";
export type FileCategory = "source" | "config" | "docs" | "unknown";
export type EventKind = "read" | "edit" | "search" | "other";
export type EventStatus = "success" | "failure" | "unknown";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** 一基闭区间；end 行包含在范围中。 */
export interface LineRange {
  start: number;
  end: number;
}

export interface Repository {
  id: string;
  path: string;
  commonDir: string;
  name: string;
  version?: string;
  stale: boolean;
}

export interface SourceReference {
  /** 容器或同文件内的原生会话选择键，由具体格式解释。 */
  selector?: string;
  sourceId: string;
  /** 原始记录的历史格式，与客户端身份分别保存。 */
  format?: string;
  path: string;
  /** 普通 JSONL 为物理行；容器／多文件快照为可校验的记录序号。 */
  recordLine: number;
  /** 原生事件序号或事件身份摘要，仅用于验证原生 fork 复制边界。 */
  recordOrdinal?: number;
  recordIdentityHash?: string;
  /** 原始记录内容哈希；文件追加不会使旧记录失效。 */
  hash: string;
  callId?: string;
}

export interface EvidenceFragment {
  content: string;
  kind: "read" | "added" | "deleted" | "context";
  path?: string;
  historicalStart?: number;
  /** false 表示片段含不完整行，不可直接计入整行覆盖。 */
  completeLines: boolean;
}

export interface HistoryEvent {
  id: string;
  client: Client;
  sessionId: string;
  parentSessionId?: string;
  occurredAt?: string;
  tool: string;
  kind: EventKind;
  status: EventStatus;
  cwd?: string;
  path?: string;
  fragments: EvidenceFragment[];
  sources: SourceReference[];
  input?: JsonValue;
  output?: JsonValue;
  reason?: string;
  reasonDescriptor?: MessageDescriptor;
}

export type GapKind =
  | "source_missing"
  | "source_unavailable"
  | "range_unknown"
  | "unsupported_format"
  | "unsupported_tool"
  | "ambiguous"
  | "unassociated"
  | "parse_error"
  | "incomplete_record"
  | "unpaired_call"
  | "budget_exceeded";

export interface Gap {
  kind: GapKind;
  message: string;
  messageDescriptor?: MessageDescriptor;
  details?: MessageDescriptor[];
  sourceId?: string;
  count?: number;
}

export interface HistorySource {
  selector?: string;
  sourceId: string;
  client: Client;
  format?: string;
  path: string;
  /** 当前来源文件的完整内容哈希。 */
  hash: string;
  sessionId: string;
  cwd?: string;
  parentSessionId?: string;
}

export interface ParsedSource extends HistorySource {
  events: HistoryEvent[];
  gaps: Gap[];
  completeBytes: number;
  /** JSON 可序列化的适配器状态，包含续读所需的未配对调用等信息。 */
  cursor?: JsonValue;
}

export interface SourceSummary extends HistorySource {
  eventCount: number;
  completeBytes: number;
  association?: "automatic" | "manual";
}

export interface BaselineFile {
  path: string;
  category: FileCategory;
  lineCount: number;
  hash: string;
  content: string;
}

export interface GitState {
  head?: string;
  branch?: string;
  dirty: boolean;
}

export interface ExcludedFile {
  path: string;
  reason: string;
}

export interface Baseline {
  repository: Repository;
  hash: string;
  createdAt: string;
  git: GitState;
  files: BaselineFile[];
  excluded: ExcludedFile[];
}

export interface Mapping {
  eventId: string;
  filePath: string;
  kind: "read" | "edit";
  exactRanges: LineRange[];
  nearRanges: LineRange[];
  unknownReason?: string;
  unknownReasonDescriptors?: MessageDescriptor[];
  ruleVersion: string;
}

/** 未提供时使用全部客户端、全部历史和 source 类别。 */
export interface Filters {
  client?: Client;
  /** 两个字段同时提供，只收窄活动，不改变当前文件基线。 */
  sessionClient?: Client;
  clientSessionId?: string;
  from?: string;
  to?: string;
  categories?: FileCategory[];
  directory?: string;
}

export interface MapSession {
  client: Client;
  clientSessionId: string;
  title?: string;
  titleDescriptor?: MessageDescriptor;
  startedAt?: string;
  updatedAt?: string;
  eventCount: number;
}

export interface MapSessionsResponse {
  version: string;
  clients: Client[];
  sessions: MapSession[];
}

export interface CoverageQuery extends Filters {
  version?: string;
}

export interface EventsQuery extends CoverageQuery {
  path?: string;
  kind?: EventKind;
  page?: number;
  pageSize?: number;
}

export interface FileCoverage {
  path: string;
  category: FileCategory;
  lineCount: number;
  hash: string;
  readExactLines: number;
  readNearLines: number;
  editExactLines: number;
  editNearLines: number;
  readCount: number;
  editCount: number;
  /** 按事件身份去重的总活动次数，各状态与类型计数可能重叠。 */
  activityCount: number;
  searchCount: number;
  failedCount: number;
  unknownCount: number;
  readExactRanges: LineRange[];
  readNearRanges: LineRange[];
  editExactRanges: LineRange[];
  editNearRanges: LineRange[];
}

export interface CoverageCount {
  files: number;
  lines: number;
}

export interface CoverageSummary {
  fileCount: number;
  lineCount: number;
  readExact: CoverageCount;
  readNear: CoverageCount;
  editExact: CoverageCount;
  editNear: CoverageCount;
}

export interface VersionedResult {
  repository: Repository;
  version: string;
  baselineHash: string;
  createdAt: string;
  stale: boolean;
  filters: Filters;
  previousVersion?: string;
}

export interface CoverageResult extends VersionedResult {
  files: FileCoverage[];
  summary: CoverageSummary;
  gaps: Gap[];
  /** 摘要查询保留完整数量，具体诊断按同版范围另取。 */
  gapCount?: number;
}

export interface FileEvent extends HistoryEvent {
  mapping?: Mapping;
}

export interface FileDetail extends VersionedResult {
  file: FileCoverage;
  /** 无法读取当前文件时为 null；内容过期时禁止应用旧范围高亮。 */
  content: string | null;
  contentHash?: string;
  contentStale: boolean;
  events: FileEvent[];
}

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Job {
  id: string;
  repositoryId: string;
  status: JobStatus;
  phase: string;
  phaseDescriptor?: MessageDescriptor;
  /** 0 到 1；未知进度可保留 0 并通过 phase 说明。 */
  progress: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  errorDescriptor?: MessageDescriptor;
  version?: string;
}

export interface AnalysisSnapshot {
  repository: Repository;
  version: string;
  baseline: Baseline;
  sources: HistorySource[];
  events: HistoryEvent[];
  mappings: Mapping[];
  gaps: Gap[];
  createdAt: string;
  previousVersion?: string;
}

export interface ServiceInstance {
  id: string;
  pid: number;
  host: "127.0.0.1";
  port: number;
  startedAt: string;
  version?: string;
  protocolVersion?: number;
}

export interface ServicePreparation {
  state: "pending" | "running" | "ready" | "failed" | "skipped";
  phase: "history" | "usage" | "overview" | "complete";
  startedAt: string;
  finishedAt?: string;
  sourceVersion?: string;
  jobIds: string[];
  error?: string;
}

export interface ServiceActiveTask {
  id: string;
  kind: "sessions" | "repository" | "knowledge" | "semantic";
  status: string;
}

export interface StatusResponse {
  instance: ServiceInstance;
  version: string;
  protocolVersion?: number;
  preparation?: ServicePreparation;
  activeTasks?: ServiceActiveTask[];
  repositories: Repository[];
  jobs: Job[];
  indexMaintenance?: IndexMaintenanceResult;
  indexReclaim?: IndexMaintenanceResult;
}

export interface IndexMaintenanceResult {
  status: "completed" | "skipped" | "failed";
  reason: "noDatabase" | "threshold" | "cooldown" | "unsupportedSchema" | "insufficientSpace" | "busy" | "error" | "completed";
  messageDescriptor: MessageDescriptor;
  beforeBytes?: number;
  afterBytes?: number;
  freeBytes?: number;
  lastSuccess?: string;
  details?: string;
}

export interface StopResponse {
  stopping: true;
}

export interface RepositoriesResponse {
  repositories: Repository[];
}

export interface RegisterRepositoryRequest {
  path: string;
}

export interface RegisterRepositoryResponse {
  repository: Repository;
  job?: Job;
}

export interface DeleteRepositoryResponse {
  repositoryId: string;
}

export interface EventsResponse {
  version: string;
  events: HistoryEvent[];
  total: number;
  page: number;
  pageSize: number;
}

export interface EvidenceRecord {
  source: SourceReference;
  raw: string;
}

export interface EvidenceResponse {
  version: string;
  event: HistoryEvent;
  records: EvidenceRecord[];
  unavailable: SourceReference[];
}

export interface SourcesResponse {
  version: string;
  sources: SourceSummary[];
  unassociated: SourceSummary[];
  gaps: Gap[];
}

export interface AssociateSourceRequest {
  sourceId: string;
}

export interface JobResponse {
  job: Job;
}

export type ApiErrorCode =
  | "INVALID_INPUT"
  | "REPOSITORY_NOT_FOUND"
  | "VERSION_NOT_FOUND"
  | "ANALYSIS_NOT_READY"
  | "FILE_NOT_FOUND"
  | "CONTENT_STALE"
  | "EVENT_NOT_FOUND"
  | "SOURCE_NOT_FOUND"
  | "JOB_NOT_FOUND"
  | "FORBIDDEN"
  | "INTERNAL_ERROR";

export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    messageDescriptor?: MessageDescriptor;
  };
}
