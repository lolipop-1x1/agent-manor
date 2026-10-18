import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const serviceLogPath = (home: string): string => join(home, "logs", "service.log");
const sleeper = new Int32Array(new SharedArrayBuffer(4));
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function owner(path: string): { pid: number; nonce: string } | undefined {
  try { return JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { pid: number; nonce: string }; } catch { return; }
}
/** 轮换和追加共享同一跨进程锁；日志竞争或磁盘失败不能阻断服务清理。 */
function logLock(directory: string): (() => void) | undefined {
  const path = join(directory, ".write.lock"), nonce = randomUUID(), deadline = Date.now() + 1000;
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
      return () => { if (owner(path)?.nonce === nonce) rmSync(path, { recursive: true, force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
      const previous = owner(path);
      let stale = previous && !alive(previous.pid);
      if (!previous) { try { stale = Date.now() - statSync(path).mtimeMs > 30_000; } catch { continue; } }
      if (stale) {
        const reaper = join(path, "reaper"); let moved = false, acquired = false;
        try {
          mkdirSync(reaper); acquired = true;
          const current = owner(path);
          const unchanged = previous ? current?.nonce === previous.nonce && !alive(current.pid) : !current && Date.now() - statSync(path).mtimeMs > 30_000;
          if (unchanged) {
            const retired = `${path}.stale-${nonce}`;
            renameSync(path, retired); moved = true; rmSync(retired, { recursive: true, force: true });
          }
        } catch { /* 其他进程正在回收时，保守等待而不碰新锁。 */ }
        finally { if (acquired && !moved) { try { rmSync(reaper, { recursive: true, force: true }); } catch { /* 日志尽力写入。 */ } } }
        if (moved) continue;
      }
      if (Date.now() >= deadline) return;
      Atomics.wait(sleeper, 0, 0, 5);
    }
  }
}
function renameIfPresent(from: string, to: string): void {
  try { renameSync(from, to); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** 日志只接受生命周期元信息，不传入会话正文、请求体或模型凭据。 */
export function serviceLog(home: string, event: string, details: Record<string, unknown> = {}, maxBytes = 10 * 1024 * 1024): void {
  let release: (() => void) | undefined;
  try {
    const directory = join(home, "logs"), path = serviceLogPath(home);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    release = logLock(directory);
    if (!release) return;
    const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`;
    let size = 0;
    try { size = statSync(path).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (size && size + Buffer.byteLength(line) > maxBytes) {
      rmSync(`${path}.4`, { force: true });
      for (let index = 3; index >= 1; index--) renameIfPresent(`${path}.${index}`, `${path}.${index + 1}`);
      renameIfPresent(path, `${path}.1`);
    }
    appendFileSync(path, line, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch { /* 日志失败不改变启动、关闭、任务状态或实例清理结果。 */ }
  finally { try { release?.(); } catch { /* 不因日志锁清理失败阻断生命周期。 */ } }
}
