import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { INDEX_SCHEMA_VERSION } from "../index/schema.js";

const marker = (home: string) => join(home, "startup-prepared.json");

/** 仅完整准备成功后保留标记；数据库存在或会话导入完成本身不能替代它。 */
export async function startupPrepared(home: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(marker(home), "utf8"));
    return value.format === 1 && value.schema === INDEX_SCHEMA_VERSION && typeof value.sourceVersion === "string" && Boolean(value.sourceVersion);
  } catch { return false; }
}

export async function completeStartupPreparation(home: string, sourceVersion: string): Promise<void> {
  const temporary = `${marker(home)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ format: 1, schema: INDEX_SCHEMA_VERSION, sourceVersion, completedAt: new Date().toISOString() }), { mode: 0o600 });
    await rename(temporary, marker(home));
  } finally { await rm(temporary, { force: true }); }
}
