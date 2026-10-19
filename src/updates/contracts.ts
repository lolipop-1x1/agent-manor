import type { MessageDescriptor } from "../i18n/types.js";

export type InstallationKind = "global" | "local" | "source" | "ephemeral";
export interface UpdateSettings { autoCheck: boolean; ignoredVersion: string | null }
export interface ReleaseStatus extends UpdateSettings {
  automaticDisabled?: boolean;
  currentVersion: string;
  latestVersion: string | null;
  checkState: "unknown" | "checking" | "ready" | "failed";
  checkedAt: string | null;
  stale: boolean;
  updateAvailable: boolean | null;
  versionRelation: "unknown" | "current" | "ahead" | "behind";
  installationKind: InstallationKind;
  selfUpdateSupported: boolean;
  compatibility: { compatible: boolean; reason: string | null; messageDescriptor?: MessageDescriptor };
  updateCommand: string;
  shell: "posix" | "powershell";
  error?: { code: string; message: string; messageDescriptor: MessageDescriptor };
}
