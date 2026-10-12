import type { MessageDescriptor } from "../../../src/i18n/types";
import type { OverviewDetailQuery, OverviewEvidenceQuery, OverviewInsight, OverviewRepository, OverviewResourceRow, OverviewTimingGroup } from "../../../src/overview-contracts";

export type InvestigationSelection = { view: "evidence"; title: string; titleDescriptor?: MessageDescriptor; evidence: OverviewEvidenceQuery; insight?: OverviewInsight }
  | { view: "resources"; title: string; kind: "skill" | "mcp" }
  | { view: "resource"; title: string; resource: OverviewResourceRow }
  | { view: "ranking"; title: string; dimension: "project" | "client" | "model" | "tool"; metric?: "tokens" | "cost" | "requests" }
  | { view: "repository"; title: string; repository: OverviewRepository }
  | { view: "timing"; title: string; timing: OverviewTimingGroup }
  | { view: "timings"; title: string }
  | { view: "combinations"; title: string; unit: "session" | "turn" }
  | { view: "observations"; title: string };

export interface InvestigationControls {
  page: number;
  pageSize: number;
  rankTab: string;
  transitionKind: string;
  resourceSort: string;
  resourceDimension: "project" | "client" | "tool";
}

/** 完整排行和派生调查只请求当前页面，不依赖首页截取数组。 */
export function investigationDetail(selection: InvestigationSelection | null, controls: InvestigationControls): OverviewDetailQuery | null {
  const { page, pageSize, rankTab, transitionKind, resourceSort, resourceDimension } = controls;
  switch (selection?.view) {
    case "resources": return { view: "resources", kind: selection.kind, sort: resourceSort as "uses" | "sessions", page, pageSize };
    case "resource": return { view: "resource", resourceId: selection.resource.id, dimension: resourceDimension, page, pageSize };
    case "ranking": return rankTab === "categories" ? null : { view: rankTab === "months" ? "months" : rankTab === "transitions" ? "transitions" : "ranking", dimension: selection.dimension, transition: transitionKind as "all" | "switch" | "delegation", sort: selection.dimension === "tool" || selection.metric === "requests" ? "count" : selection.metric === "cost" ? "cost" : "tokens", page, pageSize };
    case "timing": return { view: "timing", timingGroup: selection.timing.id, page, pageSize };
    case "timings": return { view: "timings", page, pageSize };
    case "observations": return { view: "observations", page, pageSize };
    case "combinations": return { view: "combinations", unit: selection.unit, page, pageSize };
    default: return null;
  }
}
