import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";
import type { SourceLocation } from "../history/types.js";
import { desktopSessionDirectory } from "../history/adapters/codeflicker-desktop.js";
import { object, string } from "./parser-usage.js";

/** 只查询桌面标题缓存；不读认证命名空间，不把服务端分页缓存当作完整历史。 */
export async function loadDesktopTitles(sources: readonly SourceLocation[]): Promise<Map<string, string>> {
  const desktop = sources.filter(source => source.client === "codeflicker-desktop");
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

export interface DesktopModelRecord { model?: string; requestId?: string }

/** 仅按消息 UUID 关联原生模型元信息；正文与工具仍只索引 cache.jsonl。 */
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
    for await (const line of lines) {
      hash.update(line).update("\n");
      let record: Record<string, unknown>;
      try { record = object(JSON.parse(line)); } catch { continue; }
      const uuid = string(record.uuid);
      const message = object(record.message);
      if (!uuid || record.type !== "assistant") continue;
      if (entries.size >= 50_000) { limited = true; continue; }
      entries.set(uuid, { model: string(message.model), requestId: string(message.id) });
    }
  }
  return { entries, fingerprint: hash.digest("hex"), limited };
}
