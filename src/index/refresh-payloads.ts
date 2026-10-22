import Database from "better-sqlite3";
import type { JsonValue } from "../contracts.js";
import { associationMetadata } from "../history/index.js";
import type { ParsedHistorySource } from "../history/index.js";

/** 整轮只驻留关联与映射所需内容，原始输入输出在发布编码时逐项读回。 */
export class RefreshPayloads {
  // 空文件名创建连接私有临时文件，正常关闭和 Worker 退出时均由 SQLite 清理。
  private readonly database = new Database("");
  private readonly save: Database.Statement;
  private readonly read: Database.Statement;
  private retainedBytes = 0;

  constructor() {
    this.database.pragma("journal_mode = OFF");
    this.database.pragma("cache_size = -2048");
    this.database.exec("CREATE TABLE payloads(id INTEGER PRIMARY KEY,json TEXT NOT NULL)");
    this.save = this.database.prepare("INSERT INTO payloads(json) VALUES(?)");
    this.read = this.database.prepare("SELECT json FROM payloads WHERE id=?");
  }

  retain(source: ParsedHistorySource): ParsedHistorySource {
    // 复用现有 worktree、子会话证明投影；大正文不参与这些归属判断。
    const metadata = associationMetadata({ ...source, cursor: undefined });
    this.database.transaction(() => {
      for (const [index, event] of source.events.entries()) {
        const proof = metadata.events[index]!;
        // worktree 判断只读取这两个字段，不能让同一结果中的其他大字段重新驻留。
        const field = (value: JsonValue | undefined, key: string): JsonValue | undefined => value && typeof value === "object"
          && !Array.isArray(value) && value[key] !== undefined ? { [key]: value[key] } : undefined;
        event.input = this.defer(event.input, event.tool === "CommandExecution" ? field(proof.input, "command") : proof.input);
        event.output = this.defer(event.output, event.tool === "CommandExecution" ? field(proof.output, "formatted_output") : proof.output);
      }
    })();
    return source;
  }

  private defer(value: JsonValue | undefined, projection: JsonValue | undefined): JsonValue | undefined {
    if (value === undefined) return;
    const encoded = JSON.stringify(value);
    if (encoded.length <= 4096 && this.retainedBytes + encoded.length <= 8 * 1024 * 1024) {
      this.retainedBytes += encoded.length;
      return value;
    }
    const id = this.save.run(encoded).lastInsertRowid;
    const reference = projection && typeof projection === "object" && !Array.isArray(projection) ? { ...projection } : {};
    // 归并时沿用引用，JSON 编码时才恢复原值；临时标记不会进入缓存或已发布版本。
    Object.defineProperty(reference, "toJSON", { value: () => JSON.parse((this.read.get(id) as { json: string }).json) });
    return reference;
  }

  close(): void { this.database.close(); }
}
