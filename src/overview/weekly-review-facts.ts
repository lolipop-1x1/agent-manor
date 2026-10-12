import Database from "better-sqlite3";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { OverviewQuery, OverviewRequest, OverviewRange, WeeklyReviewEvent } from "../overview-contracts.js";
import type { SessionSummary } from "../session-contracts.js";
import type { SessionStore } from "../sessions/store.js";
import { instant } from "../usage/analytics.js";
import { isActivityEvent, matchesGlobalSession, pairToolCalls } from "./analytics.js";
import { addDays, localDay, resolveTimezone } from "./dates.js";
import { OverviewFactStore } from "./facts.js";

export interface WeeklyRoundFact {
  turnId: string;
  messageId: string;
  title: string;
  startedAt?: string;
  endedAt?: string;
  completion: "explicit" | "inferred" | "unconfirmed";
  steps: number | null;
  toolCalls: number;
  tokens: number | null;
  durationMs: number | null;
}
export interface WeeklySessionFacts {
  session: SessionSummary;
  activityDays?: string[];
  events: WeeklyReviewEvent[];
  requests: OverviewRequest[];
  rounds: WeeklyRoundFact[];
  retainedCompressions: number;
  compressionSupported: boolean;
  compressionComplete: boolean;
  missingTimeEvents: number;
  missingTimeRequests: number;
  unassignedRequests: number;
}

const valid = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value >= 0;
const riskyGaps = new Set(["source_missing", "source_unavailable", "unsupported_format", "parse_error", "incomplete_record", "budget_exceeded"]);
const compressionClients = new Set(["codex", "claude", "pi", "dsh", "opencode", "workbuddy", "codeflicker", "codeflicker-desktop"]);
const bodyOnlyGaps = new Set(["diagnostics.sessions.parser.m012", "diagnostics.sessions.parser.m013",
  "diagnostics.sessions.parser.m014", "diagnostics.sessions.parser.m015"]);
const requestIdentityGaps = new Set(["diagnostics.sessions.parserUsage.m003", "diagnostics.sessions.parser.m019"]);

export function weeklyReviewRange(query: OverviewQuery, now: Date): OverviewRange {
  const timezone = resolveTimezone(query.timezone), today = query.anchorDay ?? localDay(now, timezone)!;
  return { from: addDays(today, -7), to: addDays(today, -1), today, all: false, includesToday: false, comparison: null, recent: null };
}

/** 本地日历日期下界，覆盖夏令时短日、长日与非整点时区。 */
export function weeklyReviewBounds(range: OverviewRange, timezone: string): { fromMs: number; toMs: number } {
  const start = (day: string) => {
    const midnight = Date.parse(`${day}T00:00:00Z`);
    let left = midnight - 2 * 86400000, right = midnight + 2 * 86400000;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (localDay(middle, timezone)! < day) left = middle + 1; else right = middle;
    }
    return left;
  };
  return { fromMs: start(range.from), toMs: start(addDays(range.to, 1)) };
}

/** 每次需求与结束证据均按原始轮次身份关联，继承和注入不构成新用户需求。 */
export function weeklyRoundFacts(events: WeeklyReviewEvent[], requests: OverviewRequest[], complete = true): { rounds: WeeklyRoundFact[]; unassigned: number } {
  const starts = new Map<string, WeeklyReviewEvent>();
  const ends = new Map<string, WeeklyReviewEvent>();
  const inferred = new Map<string, WeeklyReviewEvent>();
  const messages = new Map(events.map(event => [event.id, event.turnId]));
  for (const event of events) {
    if (!isActivityEvent(event) || !event.turnId) continue;
    if (event.kind === "user" && !starts.has(event.turnId)) starts.set(event.turnId, event);
    if (event.kind === "assistant" && event.final === "explicit") ends.set(event.turnId, event);
    else if (event.kind === "assistant" && event.final === "inferred") inferred.set(event.turnId, event);
  }
  const usages = new Map<string, OverviewRequest[]>(), seen = new Set<string>();
  let unassigned = 0;
  for (const request of requests) {
    if (seen.has(request.usage.id)) continue;
    seen.add(request.usage.id);
    const associated = new Set([request.usage.messageId, ...(request.usage.requestMessageIds ?? [])]
      .flatMap(id => id && messages.has(id) ? [messages.get(id)!] : []));
    const turnId = request.usage.turnId ?? (associated.size === 1 ? [...associated][0] : undefined);
    if (!turnId || !starts.has(turnId)) { unassigned += 1; continue; }
    const values = usages.get(turnId) ?? []; values.push(request); usages.set(turnId, values);
  }
  const tools = new Map<string, number>();
  for (const event of events) if (event.kind === "tool_call" && isActivityEvent(event)) tools.set(event.turnId, (tools.get(event.turnId) ?? 0) + 1);
  const rounds = [...starts].map(([turnId, start]): WeeklyRoundFact => {
    const end = ends.get(turnId) ?? inferred.get(turnId), values = usages.get(turnId) ?? [];
    const ended = end && end.ordinal >= start.ordinal ? end : undefined;
    const startTime = instant(start.occurredAt ?? ""), endTime = instant(ended?.occurredAt ?? "");
    const tokenComplete = complete && values.length > 0 && values.every(request => valid(request.usage.inputTokens) && valid(request.usage.outputTokens));
    return { turnId, messageId: start.id, title: start.promptPreview?.trim() || "", startedAt: start.occurredAt, endedAt: ended?.occurredAt,
      completion: ended?.final === "explicit" ? "explicit" : ended ? "inferred" : "unconfirmed",
      steps: values.length ? values.length : null, toolCalls: tools.get(turnId) ?? 0,
      tokens: tokenComplete ? values.reduce((sum, request) => sum + request.usage.inputTokens! + request.usage.outputTokens!, 0) : null,
      durationMs: startTime !== undefined && endTime !== undefined && endTime >= startTime ? endTime - startTime : null };
  });
  return { rounds, unassigned };
}

/** 固定七天首先筛选时间相交的会话元数据，仅物化需要的不可变修订。 */
export class WeeklyReviewFactStore {
  private readonly database: Database.Database;
  private readonly overview?: OverviewFactStore;
  constructor(private readonly sessions: SessionStore, path = join(dirname(sessions.dbPath), "weekly-review-facts-v2.sqlite")) {
    this.database = new Database(path); chmodSync(path, 0o600);
    this.database.pragma("journal_mode=WAL"); this.database.pragma("foreign_keys=ON"); this.database.pragma("busy_timeout=5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS weekly_revisions (revision TEXT PRIMARY KEY,source_revision TEXT NOT NULL,format INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS weekly_revision_source ON weekly_revisions(source_revision,format);
      CREATE TABLE IF NOT EXISTS weekly_events (revision TEXT NOT NULL REFERENCES weekly_revisions(revision) ON DELETE CASCADE,
        id TEXT NOT NULL,time_ms REAL,json TEXT NOT NULL,PRIMARY KEY(revision,id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS weekly_event_time ON weekly_events(revision,time_ms);
      CREATE TABLE IF NOT EXISTS weekly_requests (revision TEXT NOT NULL REFERENCES weekly_revisions(revision) ON DELETE CASCADE,
        id TEXT NOT NULL,time_ms REAL,json TEXT NOT NULL,PRIMARY KEY(revision,id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS weekly_request_time ON weekly_requests(revision,time_ms);
      CREATE TABLE IF NOT EXISTS weekly_rounds (revision TEXT NOT NULL REFERENCES weekly_revisions(revision) ON DELETE CASCADE,
        id TEXT NOT NULL,start_ms REAL,end_ms REAL,json TEXT NOT NULL,PRIMARY KEY(revision,id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS weekly_round_end ON weekly_rounds(revision,end_ms);
    `);
    // 已发布总览窄事实可直接复用；缺失或坏缓存退回源的只读窗口投影。
    if (existsSync(join(dirname(sessions.dbPath), "overview-facts-v2.sqlite"))) {
      try { this.overview = new OverviewFactStore(sessions, { readonly: true }); } catch { /* 可选缓存不阻断复盘。 */ }
    }
  }
  private processFacts(revision: string, sessionId: string, bounds: { fromMs: number; toMs: number }, turns: string[], timezone: string) {
    if (!this.overview) return;
    try {
      const valid = this.overview.readRows<{ events: number; requests: number; actual_events: number; actual_requests: number }>(`SELECT events,requests,
        (SELECT COUNT(*) FROM overview_fact_events WHERE revision=r.revision) AS actual_events,
        (SELECT COUNT(*) FROM overview_fact_requests WHERE revision=r.revision) AS actual_requests
        FROM overview_fact_revisions r WHERE revision=? AND format=2`, [revision])[0];
      if (!valid || valid.events !== valid.actual_events || valid.requests !== valid.actual_requests) return;
      const rows = this.overview.readRows<{ id: string; ordinal: number; kind: WeeklyReviewEvent["kind"]; turn_id: string; tool: string | null; status: WeeklyReviewEvent["status"] | null; json: string }>(`
        SELECT id,ordinal,kind,turn_id,tool,status,json FROM overview_fact_events WHERE revision=? AND active=1
          AND kind IN ('tool_call','compression') AND (time_ms>=? AND time_ms<? OR turn_id IN (SELECT value FROM json_each(?)))
        ORDER BY ordinal`, [revision, bounds.fromMs, bounds.toMs, JSON.stringify(turns)]);
      const events = rows.map((row): WeeklyReviewEvent => ({ ...JSON.parse(row.json), id: row.id, ordinal: row.ordinal, kind: row.kind,
        turnId: row.turn_id, sessionId, tool: row.tool ?? undefined, status: row.status ?? undefined, recordLine: 0 }));
      const counts = this.overview.readRows<{ compressions: number; missing_events: number; missing_requests: number }>(`SELECT
        (SELECT COUNT(*) FROM overview_fact_events WHERE revision=? AND active=1 AND kind='compression') AS compressions,
        (SELECT COUNT(*) FROM overview_fact_events WHERE revision=? AND active=1 AND time_ms IS NULL) AS missing_events,
        (SELECT COUNT(*) FROM overview_fact_requests WHERE revision=? AND time_ms IS NULL) AS missing_requests`, [revision, revision, revision])[0]!;
      const activityDays = this.overview.readRows<{ day: string | null }>(`SELECT DISTINCT overview_local_day(time_ms,?) AS day
        FROM overview_fact_events WHERE revision=? AND active=1 AND kind IN ('assistant','thinking','tool_result') AND time_ms>=? AND time_ms<?`,
        [timezone, revision, bounds.fromMs, bounds.toMs]).flatMap(row => row.day === null ? [] : [row.day]);
      return { events, activityDays, retainedCompressions: counts.compressions, missingTimeEvents: counts.missing_events, missingTimeRequests: counts.missing_requests };
    } catch { return; }
  }
  private prepare(revision: string, sourceRevision: string, session: SessionSummary, bounds: { fromMs: number; toMs: number }, timezone: string): void {
    const retained = this.database.prepare("SELECT format,json FROM weekly_revisions WHERE revision=? AND format IN (5,6)").get(revision) as { format: number; json: string } | undefined;
    if (retained?.format === 6) return;
    if (retained?.format === 5) {
      // 仅补新增的执行活动日，整轮投入与窗口请求事实仍来自同一不可变修订。
      const [, from, to, savedTimezone] = JSON.parse(revision) as string[];
      const range = { ...weeklyReviewRange({ timezone: savedTimezone, anchorDay: addDays(to!, 1) }, new Date()), from: from!, to: to! };
      const storedBounds = weeklyReviewBounds(range, savedTimezone!);
      let activityDays: string[] | undefined;
      if (this.overview) {
        try {
          const ready = this.overview.readRows(`SELECT 1 FROM overview_fact_revisions WHERE revision=? AND format=2`, [sourceRevision]).length > 0;
          if (ready) activityDays = this.overview.readRows<{ day: string | null }>(`SELECT DISTINCT overview_local_day(time_ms,?) AS day
            FROM overview_fact_events WHERE revision=? AND active=1 AND kind IN ('assistant','thinking','tool_result') AND time_ms>=? AND time_ms<?`,
            [savedTimezone!, sourceRevision, storedBounds.fromMs, storedBounds.toMs]).flatMap(row => row.day === null ? [] : [row.day]);
        } catch { /* 不可用窄缓存退回执行元数据。 */ }
      }
      const metadata = { ...JSON.parse(retained.json), activityDays: activityDays ?? this.sessions.weeklyReviewActivityDays(sourceRevision, storedBounds, savedTimezone!) };
      this.database.prepare("UPDATE weekly_revisions SET format=6,json=? WHERE revision=? AND format=5").run(JSON.stringify(metadata), revision);
      return;
    }
    const source = this.sessions.weeklyReviewRevisionFacts(sourceRevision, session.id,
      { ...bounds, client: session.client, timezone, processFacts: turns => this.processFacts(sourceRevision, session.id, bounds, turns, timezone) });
    const calls = new Map(pairToolCalls(source.events).map(event => [event.id, event]));
    const events = source.events.filter(event => isActivityEvent(event) && event.kind !== "tool_result")
      .map(event => ({ ...event, ...(calls.get(event.id) ?? {}) }));
    const complete = !session.gaps.some(gap => riskyGaps.has(gap.kind) && !bodyOnlyGaps.has(gap.messageDescriptor?.key ?? "")
      || requestIdentityGaps.has(gap.messageDescriptor?.key ?? ""));
    const { rounds, unassigned } = weeklyRoundFacts(events, source.requests, complete);
    const metadata = { activityDays: source.activityDays ?? [], retainedCompressions: source.retainedCompressions ?? events.filter(event => event.kind === "compression").length,
      compressionSupported: compressionClients.has(session.client), compressionComplete: complete,
      missingTimeEvents: source.missingTimeEvents ?? events.filter(event => instant(event.occurredAt ?? "") === undefined).length,
      missingTimeRequests: source.missingTimeRequests ?? source.requests.filter(request => instant(request.usage.occurredAt ?? "") === undefined).length, unassignedRequests: unassigned };
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM weekly_revisions WHERE revision=?").run(revision);
      this.database.prepare("INSERT INTO weekly_revisions VALUES(?,?,6,?)").run(revision, sourceRevision, JSON.stringify(metadata));
      const eventInsert = this.database.prepare("INSERT INTO weekly_events VALUES(?,?,?,?)");
      for (const event of events) eventInsert.run(revision, event.id, instant(event.occurredAt ?? "") ?? null, JSON.stringify(event));
      const requestInsert = this.database.prepare("INSERT INTO weekly_requests VALUES(?,?,?,?)");
      for (const request of source.requests) requestInsert.run(revision, request.usage.id, instant(request.usage.occurredAt ?? "") ?? null, JSON.stringify(request));
      const roundInsert = this.database.prepare("INSERT INTO weekly_rounds VALUES(?,?,?,?,?)");
      for (const round of rounds) roundInsert.run(revision, round.turnId, instant(round.startedAt ?? "") ?? null,
        instant(round.endedAt ?? "") ?? null, JSON.stringify(round));
    }).immediate();
  }
  async source(query: OverviewQuery, now: Date): Promise<{ version: string; facts: WeeklySessionFacts[] }> {
    const { version, sessions } = this.sessions.usageFactSessions(query.version), range = weeklyReviewRange(query, now);
    const timezone = resolveTimezone(query.timezone);
    const candidates = sessions.filter(({ session }) => {
      if (!matchesGlobalSession(session, query)) return false;
      const started = localDay(session.startedAt, timezone), updated = localDay(session.updatedAt, timezone);
      return !(started && updated && (updated < range.from || started > range.to));
    });
    const facts: WeeklySessionFacts[] = [];
    const used: string[] = [];
    const bounds = weeklyReviewBounds(range, timezone), low = bounds.fromMs, high = bounds.toMs;
    const inRange = (value?: string) => { const day = localDay(value, timezone); return day !== null && day >= range.from && day <= range.to; };
    const eventsQuery = this.database.prepare("SELECT json FROM weekly_events WHERE revision=? AND time_ms>=? AND time_ms<?");
    const requestsQuery = this.database.prepare("SELECT json FROM weekly_requests WHERE revision=? AND time_ms>=? AND time_ms<?");
    const roundsQuery = this.database.prepare("SELECT json FROM weekly_rounds WHERE revision=? AND (end_ms>=? AND end_ms<? OR start_ms>=? AND start_ms<?)");
    for (const { revision: sourceRevision, session } of candidates) {
      // 未变化且活动已结束的来源可复用覆盖窗口；跨日只丢弃窗口外事件，不重新扫描原历史。
      const updated = localDay(session.updatedAt, timezone);
      const reusable = updated ? this.database.prepare(`SELECT revision FROM weekly_revisions WHERE source_revision=? AND format IN (5,6)
        AND json_extract(revision,'$[3]')=? AND json_extract(revision,'$[1]')<=? AND json_extract(revision,'$[2]')>=?
        ORDER BY json_extract(revision,'$[2]') DESC LIMIT 1`).get(sourceRevision, timezone, range.from, updated < range.to ? updated : range.to) as { revision: string } | undefined : undefined;
      const revision = reusable?.revision ?? JSON.stringify([sourceRevision, range.from, range.to, timezone]);
      used.push(revision);
      this.prepare(revision, sourceRevision, session, bounds, timezone);
      const metadata = JSON.parse((this.database.prepare("SELECT json FROM weekly_revisions WHERE revision=?").get(revision) as { json: string }).json) as Omit<WeeklySessionFacts, "session" | "events" | "requests" | "rounds">;
      const events = (eventsQuery.all(revision, low, high) as { json: string }[]).map(row => JSON.parse(row.json) as WeeklyReviewEvent).filter(event => inRange(event.occurredAt));
      const requests = (requestsQuery.all(revision, low, high) as { json: string }[]).map(row => JSON.parse(row.json) as OverviewRequest).filter(request => inRange(request.usage.occurredAt));
      const rounds = (roundsQuery.all(revision, low, high, low, high) as { json: string }[]).map(row => JSON.parse(row.json) as WeeklyRoundFact)
        .filter(round => inRange(round.endedAt) || inRange(round.startedAt));
      facts.push({ session, events, requests, rounds, ...metadata });
      await nextTurn();
    }
    // 只保留仍能绑定到某个索引版本的修订，不让追加历史造成派生缓存无限增长。
    const retained = this.sessions.overviewRetainedRevisions();
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM weekly_revisions WHERE source_revision NOT IN (SELECT value FROM json_each(?))").run(JSON.stringify(retained));
      this.database.prepare(`DELETE FROM weekly_revisions WHERE revision IN (SELECT revision FROM (
        SELECT revision,ROW_NUMBER() OVER (PARTITION BY source_revision ORDER BY
          CASE WHEN revision IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END DESC,
          json_extract(revision,'$[2]') DESC,revision DESC) AS position FROM weekly_revisions) WHERE position>4)`).run(JSON.stringify(used));
    }).immediate();
    return { version, facts };
  }
  close(): void { this.overview?.close(); this.database.close(); }
}
