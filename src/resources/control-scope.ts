import type { ResourceInventoryEntry } from "../resource-inventory-contracts.js";
import type { ResourceConfigurationPreview } from "../resource-management-contracts.js";

/** 控制设置的范围与资源文件位置分别表达。 */
export function resourceControlScope(entry: ResourceInventoryEntry): Pick<ResourceConfigurationPreview, "controlScope" | "controlProject"> | undefined {
  const rule = entry.locator.nativeRule;
  if (rule) return rule.effectScope && (rule.effectScope !== "project" || rule.effectProject)
    ? { controlScope: rule.effectScope, controlProject: rule.effectProject } : undefined;
  if (entry.locator.nativeControl === "codex-skill") return { controlScope: "path" };
  if ((entry.kind === "mcp" || entry.locator.nativeControl === "codeflicker-skill") && (entry.scope !== "project" || entry.project)) return {
    controlScope: entry.scope === "project" ? "project" : "client", controlProject: entry.project,
  };
  return undefined;
}
