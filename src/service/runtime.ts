import { DiagnosticError } from "../i18n/diagnostics.js";
import type { MessageDescriptor } from "../i18n/types.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiErrorResponse, ServiceInstance, StatusResponse } from "../contracts.js";

export const delay = (milliseconds: number): Promise<void> => new Promise((done) => setTimeout(done, milliseconds));
export const dataHome = (home?: string): string => resolve(home ?? process.env.AGENT_MANOR_HOME ?? join(homedir(), ".agent-manor"));
const runtimePath = (home: string) => join(home, "service.json");
interface LockOwner { pid: number; nonce: string }

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readInstance(home: string): Promise<ServiceInstance | undefined> {
  try {
    const value = JSON.parse(await readFile(runtimePath(home), "utf8")) as ServiceInstance;
    if (!value || typeof value.id !== "string" || value.id.length < 16 || value.host !== "127.0.0.1"
      || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 || !Number.isSafeInteger(value.pid)) return undefined;
    return value;
  } catch { return undefined; }
}

export const serviceUrl = (instance: ServiceInstance): string => `http://127.0.0.1:${instance.port}`;

export async function verifiedInstance(home: string): Promise<ServiceInstance | undefined> {
  const instance = await readInstance(home);
  if (!instance || !alive(instance.pid)) return undefined;
  try {
    const response = await fetch(`${serviceUrl(instance)}/api/v1/status`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return undefined;
    const status = await response.json() as StatusResponse;
    return status.instance.id === instance.id && status.instance.pid === instance.pid
      && status.instance.port === instance.port && status.instance.host === instance.host ? instance : undefined;
  } catch { return undefined; }
}

/** 锁只凭死亡的 owner 或已过期的未初始化目录回收，从不终止锁中 PID。 */
export async function acquireLock(home: string, name: string, waitMilliseconds = 0): Promise<() => Promise<void>> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, name);
  const owner: LockOwner = { pid: process.pid, nonce: randomUUID() };
  const deadline = Date.now() + waitMilliseconds;
  for (;;) {
    try {
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
      return async () => {
        try {
          const current = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as LockOwner;
          if (current.nonce === owner.nonce && current.pid === owner.pid) await rm(path, { recursive: true });
        } catch { /* 不移除其他实例的锁。 */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const current = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as LockOwner;
        stale = typeof current.nonce === "string" && Number.isSafeInteger(current.pid) && !alive(current.pid);
      } catch {
        try { stale = Date.now() - (await stat(path)).mtimeMs > 30_000; } catch { continue; }
      }
      if (stale) {
        // 回收者在旧锁内互斥，再核验 owner；防止延迟回收者改名新建的活锁。
        const reaper = join(path, "reaper");
        let originalMtime: number;
        try {
          originalMtime = (await stat(path)).mtimeMs;
          await mkdir(reaper);
          await writeFile(join(reaper, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
        } catch {
          try {
            const current = JSON.parse(await readFile(join(reaper, "owner.json"), "utf8")) as LockOwner;
            if (Number.isSafeInteger(current.pid) && !alive(current.pid)) await rm(reaper, { recursive: true });
          } catch { /* 回收目录仍在初始化时等待。 */ }
          if (Date.now() >= deadline) throw new DiagnosticError("另一个服务实例正在回收启动锁", { key: "diagnostics.service.runtime.m001" });
          await delay(100);
          continue;
        }
        let moved = false;
        try {
          let stillStale = false;
          try {
            const current = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as LockOwner;
            stillStale = typeof current.nonce === "string" && Number.isSafeInteger(current.pid) && !alive(current.pid);
          } catch { stillStale = Date.now() - originalMtime > 30_000; }
          if (stillStale) {
            const retired = `${path}.stale-${randomUUID()}`;
            await rename(path, retired);
            moved = true;
            await rm(retired, { recursive: true });
          }
        } catch { /* 旧锁已由其他进程移除。 */ }
        finally { if (!moved) await rm(reaper, { recursive: true, force: true }); }
        continue;
      }
      if (Date.now() >= deadline) throw new DiagnosticError("另一个服务实例正在启动或运行", { key: "diagnostics.service.runtime.m002" });
      await delay(100);
    }
  }
}

export async function writeInstance(home: string, instance: ServiceInstance): Promise<void> {
  const temporary = `${runtimePath(home)}.${instance.id}.tmp`;
  await writeFile(temporary, JSON.stringify(instance), { mode: 0o600 });
  await rename(temporary, runtimePath(home));
}

export async function removeInstance(home: string, instance: ServiceInstance): Promise<void> {
  if ((await readInstance(home))?.id === instance.id) await rm(runtimePath(home), { force: true });
}

export async function connectService(autoStart = true, home = dataHome()): Promise<ServiceInstance | undefined> {
  const existing = await verifiedInstance(home);
  if (existing || !autoStart) return existing;
  const release = await acquireLock(home, "startup.lock", 20_000);
  try {
    const ready = await verifiedInstance(home);
    if (ready) return ready;
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const cliPath = fileURLToPath(new URL(`../cli.${extension}`, import.meta.url));
    const args = extension === "ts" ? ["--import", fileURLToPath(import.meta.resolve("tsx/esm")), cliPath, "--lang", "auto", "serve"] : [cliPath, "--lang", "auto", "serve"];
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", cwd: dirname(cliPath), env: { ...process.env, AGENT_MANOR_HOME: home } });
    let failure: Error | undefined;
    child.once("error", (error) => { failure = error; });
    child.unref();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const instance = await verifiedInstance(home);
      if (instance) return instance;
      if (child.exitCode !== null) throw new DiagnosticError(`本地后台启动失败（${child.exitCode}）`, { key: "diagnostics.service.runtime.m003", params: { p0: String(child.exitCode) } });
      await delay(100);
    }
    throw new DiagnosticError("本地后台启动超时，请运行 agent-manor serve 查看错误", { key: "diagnostics.service.runtime.m004" });
  } finally { await release(); }
}

export class RequestError extends Error {
  constructor(readonly code: string, message: string, readonly messageDescriptor?: MessageDescriptor) { super(message); }
}

export async function apiRequest<T>(instance: ServiceInstance, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${serviceUrl(instance)}/api/v1${path}`, {
    method, headers: { "x-agent-manor-instance": instance.id, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json() as T | ApiErrorResponse;
  if (!response.ok) {
    const error = data as ApiErrorResponse;
    throw new RequestError(error.error.code, error.error.message, error.error.messageDescriptor);
  }
  return data as T;
}
