/** 按序列化体积限制派生结果；过大的单项不驻留，读取时仍可从持久化汇总重建。 */
export class UsageResultCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;

  constructor(private readonly maxBytes: number, private readonly maxEntries: number) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }

  /** 传入保守字节上界可避免序列化；未传时按 JSON 字节数精确计费。 */
  set(key: string, value: T, estimatedBytes?: number): void {
    const previous = this.entries.get(key);
    if (previous) { this.entries.delete(key); this.bytes -= previous.bytes; }
    if (estimatedBytes !== undefined && (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0)) {
      throw new RangeError("缓存字节估算必须是非负安全整数");
    }
    const bytes = estimatedBytes ?? Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes }); this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest);
    }
  }

  clear(): void { this.entries.clear(); this.bytes = 0; }
}
