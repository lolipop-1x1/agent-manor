import type { OverviewQuery, WeeklyReview, WeeklyReviewDetailKind, WeeklyReviewDetailPage, WeeklyReviewDetailQuery, WeeklyReviewRecord } from "../../../src/overview-contracts";
import type { Language } from "../../../src/i18n/types";
import type { Client } from "../../../src/clients";
import { sessionDisplayTitle } from "../sessions/session-model";
import { overviewParameters } from "./model";
import { sameOverviewSnapshot, OverviewSnapshotMismatch } from "./loading";
import { questionPreview } from "../sessions/session-question-preview";

/** 周复盘只沿用客户端和项目；顶部日期及模型筛选不改变七天窗口。 */
export function weeklyReviewParameters(query: Pick<OverviewQuery, "clients" | "projects">): string {
  return overviewParameters({ clients: query.clients, projects: query.projects });
}

export function weeklyReviewDetailParameters(review: WeeklyReview, detail: WeeklyReviewDetailQuery): string {
  return overviewParameters({ ...review.query, version: review.version, priceVersion: review.priceVersion, timezone: review.timezone, detail: JSON.stringify(detail) });
}

export async function loadWeeklyReviewDetail(review: WeeklyReview, detail: WeeklyReviewDetailQuery, transport: (path: string, signal: AbortSignal) => Promise<WeeklyReviewDetailPage>, signal: AbortSignal): Promise<WeeklyReviewDetailPage> {
  const result = await transport(`/overview/review/detail?${weeklyReviewDetailParameters(review, detail)}`, signal);
  if (signal.aborted) throw new DOMException("", "AbortError");
  const snapshot = (value: WeeklyReview | WeeklyReviewDetailPage) => ({ version: value.version, priceVersion: value.priceVersion, timezone: value.timezone, query: value.query, range: value.range });
  if (!sameOverviewSnapshot(snapshot(review), snapshot(result))) throw new OverviewSnapshotMismatch();
  return result;
}

export const weeklyReviewViews = ["sessions", "sessionRounds", "rounds", "cache", "compressions", "agents", "models", "reasoning", "prompts", "activity", "uncompressed", "projects", "delegation", "tools"] as const;

export function weeklyReviewDefaultFilter(kind: WeeklyReviewDetailKind): WeeklyReviewDetailQuery["filter"] {
  return kind === "rounds" ? "ended" : undefined;
}

export function weeklyReviewApproximation(value: number | null | undefined, inferredSamples?: number): string {
  return value != null && (inferredSamples ?? 0) > 0 ? "≈ " : "";
}

export function weeklyReviewDuration(ms: number | null | undefined): { key: string; value: number } | null {
  return ms == null ? null : ms < 60_000 ? { key: "overview.review.timeSeconds", value: ms / 1000 }
    : ms < 3_600_000 ? { key: "overview.review.timeMinutes", value: ms / 60_000 }
      : { key: "overview.review.timeHours", value: ms / 3_600_000 };
}

/** 产品生成标题按来源翻译，真实需求与原会话标题保持原文。 */
export function weeklyReviewRecordTitle(record: WeeklyReviewRecord | undefined, language: Language): string {
  const title = record ? sessionDisplayTitle({ title: record.title, titleOrigin: record.titleOrigin ?? "recorded", id: record.sessionId,
    clientSessionId: record.sessionId, client: record.client as Client, relationship: record.relationship,
    messageCount: 0, turnCount: 0, models: [], gaps: [] }, language) : "—";
  return record?.titleOrigin === "first_user" ? questionPreview(title).text || title : title;
}

export function weeklyReviewFreshLabel(cache: Pick<WeeklyReview["cache"], "requests" | "freshSamples">): string {
  return cache.freshSamples < cache.requests ? "freshSubtotal" : "fresh";
}

export function weeklyReviewCacheShareLabel(cache: Pick<WeeklyReview["cache"], "readShareMissing">): string {
  return cache.readShareMissing > 0 ? "readShareRecorded" : "readShare";
}
