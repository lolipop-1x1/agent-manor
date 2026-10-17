/** 各入口共享的客户端身份；不依赖 Node 或历史格式。 */
const KNOWN_CLIENTS = [
  { id: "codex", name: "Codex", abbreviation: "CX" },
  { id: "claude", name: "Claude Code", abbreviation: "CC" },
  { id: "codeflicker", name: "CodeFlicker CLI", abbreviation: "CF" },
  { id: "codeflicker-desktop", name: "CodeFlicker 桌面版", abbreviation: "FD" },
  { id: "dsh", name: "DeepSeek Harness", abbreviation: "DH" },
  { id: "pi", name: "Pi", abbreviation: "PI" },
  { id: "workbuddy", name: "WorkBuddy", abbreviation: "WB" },
  { id: "opencode", name: "OpenCode", abbreviation: "OC" },
  { id: "zcode", name: "ZCode", abbreviation: "ZC" },
  { id: "codebuddy", name: "CodeBuddy", abbreviation: "CB" },
  { id: "qoder", name: "Qoder", abbreviation: "QD" },
  { id: "gemini", name: "Gemini CLI", abbreviation: "GM" },
  { id: "qwen", name: "Qwen Code", abbreviation: "QW" },
  { id: "kimi", name: "Kimi Code CLI", abbreviation: "KM" },
  { id: "omp", name: "Oh My Pi", abbreviation: "OM" },
  { id: "grok", name: "Grok Build", abbreviation: "GK" },
  { id: "reasonix", name: "Reasonix", abbreviation: "RX" },
  { id: "codewhale", name: "Codewhale", abbreviation: "CW" },
  { id: "doubao-work", name: "Doubao Work", abbreviation: "DW" },
] as const;

export type Client = typeof KNOWN_CLIENTS[number]["id"];
// 保留旧索引身份与研究解析器；本机历史不完整的客户端暂不进入产品入口。
export const inactiveClientIds: readonly Client[] = ["doubao-work"];
export const CLIENTS = KNOWN_CLIENTS.filter(client => !inactiveClientIds.includes(client.id));
export const clientIds: readonly Client[] = CLIENTS.map(client => client.id);
export const isSupportedClient = (client: string): client is Client => clientIds.includes(client as Client);
export const clientName = (client: Client): string => KNOWN_CLIENTS.find(item => item.id === client)!.name;
