import Database from "better-sqlite3";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** 人工样本同时用于存储回归与真实浏览器端到端。 */
export function ideFixture(root, repository) {
  const db = new Database(join(root, "composer_data.sqlite"));
  db.exec("CREATE TABLE KwaipilotKV(key TEXT PRIMARY KEY,value BLOB,version INTEGER,updatedAt INTEGER)");
  const write = (key, value) => db.prepare("INSERT OR REPLACE INTO KwaipilotKV VALUES(?,?,1,1)").run(key, JSON.stringify(value));
  const messages = [
    { ts: 1_780_000_000_000, role: "user", type: "say", say: "text", text: "检查入口文件", chatId: "turn-one" },
    { ts: 1_780_000_000_001, type: "say", say: "api_req_started", text: "", chatModel: "sample-model" },
    { ts: 1_780_000_000_002, type: "say", say: "thinking", text: "先阅读文件。", chatModel: "sample-model" },
    { ts: 1_780_000_000_003, type: "say", say: "tool", toolCallId: "read-one", text: JSON.stringify({ tool: "readFile", path: join(repository, "src/entry.ts"), startLine: 1, endLine: 2,
      content: "0\texport const healthy = true;\n1\texport const updated = true;\n" }) },
    { ts: 1_780_000_000_004, type: "say", say: "tool", toolCallId: "edit-one", text: JSON.stringify({ tool: "editFile", path: join(repository, "src/entry.ts"), content: "建议修改" }),
      workingSetEffect: { status: "accepted", path: join(repository, "src/entry.ts"), diffContent: { originalCode: "export const healthy = true;\nexport const updated = false;\n", modifiedCode: "export const healthy = true;\nexport const updated = true;\n" } } },
    { ts: 1_780_000_000_005, type: "ask", ask: "use_mcp_tool", toolCallId: "mcp-one", text: JSON.stringify({ tool: "useMcpTool", serverName: "sample", toolName: "lookup", arguments: { query: "例子" } }) },
    { ts: 1_780_000_000_006, type: "say", say: "use_mcp_tool_result", toolCallId: "mcp-one", text: "查找完成" },
    { ts: 1_780_000_000_007, type: "say", say: "text", text: "已完成入口核对。", chatModel: "sample-model" },
    { ts: 1_780_000_000_008, type: "say", say: "completion_result", text: "", stopReason: "stop" },
  ];
  write("composerData:ide-main", { sessionId: "ide-main", workspaceUri: pathToFileURL(repository).href, localMessages: messages });
  write("composerData:ide-chat", { sessionId: "ide-chat", workspaceUri: "", localMessages: [
    { ts: 1_780_000_000_000, role: "user", say: "text", text: "你好" }, { ts: 1_780_000_000_001, say: "text", text: "你好！" },
  ] });
  const index = new Database(join(root, "index.sqlite"));
  index.exec("CREATE TABLE KwaipilotKV(key TEXT PRIMARY KEY,value BLOB,version INTEGER,updatedAt INTEGER)");
  index.prepare("INSERT INTO KwaipilotKV VALUES(?,?,1,1)").run("composerMeta:ide-main", JSON.stringify({ sessionId: "ide-main", name: "SQLite 入口核对" }));
  index.close();
  return { db, write, messages };
}
