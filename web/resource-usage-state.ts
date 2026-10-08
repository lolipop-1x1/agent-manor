import type { MessageDescriptor } from "../src/i18n/types";
import type { ResourceMapMetric, ResourceMapNode } from "../src/resource-service-contracts";

export function resourceMapCompactTitleKey(nodes: ResourceMapNode[], metric: ResourceMapMetric): string {
  if (nodes.some(node => node.value === null)) return "resources.map.otherResources";
  if (nodes.every(node => node.observation === "unused")) return "resources.candidate.unused";
  return metric === "sessions" ? "resources.map.zeroSessions" : metric === "reads" ? "resources.map.zeroReads" : "resources.map.zeroCalls";
}

export function resourceMapValueMessage(node: Pick<ResourceMapNode, "value" | "observation">, metric: ResourceMapMetric): MessageDescriptor {
  if (node.value === null) return { key: node.observation === "insufficient" ? "resources.observation.insufficient" : "resources.observation.unknown" };
  return { key: metric === "sessions" ? "resources.map.sessionValue" : metric === "reads" ? "resources.map.metricValue" : "resources.map.callValue", params: { count: node.value } };
}

export function normalizeResourceRouteParams(params: URLSearchParams): URLSearchParams {
  const normalized = new URLSearchParams(params);
  if (normalized.get("candidate") === "review") normalized.set("candidate", "all");
  normalized.delete("reviewPage");
  normalized.delete("reviewSize");
  return normalized;
}
