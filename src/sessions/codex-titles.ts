import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";
import { historyClient } from "../history/adapters/index.js";
import type { DiscoverRoots } from "../history/types.js";

const nonempty = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

function metadataHome(root: string): string {
  let current = resolve(root);
  while (dirname(current) !== current) {
    if (["sessions", "archived_sessions"].includes(basename(current))) return dirname(current);
    current = dirname(current);
  }
  return dirname(resolve(root));
}

async function indexTitles(home: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const lines = createInterface({ input: createReadStream(join(home, "session_index.jsonl")), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let entry: { id?: unknown; thread_name?: unknown };
      try { entry = JSON.parse(line) as typeof entry; } catch { continue; }
      if (entry && typeof entry.id === "string" && typeof entry.thread_name === "string") titles.set(entry.id, entry.thread_name.trim());
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally { lines.close(); }
  return titles;
}

/** 与 agentsview 一样按线程 ID 读取旁路索引；同时兼容新版 Codex 状态库中独立保存的 name。 */
export async function loadCodexTitles(roots?: DiscoverRoots): Promise<Map<string, string>> {
  const configured = roots?.codex ?? process.env.AGENT_MANOR_CODEX_DIR ?? historyClient("codex").defaultRoots.map(path => join(homedir(), path));
  const homes = [...new Set((typeof configured === "string" ? [configured] : configured).map(metadataHome))];
  const available: { home: string; modified: number; files: string[] }[] = [];
  for (const home of homes) {
    try {
      const files = await readdir(home);
      let modified = 0;
      for (const filename of files.filter(name => name === "session_index.jsonl" || /^state_\d+\.sqlite(?:-wal)?$/.test(name))) {
        try { modified = Math.max(modified, (await stat(join(home, filename))).mtimeMs); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      available.push({ home, modified, files });
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const titles = new Map<string, string>();
  for (const { home, files } of available.sort((left, right) => left.modified - right.modified)) {
    const indexed = await indexTitles(home);
    const states = files.filter(name => /^state_\d+\.sqlite$/.test(name))
      .sort((left, right) => Number(right.match(/\d+/)![0]) - Number(left.match(/\d+/)![0]));
    const named = new Map<string, string>();
    const legacy = new Map<string, string>();
    for (const filename of states) {
      const database = new Database(join(home, filename), { readonly: true, fileMustExist: true });
      try {
        const columns = new Set((database.prepare("PRAGMA table_info(threads)").all() as { name: string }[]).map(column => column.name));
        if (!columns.has("id") || !columns.has("title")) continue;
        const rows = database.prepare(`SELECT id,title,${columns.has("name") ? "name" : "NULL AS name"} FROM threads`).iterate() as Iterable<{ id: string; title: unknown; name: unknown }>;
        for (const row of rows) {
          const name = nonempty(row.name);
          const title = nonempty(row.title);
          if (name) named.set(row.id, name);
          // 旧 title 可能是初始化上下文；此时交由正文解析生成后备标题。
          if (title && !/^(?:# AGENTS\.md|<environment_context>|<INSTRUCTIONS>|<in-app-browser-context\b|<skill>)/.test(title)) legacy.set(row.id, title);
        }
        break;
      } finally { database.close(); }
    }
    for (const [id, title] of legacy) titles.set(id, title);
    for (const [id, title] of indexed) titles.set(id, title);
    for (const [id, title] of named) titles.set(id, title);
  }
  return titles;
}
