import type { ApiErrorCode } from "../contracts.js";
import type { MessageDescriptor } from "../i18n/types.js";
import type { PricingStatus, UsagePreparationStatus, UsageQuery, UsageReport, UsageRequestPage } from "../usage-contracts.js";

export interface UsageWorkerRequest {
  id: number; type: "report" | "requests" | "prepare"; query: UsageQuery; pricing: PricingStatus;
  sessionId?: string; page?: number; pageSize?: number;
}
export type UsageWorkerResponse = { id: number; type: "result"; result: UsageReport | UsageRequestPage | null }
  | { id: number; type: "error"; error: { code: ApiErrorCode; message: string; messageDescriptor?: MessageDescriptor } }
  | { type: "status"; status: UsagePreparationStatus };

export const preparationKey = (query: UsageQuery): string => JSON.stringify([query.version, query.priceVersion, query.timezone]);
