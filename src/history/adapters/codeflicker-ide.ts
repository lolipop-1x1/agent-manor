import { DiagnosticError } from "../../i18n/diagnostics.js";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { HistoryEvent, SourceReference } from "../../contracts.js";
import type { SourceLocation } from "../types.js";
import { object, physicalLines, returnedText, string, toolEvidence, changedFragments } from "../extraction.js";
import { normalizeHistoryPath, registerRequest } from "./common.js";
import type { HistoryAdapter, HistoryRecordSnapshot } from "./types.js";

export const IDE_FORMAT = "codeflicker-ide-sqlite";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const missing = () => Object.assign(new DiagnosticError("SQLite 会话来源已缺失", { key: "diagnostics.history.adapters.codeflickerIde.m001" }), { code: "ENOENT" });
const decode = (value: unknown): unknown => JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : String(value));

async function openDatabase(path: string): Promise<Database.Database> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new DiagnosticError("SQLite 历史来源必须为普通文件", { key: "diagnostics.history.adapters.codeflickerIde.m002" });
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

/** workspaceUri 经常是 IDE 缓存地址；仅使用正式工作区配置，不将其当成仓库。 */
async function workspace(uri: string | undefined): Promise<string | undefined> {
  const path = normalizeHistoryPath(uri);
  if (!path || !isAbsolute(path)) return undefined;
  const cache = /^(.*[/\\]workspaceStorage[/\\][^/\\]+)(?:[/\\].*)?$/.exec(path);
  if (!cache) return path;
  try {
    const meta = object(JSON.parse(await readFile(join(cache[1]!, "workspace.json"), "utf8")));
    const folder = normalizeHistoryPath(string(meta.folder));
    if (folder && isAbsolute(folder)) return folder;
    const configPath = normalizeHistoryPath(string(meta.workspace));
    if (configPath && isAbsolute(configPath)) {
      const config = object(JSON.parse(await readFile(configPath, "utf8")));
      const folders = Array.isArray(config.folders) ? config.folders.map(item => string(object(item).path)).filter(Boolean) : [];
      if (folders.length === 1) return resolve(dirname(configPath), folders[0]!);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return undefined;
}

async function indexMetadata(path: string, id: string): Promise<Record<string, unknown>> {
  let db;
  try { db = await openDatabase(join(dirname(path), "index.sqlite")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='KwaipilotKV' AND type='table'").get()) return {};
    const row = db.prepare("SELECT value FROM KwaipilotKV WHERE key=?").get(`composerMeta:${id}`) as { value: unknown } | undefined;
    if (row) return object(decode(row.value));
    const history = db.prepare("SELECT value FROM KwaipilotKV WHERE key='composerHistory'").get() as { value: unknown } | undefined;
    const entries = history ? decode(history.value) : undefined;
    return Array.isArray(entries) ? object(entries.find(item => object(item).sessionId === id)) : {};
  } finally { db.close(); }
}

export interface IdeSnapshot extends HistoryRecordSnapshot { title?: string; legacy?: boolean }

/** 读事务包含 WAL 中已提交的内容；按会话正文和旁路元数据计算逻辑指纹。 */
export async function readIdeSnapshot(location: SourceLocation): Promise<IdeSnapshot> {
  if (!location.selector) throw new DiagnosticError("SQLite 来源缺少会话选择器", { key: "diagnostics.history.adapters.codeflickerIde.m003" });
  const db = await openDatabase(location.path);
  let data: Record<string, unknown>;
  let records: IdeSnapshot["records"];
  let legacyMetadata: Record<string, unknown> = {};
  const legacy = location.selector.startsWith("legacy:");
  db.exec("BEGIN");
  try {
    if (legacy) {
      const id = location.selector.slice(7);
      const row = db.prepare("SELECT * FROM session WHERE session_id=?").get(id);
      if (!row) throw missing();
      data = object(row);
      const rows = db.prepare("SELECT id,content,create_time FROM message WHERE session_id=? ORDER BY id").all(id) as { id: number; content: string; create_time: number }[];
      records = rows.map((item, index) => ({ raw: JSON.stringify(item), record: { ...object(decode(item.content)), ts: item.create_time }, line: index + 1 }));
      data.workspaceUri = object(decode(data.extra || "{}")).workspaceUri;
    } else {
      const row = db.prepare("SELECT value FROM KwaipilotKV WHERE key=?").get(location.selector) as { value: unknown } | undefined;
      if (!row) throw missing();
      data = object(decode(row.value));
      if (!Array.isArray(data.localMessages)) throw new DiagnosticError("SQLite 会话缺少 localMessages 数组", { key: "diagnostics.history.adapters.codeflickerIde.m004" });
      records = data.localMessages.map((value, index) => ({ record: object(value), raw: JSON.stringify(value), line: index + 1 }));
      const history = db.prepare("SELECT value FROM KwaipilotKV WHERE key='composerHistory'").get() as { value: unknown } | undefined;
      const entries = history ? decode(history.value) : undefined;
      if (Array.isArray(entries)) legacyMetadata = object(entries.find(item => object(item).sessionId === data.sessionId));
    }
  } finally { db.exec("ROLLBACK"); db.close(); }
  const id = string(data.sessionId) ?? string(data.session_id) ?? location.sessionId;
  if (!id || !legacy && location.selector !== `composerData:${id}`) throw new DiagnosticError("SQLite 会话键与原生身份不符", { key: "diagnostics.history.adapters.codeflickerIde.m005" });
  const meta = legacy ? data : { ...legacyMetadata, ...await indexMetadata(location.path, id) };
  if (meta.sessionId && meta.sessionId !== id) throw new DiagnosticError("SQLite 标题元数据与会话身份不符", { key: "diagnostics.history.adapters.codeflickerIde.m006" });
  const cwd = await workspace(string(data.workspaceUri) || string(meta.workspaceUri));
  const title = string(meta.name) ?? string(data.session_name);
  const results = new Map<string, number>();
  for (const [index, item] of records.entries()) if (["command_output", "use_mcp_tool_result", "tool_error"].includes(string(item.record.say) ?? "") && string(item.record.toolCallId)) results.set(String(item.record.toolCallId), index);
  for (const [index, item] of records.entries()) if ((results.get(String(item.record.toolCallId)) ?? -1) > index) item.record = { ...item.record, __separateResult: true };
  return { source: { ...location, format: IDE_FORMAT, sessionId: id, cwd, sourceId: `${location.client}:${hash(id).slice(0, 24)}` },
    hash: hash(JSON.stringify(legacy ? [data, meta, cwd ?? null, records.map(item => item.raw)] : [data, meta, cwd ?? null])), records, title, legacy };
}

export async function discoverIdeFile(location: SourceLocation): Promise<SourceLocation[]> {
  const db = await openDatabase(location.path);
  const result: SourceLocation[] = [];
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='KwaipilotKV' AND type='table'").get()) {
      // 发现只取身份与项目字段，不将整个数据库正文留在内存。
      const rows = db.prepare("SELECT key,json_extract(CAST(value AS TEXT),'$.sessionId') AS id,json_extract(CAST(value AS TEXT),'$.workspaceUri') AS uri FROM KwaipilotKV WHERE key LIKE 'composerData:%' AND json_valid(CAST(value AS TEXT))").iterate() as Iterable<{ key: string; id: string; uri?: string }>;
      for (const row of rows) {
        if (!row.id || row.key !== `composerData:${row.id}`) continue;
        result.push({ ...location, selector: row.key, sessionId: row.id, sourceId: `${location.client}:${hash(row.id).slice(0, 24)}`,
          cwd: await workspace(row.uri) });
      }
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='session' AND type='table'").get()) {
      const rows = db.prepare("SELECT session_id,extra FROM session").all() as { session_id: string; extra: string }[];
      for (const row of rows) if (!result.some(item => item.sessionId === row.session_id)) result.push({ ...location,
        selector: `legacy:${row.session_id}`, sessionId: row.session_id, sourceId: `${location.client}:${hash(row.session_id).slice(0, 24)}`,
        cwd: await workspace(string(object(decode(row.extra || "{}")).workspaceUri)) });
    }
  } finally { db.close(); }
  return result;
}

export function ideTool(record: Record<string, unknown>): { name: string; input: Record<string, unknown>; content: string; status: HistoryEvent["status"]; mcp?: { name: string; server: string } } | undefined {
  if (!["tool", "use_mcp_tool", "command"].includes(string(record.say ?? record.ask) ?? "")) return undefined;
  let input = object(record.jsonText);
  if (!Object.keys(input).length) { try { input = object(JSON.parse(string(record.text) ?? "")); } catch { /* 未完成的参数保留为过程。 */ } }
  // 命令确认卡的 text 本身就是命令，不是 JSON 工具对象。
  if (record.ask === "command" && !Object.keys(input).length && string(record.text)) input = { tool: "executeCommand", command: record.text };
  const name = string(input.tool);
  if (!name) return undefined;
  const effect = object(record.workingSetEffect);
  const read = name === "readFile" && /^\s*\d+[\t|]/.test(string(input.content) ?? "");
  const status = record.partial === true ? "unknown" : effect.status === "rejected" ? "failure"
    : effect.status === "accepted" || read ? "success" : "unknown";
  const mcp = ["use_mcp_tool", "useMcpTool"].includes(name) && string(input.serverName) && string(input.toolName)
    ? { name: String(input.toolName), server: String(input.serverName) } : undefined;
  return { name, input, content: string(input.content) ?? string(input.output) ?? "", status, mcp };
}

/** 仅在已保存内容自身的编号可校验时提取读取范围；请求范围不充当返回证据。 */
function readEvidence(input: Record<string, unknown>, visible: string) {
  const path = string(input.path);
  const lines = physicalLines(visible);
  const first = Number(/^\s*(\d+)[\t|]/.exec(lines[0] ?? "")?.[1]);
  if (!Number.isInteger(first) || returnedText(visible).truncated) return [{ kind: "read" as const, path, fragments: [], reason: "range_unknown: IDE 读取缺少完整编号返回内容", reasonDescriptor: { key: "diagnostics.history.adapters.codeflickerIde.m007" } }];
  const shift = first === 0 || typeof input.startLine === "number" && first === input.startLine - 1 ? 1 : 0;
  if (typeof input.startLine === "number" && first + shift !== input.startLine) return [{ kind: "read" as const, path, fragments: [], reason: "range_unknown: IDE 读取请求与返回起始行不符", reasonDescriptor: { key: "diagnostics.history.adapters.codeflickerIde.m008" } }];
  const prefix: string[] = [];
  for (const line of lines) {
    const numbered = /^\s*(\d+)[\t|](.*)$/.exec(line);
    if (!numbered) break;
    prefix.push(`${Number(numbered[1]) + shift}\t${numbered[2]}`);
  }
  const normalized = prefix.join("\n");
  if (typeof input.endLine === "number" && first + shift + prefix.length - 1 > input.endLine) return [{ kind: "read" as const, path, fragments: [], reason: "range_unknown: IDE 读取返回超出请求范围", reasonDescriptor: { key: "diagnostics.history.adapters.codeflickerIde.m009" } }];
  return toolEvidence("Read", input, {}, normalized);
}

export const codeflickerIdeAdapter: HistoryAdapter = {
  id: IDE_FORMAT, discover: () => undefined, discoverFile: discoverIdeFile, readRecords: readIdeSnapshot,
  // 新库是迁移后的正式来源；旧库同身份副本不再重复计数。
  selectSources: sources => sources.filter(source => source.format !== IDE_FORMAT || !source.path.endsWith("session_data.sqlite")
    || !sources.some(other => other.format === IDE_FORMAT && other.sessionId === source.sessionId && other.client === source.client
      && other.path === join(dirname(source.path), "composer_data.sqlite"))),
  async readEvidence(source: SourceReference) {
    if (!source.selector || !Number.isSafeInteger(source.recordLine) || source.recordLine < 1) return undefined;
    let db;
    try {
      db = await openDatabase(source.path);
      let raw: string | undefined;
      if (source.selector.startsWith("legacy:")) {
        const row = db.prepare("SELECT id,content,create_time FROM message WHERE session_id=? ORDER BY id LIMIT 1 OFFSET ?").get(source.selector.slice(7), source.recordLine - 1);
        if (row) raw = JSON.stringify(row);
      } else {
        const row = db.prepare("SELECT json_extract(CAST(value AS TEXT),?) AS value FROM KwaipilotKV WHERE key=?")
          .get(`$.localMessages[${source.recordLine - 1}]`, source.selector) as { value: string | null } | undefined;
        if (row?.value) raw = JSON.stringify(decode(row.value));
      }
      return raw && hash(raw) === source.hash ? { source, raw } : undefined;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    finally { db?.close(); }
  },
  extract(tool, inputValue, resultValue, visible) {
    const input = object(inputValue);
    if (tool === "readFile") return readEvidence(input, visible);
    if (tool === "editFile") {
      const effect = object(object(resultValue).workingSetEffect);
      const diff = object(effect.diffContent);
      const path = string(input.path) ?? string(effect.path);
      if (effect.status === "accepted" && typeof diff.originalCode === "string" && typeof diff.modifiedCode === "string"
        && (!input.path || !effect.path || input.path === effect.path)) return [{ kind: "edit", path, fragments: changedFragments(diff.originalCode, diff.modifiedCode, path) }];
      return [{ kind: "edit", path, fragments: [], reason: "range_unknown: IDE 编辑缺少已接受的前后快照", reasonDescriptor: { key: "diagnostics.history.adapters.codeflickerIde.m010" } }];
    }
    const mapped = /^(?:grepSearch|codebaseSearch|searchFile|listFiles)/.test(tool) ? "Grep" : tool === "executeCommand" ? "Bash" : tool;
    return toolEvidence(mapped, input, resultValue, visible);
  },
  processRecord(record, context) {
    const tool = ideTool(record);
    context.occurredAt = typeof record.ts === "number" ? new Date(record.ts).toISOString() : undefined;
    if (tool) {
      const callId = string(record.toolCallId) ?? `ide:${context.row}`;
      registerRequest(context, { callId, tool: tool.name, input: tool.input, key: `ide:${context.row}`, cwd: context.source.cwd });
      if (!record.__separateResult && (tool.content || Object.keys(object(record.workingSetEffect)).length)) {
        const call = context.pair(callId);
        if (call) context.finish(call, record, tool.content, tool.status, context.row, context.raw);
      }
      return;
    }
    if (["command_output", "use_mcp_tool_result", "tool_error"].includes(string(record.say) ?? "")) {
      const callId = string(record.toolCallId);
      if (!callId) { context.gap("unpaired_call", "IDE 工具返回缺少调用身份", { key: "diagnostics.history.adapters.codeflickerIde.m011" }); return; }
      const call = context.pair(callId);
      if (call) context.finish(call, record, string(record.text) ?? "", record.say === "tool_error" ? "failure" : "unknown", context.row, context.raw);
    }
  },
};
