import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseSessionSource } from "../src/sessions/parser.js";

test("主解析同时观察原始字节，哈希保留换行与不完整尾行，不重复计算身份探测", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-source-hash-"));
  try {
    const path = join(directory, "demo.jsonl");
    const bytes = Buffer.from(JSON.stringify({ type: "user", sessionId: "synthetic", uuid: "first", message: { content: "中文和锁" } })
      + "\r\n" + '{"尚未完整":');
    await writeFile(path, bytes);
    const hash = createHash("sha256");
    let observed = 0;
    const meta = await parseSessionSource({ client: "claude", path, sessionId: "synthetic" }, { message() {}, usage() {} }, {
      byteLimit: bytes.length,
      onRead: chunk => { observed += chunk.length; hash.update(chunk); },
    });
    assert.equal(observed, bytes.length);
    assert.equal(hash.digest("hex"), createHash("sha256").update(bytes).digest("hex"));
    assert.ok(meta.gaps.some(gap => gap.kind === "incomplete_record"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
