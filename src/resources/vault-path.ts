import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ResourceInventoryEntry } from "../resource-inventory-contracts.js";
import type { ResourceManagementAction } from "../resource-management-contracts.js";

function safeName(name: string): string {
  const cleaned = name.normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-").trim().replace(/^\.+|[. ]+$/g, "");
  let value = "";
  for (const character of cleaned) {
    if (Buffer.byteLength(value + character, "utf8") > 80) break;
    value += character;
  }
  return value || "resource";
}

/** 来源身份使用原入口，不将共享目标或同名注册误认为同一入口。 */
export function resourceMaterialPath(vaultPath: string, action: ResourceManagementAction, entry: ResourceInventoryEntry, operationId: string): string {
  if (!["skill", "mcp"].includes(entry.kind) || !["disable", "standby", "trash"].includes(action)
    || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(operationId)) {
    throw new TypeError("恢复材料路径需要隔离操作及有效操作 ID");
  }
  const source = entry.kind === "skill" ? [entry.entryPath]
    : [entry.locator.configPath ?? entry.entryPath, entry.locator.keyPath ?? [], entry.server ?? entry.name];
  const identity = createHash("sha256").update(JSON.stringify(source)).digest("hex");
  return join(vaultPath, action === "disable" ? "backups" : "trash", entry.kind, `${safeName(entry.name)}--${identity}`, operationId, "material");
}
