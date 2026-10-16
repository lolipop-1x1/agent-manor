// 按 LevelDB 公开格式读取，不打开数据库、不创建锁或恢复文件。
export const CACHE_BYTE_LIMIT = 128 * 1024 * 1024;
const RECORD_LIMIT = 1_000_000;

export class CacheCursor {
  offset = 0;
  constructor(readonly data: Buffer) {}
  take(size: number): Buffer {
    if (!Number.isSafeInteger(size) || size < 0 || this.offset + size > this.data.length) {
      throw new Error("Doubao Work cache has a truncated binary field");
    }
    const value = this.data.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }
  byte(): number { return this.take(1)[0]!; }
  uint(): number {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const part = this.byte();
      value |= BigInt(part & 127) << shift;
      if (!(part & 128)) {
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Doubao Work cache integer exceeds its supported range");
        return Number(value);
      }
    }
    throw new Error("Doubao Work cache has an invalid varint");
  }
  bytes(): Buffer { return this.take(this.uint()); }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  return crc >>> 0;
});

export function maskedCrc32c(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  crc = (~crc) >>> 0;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

export function decompressSnappy(data: Buffer, limit = CACHE_BYTE_LIMIT): Buffer {
  const input = new CacheCursor(data);
  const size = input.uint();
  if (size > limit) throw new Error("Doubao Work cache decompression exceeds its byte limit");
  const output = Buffer.alloc(size);
  let offset = 0;
  while (input.offset < data.length) {
    const tag = input.byte();
    const kind = tag & 3;
    let count: number;
    if (kind === 0) {
      count = tag >>> 2;
      if (count < 60) count += 1;
      else {
        const width = count - 59;
        count = input.take(width).readUIntLE(0, width) + 1;
      }
      if (offset + count > size) throw new Error("Doubao Work cache has an invalid Snappy literal");
      input.take(count).copy(output, offset);
    } else {
      let distance: number;
      if (kind === 1) {
        count = 4 + ((tag >>> 2) & 7);
        distance = ((tag & 224) << 3) | input.byte();
      } else {
        count = 1 + (tag >>> 2);
        const width = kind === 2 ? 2 : 4;
        distance = input.take(width).readUIntLE(0, width);
      }
      if (distance <= 0 || distance > offset || offset + count > size) {
        throw new Error("Doubao Work cache has an invalid Snappy copy");
      }
      for (let index = 0; index < count; index++) output[offset + index] = output[offset + index - distance]!;
    }
    offset += count;
  }
  if (offset !== size) throw new Error("Doubao Work cache has an incomplete Snappy payload");
  return output;
}

export function* logRecords(data: Buffer): Generator<Buffer> {
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  for (let block = 0; block < data.length; block += 32768) {
    const end = Math.min(block + 32768, data.length);
    let offset = block;
    while (offset + 7 <= end) {
      const crc = data.readUInt32LE(offset);
      const size = data.readUInt16LE(offset + 4);
      const kind = data[offset + 6]!;
      if (crc === 0 && size === 0 && kind === 0) {
        if (data.subarray(offset, end).some((byte) => byte !== 0)) throw new Error("Doubao Work cache has invalid log padding");
        offset = end;
        break;
      }
      if (offset + 7 + size > end) throw new Error("Doubao Work cache has an incomplete log record");
      const value = data.subarray(offset + 7, offset + 7 + size);
      if (maskedCrc32c(Buffer.concat([Buffer.from([kind]), value])) !== crc) {
        throw new Error("Doubao Work cache log checksum does not match");
      }
      offset += 7 + size;
      if (kind === 1) {
        if (fragments.length) throw new Error("Doubao Work cache has overlapping log records");
        yield value;
      } else if (kind >= 2 && kind <= 4) {
        if ((kind === 2) === (fragments.length > 0)) throw new Error("Doubao Work cache has an invalid log fragment sequence");
        fragments.push(value);
        fragmentBytes += value.length;
        if (fragmentBytes > CACHE_BYTE_LIMIT) throw new Error("Doubao Work cache log exceeds its byte limit");
        if (kind === 4) {
          yield Buffer.concat(fragments);
          fragments = [];
          fragmentBytes = 0;
        }
      } else throw new Error("Doubao Work cache has an unsupported log record type");
    }
    if (offset < end && data.subarray(offset, end).some((byte) => byte !== 0)) {
      throw new Error("Doubao Work cache has an incomplete log header");
    }
  }
  if (fragments.length) throw new Error("Doubao Work cache has an incomplete log fragment sequence");
}

export interface CacheVersion {
  tables: Map<number, number>;
  logNumber: number;
  previousLog: number;
}

export function readCacheVersion(data: Buffer): CacheVersion {
  const version: CacheVersion = { tables: new Map(), logNumber: 0, previousLog: 0 };
  let edits = 0;
  for (const record of logRecords(data)) {
    if (!record.length) throw new Error("Doubao Work cache has an empty manifest edit");
    edits++;
    const input = new CacheCursor(record);
    while (input.offset < record.length) {
      const tag = input.uint();
      if (tag === 1) {
        const comparator = input.bytes().toString();
        if (comparator !== "idb_cmp1" && comparator !== "leveldb.BytewiseComparator") {
          throw new Error("Doubao Work cache has an unsupported comparator");
        }
      } else if (tag === 2) version.logNumber = input.uint();
      else if (tag === 9) version.previousLog = input.uint();
      else if (tag === 3 || tag === 4) input.uint();
      else if (tag === 5) { input.uint(); input.bytes(); }
      else if (tag === 6) { input.uint(); version.tables.delete(input.uint()); }
      else if (tag === 7) {
        input.uint();
        const number = input.uint();
        version.tables.set(number, input.uint());
        input.bytes();
        input.bytes();
      } else throw new Error("Doubao Work cache has an unsupported manifest field");
    }
  }
  if (!edits) throw new Error("Doubao Work cache manifest contains no complete edits");
  return version;
}

export interface CacheEntry { key: Buffer; value: Buffer; sequence: bigint; deleted: boolean }

function* blockEntries(data: Buffer): Generator<{ key: Buffer; value: Buffer }> {
  if (data.length < 8) throw new Error("Doubao Work cache has a truncated table block");
  const count = data.readUInt32LE(data.length - 4);
  const limit = data.length - 4 * (count + 1);
  if (count < 1 || limit < 0 || data.readUInt32LE(limit) !== 0) throw new Error("Doubao Work cache has invalid restart offsets");
  let previousRestart = -1;
  for (let index = 0; index < count; index++) {
    const restart = data.readUInt32LE(limit + index * 4);
    if (restart < previousRestart || restart > limit) throw new Error("Doubao Work cache has invalid restart offsets");
    previousRestart = restart;
  }
  const input = new CacheCursor(data.subarray(0, limit));
  let previous = Buffer.alloc(0);
  while (input.offset < limit) {
    const shared = input.uint();
    const unshared = input.uint();
    const size = input.uint();
    if (shared > previous.length) throw new Error("Doubao Work cache table key prefix exceeds its previous key");
    const key = Buffer.concat([previous.subarray(0, shared), input.take(unshared)]);
    const value = input.take(size);
    yield { key, value };
    previous = key;
  }
}

export function* tableEntries(data: Buffer): Generator<CacheEntry> {
  if (data.length < 48 || data.readBigUInt64LE(data.length - 8) !== 0xdb4775248b80fb57n) {
    throw new Error("Doubao Work cache has an invalid table footer");
  }
  const footer = new CacheCursor(data.subarray(data.length - 48, data.length - 8));
  footer.uint(); footer.uint();
  const indexOffset = footer.uint();
  const indexSize = footer.uint();
  const readBlock = (offset: number, size: number): Buffer => {
    if (offset + size + 5 > data.length - 48) throw new Error("Doubao Work cache table block exceeds its file");
    const block = data.subarray(offset, offset + size);
    const kind = data[offset + size]!;
    if (maskedCrc32c(data.subarray(offset, offset + size + 1)) !== data.readUInt32LE(offset + size + 1)) {
      throw new Error("Doubao Work cache table checksum does not match");
    }
    if (kind === 0) return block;
    if (kind === 1) return decompressSnappy(block);
    throw new Error("Doubao Work cache has an unsupported table compression");
  };
  let decodedBytes = 0;
  for (const index of blockEntries(readBlock(indexOffset, indexSize))) {
    const handle = new CacheCursor(index.value);
    const block = readBlock(handle.uint(), handle.uint());
    if (handle.offset !== handle.data.length) throw new Error("Doubao Work cache has an invalid table block handle");
    decodedBytes += block.length;
    if (decodedBytes > CACHE_BYTE_LIMIT) throw new Error("Doubao Work cache decoded tables exceed their byte limit");
    for (const entry of blockEntries(block)) {
      if (entry.key.length < 8) throw new Error("Doubao Work cache table key lacks its sequence");
      const trailer = entry.key.readBigUInt64LE(entry.key.length - 8);
      const kind = Number(trailer & 255n);
      if (kind !== 0 && kind !== 1) throw new Error("Doubao Work cache has an unsupported table value type");
      yield { key: entry.key.subarray(0, -8), value: entry.value, sequence: trailer >> 8n, deleted: kind === 0 };
    }
  }
}

export function* writeBatchEntries(data: Buffer): Generator<CacheEntry> {
  const input = new CacheCursor(data);
  const sequence = input.take(8).readBigUInt64LE();
  const count = input.take(4).readUInt32LE();
  if (count > RECORD_LIMIT) throw new Error("Doubao Work cache write batch exceeds its record limit");
  for (let index = 0; index < count; index++) {
    const kind = input.byte();
    if (kind !== 0 && kind !== 1) throw new Error("Doubao Work cache has an unsupported log value type");
    const key = input.bytes();
    const value = kind ? input.bytes() : Buffer.alloc(0);
    yield { key, value, sequence: sequence + BigInt(index), deleted: !kind };
  }
  if (input.offset !== data.length) throw new Error("Doubao Work cache write batch count does not match");
}

export function latestCacheEntries(entries: Iterable<CacheEntry>): Map<string, CacheEntry> {
  const latest = new Map<string, CacheEntry>();
  let count = 0;
  for (const entry of entries) {
    if (++count > RECORD_LIMIT) throw new Error("Doubao Work cache exceeds its record limit");
    const key = entry.key.toString("hex");
    const previous = latest.get(key);
    if (!previous || previous.sequence < entry.sequence) latest.set(key, entry);
    else if (previous.sequence === entry.sequence
      && (previous.deleted !== entry.deleted || !previous.value.equals(entry.value))) {
      throw new Error("Doubao Work cache has conflicting values for one sequence");
    }
  }
  return latest;
}
