import type { ResourceKind } from "../../../src/resource-contracts";
import type { ResourceInventoryEntry } from "../../../src/resource-inventory-contracts";
import type { ResourceLocalRow } from "../../../src/resource-service-contracts";

export type ResourceLocationGroup = Pick<ResourceLocalRow, "body" | "entries"> & { key?: string };

/** 多个适配器读到同一注册时只展示一个位置，保留各自的精确控制入口。 */
export function resourceLocationGroups(rows: ResourceLocalRow[], kind: ResourceKind): ResourceLocationGroup[] {
  if (kind === "skill") return rows;
  const groups = new Map<string, ResourceLocationGroup>();
  for (const row of rows) for (const entry of row.entries) {
    const key = JSON.stringify([entry.entryPath, entry.locator.keyPath ?? []]);
    let group = groups.get(key);
    if (!group) { group = { key, body: row.body, entries: [] }; groups.set(key, group); }
    if (!group.entries.some(item => item.id === entry.id)) group.entries.push(entry);
  }
  return [...groups.values()];
}

export function physicalLocationEntry(entries: ResourceInventoryEntry[]): ResourceInventoryEntry | undefined {
  return [...entries].sort((a, b) => Number(b.capabilities.trash && !b.capabilities.disable) - Number(a.capabilities.trash && !a.capabilities.disable)
    || Number(b.capabilities.trash) - Number(a.capabilities.trash) || a.client.localeCompare(b.client))[0];
}
