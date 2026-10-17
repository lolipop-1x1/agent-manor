import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import path from "node:path";
import { deserialize } from "node:v8";
import { DiagnosticError, errorDescriptor } from "../../i18n/diagnostics.js";
import { cacheFailure } from "./doubao-work-diagnostics.js";
import {
  CACHE_BYTE_LIMIT, CacheCursor, decompressSnappy, latestCacheEntries,
  logRecords, readCacheVersion, tableEntries, writeBatchEntries,
} from "./doubao-work-leveldb.js";
import type { CacheEntry } from "./doubao-work-leveldb.js";

const FILE_LIMIT = 4096;
const VALUE_LIMIT = 32 * 1024 * 1024;
const VALUE_COUNT_LIMIT = 10_000;

interface FileStamp { name: string; stamp: string; size: number }
interface CacheSnapshot { files: Map<string, Buffer>; fingerprint: string }
export interface DoubaoWorkCache {
  records: { account: string; store?: "conversationListDataSnapshots"; value: Record<string, unknown> }[];
  fingerprint: string;
}

function signature(stat: Awaited<ReturnType<typeof lstat>>): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

async function fileList(directory: string, blobDirectory: string): Promise<FileStamp[]> {
  const files: FileStamp[] = [];
  let total = 0;
  let visited = 0;
  const countEntry = (): void => {
    if (++visited > FILE_LIMIT * 4) throw cacheFailure("limit", "Doubao Work cache exceeds its directory entry limit");
  };
  const add = async (file: string, name: string): Promise<void> => {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw cacheFailure("unsupported", "Doubao Work cache contains an unsupported file entry");
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || total + stat.size > CACHE_BYTE_LIMIT) {
      throw cacheFailure("limit", "Doubao Work cache exceeds its byte limit");
    }
    total += stat.size;
    files.push({ name, stamp: signature(stat), size: stat.size });
    if (files.length > FILE_LIMIT) throw cacheFailure("limit", "Doubao Work cache exceeds its file limit");
  };
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw cacheFailure("unsupported", "Doubao Work cache directory must be a regular directory");
  for await (const entry of await opendir(directory)) {
    countEntry();
    if (entry.name === "CURRENT" || /^MANIFEST-\d+$/.test(entry.name) || /^\d+\.(?:log|ldb|sst)$/.test(entry.name)) {
      await add(path.join(directory, entry.name), `leveldb/${entry.name}`);
    }
  }
  const visit = async (folder: string, relative: string, depth: number): Promise<void> => {
    if (depth > 3) throw cacheFailure("limit", "Doubao Work cache blob directory exceeds its depth limit");
    const stat = await lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw cacheFailure("unsupported", "Doubao Work cache blob directory must be a regular directory");
    for await (const entry of await opendir(folder)) {
      countEntry();
      if (!/^[0-9a-f]+$/i.test(entry.name)) throw cacheFailure("unsupported", "Doubao Work cache contains an unsupported blob entry");
      const child = path.join(folder, entry.name);
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(child, name, depth + 1);
      else await add(child, name);
    }
  };
  try { await visit(blobDirectory, "blob", 0); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT" && "path" in error && error.path === blobDirectory)) throw error;
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function captureCache(currentPath: string): Promise<CacheSnapshot> {
  if (path.basename(currentPath) !== "CURRENT") throw cacheFailure("unsupported", "Doubao Work cache source must be a CURRENT file");
  const directory = path.dirname(currentPath);
  if (!directory.endsWith(".leveldb")) throw cacheFailure("unsupported", "Doubao Work cache source must belong to a LevelDB directory");
  const blobDirectory = `${directory.slice(0, -".leveldb".length)}.blob`;
  const before = await fileList(directory, blobDirectory);
  if (!before.some((file) => file.name === "leveldb/CURRENT")) {
    // 保留 ENOENT，让共享刷新流程确认整个来源已消失。
    await lstat(currentPath);
    throw cacheFailure("missing", "Doubao Work cache CURRENT file is unavailable");
  }
  const files = new Map<string, Buffer>();
  const fingerprint = createHash("sha256");
  for (const file of before) {
    const base = file.name.startsWith("leveldb/") ? directory : blobDirectory;
    const relative = file.name.slice(file.name.indexOf("/") + 1);
    const handle = await open(path.join(base, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (signature(await handle.stat()) !== file.stamp) throw cacheFailure("changed", "Doubao Work cache changed while taking a snapshot");
      const data = Buffer.alloc(file.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
        if (!bytesRead) throw cacheFailure("changed", "Doubao Work cache changed while taking a snapshot");
        offset += bytesRead;
      }
      if (signature(await handle.stat()) !== file.stamp) throw cacheFailure("changed", "Doubao Work cache changed while taking a snapshot");
      files.set(file.name, data);
      fingerprint.update(file.name).update("\0").update(createHash("sha256").update(data).digest());
    } finally { await handle.close(); }
  }
  const after = await fileList(directory, blobDirectory);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw cacheFailure("changed", "Doubao Work cache changed while taking a snapshot");
  return { files, fingerprint: fingerprint.digest("hex") };
}

function integer(data: Buffer): number {
  if (!data.length || data.length > 8) throw cacheFailure("invalid", "Doubao Work cache has an invalid IndexedDB integer");
  let value = 0n;
  for (let index = data.length - 1; index >= 0; index--) value = (value << 8n) | BigInt(data[index]!);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw cacheFailure("limit", "Doubao Work cache IndexedDB integer exceeds its supported range");
  return Number(value);
}

function string(data: Buffer): string {
  if (data.length % 2) throw cacheFailure("invalid", "Doubao Work cache has an invalid IndexedDB string");
  return Buffer.from(data).swap16().toString("utf16le");
}

function keyPrefix(key: Buffer): { database: number; store: number; index: number; tail: Buffer } {
  const input = new CacheCursor(key);
  const widths = input.byte();
  const database = integer(input.take((widths >>> 5) + 1));
  const store = integer(input.take(((widths >>> 2) & 7) + 1));
  const index = integer(input.take((widths & 3) + 1));
  return { database, store, index, tail: key.subarray(input.offset) };
}

function* activeEntries(files: Map<string, Buffer>): Generator<CacheEntry> {
  const current = files.get("leveldb/CURRENT")!.toString();
  if (!/^MANIFEST-\d+\n$/.test(current)) throw cacheFailure("invalid", "Doubao Work cache has an invalid CURRENT manifest reference");
  const manifest = files.get(`leveldb/${current.trim()}`);
  if (!manifest) throw cacheFailure("missing", "Doubao Work cache manifest is missing");
  const version = readCacheVersion(manifest);
  for (const [number, size] of version.tables) {
    const name = String(number).padStart(6, "0");
    const data = files.get(`leveldb/${name}.ldb`) ?? files.get(`leveldb/${name}.sst`);
    if (!data || data.length !== size) throw cacheFailure("missing", "Doubao Work cache active table is missing or changed");
    yield* tableEntries(data);
  }
  const logs = [...files.keys()].filter((name) => /^leveldb\/\d+\.log$/.test(name));
  if ([version.logNumber, version.previousLog].some(number => number !== 0
    && !logs.some(name => Number(path.basename(name, ".log")) === number))) {
    throw cacheFailure("missing", "Doubao Work cache active log is missing");
  }
  for (const name of logs) {
    const number = Number(path.basename(name, ".log"));
    if (number >= version.logNumber || number === version.previousLog) {
      for (const record of logRecords(files.get(name)!)) yield* writeBatchEntries(record);
    }
  }
}

function validateValue(value: unknown): void {
  const ancestors = new WeakSet<object>();
  let count = 0;
  let bytes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++count > 1_000_000 || depth > 64) throw cacheFailure("limit", "Doubao Work cache object exceeds its structural limit");
    if (typeof item === "bigint") throw cacheFailure("unsupported", "Doubao Work cache contains an unsupported integer type");
    if (typeof item === "string") bytes += item.length * 2;
    if (bytes > CACHE_BYTE_LIMIT) throw cacheFailure("limit", "Doubao Work cache object exceeds its text limit");
    if (!item || typeof item !== "object") return;
    if (ancestors.has(item)) throw cacheFailure("invalid", "Doubao Work cache contains a cyclic object");
    if (Array.isArray(item)) {
      if (item.length > 1_000_000) throw cacheFailure("limit", "Doubao Work cache array exceeds its structural limit");
    } else if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw cacheFailure("unsupported", "Doubao Work cache contains an unsupported object type");
    }
    ancestors.add(item);
    for (const [key, child] of Object.entries(item)) {
      bytes += key.length * 2;
      visit(child, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
}

function unwrapValue(
  data: Buffer, entry: CacheEntry, database: number, store: number,
  latest: Map<string, CacheEntry>, files: Map<string, Buffer>, budget: { remaining: number }, depth = 0,
): Record<string, unknown> {
  if (depth > 4 || data.length > VALUE_LIMIT) throw cacheFailure("limit", "Doubao Work cache value exceeds its decoding limit");
  budget.remaining -= data.length;
  if (budget.remaining < 0) throw cacheFailure("limit", "Doubao Work cache decoded values exceed their byte limit");
  const input = new CacheCursor(data);
  if (input.byte() !== 255) throw cacheFailure("unsupported", "Doubao Work cache has an unsupported Blink value");
  const version = input.uint();
  if (version === 17) {
    const operation = input.byte();
    if (operation === 2) return unwrapValue(decompressSnappy(data.subarray(input.offset), Math.min(VALUE_LIMIT, budget.remaining)), entry, database, store, latest, files, budget, depth + 1);
    if (operation !== 1) throw cacheFailure("unsupported", "Doubao Work cache has an unsupported Blink wrapper");
    const expectedSize = input.uint();
    const selectedIndex = input.uint();
    if (input.offset !== data.length) throw cacheFailure("invalid", "Doubao Work cache has invalid external value metadata");
    const blobKey = Buffer.from(entry.key);
    // index id 使用原键前缀中的原生宽度，保留键本体。
    const prefixLength = 1 + (blobKey[0]! >>> 5) + 1 + ((blobKey[0]! >>> 2) & 7) + 1;
    const indexWidth = (blobKey[0]! & 3) + 1;
    blobKey.fill(0, prefixLength, prefixLength + indexWidth);
    blobKey[prefixLength] = 3;
    const external = latest.get(blobKey.toString("hex"));
    if (!external || external.deleted) throw cacheFailure("missing", "Doubao Work cache external value metadata is missing");
    const objects = new CacheCursor(external.value);
    for (let index = 0; objects.offset < objects.data.length; index++) {
      const kind = objects.byte();
      if (kind !== 0 && kind !== 1) throw cacheFailure("unsupported", "Doubao Work cache has an unsupported external object");
      const number = objects.uint();
      objects.take(objects.uint() * 2);
      const size = objects.uint();
      if (kind === 1) { objects.take(objects.uint() * 2); objects.uint(); }
      if (index !== selectedIndex) continue;
      const name = `blob/${database.toString(16)}/${Math.floor(number / 256).toString(16).padStart(2, "0")}/${number.toString(16)}`;
      const blob = files.get(name);
      if (!blob || blob.length !== size || blob.length !== expectedSize) throw cacheFailure("missing", "Doubao Work cache external value is missing or changed");
      return unwrapValue(blob, entry, database, store, latest, files, budget, depth + 1);
    }
    throw cacheFailure("missing", "Doubao Work cache external object index is missing");
  }
  if (version < 16 || version > 21) throw cacheFailure("unsupported", "Doubao Work cache has an unsupported Blink version");
  if (version >= 21) {
    if (input.byte() !== 254) throw cacheFailure("invalid", "Doubao Work cache has an invalid Blink trailer marker");
    const trailerOffset = input.take(8).readBigUInt64BE();
    const trailerSize = input.take(4).readUInt32BE();
    if ((trailerOffset === 0n) !== (trailerSize === 0)
      || trailerOffset > BigInt(data.length) || Number(trailerOffset) + trailerSize > data.length) {
      throw cacheFailure("invalid", "Doubao Work cache has an invalid Blink trailer location");
    }
    if (trailerSize) throw cacheFailure("unsupported", "Doubao Work cache uses unsupported Blink host objects");
  }
  let value: unknown;
  try { value = deserialize(data.subarray(input.offset)); }
  catch (error) { throw cacheFailure("invalid", "Doubao Work cache V8 value could not be decoded", error); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw cacheFailure("invalid", "Doubao Work conversation cache value must be an object");
  validateValue(value);
  return value as Record<string, unknown>;
}

async function readCache(currentPath: string): Promise<DoubaoWorkCache> {
  const snapshot = await captureCache(currentPath);
  const latest = latestCacheEntries(activeEntries(snapshot.files));
  const entries = [...latest.values()].filter((entry) => !entry.deleted).map((entry) => ({ entry, prefix: keyPrefix(entry.key) }));
  const accounts = new Map<number, string>();
  for (const { entry, prefix } of entries) {
    if (prefix.database === 0 && prefix.store === 0 && prefix.index === 0 && prefix.tail[0] === 201) {
      const input = new CacheCursor(prefix.tail.subarray(1));
      input.take(input.uint() * 2);
      const name = string(input.take(input.uint() * 2));
      if (input.offset !== input.data.length) throw cacheFailure("invalid", "Doubao Work cache has invalid database metadata");
      if (name.startsWith("DoubaoPC_")) accounts.set(integer(entry.value), name);
    }
  }
  const stores = new Map<string, "conversations" | "conversationListDataSnapshots">();
  for (const { entry, prefix } of entries) {
    if (!accounts.has(prefix.database) || prefix.store || prefix.index || prefix.tail[0] !== 50) continue;
    const input = new CacheCursor(prefix.tail.subarray(1));
    const store = input.uint();
    if (input.byte() !== 0) continue;
    const name = string(entry.value);
    if (name === "conversations" || name === "conversationListDataSnapshots") stores.set(`${prefix.database}:${store}`, name);
  }
  if (!accounts.size || [...accounts.keys()].some(database => ![...stores.keys()].some(store => store.startsWith(`${database}:`)))) {
    throw cacheFailure("unsupported", "Doubao Work cache has no recognized account conversation store");
  }
  const records: DoubaoWorkCache["records"] = [];
  const budget = { remaining: CACHE_BYTE_LIMIT };
  let bytes = 0;
  for (const { entry, prefix } of entries) {
    if (prefix.index !== 1 || !stores.has(`${prefix.database}:${prefix.store}`)) continue;
    const input = new CacheCursor(entry.value);
    input.uint();
    const payload = entry.value.subarray(input.offset);
    bytes += payload.length;
    if (records.length >= VALUE_COUNT_LIMIT || bytes > CACHE_BYTE_LIMIT) throw cacheFailure("limit", "Doubao Work conversation cache exceeds its value limit");
    records.push({ account: accounts.get(prefix.database)!,
      ...(stores.get(`${prefix.database}:${prefix.store}`) === "conversationListDataSnapshots" ? { store: "conversationListDataSnapshots" as const } : {}),
      value: unwrapValue(payload, entry, prefix.database, prefix.store, latest, snapshot.files, budget) });
  }
  return { records, fingerprint: snapshot.fingerprint };
}

export async function readDoubaoWorkCache(currentPath: string): Promise<DoubaoWorkCache> {
  try { return await readCache(currentPath); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failure = new DiagnosticError(`豆包工作会话缓存读取失败：${reason}`, errorDescriptor(error) ?? {
      key: "diagnostics.history.adapters.doubaoWork.cacheReadFailed", params: { reason },
    });
    Object.defineProperty(failure, "cause", { value: error });
    if (error && typeof error === "object") {
      const original = error as Record<string, unknown>;
      for (const field of ["code", "errno", "syscall", "path"] as const) {
        if (field in original) Object.assign(failure, { [field]: original[field] });
      }
    }
    throw failure;
  }
}
