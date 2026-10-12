import type { ApiErrorCode } from "../contracts.js";
import type { MessageDescriptor } from "../i18n/types.js";
import type { PricingStatus, SessionCostSummary, UsagePreparationStatus, UsageQuery, UsageReport, UsageRequestPage } from "../usage-contracts.js";

export interface UsageWorkerRequest {
  id: number; type: "report" | "summary" | "requests" | "prepare" | "sessionCost"; query: UsageQuery; pricing: PricingStatus;
  sessionId?: string; page?: number; pageSize?: number;
  sessionIds?: string[]; scope?: "self" | "tree";
}
export type UsageWorkerResponse = { id: number; type: "result"; result: UsageReport | UsageRequestPage | SessionCostSummary | null }
  | { id: number; type: "error"; error: { code: ApiErrorCode; message: string; messageDescriptor?: MessageDescriptor } }
  | { type: "status"; status: UsagePreparationStatus };

export const preparationKey = (query: UsageQuery): string => JSON.stringify([query.version, query.priceVersion, query.timezone]);
