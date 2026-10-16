import type { MessageDescriptor } from "../../../src/i18n/types";
import type { ResourceMapMetric, ResourceMapNode } from "../../../src/resource-service-contracts";

export function resourceMapValueMessage(node: Pick<ResourceMapNode, "value" | "observation">, metric: ResourceMapMetric): MessageDescriptor {
  if (node.value === null) return { key: node.observation === "insufficient" ? "resources.observation.insufficient" : "resources.observation.unknown" };
  return { key: metric === "sessions" ? "resources.map.sessionValue" : metric === "reads" ? "resources.map.metricValue" : "resources.map.callValue", params: { count: node.value } };
}

export function normalizeResourceRouteParams(params: URLSearchParams): URLSearchParams {
  const normalized = new URLSearchParams(params);
  if (["disabled", "trash", "standby"].includes(normalized.get("tab") ?? "")) normalized.set("tab", "recovery");
  if (["recovery", "operations"].includes(normalized.get("tab") ?? "")) {
    for (const key of ["client", "project", "window", "from", "to", "sort", "order", "candidate", "low", "inactive", "favorite", "view", "metric", "maxValue", "presence", "scope", "locationProject", "detail", "tool", "evidencePage"]) normalized.delete(key);
  }
  if (normalized.get("candidate") === "review") normalized.set("candidate", "all");
  normalized.delete("reviewPage");
  normalized.delete("reviewSize");
  normalized.delete("zeroPage");
  normalized.delete("zeroSize");
  return normalized;
}
