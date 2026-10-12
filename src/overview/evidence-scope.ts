import type { OverviewEvidencePage, OverviewSource } from "../overview-contracts.js";

/** 客户端、项目、关系及日期追加条件与原快照取交后的证据查询范围。 */
export interface FactEvidenceScope {
  metadata: OverviewSource;
  revisions: string[];
  time: string;
  values: (string | number | null)[];
  initial: OverviewEvidencePage;
}
