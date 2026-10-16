import type { ResourceKind } from "../../../src/resource-contracts";
import type { ResourceInventoryEntry } from "../../../src/resource-inventory-contracts";
import type { ResourceLocalRow } from "../../../src/resource-service-contracts";

export type ResourceLocationGroup = Pick<ResourceLocalRow, "body" | "entries"> & { key?: string };

/** 相同物理位置去重，保留每个来源的精确控制入口。 */
export function resourceLocationGroups(rows: ResourceLocalRow[], kind: ResourceKind): ResourceLocationGroup[] {
  if (kind === "skill") {
    const result: ResourceLocationGroup[] = []; const links = new Map<string, ResourceLocationGroup>();
    for (const row of rows) {
      const path = row.entries[0]?.entryPath;
      if (!path || !row.entries.every(entry => entry.entryType === "symlink" && entry.readState === "broken" && entry.entryPath === path)) { result.push(row); continue; }
      let group = links.get(path);
      if (!group) { group = { key: path, body: row.body, entries: [] }; links.set(path, group); result.push(group); }
      for (const entry of row.entries) if (!group.entries.some(value => value.id === entry.id)) group.entries.push(entry);
    }
    return result;
  }
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
  return [...entries].sort((a, b) => Number(b.capabilities.trash) - Number(a.capabilities.trash)
    || Number(b.locator.controlPath === b.entryPath) - Number(a.locator.controlPath === a.entryPath)
    || Number(a.scope === "project") - Number(b.scope === "project")
    || Number(!!a.locator.nativeRule) - Number(!!b.locator.nativeRule) || a.client.localeCompare(b.client))[0];
}

/** 相同路径被兼容适配器重复发现时，不将项目继承关系当作新的文件范围。 */
export function resourceLocationScopes(entries: ResourceInventoryEntry[]): ResourceInventoryEntry["scope"][] {
  const paths = new Map<string, ResourceInventoryEntry[]>();
  for (const entry of entries) paths.set(entry.entryPath, [...paths.get(entry.entryPath) ?? [], entry]);
  return [...new Set([...paths.values()].map(values => physicalLocationEntry(values)!.scope))];
}
