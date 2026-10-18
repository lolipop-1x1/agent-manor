import { createRequire } from "node:module";
import type Database from "better-sqlite3";

export interface InstallationCheck { id: string; ok: boolean; details?: string }
/** 原生依赖使用内存数据库核验，不迁移或打开用户数据。 */
export function installationChecks(): InstallationCheck[] {
  const major = Number(process.versions.node.split(".")[0]);
  const supported = process.platform === "win32" ? process.arch === "x64"
    : ["darwin", "linux"].includes(process.platform) && ["arm64", "x64"].includes(process.arch);
  const checks: InstallationCheck[] = [{ id: "node24", ok: major === 24, details: process.versions.node }, { id: "platform", ok: supported, details: `${process.platform}/${process.arch}` }];
  const require = createRequire(import.meta.url);
  let database: Database.Database | undefined;
  try {
    const Driver = require("better-sqlite3") as typeof Database;
    database = new Driver(":memory:");
    database.prepare("SELECT 1").get();
    checks.push({ id: "sqlite", ok: true });
    try {
      const vector = require("sqlite-vec") as { load(database: Database.Database): void };
      vector.load(database);
      const result = database.prepare("SELECT vec_version() AS version").get() as { version: string };
      checks.push({ id: "sqlite-vec", ok: true, details: result.version });
    } catch (error) { checks.push({ id: "sqlite-vec", ok: false, details: error instanceof Error ? error.message : String(error) }); }
  } catch (error) { checks.push({ id: "sqlite", ok: false, details: error instanceof Error ? error.message : String(error) }); }
  finally { database?.close(); }
  return checks;
}
