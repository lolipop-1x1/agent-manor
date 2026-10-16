import type { MessageDescriptor } from "./i18n/types.js";
import type { ResourceInventoryEntry, ResourceInventorySnapshot, ResourceManualSource } from "./resource-inventory-contracts.js";

export type ResourceManagementAction = "disable" | "standby" | "trash" | "restore" | "purge";
export type ResourceArchiveState = "disabled" | "standby" | "trash" | "restored" | "purged";
export type ResourceAffectedEntry = Pick<ResourceInventoryEntry, "id" | "name" | "client" | "scope" | "project" | "entryPath">;
export interface ResourceManagementInput { entryId?: string; operationId?: string; action: ResourceManagementAction }
/** 仅公开被改动的控制值及定位，不包含注册、命令、地址或凭证正文。 */
export interface ResourceConfigurationPreview {
  path: string;
  keyPath: string[];
  selector?: { key: "path" | "name"; value: string };
  kind: "boolean" | "membership" | "registration" | "marker";
  before: boolean | "missing" | "present";
  after: boolean | "missing" | "present";
  controlScope?: "path" | "project" | "client";
  controlProject?: string;
}
export interface ResourceLinkStatus {
  target: string;
  state: "available" | "missing" | "unreadable" | "skill_missing" | "skill_unreadable";
}
export interface ResourceManagementPreview {
  id: string;
  action: ResourceManagementAction;
  entryId: string;
  operationId?: string;
  resource: Pick<ResourceInventoryEntry, "name" | "kind" | "client" | "scope" | "project">;
  method: "native_toggle" | "entry_isolation" | "registration_remove" | "restore" | "permanent_purge";
  target?: "entry" | "file";
  sourcePath: string;
  originalPath?: string;
  link?: ResourceLinkStatus;
  destinationPath?: string;
  configuration?: ResourceConfigurationPreview;
  affectedEntries: ResourceAffectedEntry[];
  /** 当前所选入口被隔离后，可能重新可见的持久来源。 */
  revealedEntries?: Pick<ResourceInventoryEntry, "name" | "client" | "scope" | "project" | "entryPath">[];
  referencesComplete: false;
  protected: boolean;
  protectionReasons: string[];
  restoration: string;
  restorationDescriptor?: MessageDescriptor;
  createdAt: string;
  expiresAt: string;
  requiresConfirmation: true;
  clientEffect: "pending_reload" | "unknown";
}
export interface ResourceManagementOperation {
  id: string;
  previewId: string;
  action: ResourceManagementAction;
  entryId: string;
  name: string;
  resource: Pick<ResourceInventoryEntry, "kind" | "client" | "scope" | "project">;
  status: "success" | "failure" | "conflict" | "partial";
  message: string;
  messageDescriptor?: MessageDescriptor;
  details?: MessageDescriptor[];
  createdAt: string;
  archiveId?: string;
  localState: "changed" | "unchanged" | "partial";
  clientEffect: "pending_reload" | "unknown";
  target?: "entry" | "file";
  affectedEntries?: ResourceAffectedEntry[];
  link?: ResourceLinkStatus;
}
export interface ResourceManagementArchive {
  id: string;
  operationId: string;
  entry: ResourceInventoryEntry;
  state: ResourceArchiveState;
  originalPath: string;
  storedPath?: string;
  createdAt: string;
  restorable: boolean;
  operationStatus: "success" | "partial";
  target?: "entry" | "file";
  affectedEntries?: ResourceAffectedEntry[];
}
export interface ResourceManagementOperations { operations: ResourceManagementOperation[]; total: number; page: number; pageSize: number }
export interface ResourceManagementOperationQuery { kind?: "skill" | "mcp"; client?: string; project?: string; q?: string }
export interface ManagedResourceInventoryEntry extends ResourceInventoryEntry {
  favorite: boolean;
  firstSeenAt: string;
  managementState: "active" | ResourceArchiveState;
}
export interface ManagedResourceInventorySnapshot extends Omit<ResourceInventorySnapshot, "entries"> { entries: ManagedResourceInventoryEntry[] }
export type StoredResourceManualSource = ResourceManualSource & { id: string };
