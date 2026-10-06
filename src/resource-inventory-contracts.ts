import type { Client } from "./clients.js";
import type { ResourceAssociationEntry, ResourceKind } from "./resource-contracts.js";

export type ResourceSourceFormat = "skill-directory" | "skill-files" | "json" | "jsonc" | "toml" | "plugin" | "unsupported";
export type ResourceReadState = "ok" | "missing" | "unreadable" | "invalid" | "unsupported";
export interface ResourceManualSource {
  id?: string;
  client: Client;
  kind: ResourceKind;
  path: string;
  project?: string;
  format?: ResourceSourceFormat;
  /** 手动配置只接收注册 map 的定位，不接受命令或连接凭证。 */
  keyPath?: string[];
}
export interface ResourceInventoryOptions {
  userHome?: string;
  projects?: readonly string[];
  manualSources?: readonly ResourceManualSource[];
  /** 环境覆盖由调用方明确传入；合成测试无需改动进程 HOME。 */
  environment?: Readonly<Record<string, string | undefined>>;
  observedAt?: string;
}
export interface ResourceInventorySource {
  id: string;
  client: Client;
  kind: ResourceKind;
  scope: "user" | "project";
  project?: string;
  path: string;
  format: ResourceSourceFormat;
  origin: "standard" | "compatibility" | "manual" | "plugin" | "system";
  readState: ResourceReadState;
  observedAt: string;
  verified: boolean;
  owner?: string;
  manualSourceId?: string;
}
export interface ResourceInventoryLocator {
  type: "skill" | "mcp";
  /** MCP 定位只公开文件路径及目标 key，不包含注册值。 */
  configPath?: string;
  format?: "json" | "jsonc" | "toml";
  keyPath?: string[];
  skillFile?: string;
  nativeControl?: "codex-skill" | "codex-mcp" | "claude-skill" | "claude-mcp-project";
  controlPath?: string;
}
export interface ResourceInventoryCapabilities {
  inventory: boolean;
  associate: boolean;
  disable: boolean;
  standby: boolean;
  restore: boolean;
  trash: boolean;
  purge: boolean;
}
export interface ResourceInventoryEntry extends ResourceAssociationEntry {
  sourceId: string;
  bodyId: string;
  entryType: "directory" | "symlink" | "file" | "registration";
  readState: "present" | "broken" | "unreadable";
  nativeState: "enabled" | "disabled" | "unknown";
  sourceFormat: ResourceSourceFormat;
  linkTarget?: string;
  description?: string;
  contentFingerprint?: string;
  fingerprintScope?: "skill-document";
  modifiedAt?: string;
  observedAt: string;
  owner?: string;
  protected: boolean;
  protectionReason?: "system" | "plugin";
  transport?: "stdio" | "http" | "sse" | "unknown";
  locator: ResourceInventoryLocator;
  capabilities: ResourceInventoryCapabilities;
}
export interface ResourceInventoryBody {
  id: string;
  kind: ResourceKind;
  name: string;
  targetPath?: string;
  entryIds: string[];
  contentFingerprint?: string;
  fingerprintScope?: "skill-document";
}
export interface ResourceInventoryGap {
  sourceId: string;
  client: Client;
  reason: ResourceReadState | "project_missing" | "limit";
}
export interface ResourceInventorySnapshot {
  observedAt: string;
  sources: ResourceInventorySource[];
  entries: ResourceInventoryEntry[];
  bodies: ResourceInventoryBody[];
  gaps: ResourceInventoryGap[];
}
