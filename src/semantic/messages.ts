import type { MessageDescriptor } from "../i18n/types.js";

const messages: Record<string, string> = {
  semantic_config_invalid: "settings", semantic_config_unreadable: "settingsRead", semantic_key_unreadable: "keyRead", semantic_usage_unreadable: "usageRead",
  semantic_input_invalid: "input", INVALID_INPUT: "input", semantic_embedding_invalid: "vector", INDEX_CHANGED: "indexChanged",
  semantic_aborted: "cancelled", semantic_closed: "stopped", semantic_timeout: "timeout", semantic_network: "network",
  semantic_rate_limited: "rate", semantic_auth: "auth", semantic_input_too_long: "tooLong", semantic_service: "service", semantic_request_invalid: "request",
  semantic_budget_exceeded: "budget", semantic_rate_limit_input: "tokenLimit", semantic_busy: "busy", semantic_not_ready: "notReady", NOT_READY: "notReady",
  semantic_connection_required: "connection", semantic_scope_required: "scope", semantic_preview_stale: "preview", PREVIEW_STALE: "preview",
  semantic_worker_stopped: "worker", semantic_build_failed: "build", semantic_persistence_failed: "persistence", INTERNAL_ERROR: "processing",
  semantic_query_cache_expired: "cacheExpired",
};

/** 产品错误用稳定标识翻译；原始错误另行保留，不按原文内容猜测。 */
export function semanticErrorDescriptor(code?: string): MessageDescriptor | undefined {
  const message = code && messages[code];
  return message ? { key: `sessions.semantic.errors.${message}` } : undefined;
}
