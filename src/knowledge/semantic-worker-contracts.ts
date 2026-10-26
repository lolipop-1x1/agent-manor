import type { MessageDescriptor } from "../i18n/types.js";

export type KnowledgeSemanticMethod = "status" | "preview" | "build" | "action" | "search" | "compareCandidates" | "maintain" | "close";
export type KnowledgeSettingsMethod = "settings" | "key" | "reusedSettings" | "reusedKey";
export interface KnowledgeSemanticRequest { id: number; method: KnowledgeSemanticMethod; input?: unknown }
export interface KnowledgeSemanticFailure { kind: "knowledge" | "semantic" | "internal"; code: string; message: string; status?: number; messageDescriptor?: MessageDescriptor }
export type KnowledgeSemanticResponse = { type: "ready" } | { type: "busy"; busy: boolean }
  | { type: "configuration"; id: number; method: KnowledgeSettingsMethod }
  | { type: "result"; id: number; result?: unknown; error?: KnowledgeSemanticFailure };
