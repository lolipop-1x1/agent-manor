import type { ApiErrorCode, Repository } from "../contracts.js";
import type { MessageDescriptor } from "../i18n/types.js";
import type { OverviewEvidencePage, OverviewEvidenceQuery, OverviewQuery, OverviewReport } from "../overview-contracts.js";
import type { PricingStatus } from "../usage-contracts.js";

export interface OverviewWorkerRequest {
  id: number;
  type: "report" | "evidence";
  query: OverviewQuery;
  pricing: PricingStatus;
  repositories: Repository[];
  now: string;
  evidence?: OverviewEvidenceQuery;
}
export type OverviewWorkerResponse = { id: number; type: "result"; result: OverviewReport | OverviewEvidencePage }
  | { id: number; type: "error"; error: { code: ApiErrorCode; message: string; messageDescriptor?: MessageDescriptor } };
