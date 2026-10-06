import type { Client, EvidenceRecord, SourceReference } from "../../contracts.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { codeflickerAdapter } from "./codeflicker.js";
import { codeflickerDesktopAdapter } from "./codeflicker-desktop.js";
import { codeflickerIdeAdapter, IDE_FORMAT } from "./codeflicker-ide.js";
import { dshAdapter } from "./dsh.js";
import { piAdapter } from "./pi.js";
import { workbuddyAdapter } from "./workbuddy.js";
import { opencodeAdapter } from "./opencode.js";
import { zcodeAdapter } from "./zcode.js";
import { codebuddyAdapter } from "./codebuddy.js";
import { qoderAdapter } from "./qoder.js";
import type { HistoryAdapter, HistoryClient } from "./types.js";

export type { HistoryAdapter, HistoryAdapterContext, HistoryClient } from "./types.js";

/** Node 来源声明与客户端展示声明分开；只把 roots 纯数据传给 Worker。 */
export const HISTORY_CLIENTS: readonly HistoryClient[] = [
  { client: "codex", format: "codex-jsonl", environmentVariable: "AGENT_MANOR_CODEX_DIR", defaultRoots: [".codex/sessions", ".codex/archived_sessions"] },
  { client: "claude", format: "claude-jsonl", environmentVariable: "AGENT_MANOR_CLAUDE_DIR", defaultRoots: [".claude/projects"] },
  { client: "codeflicker", format: "codeflicker-jsonl", environmentVariable: "AGENT_MANOR_CODEFLICKER_DIR", defaultRoots: [".codeflicker/projects"], acceptsFile: path => path.endsWith(".jsonl") && !path.split(/[\\/]/).some(part => ["requests", "file-history"].includes(part)) },
  { client: "codeflicker-desktop", format: "codeflicker-desktop-jsonl", environmentVariable: "AGENT_MANOR_CODEFLICKER_DESKTOP_DIR", homeEnvironmentVariable: "MYFLICKER_HOME", defaultRoots: [".myflicker/sessions", ".codeflicker/data/codeflicker"], containerFormat: IDE_FORMAT, acceptsContainer: path => /[/\\](?:session_data|composer_data)\.sqlite$/.test(path), acceptsFile: path => /[/\\]message[/\\]cache\.jsonl$/.test(path) },
  { client: "dsh", format: dshAdapter.id, environmentVariable: "AGENT_MANOR_DSH_DIR", defaultRoots: [".dsh/sessions"], acceptsFile: path => /[/\\]session\.v\d+\.jsonl\.zstd$/.test(path) },
  { client: "pi", format: piAdapter.id, environmentVariable: "AGENT_MANOR_PI_DIR", defaultRoots: [".pi/agent/sessions"] },
  { client: "workbuddy", format: workbuddyAdapter.id, environmentVariable: "AGENT_MANOR_WORKBUDDY_DIR", defaultRoots: [".workbuddy/projects"] },
  { client: "opencode", format: opencodeAdapter.id, environmentVariable: "AGENT_MANOR_OPENCODE_DIR", defaultRoots: [".local/share/opencode"], containerFormat: opencodeAdapter.id, acceptsContainer: path => /[/\\]opencode\.db$/.test(path), acceptsFile: () => false },
  { client: "zcode", format: zcodeAdapter.id, environmentVariable: "AGENT_MANOR_ZCODE_DIR", defaultRoots: [".zcode/cli/db"], containerFormat: zcodeAdapter.id, acceptsContainer: path => /[/\\]db\.sqlite$/.test(path), acceptsFile: () => false },
  { client: "codebuddy", format: codebuddyAdapter.id, environmentVariable: "AGENT_MANOR_CODEBUDDY_DIR", defaultRoots: [".codebuddy/projects"] },
  { client: "qoder", format: qoderAdapter.id, environmentVariable: "AGENT_MANOR_QODER_DIR", defaultRoots: [".qoder/projects"] },
];

/** 仅注册随安装包提供的适配器，本轮不提供动态插件加载。 */
export const HISTORY_ADAPTERS: readonly HistoryAdapter[] = [codexAdapter, claudeAdapter, codeflickerAdapter, codeflickerDesktopAdapter, codeflickerIdeAdapter,
  dshAdapter, piAdapter, workbuddyAdapter, opencodeAdapter, zcodeAdapter, codebuddyAdapter, qoderAdapter];
export const historyClient = (client: Client): HistoryClient => HISTORY_CLIENTS.find(item => item.client === client)!;
export const historyAdapter = (format: string): HistoryAdapter | undefined => HISTORY_ADAPTERS.find(item => item.id === format);

export async function readHistoryEvidence(source: SourceReference): Promise<EvidenceRecord | undefined> {
  const client = HISTORY_CLIENTS.find(item => source.sourceId.startsWith(`${item.client}:`));
  const format = source.format ?? client?.format;
  return format ? historyAdapter(format)?.readEvidence(source) : undefined;
}
