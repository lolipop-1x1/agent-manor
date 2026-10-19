import type { ReleaseStatus } from "../../../src/updates/contracts";

export function updateReminderVisible(status: ReleaseStatus | null): boolean {
  return !!status && status.autoCheck && !status.automaticDisabled && status.checkState === "ready" && !status.stale
    && status.updateAvailable === true && !!status.latestVersion && status.latestVersion !== status.ignoredVersion;
}

export function updateSummaryKey(status: ReleaseStatus): string {
  if (status.checkState === "failed") return "updateUi.failed";
  if ((status.stale || status.checkState === "checking") && status.latestVersion) return "updateUi.stale";
  if (status.updateAvailable === true) return "updateUi.available";
  if (status.versionRelation === "ahead") return "updateUi.ahead";
  if (status.updateAvailable === false && status.versionRelation === "current") return "updateUi.upToDate";
  return "updateUi.unknown";
}
