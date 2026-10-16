import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, truncate, unlink, writeFile, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DiagnosticError, errorDescriptor } from "../src/i18n/diagnostics.js";
import { translateMessage } from "../src/i18n/index.js";
import { CACHE_BYTE_LIMIT, decompressSnappy } from "../src/history/adapters/doubao-work-leveldb.js";
import { readDoubaoWorkCache } from "../src/history/adapters/doubao-work-store.js";
import {
  cacheBatch, cacheLog, cacheManifest, cacheTable, cacheVarint,
  syntheticCacheEntries, writeDoubaoWorkCache,
} from "./helpers/doubao-work-store.js";

const record = { account: "DoubaoPC_synthetic", value: { downlink_body: { cells: [{ conversation: { name: "Synthetic task", messages: [{ message_id: "synthetic-message", content: "合成缓存正文" }] } }] } } };

async function fixture(run: (directory: string, current: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "doubao-cache-test-"));
  const directory = path.join(root, "launcher.leveldb");
  try { await run(directory, await writeDoubaoWorkCache(directory, [record])); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("豆包缓存从 WAL 解码账号对象，读取不修改来源，指纹覆盖依赖变化", async () => {
  await fixture(async (directory, current) => {
    const before = await readFile(path.join(directory, "000002.log"));
    const first = await readDoubaoWorkCache(current);
    assert.deepEqual(first.records, [record]);
    assert.equal((await readDoubaoWorkCache(current)).fingerprint, first.fingerprint);
    assert.deepEqual(await readFile(path.join(directory, "000002.log")), before);
    await writeDoubaoWorkCache(directory, [{ ...record, value: { changed: true } }]);
    const changed = await readDoubaoWorkCache(current);
    assert.notEqual(changed.fingerprint, first.fingerprint);
    assert.deepEqual(changed.records[0]?.value, { changed: true });
  });
});

test("豆包缓存支持 SST、Snappy 和外置 blob 组合", async () => {
  await fixture(async (directory, current) => {
    await writeDoubaoWorkCache(directory, [record], { table: true, external: true, snappy: true });
    assert.deepEqual((await readDoubaoWorkCache(current)).records, [record]);
  });
});

test("豆包缓存仅选择活动表和有效 WAL，并应用最新值与删除标记", async () => {
  await fixture(async (directory, current) => {
    const { entries } = syntheticCacheEntries([record]);
    const table = cacheTable(entries);
    await writeFile(path.join(directory, "000003.ldb"), table);
    await writeFile(path.join(directory, "000099.ldb"), "inactive table must never be parsed");
    await writeFile(path.join(directory, "MANIFEST-000001"), cacheManifest({ number: 3, size: table.length }, 4));
    await writeFile(path.join(directory, "000004.log"), cacheLog([cacheBatch([{ key: entries.at(-1)!.key }], 100)]));
    assert.deepEqual((await readDoubaoWorkCache(current)).records, []);
    await writeFile(path.join(directory, "000004.log"), cacheLog([cacheBatch([entries.at(-1)!], 101)]));
    assert.deepEqual((await readDoubaoWorkCache(current)).records, [record]);
  });
});

test("豆包缓存使用 MANIFEST 的删除表记录，忽略遗留旧表", async () => {
  await fixture(async (directory, current) => {
    const { entries } = syntheticCacheEntries([record]);
    const table = cacheTable(entries);
    await writeFile(path.join(directory, "000003.ldb"), table);
    const manifest = await readFile(path.join(directory, "MANIFEST-000001"));
    const addAndDelete = Buffer.concat([cacheVarint(7), cacheVarint(0), cacheVarint(3), cacheVarint(table.length), Buffer.from([0, 0]), cacheVarint(6), cacheVarint(0), cacheVarint(3)]);
    await writeFile(path.join(directory, "MANIFEST-000001"), Buffer.concat([manifest, cacheLog([addAndDelete])]));
    await writeFile(path.join(directory, "000002.log"), cacheLog([cacheBatch(entries.slice(0, 2), 100)]));
    assert.deepEqual((await readDoubaoWorkCache(current)).records, []);
  });
});

test("豆包缓存包含 previous log，但不会复活更旧日志中的记录", async () => {
  await fixture(async (directory, current) => {
    const { entries } = syntheticCacheEntries([record]);
    await writeFile(path.join(directory, "000002.log"), cacheLog([cacheBatch(entries, 1000)]));
    await writeFile(path.join(directory, "000003.log"), cacheLog([cacheBatch(entries, 20)]));
    await writeFile(path.join(directory, "000004.log"), Buffer.alloc(0));
    const edit = Buffer.concat([cacheVarint(2), cacheVarint(4), cacheVarint(9), cacheVarint(3)]);
    await writeFile(path.join(directory, "MANIFEST-000001"), cacheLog([edit]));
    assert.deepEqual((await readDoubaoWorkCache(current)).records, [record]);
    await writeFile(path.join(directory, "000004.log"), cacheLog([cacheBatch([{ key: entries.at(-1)!.key }], 30)]));
    assert.deepEqual((await readDoubaoWorkCache(current)).records, []);
  });
});

test("豆包缓存缺失 MANIFEST 引用的 previous log 时失败，不将元数据当作有效空来源", async () => {
  await fixture(async (directory, current) => {
    const { entries } = syntheticCacheEntries([record]);
    await writeFile(path.join(directory, "000003.log"), cacheLog([cacheBatch(entries.slice(2), 10)]));
    await writeFile(path.join(directory, "000004.log"), cacheLog([cacheBatch(entries.slice(0, 2), 20)]));
    await writeFile(path.join(directory, "MANIFEST-000001"), cacheManifest(undefined, 4, 3));
    assert.deepEqual((await readDoubaoWorkCache(current)).records, [record]);
    await unlink(path.join(directory, "000003.log"));
    await assert.rejects(readDoubaoWorkCache(current), /active log is missing/);
  });
});

test("豆包缓存自产格式错误在组合后保留稳定中英文描述与原始 cause", async () => {
  await fixture(async (directory, current) => {
    for (const corruption of ["current", "checksum"] as const) {
      await writeDoubaoWorkCache(directory, [record]);
      if (corruption === "current") await writeFile(current, "invalid");
      else {
        const logPath = path.join(directory, "000002.log");
        const log = await readFile(logPath); log[0] = log[0]! ^ 1;
        await writeFile(logPath, log);
      }
      await assert.rejects(readDoubaoWorkCache(current), (error: unknown) => {
        assert.ok(error instanceof DiagnosticError && error.cause instanceof DiagnosticError);
        const descriptor = errorDescriptor(error)!;
        assert.deepEqual(descriptor, errorDescriptor(error.cause));
        assert.equal(descriptor.key, "diagnostics.history.adapters.doubaoWork.cacheInvalid");
        assert.equal(translateMessage("zh-CN", descriptor), "豆包工作本机缓存读取失败：缓存格式无效或不完整");
        assert.equal(translateMessage("en", descriptor), "Unable to read the Doubao Work local cache: invalid or incomplete cache format");
        assert.match(error.cause.message, corruption === "current" ? /invalid CURRENT/ : /checksum/);
        return true;
      });
    }
  });
});

test("豆包缓存保留独立账号命名空间，忽略非豆包数据库", async () => {
  await fixture(async (directory, current) => {
    const other = { account: "DoubaoPC_other_synthetic", value: { text: "第二个合成账号" } };
    await writeDoubaoWorkCache(directory, [record, other, { account: "unrelated-database", value: {} }]);
    assert.deepEqual((await readDoubaoWorkCache(current)).records, [record, other]);
  });
});

test("豆包缓存区分合法空 store 与未识别的账号或 store schema", async () => {
  await fixture(async (directory, current) => {
    await writeDoubaoWorkCache(directory, []);
    assert.deepEqual((await readDoubaoWorkCache(current)).records, []);
    await writeFile(path.join(directory, "000002.log"), cacheLog([cacheBatch([])]));
    await assert.rejects(readDoubaoWorkCache(current), /no recognized account conversation store/);
    const { entries } = syntheticCacheEntries([record]);
    await writeFile(path.join(directory, "000002.log"), cacheLog([cacheBatch([entries[0]!])]));
    await assert.rejects(readDoubaoWorkCache(current), /no recognized account conversation store/);
  });
});

test("豆包缓存产品诊断包含稳定翻译描述并保留原始错误与 errno", async () => {
  await fixture(async (_directory, current) => {
    await unlink(current);
    await assert.rejects(readDoubaoWorkCache(current), (error: unknown) => {
      assert.ok(error instanceof DiagnosticError);
      assert.equal(errorDescriptor(error)?.key, "diagnostics.history.adapters.doubaoWork.cacheReadFailed");
      assert.match(String(errorDescriptor(error)?.params?.reason), /ENOENT/);
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      assert.equal((error as NodeJS.ErrnoException).path, current);
      assert.ok(error.cause instanceof Error);
      assert.equal(errorDescriptor(error)?.params?.reason, error.cause.message);
      for (const language of ["en", "zh-CN"] as const) {
        assert.ok(translateMessage(language, errorDescriptor(error)!).includes(error.cause.message));
      }
      assert.match(error.message, /^豆包工作会话缓存读取失败：/);
      return true;
    });
  });
});

test("豆包缓存支持跨 32KB 日志分片，不截断大消息", async () => {
  await fixture(async (directory, current) => {
    const large = { ...record, value: { text: "合成正文".repeat(25000) } };
    await writeDoubaoWorkCache(directory, [large]);
    assert.deepEqual((await readDoubaoWorkCache(current)).records, [large]);
  });
});

test("豆包缓存只解码 conversations，不解码其他 store 的载荷", async () => {
  await fixture(async (directory, current) => {
    const { entries } = syntheticCacheEntries([record]);
    entries.push({ key: Buffer.from([0, 1, 2, 1, 3, 0, 0, 0, 0, 0, 0, 0, 0]), value: Buffer.from("unrelated secret store is not decoded") });
    await writeFile(path.join(directory, "000002.log"), cacheLog([cacheBatch(entries)]));
    assert.deepEqual((await readDoubaoWorkCache(current)).records, [record]);
  });
});

test("豆包缓存缺少 blob 时失败，不返回空会话", async () => {
  await fixture(async (directory, current) => {
    await writeDoubaoWorkCache(directory, [record], { external: true });
    await unlink(path.join(directory.replace(/\.leveldb$/, ".blob"), "1", "01", "101"));
    await assert.rejects(readDoubaoWorkCache(current), /external value is missing/);
  });
});

test("豆包缓存损坏日志、SST 或尾部未完成记录时失败", async () => {
  await fixture(async (directory, current) => {
    const logPath = path.join(directory, "000002.log");
    const log = await readFile(logPath);
    log[0] = log[0]! ^ 1;
    await writeFile(logPath, log);
    await assert.rejects(readDoubaoWorkCache(current), /checksum/);
    await writeDoubaoWorkCache(directory, [record], { table: true });
    const tablePath = path.join(directory, "000003.ldb");
    const table = await readFile(tablePath);
    table[1] = table[1]! ^ 1;
    await writeFile(tablePath, table);
    await assert.rejects(readDoubaoWorkCache(current), /checksum/);
    await writeDoubaoWorkCache(directory, [record]);
    const fresh = await readFile(logPath);
    await writeFile(logPath, fresh.subarray(0, fresh.length - 1));
    await assert.rejects(readDoubaoWorkCache(current), /incomplete log/);
  });
});

test("豆包缓存缺少活动表、日志、manifest 或空 manifest 时失败", async () => {
  await fixture(async (directory, current) => {
    await writeDoubaoWorkCache(directory, [record], { table: true });
    await unlink(path.join(directory, "000003.ldb"));
    await assert.rejects(readDoubaoWorkCache(current), /active table is missing/);
    await writeDoubaoWorkCache(directory, [record]);
    await unlink(path.join(directory, "000002.log"));
    await assert.rejects(readDoubaoWorkCache(current), /active log is missing/);
    await writeFile(path.join(directory, "MANIFEST-000001"), Buffer.alloc(0));
    await assert.rejects(readDoubaoWorkCache(current), /no complete edits/);
    await unlink(path.join(directory, "MANIFEST-000001"));
    await assert.rejects(readDoubaoWorkCache(current), /manifest is missing/);
  });
});

test("豆包缓存未知 Blink 包装和无法解码的 V8 都失败", async () => {
  await fixture(async (directory, current) => {
    const { entries } = syntheticCacheEntries([record]);
    entries.at(-1)!.value = Buffer.from([1, 255, 17, 9]);
    await writeFile(path.join(directory, "000002.log"), cacheLog([cacheBatch(entries)]));
    await assert.rejects(readDoubaoWorkCache(current), error => {
      assert.equal(errorDescriptor(error)?.key, "diagnostics.history.adapters.doubaoWork.cacheUnsupported");
      return /unsupported Blink wrapper/.test(String(error));
    });
    entries.at(-1)!.value = Buffer.from([1, 255, 16, 1, 2, 3]);
    await writeFile(path.join(directory, "000002.log"), cacheLog([cacheBatch(entries)]));
    await assert.rejects(readDoubaoWorkCache(current), error => {
      assert.ok(error instanceof DiagnosticError && error.cause instanceof DiagnosticError);
      assert.ok(error.cause.cause instanceof Error);
      return /V8 value could not be decoded/.test(error.message);
    });
  });
});

test("豆包缓存拒绝循环对象与超深结构，不交给后续 JSON 索引", async () => {
  await fixture(async (directory, current) => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await writeDoubaoWorkCache(directory, [{ ...record, value: cyclic }]);
    await assert.rejects(readDoubaoWorkCache(current), /cyclic object/);
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 70; index++) deep = { child: deep };
    await writeDoubaoWorkCache(directory, [{ ...record, value: deep }]);
    await assert.rejects(readDoubaoWorkCache(current), /structural limit/);
  });
});

test("豆包缓存按文件体积和 Snappy 解压长度限制读取", async () => {
  await fixture(async (directory, current) => {
    const large = path.join(directory, "000099.ldb");
    await writeFile(large, "");
    await truncate(large, CACHE_BYTE_LIMIT + 1);
    await assert.rejects(readDoubaoWorkCache(current), /byte limit/);
    assert.throws(() => decompressSnappy(cacheVarint(CACHE_BYTE_LIMIT + 1)), /byte limit/);
  });
});

test("Snappy 重叠复制正确，非法偏移和缺字节失败", () => {
  // 一个 a 字面值后从距离 1 复制四次，产生 aaaaa。
  assert.equal(decompressSnappy(Buffer.from([5, 0, 97, 1, 1])).toString(), "aaaaa");
  assert.throws(() => decompressSnappy(Buffer.from([5, 0, 97, 1, 0])), /invalid Snappy copy/);
  assert.throws(() => decompressSnappy(Buffer.from([5, 0, 97, 1])), /truncated binary field/);
});

test("豆包缓存拒绝符号链接文件与跨目录 CURRENT 引用", async () => {
  await fixture(async (directory, current) => {
    await symlink("000002.log", path.join(directory, "000099.log"));
    await assert.rejects(readDoubaoWorkCache(current), /unsupported file entry/);
    await unlink(path.join(directory, "000099.log"));
    await writeFile(current, "../MANIFEST-000001\n");
    await assert.rejects(readDoubaoWorkCache(current), /invalid CURRENT/);
  });
});

test("豆包缓存并发变化时拒绝发布混合快照", async () => {
  await fixture(async (directory, current) => {
    const changingPath = path.join(directory, "000099.ldb");
    await writeFile(changingPath, Buffer.alloc(16 * 1024 * 1024));
    const writer = await open(changingPath, "r+");
    let running = true;
    const writes = (async () => {
      let value = 0;
      while (running) {
        await writer.write(Buffer.from([++value & 255]), 0, 1, 0);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })();
    try { await assert.rejects(readDoubaoWorkCache(current), /changed while taking a snapshot/); }
    finally { running = false; await writes; await writer.close(); }
  });
});
