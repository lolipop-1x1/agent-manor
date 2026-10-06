/** 各入口共享的客户端身份；不依赖 Node 或历史格式。 */
export const CLIENTS = [
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
] as const;

export type Client = typeof CLIENTS[number]["id"];
export const clientIds: readonly Client[] = CLIENTS.map(client => client.id);
export const clientName = (client: Client): string => CLIENTS.find(item => item.id === client)!.name;
