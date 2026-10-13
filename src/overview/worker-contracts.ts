import type { ApiErrorCode, Repository } from "../contracts.js";
import type { MessageDescriptor } from "../i18n/types.js";
import type { OverviewDetailPage, OverviewDetailQuery, OverviewDistributionDimension, OverviewEvidencePage, OverviewEvidenceQuery, OverviewPanel,
  OverviewPanelResult, OverviewQuery, OverviewReport, OverviewSnapshot, WeeklyReview, WeeklyReviewDetailPage, WeeklyReviewDetailQuery } from "../overview-contracts.js";
import type { PricingStatus, UsageStatistics } from "../usage-contracts.js";
import type { OverviewInsightContext } from "./insights.js";
export interface OverviewWorkerRequest {
  id: number;
  type: "prepare" | "report" | "snapshot" | "panel" | "detail" | "evidence" | "review" | "review_detail";
  query: OverviewQuery;
  pricing: PricingStatus;
  repositories: Repository[];
  now: string;
  panel?: OverviewPanel;
  dimension?: OverviewDistributionDimension;
  detail?: OverviewDetailQuery;
  reviewDetail?: WeeklyReviewDetailQuery;
  evidence?: OverviewEvidenceQuery;
  usage?: UsageStatistics;
  globalUsage?: UsageStatistics;
  insightUsage?: OverviewInsightContext;
}
export type OverviewWorkerResult = OverviewReport | OverviewEvidencePage | OverviewSnapshot | OverviewPanelResult | OverviewDetailPage | WeeklyReview | WeeklyReviewDetailPage;
export type OverviewWorkerResponse = { id: number; type: "result"; result: OverviewWorkerResult }
  | { id: number; type: "error"; error: { code: ApiErrorCode; message: string; messageDescriptor?: MessageDescriptor } };
