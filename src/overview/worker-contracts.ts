import type { ApiErrorCode, Repository } from "../contracts.js";
import type { MessageDescriptor } from "../i18n/types.js";
import type { OverviewDetailPage, OverviewDetailQuery, OverviewEvidencePage, OverviewEvidenceQuery, OverviewPanel,
  OverviewPanelResult, OverviewQuery, OverviewReport, OverviewSnapshot } from "../overview-contracts.js";
import type { PricingStatus, UsageReport } from "../usage-contracts.js";
import type { OverviewInsightContext } from "./insights.js";
export interface OverviewWorkerRequest {
  id: number;
  type: "report" | "snapshot" | "panel" | "detail" | "evidence";
  query: OverviewQuery;
  pricing: PricingStatus;
  repositories: Repository[];
  now: string;
  panel?: OverviewPanel;
  detail?: OverviewDetailQuery;
  evidence?: OverviewEvidenceQuery;
  usage?: UsageReport;
  globalUsage?: UsageReport;
  dimensions?: { clients: UsageReport; projects: UsageReport; models: UsageReport };
  insightUsage?: OverviewInsightContext;
}
export type OverviewWorkerResult = OverviewReport | OverviewEvidencePage | OverviewSnapshot | OverviewPanelResult | OverviewDetailPage;
export type OverviewWorkerResponse = { id: number; type: "result"; result: OverviewWorkerResult }
  | { id: number; type: "error"; error: { code: ApiErrorCode; message: string; messageDescriptor?: MessageDescriptor } };
