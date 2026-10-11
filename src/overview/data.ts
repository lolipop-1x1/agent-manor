import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { gunzipSync, gzipSync } from "node:zlib";
import type { OverviewSource } from "../overview-contracts.js";
import type { SessionStore } from "../sessions/store.js";

const format = 1, maxRawBytes = 768 * 1024 * 1024, maxCompressedBytes = 128 * 1024 * 1024;

/** 只保留当前完整版本的无正文事实；损坏或不可写的派生缓存不影响正常查询。 */
export function loadOverviewSource(store: SessionStore, version?: string): OverviewSource {
  const selected = store.usageVersion(version);
  if (selected !== store.usageVersion()) return store.overviewSource(selected);
  const path = join(dirname(store.dbPath), "overview-source.bin.gz");
  try {
    if (statSync(path).size <= maxCompressedBytes) {
      const bytes = readFileSync(path);
      if (bytes.length <= maxCompressedBytes) {
        const cached = deserialize(gunzipSync(bytes, { maxOutputLength: maxRawBytes })) as { format: number; source: OverviewSource };
        if (cached?.format === format && cached.source?.version === selected
          && [cached.source.sessions, cached.source.events, cached.source.requests, cached.source.resources, cached.source.gaps].every(Array.isArray)) return cached.source;
      }
    }
  } catch { /* 派生缓存失效时由完整已发布版本重建。 */ }
  const source = store.overviewSource(selected), temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const raw = serialize({ format, source });
    if (raw.length <= maxRawBytes) {
      const bytes = gzipSync(raw, { level: 1 });
      if (bytes.length <= maxCompressedBytes) {
        writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
        renameSync(temporary, path);
      }
    }
  } catch { /* 缓存写入失败仍返回完整事实。 */ }
  finally { try { rmSync(temporary, { force: true }); } catch {} }
  return source;
}
