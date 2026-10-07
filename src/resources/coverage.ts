import type { Gap } from "../contracts.js";

// 这些稳定诊断只涉及正文、用量、项目或父子关系，不影响已记录资源请求。
const unrelatedKeys = new Set([
  "diagnostics.sessions.parser.m007", "diagnostics.sessions.parser.m009",
  "diagnostics.sessions.parser.m012", "diagnostics.sessions.parser.m013",
  "diagnostics.sessions.parser.m014", "diagnostics.sessions.parser.m015",
  "diagnostics.sessions.parser.m017", "diagnostics.sessions.parser.m020",
  "diagnostics.sessions.parser.m021", "diagnostics.sessions.parser.m022", "diagnostics.sessions.parser.m023",
  "diagnostics.sessions.refresh.m007",
  "diagnostics.sessions.store.m004", "diagnostics.sessions.store.m005", "diagnostics.sessions.store.m006",
  "diagnostics.sessions.store.m017",
  "diagnostics.history.index.m008", "diagnostics.history.index.m009",
  "diagnostics.history.index.m014", "diagnostics.history.index.m015",
  "diagnostics.history.adapters.nativeJsonl.m001",
  "diagnostics.history.adapters.codeflicker.m001", "diagnostics.history.adapters.codeflicker.m002",
  "diagnostics.history.adapters.qoder.m001", "diagnostics.history.adapters.qoder.m002",
  "diagnostics.history.adapters.qoder.m003", "diagnostics.history.adapters.qoder.m004",
  "diagnostics.history.adapters.qoder.m009",
  "diagnostics.history.adapters.workbuddy.m001", "diagnostics.history.adapters.workbuddy.m002",
  "diagnostics.history.adapters.workbuddy.m004", "diagnostics.history.adapters.workbuddy.m012",
  "diagnostics.history.adapters.workbuddy.m013",
  "diagnostics.history.adapters.codebuddy.m004", "diagnostics.history.adapters.codebuddy.m005",
  "diagnostics.history.adapters.codebuddy.m010",
  "diagnostics.history.adapters.opencode.m002", "diagnostics.history.adapters.opencode.m003",
  "diagnostics.history.adapters.opencode.m012",
  "diagnostics.history.adapters.zcode.m007",
  "diagnostics.history.adapters.zcode.m008", "diagnostics.history.adapters.zcode.m011",
  "diagnostics.history.adapters.pi.m020",
]);

/** 未识别诊断仍保守标记部分记录；不匹配翻译后的句子，也不否定已有请求。 */
export function resourceGapRelevant(gap: Gap): boolean {
  return !gap.messageDescriptor || !unrelatedKeys.has(gap.messageDescriptor.key);
}
