import type { ResourceManagementArchive, ResourceManagementOperation, ResourceManagementPreview } from "../../../src/resource-management-contracts";

export function recoveryKind(archive: ResourceManagementArchive): "disable" | "registration" | "link" | "file" {
  return archive.state === "disabled" ? "disable" : archive.entry.kind === "mcp" ? "registration" : archive.entry.entryType === "symlink" ? "link" : "file";
}

export function restoreActionKey(preview: ResourceManagementPreview): string {
  return `resources.recovery.restore.${preview.configuration ? preview.configuration.kind === "registration" ? "registration" : "disable" : preview.link ? "link" : "file"}`;
}

export function managementSuccessKey(preview: ResourceManagementPreview, result: ResourceManagementOperation): string {
  if (result.action === "purge") return "resources.workspace.purged";
  if (result.action === "restore") return result.link ? `resources.workspace.restoredLink.${result.link.state}` : `resources.recovery.restored.${preview.configuration ? preview.configuration.kind === "registration" ? "registration" : "disable" : "file"}`;
  return `resources.recovery.changed.${result.action === "disable" ? "disable" : preview.configuration ? "registration" : preview.link ? "link" : "file"}`;
}
