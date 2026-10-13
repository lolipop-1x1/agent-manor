import type { ResourceInventoryEntry } from "../resource-inventory-contracts.js";

/** 描述保持来源原文；同名资源的不同描述不任意择一。 */
export function skillDescriptions(entries: readonly Pick<ResourceInventoryEntry, "kind" | "description">[]): string[] {
  return [...new Set(entries.filter(entry => entry.kind === "skill").map(entry => entry.description?.trim()).filter((value): value is string => Boolean(value)))];
}
export function skillDescription(entries: readonly Pick<ResourceInventoryEntry, "kind" | "description">[]): string | undefined {
  const values = skillDescriptions(entries);
  return values.length === 1 ? values[0] : undefined;
}
