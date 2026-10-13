import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";
import type { SourceLocation } from "../history/types.js";
import type { SessionRequestTiming } from "../session-contracts.js";
import { DESKTOP_FORMAT, desktopSessionDirectory } from "../history/adapters/codeflicker-desktop.js";
import { object, string, tokens } from "./parser-usage.js";

/** 只查询桌面标题缓存；不读认证命名空间，不把服务端分页缓存当作完整历史。 */
export async function loadDesktopTitles(sources: readonly SourceLocation[]): Promise<Map<string, string>> {
  const desktop = sources.filter(source => source.format === DESKTOP_FORMAT);
  const titles = new Map<string, string>();
  if (!desktop.length) return titles;
  const defaultRoot = join(process.env.MYFLICKER_HOME ?? join(homedir(), ".myflicker"), "sessions");
  const defaultSources = desktop.some(source => {
    const path = relative(defaultRoot, source.path);
    return path !== ".." && !path.startsWith("../") && !isAbsolute(path);
  });
  const dataHome = process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
    : process.platform === "win32" ? process.env.APPDATA : join(homedir(), ".config");
  const path = process.env.AGENT_MANOR_CODEFLICKER_DESKTOP_DB ?? (defaultSources && dataHome ? join(dataHome, "MyFlicker", "app.db") : undefined);
  if (!path) return titles;
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) return titles; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return titles; throw error; }
  const ids = new Set(desktop.map(source => source.sessionId));
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kv'").get();
    if (!table) return titles;
    const rows = db.prepare("SELECT key,value FROM kv WHERE (ns LIKE 'u/%/session-data' AND key LIKE 'session:%') OR ns LIKE 'u/%/session-list-cache-v2' ORDER BY updated_at").iterate() as Iterable<{ key: string; value: string }>;
    for (const row of rows) {
      let value: Record<string, unknown>;
      try { value = object(JSON.parse(row.value)); } catch { continue; }
      for (const raw of Array.isArray(value.items) ? value.items : [value]) {
        const item = object(raw);
        const id = string(item.id) ?? string(item.serverSessionId) ?? row.key.split(":").at(-1);
        const title = string(item.title)?.trim();
        if (ids.has(id) && title) titles.set(id!, title);
      }
    }
  } finally { db.close(); }
  return titles;
}

export interface DesktopModelRecord { model?: string; reasoningEffort?: string; requestId?: string; timing?: SessionRequestTiming }

/** 镜像列表和各文件身份均参与快检；只看目录时间会漏掉原文件追加。 */
export async function desktopMirrorStamp(path: string): Promise<string | undefined> {
  const directory = join(desktopSessionDirectory(path), "claude-session");
  let files;
  try { files = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "desktop-mirror-v1:missing";
    throw error;
  }
  const signatures: string[][] = [];
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!file.name.endsWith(".jsonl")) continue;
    if (!file.isFile()) return undefined;
    try {
      const info = await lstat(join(directory, file.name), { bigint: true });
      if (!info.isFile() || info.isSymbolicLink()) return undefined;
      signatures.push([file.name, String(info.dev), String(info.ino), String(info.size), String(info.mtimeNs), String(info.ctimeNs)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  return createHash("sha256").update(JSON.stringify(["desktop-mirror-v1", signatures])).digest("hex");
}

/** 按 UUID 与明确父关系关联原生请求；正文与工具仍只索引 cache.jsonl。 */
export async function desktopModels(path: string): Promise<{ entries: Map<string, DesktopModelRecord>; fingerprint: string; limited: boolean }> {
  const directory = join(desktopSessionDirectory(path), "claude-session");
  const entries = new Map<string, DesktopModelRecord>();
  const hash = createHash("sha256");
  let limited = false;
  let files;
  try { files = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries, fingerprint: hash.digest("hex"), limited }; throw error; }
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
    const location = join(directory, file.name);
    const info = await lstat(location);
    if (info.size > 64 * 1024 * 1024) { limited = true; hash.update(`${file.name}:oversized:${info.size}`); continue; }
    const lines = createInterface({ input: createReadStream(location), crlfDelay: Infinity });
    const nodes = new Map<string, { type: string; parent?: string; request?: string; at?: string; line: number }>();
    const groups = new Map<string, { model?: string; reasoningEffort?: string; first: string; last: string; output?: number; stop?: string; partial: boolean }>();
    let row = 0;
    for await (const line of lines) {
      row += 1;
      hash.update(line).update("\n");
      let record: Record<string, unknown>;
      try { record = object(JSON.parse(line)); } catch { continue; }
      const uuid = string(record.uuid);
      const message = object(record.message);
      if (!uuid) continue;
      if (nodes.size >= 50_000 || entries.size >= 50_000) { limited = true; continue; }
      const request = record.type === "assistant" ? string(message.id) : undefined;
      nodes.set(uuid, { type: string(record.type) ?? "", parent: string(record.parentUuid), request,
        at: string(record.timestamp), line: row });
      if (record.type !== "assistant") continue;
      const reasoningEffort = string(record.effort) ?? string(record.reasoningEffort) ?? string(message.reasoning_effort);
      if (!request) { entries.set(uuid, { model: string(message.model), reasoningEffort }); continue; }
      let group = groups.get(request);
      if (!group) { group = { first: uuid, last: uuid, partial: false }; groups.set(request, group); }
      group.last = uuid;
      group.model = string(message.model) ?? group.model;
      group.reasoningEffort ??= reasoningEffort;
      group.output = tokens(object(message.usage).output_tokens) ?? group.output;
      group.stop = string(message.stop_reason) ?? group.stop;
      group.partial ||= record.isApiErrorMessage === true || record.isInterrupted === true || record.interrupted === true;
      groups.set(request, group);
    }
    const children = new Map<string, Set<string>>();
    const requests = new Map<string, DesktopModelRecord>();
    for (const [request, group] of groups) {
      const first = nodes.get(group.first)!; const last = nodes.get(group.last)!;
      let parentId = first.parent;
      let parent = parentId ? nodes.get(parentId) : undefined;
      const visited = new Set<string>();
      while (parent?.type === "assistant" && parent.request === request && parent.parent && !visited.has(parent.parent)) {
        visited.add(parent.parent); parentId = parent.parent; parent = nodes.get(parentId);
      }
      const timing: SessionRequestTiming = { basis: "estimated", window: "response", method: "codeflicker_desktop_mirror",
        completion: group.partial ? "partial" : ["end_turn", "tool_use", "stop_sequence", "max_tokens"].includes(group.stop ?? "") ? "explicit" : "unknown",
        completionEvidence: group.partial ? "request_interrupted" : group.stop ? "stop_reason" : undefined,
        outputTokens: group.output, end: { occurredAt: last.at, recordLine: last.line, source: "mirror" } };
      if (parent?.type === "user") {
        timing.start = { occurredAt: parent.at, recordLine: parent.line, source: "mirror" };
        const elapsed = parent.at && last.at ? Date.parse(last.at) - Date.parse(parent.at) : NaN;
        if (Number.isFinite(elapsed)) timing.durationMs = elapsed;
        const aliases = children.get(parentId!) ?? new Set<string>();
        aliases.add(request); children.set(parentId!, aliases);
      }
      requests.set(request, { model: group.model, reasoningEffort: group.reasoningEffort, requestId: request, timing });
    }
    for (const [uuid, node] of nodes) {
      const key = node.request ?? (children.get(uuid)?.size === 1 ? [...children.get(uuid)!][0] : undefined);
      const value = key ? requests.get(key) : undefined;
      if (value) entries.set(uuid, value);
    }
  }
  return { entries, fingerprint: hash.digest("hex"), limited };
}
