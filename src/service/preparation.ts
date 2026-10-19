import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { INDEX_SCHEMA_VERSION } from "../index/schema.js";

const marker = (home: string) => join(home, "startup-prepared.json");

/** 空库先记录准备中；已有历史的旧目录直接可用，首次中断则继续等待。 */
export async function beginStartupPreparation(home: string, hasHistory: boolean): Promise<boolean> {
  if (hasHistory) {
    try {
      const value = JSON.parse(await readFile(marker(home), "utf8"));
      return value.format === 1 && value.state === "pending";
    } catch { return false; }
  }
  await savePreparation(home, { state: "pending", startedAt: new Date().toISOString() });
  return true;
}

export async function completeStartupPreparation(home: string, sourceVersion: string): Promise<void> {
  await savePreparation(home, { state: "complete", sourceVersion, completedAt: new Date().toISOString() });
}

async function savePreparation(home: string, value: object): Promise<void> {
  const temporary = `${marker(home)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ format: 1, schema: INDEX_SCHEMA_VERSION, ...value }), { mode: 0o600 });
    await rename(temporary, marker(home));
  } finally { await rm(temporary, { force: true }); }
}
