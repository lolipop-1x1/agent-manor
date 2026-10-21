import { threadId } from "node:worker_threads";
import type Database from "better-sqlite3";

const owner = threadId + 1;

/** 服务内部写者先交接写权限，避免长事务让另一个写者耗尽 SQLite 的锁超时。 */
function acquireIndexWrite(buffer?: SharedArrayBuffer): () => void {
  if (!buffer) return () => undefined;
  const gate = new Int32Array(buffer);
  if (Atomics.load(gate, 0) === owner) return () => undefined;
  for (;;) {
    const current = Atomics.compareExchange(gate, 0, 0, owner);
    if (!current) break;
    Atomics.wait(gate, 0, current);
  }
  return () => releaseIndexWrite(buffer, owner);
}

export function withIndexWrite<T>(buffer: SharedArrayBuffer | undefined, write: () => T): T {
  const release = acquireIndexWrite(buffer);
  try { return write(); }
  finally { release(); }
}

/** 管理线程异步等候，仍能接收 Worker 退出事件并回收写权限。 */
export async function withIndexWriteAsync<T>(buffer: SharedArrayBuffer | undefined, write: () => T | Promise<T>): Promise<T> {
  if (!buffer) return write();
  const gate = new Int32Array(buffer);
  if (Atomics.load(gate, 0) === owner) return write();
  for (;;) {
    const current = Atomics.compareExchange(gate, 0, 0, owner);
    if (!current) break;
    await Atomics.waitAsync(gate, 0, current).value;
  }
  try { return await write(); }
  finally { releaseIndexWrite(buffer, owner); }
}

/** 线程退出并释放原生连接后，回收它尚未交还的写权限。 */
export function releaseIndexWrite(buffer: SharedArrayBuffer | undefined, previousOwner: number): void {
  if (!buffer) return;
  const gate = new Int32Array(buffer);
  if (Atomics.compareExchange(gate, 0, previousOwner, 0) === previousOwner) Atomics.notify(gate, 0);
}

/** 空闲维护不等待写者，避免维护等待挡住随后到达的地图任务。 */
export function tryIndexWrite<T>(buffer: SharedArrayBuffer | undefined, write: () => T): T | undefined {
  if (!buffer) return write();
  const gate = new Int32Array(buffer);
  if (Atomics.compareExchange(gate, 0, 0, owner)) return undefined;
  try { return write(); }
  finally { releaseIndexWrite(buffer, owner); }
}

/** 仅用于后台可写连接；读语句和显式只读快照不获取写权限。 */
export function coordinateIndexWrites(database: Database.Database, buffer?: SharedArrayBuffer): void {
  if (!buffer) return;
  const prepare = database.prepare.bind(database), exec = database.exec.bind(database), transaction = database.transaction.bind(database);
  database.prepare = ((...args: Parameters<typeof prepare>) => {
    const statement = prepare(...args);
    if (!statement.readonly) {
      for (const method of ["run", "get", "all"] as const) {
        const execute = statement[method].bind(statement);
        Object.defineProperty(statement, method, { value: (...values: unknown[]) => withIndexWrite(buffer, () => Reflect.apply(execute, statement, values)) });
      }
      const iterate = statement.iterate.bind(statement);
      Object.defineProperty(statement, "iterate", { value: function*(...values: unknown[]) {
        const release = acquireIndexWrite(buffer);
        try { yield* Reflect.apply(iterate, statement, values); }
        finally { release(); }
      } });
    }
    return statement;
  }) as typeof database.prepare;
  database.exec = sql => withIndexWrite(buffer, () => exec(sql));
  database.transaction = ((fn: (...args: unknown[]) => unknown) => {
    const original = transaction(fn);
    const wrap = (execute: (...args: unknown[]) => unknown) => function(this: unknown, ...args: unknown[]) {
      return withIndexWrite(buffer, () => Reflect.apply(execute, this, args));
    };
    // 本仓库显式 deferred 只用于只读快照，继续允许它在 WAL 写入期间读取。
    const modes = { default: wrap(original), deferred: function(this: unknown, ...args: unknown[]) { return Reflect.apply(original.deferred, this, args); },
      immediate: wrap(original.immediate), exclusive: wrap(original.exclusive) };
    const properties = Object.fromEntries(Object.entries({ ...modes, database }).map(([key, value]) => [key, { value }]));
    for (const mode of Object.values(modes)) Object.defineProperties(mode, properties);
    return modes.default;
  }) as typeof database.transaction;
}
