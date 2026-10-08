import type Database from "better-sqlite3";
import { DiagnosticError } from "../i18n/diagnostics.js";

export const INDEX_SCHEMA_VERSION = 4;

/** 新安装与两个索引模块共用版本标识，不读取或迁移旧索引结构。 */
export function initializeIndexSchema(database: Database.Database, create: () => void): void {
  database.transaction(() => {
    const version = database.pragma("user_version", { simple: true }) as number;
    const existingTables = version === 0 && Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get());
    if (existingTables || version !== 0 && version !== INDEX_SCHEMA_VERSION) {
      throw new DiagnosticError(`不支持的索引版本 ${version}`, { key: "diagnostics.index.store.m001", params: { p0: version } });
    }
    create();
    if (version === 0) database.pragma(`user_version = ${INDEX_SCHEMA_VERSION}`);
  }).immediate();
}
