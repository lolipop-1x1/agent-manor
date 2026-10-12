import type { ApiErrorCode } from "../contracts.js";
import type { MessageDescriptor } from "../i18n/types.js";
import type { PricingStatus, SessionCostSummary, UsagePreparationStatus, UsageQuery, UsageReport, UsageRequestPage,
  UsageStatistics, UsageStatisticsView } from "../usage-contracts.js";

export interface UsageWorkerRequest {
  id: number; type: "report" | "summary" | "statistics" | "requests" | "prepare" | "sessionCost"; query: UsageQuery; pricing: PricingStatus;
  view?: UsageStatisticsView;
  sessionId?: string; page?: number; pageSize?: number;
  sessionIds?: string[]; scope?: "self" | "tree";
}
export type UsageWorkerResponse = { id: number; type: "result"; result: UsageReport | UsageRequestPage | SessionCostSummary | UsageStatistics | null }
  | { id: number; type: "error"; error: { code: ApiErrorCode; message: string; messageDescriptor?: MessageDescriptor } }
  | { type: "status"; status: UsagePreparationStatus };

export const preparationKey = (query: UsageQuery): string => JSON.stringify([query.version, query.priceVersion, query.timezone]);
