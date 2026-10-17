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
import { geminiAdapter, geminiHistoryRoots, acceptsGeminiHistoryFile } from "./gemini.js";
import { qwenAdapter, qwenHistoryRoots, acceptsQwenHistoryFile } from "./qwen.js";
import { kimiAdapter, kimiHistoryRoots } from "./kimi.js";
import { ompAdapter, ompHistoryRoots } from "./omp.js";
import { grokAdapter, grokHistoryRoots } from "./grok.js";
import { reasonixAdapter, reasonixHistoryRoots } from "./reasonix.js";
import { codewhaleAdapter, codewhaleHistoryRoots } from "./codewhale.js";
import { doubaoWorkAdapter, DOUBAO_WORK_FORMAT } from "./doubao-work.js";
import type { HistoryAdapter, HistoryClient } from "./types.js";
import { inactiveClientIds, isSupportedClient } from "../../clients.js";

export type { HistoryAdapter, HistoryAdapterContext, HistoryClient } from "./types.js";

/** Node 来源声明与客户端展示声明分开；只把 roots 纯数据传给 Worker。 */
const KNOWN_HISTORY_CLIENTS: readonly HistoryClient[] = [
  { client: "codex", format: "codex-jsonl", environmentVariable: "AGENT_MANOR_CODEX_DIR", defaultRoots: [".codex/sessions", ".codex/archived_sessions"], acceptsFile: path => path.endsWith(".jsonl") || path.endsWith(".jsonl.zst") },
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
  { client: "gemini", format: geminiAdapter.id, environmentVariable: "AGENT_MANOR_GEMINI_DIR", defaultRoots: [".gemini/tmp"], resolveNativeRoots: geminiHistoryRoots, acceptsFile: acceptsGeminiHistoryFile },
  { client: "qwen", format: qwenAdapter.id, environmentVariable: "AGENT_MANOR_QWEN_DIR", defaultRoots: [".qwen/projects"], resolveNativeRoots: qwenHistoryRoots, acceptsFile: acceptsQwenHistoryFile },
  { client: "kimi", format: kimiAdapter.id, environmentVariable: "AGENT_MANOR_KIMI_DIR", defaultRoots: [".kimi-code/sessions"], resolveNativeRoots: kimiHistoryRoots, acceptsFile: path => /[/\\]wire\.jsonl$/.test(path) },
  { client: "omp", format: ompAdapter.id, environmentVariable: "AGENT_MANOR_OMP_DIR", defaultRoots: [".omp/agent/sessions"], resolveNativeRoots: ompHistoryRoots, acceptsFile: path => path.endsWith(".jsonl") && !/[/\\]__advisor/.test(path) },
  { client: "grok", format: grokAdapter.id, environmentVariable: "AGENT_MANOR_GROK_DIR", defaultRoots: [".grok/sessions"], resolveNativeRoots: grokHistoryRoots, acceptsFile: path => /[/\\]updates\.jsonl$/.test(path) },
  { client: "reasonix", format: reasonixAdapter.id, environmentVariable: "AGENT_MANOR_REASONIX_DIR", defaultRoots: [".reasonix/sessions", ".reasonix/projects", ".reasonix/archive"], resolveNativeRoots: reasonixHistoryRoots,
    acceptsFile: path => path.endsWith(".jsonl") && !/\.(?:events|conflicts|guardian|wire|adjudication|execution|turns)\.jsonl$/.test(path) },
  { client: "codewhale", format: codewhaleAdapter.id, environmentVariable: "AGENT_MANOR_CODEWHALE_DIR", defaultRoots: [".codewhale/sessions"], resolveNativeRoots: codewhaleHistoryRoots,
    acceptsFile: path => path.endsWith(".json") && !/[/\\](?:checkpoints|\.goals|\.late-usage|\.journal-archive)[/\\]/.test(path) },
  { client: "doubao-work", format: DOUBAO_WORK_FORMAT, environmentVariable: "AGENT_MANOR_DOUBAO_WORK_DIR", defaultRoots: ["Library/Application Support/DoubaoWork/Default/IndexedDB"],
    containerFormat: DOUBAO_WORK_FORMAT, acceptsFile: () => false,
    acceptsContainer: path => /[/\\](?:chrome_doubaowork-(?:launcher|chat)_0\.indexeddb|launcher|chat)\.leveldb[/\\]CURRENT$/.test(path) },
];
export const HISTORY_CLIENTS = KNOWN_HISTORY_CLIENTS.filter(item => isSupportedClient(item.client));

/** 仅注册随安装包提供的适配器，本轮不提供动态插件加载。 */
export const HISTORY_ADAPTERS: readonly HistoryAdapter[] = [codexAdapter, claudeAdapter, codeflickerAdapter, codeflickerDesktopAdapter, codeflickerIdeAdapter,
  dshAdapter, piAdapter, workbuddyAdapter, opencodeAdapter, zcodeAdapter, codebuddyAdapter, qoderAdapter,
  geminiAdapter, qwenAdapter, kimiAdapter, ompAdapter, grokAdapter, reasonixAdapter, codewhaleAdapter, doubaoWorkAdapter];
export const historyClient = (client: Client): HistoryClient => KNOWN_HISTORY_CLIENTS.find(item => item.client === client)!;
export const historyAdapter = (format: string): HistoryAdapter | undefined => HISTORY_ADAPTERS.find(item => item.id === format);

export async function readHistoryEvidence(source: SourceReference): Promise<EvidenceRecord | undefined> {
  if (inactiveClientIds.some(client => source.sourceId.startsWith(`${client}:`))) return undefined;
  const client = HISTORY_CLIENTS.find(item => source.sourceId.startsWith(`${item.client}:`));
  const format = source.format ?? client?.format;
  return format ? historyAdapter(format)?.readEvidence(source) : undefined;
}
