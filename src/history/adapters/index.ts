import type { Client, EvidenceRecord, SourceReference } from "../../contracts.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { codeflickerAdapter } from "./codeflicker.js";
import type { HistoryAdapter, HistoryClient } from "./types.js";

export type { HistoryAdapter, HistoryAdapterContext, HistoryClient } from "./types.js";

/** Node 来源声明与客户端展示声明分开；只把 roots 纯数据传给 Worker。 */
export const HISTORY_CLIENTS: readonly HistoryClient[] = [
  { client: "codex", format: "codex-jsonl", environmentVariable: "AGENT_MANOR_CODEX_DIR", defaultRoots: [".codex/sessions", ".codex/archived_sessions"] },
  { client: "claude", format: "claude-jsonl", environmentVariable: "AGENT_MANOR_CLAUDE_DIR", defaultRoots: [".claude/projects"] },
  { client: "codeflicker", format: "codeflicker-jsonl", environmentVariable: "AGENT_MANOR_CODEFLICKER_DIR", defaultRoots: [".codeflicker/projects"], acceptsFile: path => path.endsWith(".jsonl") && !path.split(/[\\/]/).some(part => ["requests", "file-history"].includes(part)) },
];

/** 仅注册随安装包提供的适配器，本轮不提供动态插件加载。 */
export const HISTORY_ADAPTERS: readonly HistoryAdapter[] = [codexAdapter, claudeAdapter, codeflickerAdapter];
export const historyClient = (client: Client): HistoryClient => HISTORY_CLIENTS.find(item => item.client === client)!;
export const historyAdapter = (format: string): HistoryAdapter | undefined => HISTORY_ADAPTERS.find(item => item.id === format);

export async function readHistoryEvidence(source: SourceReference): Promise<EvidenceRecord | undefined> {
  const client = HISTORY_CLIENTS.find(item => source.sourceId.startsWith(`${item.client}:`));
  const format = source.format ?? client?.format;
  return format ? historyAdapter(format)?.readEvidence(source) : undefined;
}
