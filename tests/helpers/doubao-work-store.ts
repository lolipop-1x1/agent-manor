import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { serialize } from "node:v8";
import { maskedCrc32c } from "../../src/history/adapters/doubao-work-leveldb.js";

export function cacheVarint(value: number): Buffer {
  let remaining = BigInt(value);
  const output: number[] = [];
  do {
    const part = Number(remaining & 127n);
    remaining >>= 7n;
    output.push(part | (remaining ? 128 : 0));
  } while (remaining);
  return Buffer.from(output);
}

export const cacheBytes = (value: Buffer): Buffer => Buffer.concat([cacheVarint(value.length), value]);
export const cacheString = (value: string): Buffer => Buffer.from(value, "utf16le").swap16();
export const cacheStringWithLength = (value: string): Buffer => Buffer.concat([cacheVarint(value.length), cacheString(value)]);
export const cachePrefix = (database: number, store = 0, index = 0): Buffer => Buffer.from([0, database, store, index]);

export function cacheBlink(value: Record<string, unknown>): Buffer {
  return Buffer.concat([Buffer.from([255, 21, 254]), Buffer.alloc(12), serialize(value)]);
}

export function cacheSnappyLiteral(data: Buffer): Buffer {
  const size = data.length - 1;
  let header: Buffer;
  if (size < 60) header = Buffer.from([size << 2]);
  else {
    const width = size < 256 ? 1 : size < 65536 ? 2 : size < 16777216 ? 3 : 4;
    header = Buffer.alloc(width + 1);
    header[0] = (59 + width) << 2;
    header.writeUIntLE(size, 1, width);
  }
  return Buffer.concat([cacheVarint(data.length), header, data]);
}

export function cacheLog(records: Buffer[]): Buffer {
  const output: Buffer[] = [];
  let fileOffset = 0;
  for (const record of records) {
    let consumed = 0;
    do {
      const remaining = 32768 - (fileOffset % 32768);
      if (remaining < 7) {
        output.push(Buffer.alloc(remaining));
        fileOffset += remaining;
        continue;
      }
      const size = Math.min(remaining - 7, record.length - consumed);
      const first = consumed === 0;
      const last = consumed + size === record.length;
      const kind = first ? (last ? 1 : 2) : (last ? 4 : 3);
      const payload = record.subarray(consumed, consumed + size);
      const header = Buffer.alloc(7);
      header.writeUInt32LE(maskedCrc32c(Buffer.concat([Buffer.from([kind]), payload])));
      header.writeUInt16LE(size, 4);
      header[6] = kind;
      output.push(header, payload);
      fileOffset += 7 + size;
      consumed += size;
    } while (consumed < record.length);
  }
  return Buffer.concat(output);
}

export interface SyntheticCacheEntry { key: Buffer; value?: Buffer }

export function cacheBatch(entries: SyntheticCacheEntry[], sequence = 1): Buffer {
  const header = Buffer.alloc(12);
  header.writeBigUInt64LE(BigInt(sequence));
  header.writeUInt32LE(entries.length, 8);
  return Buffer.concat([header, ...entries.flatMap(({ key, value }) => [
    Buffer.from([value === undefined ? 0 : 1]), cacheBytes(key), ...(value === undefined ? [] : [cacheBytes(value)]),
  ])]);
}

export function cacheTable(entries: SyntheticCacheEntry[], sequence = 1, compressed = false): Buffer {
  const block = (rows: { key: Buffer; value: Buffer }[]): Buffer => {
    const restart = Buffer.alloc(8);
    restart.writeUInt32LE(1, 4);
    return Buffer.concat([...rows.flatMap(({ key, value }) => [Buffer.from([0]), cacheVarint(key.length), cacheVarint(value.length), key, value]), restart]);
  };
  const frame = (data: Buffer, snappy: boolean): Buffer => {
    const encoded = snappy ? cacheSnappyLiteral(data) : data;
    const trailer = Buffer.alloc(5);
    trailer[0] = snappy ? 1 : 0;
    trailer.writeUInt32LE(maskedCrc32c(Buffer.concat([encoded, trailer.subarray(0, 1)])), 1);
    return Buffer.concat([encoded, trailer]);
  };
  const data = frame(block(entries.map(({ key, value }, index) => {
    const trailer = Buffer.alloc(8);
    trailer.writeBigUInt64LE((BigInt(sequence + index) << 8n) | BigInt(value === undefined ? 0 : 1));
    return { key: Buffer.concat([key, trailer]), value: value ?? Buffer.alloc(0) };
  })), compressed);
  const index = frame(block([{ key: Buffer.from("end"), value: Buffer.concat([cacheVarint(0), cacheVarint(data.length - 5)]) }]), false);
  const footer = Buffer.alloc(48);
  Buffer.concat([cacheVarint(0), cacheVarint(0), cacheVarint(data.length), cacheVarint(index.length - 5)]).copy(footer);
  footer.writeBigUInt64LE(0xdb4775248b80fb57n, 40);
  return Buffer.concat([data, index, footer]);
}

export function cacheManifest(table?: { number: number; size: number }, logNumber = 2, previousLog = 0): Buffer {
  return cacheLog([Buffer.concat([
    cacheVarint(1), cacheBytes(Buffer.from("idb_cmp1")), cacheVarint(2), cacheVarint(logNumber),
    cacheVarint(9), cacheVarint(previousLog),
    ...(table ? [cacheVarint(7), cacheVarint(0), cacheVarint(table.number), cacheVarint(table.size), cacheBytes(Buffer.alloc(0)), cacheBytes(Buffer.alloc(0))] : []),
  ])]);
}

export function syntheticCacheEntries(
  records: { account: string; value: Record<string, unknown> }[],
  options: { external?: boolean; snappy?: boolean } = {},
): { entries: SyntheticCacheEntry[]; blobs: { database: number; data: Buffer }[] } {
  const entries: SyntheticCacheEntry[] = [];
  const blobs: { database: number; data: Buffer }[] = [];
  if (!records.length) entries.push(
    { key: Buffer.concat([cachePrefix(0), Buffer.from([201]), cacheStringWithLength("chrome://synthetic"), cacheStringWithLength("DoubaoPC_synthetic")]), value: Buffer.from([1]) },
    { key: Buffer.concat([cachePrefix(1), Buffer.from([50, 1, 0])]), value: cacheString("conversations") },
  );
  records.forEach(({ account, value }, index) => {
    const database = index + 1;
    entries.push(
      { key: Buffer.concat([cachePrefix(0), Buffer.from([201]), cacheStringWithLength("chrome://synthetic"), cacheStringWithLength(account)]), value: Buffer.from([database]) },
      { key: Buffer.concat([cachePrefix(database), Buffer.from([50, 1, 0])]), value: cacheString("conversations") },
    );
    const rawKey = Buffer.alloc(9);
    rawKey[0] = 3;
    const key = Buffer.concat([cachePrefix(database, 1, 1), rawKey]);
    let payload = cacheBlink(value);
    if (options.snappy) payload = Buffer.concat([Buffer.from([255, 17, 2]), cacheSnappyLiteral(payload)]);
    if (options.external) {
      blobs.push({ database, data: payload });
      entries.push({ key: Buffer.concat([cachePrefix(database, 1, 3), rawKey]), value: Buffer.concat([Buffer.from([0]), cacheVarint(257), cacheStringWithLength("application/octet-stream"), cacheVarint(payload.length)]) });
      payload = Buffer.concat([Buffer.from([255, 17, 1]), cacheVarint(payload.length), cacheVarint(0)]);
    }
    entries.push({ key, value: Buffer.concat([cacheVarint(1), payload]) });
  });
  return { entries, blobs };
}

export async function writeDoubaoWorkCache(
  directory: string,
  records: { account: string; value: Record<string, unknown> }[],
  options: { external?: boolean; snappy?: boolean; table?: boolean } = {},
): Promise<string> {
  const { entries, blobs } = syntheticCacheEntries(records, options);
  await mkdir(directory, { recursive: true });
  let table: Buffer | undefined;
  if (options.table) {
    table = cacheTable(entries, 1, options.snappy);
    await writeFile(path.join(directory, "000003.ldb"), table);
  }
  await writeFile(path.join(directory, "000002.log"), options.table ? Buffer.alloc(0) : cacheLog([cacheBatch(entries)]));
  await writeFile(path.join(directory, "MANIFEST-000001"), cacheManifest(table ? { number: 3, size: table.length } : undefined));
  await writeFile(path.join(directory, "CURRENT"), "MANIFEST-000001\n");
  for (const { database, data } of blobs) {
    const folder = path.join(directory.replace(/\.leveldb$/, ".blob"), database.toString(16), "01");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "101"), data);
  }
  return path.join(directory, "CURRENT");
}
