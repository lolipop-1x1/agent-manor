import { DiagnosticError } from "../i18n/diagnostics.js";
import type { MessageDescriptor } from "../i18n/types.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiErrorResponse, ServiceInstance, StatusResponse } from "../contracts.js";
import { activeIndexMaintenance } from "../index/maintenance.js";
import { VERSION } from "../version.js";
import { acquireInstallationOperation, assertInstalledVersion, installationContext, registerInstallationService } from "./installation.js";
import { serviceLog, serviceLogPath } from "./logging.js";

export { serviceLogPath } from "./logging.js";
export const SERVICE_PROTOCOL_VERSION = 1;
export const DEFAULT_SERVICE_PORT = 16666;

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
    if (value.controlPort !== undefined && (!Number.isSafeInteger(value.controlPort) || value.controlPort < 1 || value.controlPort > 65535)) return undefined;
    return value;
  } catch { return undefined; }
}

export const serviceUrl = (instance: ServiceInstance): string => `http://127.0.0.1:${instance.port}`;

export async function verifiedInstance(home: string): Promise<ServiceInstance | undefined> {
  return (await serviceStatus(home, { summary: true })).instance;
}

export interface LocalServiceStatus {
  running: boolean;
  state: "running" | "stopped" | "starting" | "unreachable" | "foreign";
  instance?: ServiceInstance;
  status?: StatusResponse;
  logPath: string;
  stage?: string;
}

/** 状态检查不建目录、不获取锁，也不启动服务或后台任务。 */
export async function serviceStatus(home = dataHome(), options: { summary?: boolean } = {}): Promise<LocalServiceStatus> {
  const base = { running: false, logPath: serviceLogPath(home) };
  const instance = await readInstance(home);
  if (!instance || !alive(instance.pid)) {
    for (const name of ["startup.lock", "service.lock"]) {
      try {
        const owner = JSON.parse(await readFile(join(home, name, "owner.json"), "utf8")) as LockOwner;
        if (alive(owner.pid)) return { ...base, state: "starting" };
      } catch { /* 不存在或失效的锁不表示正在启动。 */ }
    }
    return { ...base, state: "stopped" };
  }
  try {
    const response = await fetch(`${serviceUrl(instance)}/api/v1/status?summary=true${options.summary ? "&response=summary" : ""}`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return { ...base, state: "unreachable" };
    const status = await response.json() as StatusResponse;
    if (status.instance?.id !== instance.id || status.instance.pid !== instance.pid || status.instance.port !== instance.port
      || status.instance.host !== instance.host) return { ...base, state: "foreign" };
    return { ...base, running: true, state: "running", instance: { ...instance, version: status.version, protocolVersion: status.protocolVersion }, status };
  } catch { return { ...base, state: "unreachable" }; }
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
      if (Date.now() >= deadline && !(name === "startup.lock" && waitMilliseconds > 0 && await activeIndexMaintenance(home))) throw new DiagnosticError("另一个服务实例正在启动或运行", { key: "diagnostics.service.runtime.m002" });
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

export async function connectService(autoStart = true, home = dataHome(), options: { noUpdateCheck?: boolean } = {}): Promise<ServiceInstance | undefined> {
  if (!autoStart) return verifiedInstance(home);
  return startBackground(home, options);
}

export interface BackgroundOptions {
  port?: number;
  waitData?: boolean | "initial";
  timeoutMs?: number;
  onProgress?: (status: StatusResponse) => void;
  noUpdateCheck?: boolean;
}

export function validateServicePort(port?: number): void {
  const environment = process.env.AGENT_MANOR_PORT;
  const value = port ?? (environment === undefined ? DEFAULT_SERVICE_PORT : environment.trim() ? Number(environment) : NaN);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new RequestError("INVALID_INPUT", "Port must be an integer from 0 to 65535", { key: "diagnostics.server.m001" });
}

export async function assertNotUpdating(home: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(join(home, "update.lock", "owner.json"), "utf8")) as LockOwner;
    if (alive(owner.pid)) throw new RequestError("SERVICE_BUSY", "程序正在更新，请稍后再执行查询或启动", { key: "diagnostics.service.runtime.updating" });
  } catch (error) { if (error instanceof RequestError) throw error; }
}

export function assertServiceCompatible(status: StatusResponse): void {
  if (status.version !== VERSION || status.protocolVersion !== SERVICE_PROTOCOL_VERSION) {
    throw new RequestError("SERVICE_VERSION_MISMATCH", "后台版本与当前程序不同，请显式重启或更新后台", { key: "diagnostics.service.runtime.versionMismatch", params: { version: status.version, expected: VERSION } });
  }
}

export async function startBackground(home = dataHome(), options: BackgroundOptions = {}): Promise<ServiceInstance> {
  validateServicePort(options.port);
  await assertNotUpdating(home);
  let startupRelease: (() => Promise<void>) | undefined;
  const prepare = async (instance: ServiceInstance, status: StatusResponse) => {
    // 监听地址和身份已确认，后续长时间数据等待不能继续占用启动锁。
    await startupRelease?.(); startupRelease = undefined;
    const initial = status.preparation?.initial ?? !status.sessions?.version;
    if (options.waitData === true || options.waitData === "initial" && initial) {
      await waitForPreparation(instance, options.timeoutMs ?? (initial ? Infinity : 120_000), { summary: true, onProgress: options.onProgress });
    }
  };
  const reuse = async (): Promise<ServiceInstance | undefined> => {
    const current = await serviceStatus(home, { summary: true });
    if (current.running) {
      assertServiceCompatible(current.status!);
      await prepare(current.instance!, current.status!);
      return current.instance;
    }
    if (current.state === "foreign" || current.state === "unreachable") throw new RequestError("SERVICE_IDENTITY_UNVERIFIED", "已有实例尚未通过身份检查，未启动另一个服务", { key: "diagnostics.service.runtime.identity" });
    return undefined;
  };
  const existing = await reuse();
  if (existing) return existing;
  const release = await acquireLock(home, "startup.lock", 20_000);
  startupRelease = release;
  try {
    await assertNotUpdating(home);
    const ready = await reuse();
    if (ready) return ready;
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const cliPath = fileURLToPath(new URL(`../cli.${extension}`, import.meta.url));
    const args = extension === "ts" ? ["--import", fileURLToPath(import.meta.resolve("tsx/esm")), cliPath, "--lang", "auto", "serve"] : [cliPath, "--lang", "auto", "serve"];
    if (options.port !== undefined) args.push("--port", String(options.port));
    if (options.noUpdateCheck) args.push("--no-update-check");
    const installation = await installationContext();
    const releaseInstallation = await acquireInstallationOperation(installation);
    let reservation: Awaited<ReturnType<typeof registerInstallationService>> | undefined;
    let child: ReturnType<typeof spawn>;
    let failure: Error | undefined;
    let exited = false;
    try {
      await assertInstalledVersion(installation);
      reservation = await registerInstallationService(installation, home);
      serviceLog(home, "background.start", { version: VERSION, port: options.port ?? DEFAULT_SERVICE_PORT });
      child = spawn(process.execPath, args, { detached: true, stdio: "ignore", cwd: dirname(cliPath), env: { ...process.env, AGENT_MANOR_HOME: home, AGENT_MANOR_INSTALLATION_RESERVATION: reservation.nonce } });
      child.once("error", error => { failure = error; });
      child.once("exit", () => { exited = true; });
      if (child.pid !== undefined) await reservation.transfer(child.pid);
      else await reservation.remove();
    } catch (error) { await reservation?.remove(); throw error; }
    finally { await releaseInstallation(); }
    child.unref();
    const deadline = Date.now() + (options.timeoutMs ?? 20_000);
    while (Date.now() < deadline || await activeIndexMaintenance(home, child.pid)) {
      if (failure) throw failure;
      const instance = await verifiedInstance(home);
      if (instance) {
        const status = await apiRequest<StatusResponse>(instance, "/status?summary=true&response=summary");
        assertServiceCompatible(status);
        await prepare(instance, status);
        return instance;
      }
      if (exited) throw new DiagnosticError(`本地后台启动失败（${child.exitCode}），日志：${serviceLogPath(home)}`, { key: "diagnostics.service.runtime.startFailed", params: { code: String(child.exitCode), path: serviceLogPath(home) } });
      await delay(100);
    }
    throw new DiagnosticError("本地后台启动超时，请运行 agent-manor serve 查看错误", { key: "diagnostics.service.runtime.m004" });
  } finally { await release(); }
}

export async function waitForPreparation(instance: ServiceInstance, timeoutMs = 120_000, options: { summary?: boolean; onProgress?: (status: StatusResponse) => void } = {}): Promise<StatusResponse> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await apiRequest<StatusResponse>(instance, `/status?summary=true${options.summary ? "&response=summary" : ""}`);
    assertServiceCompatible(status);
    if (!status.preparation) throw new RequestError("SERVICE_VERSION_MISMATCH", "后台不支持启动准备状态", { key: "diagnostics.service.runtime.versionMismatch", params: { version: status.version, expected: VERSION } });
    options.onProgress?.(status);
    if (status.preparation.state === "failed") throw new RequestError("PREPARATION_FAILED", status.preparation.error ?? "启动数据准备失败", {
      key: "diagnostics.service.runtime.preparationFailedDetails", params: { phase: status.preparation.phase, reason: status.preparation.error ?? "unknown" },
    });
    if (["ready", "skipped"].includes(status.preparation.state)) return status;
    if (Date.now() >= deadline) throw new RequestError("WAIT_TIMEOUT", "等待数据准备超时，后台仍继续运行", { key: "diagnostics.service.runtime.waitTimeout" });
    await delay(100);
  }
}

async function serviceControl(instance: ServiceInstance, path: "/status" | "/stop"): Promise<ServiceInstance> {
  try {
    const response = await fetch(`http://127.0.0.1:${instance.controlPort}${path}`, {
      method: path === "/stop" ? "POST" : "GET", headers: { "x-agent-manor-instance": instance.id }, signal: AbortSignal.timeout(1000),
    });
    const result = await response.json() as { instance?: ServiceInstance };
    const verified = result.instance;
    if (!response.ok || !verified || verified.id !== instance.id || verified.pid !== instance.pid || verified.host !== instance.host
      || verified.port !== instance.port || verified.startedAt !== instance.startedAt) throw new Error("Service control identity mismatch");
    return verified;
  } catch { throw new RequestError("SERVICE_IDENTITY_UNVERIFIED", "服务身份尚未核验，未停止任何进程", { key: "diagnostics.service.runtime.identity" }); }
}

export async function stopService(home = dataHome(), options: { timeoutMs?: number; wait?: boolean; allowBusy?: boolean } = {}): Promise<{ stopped: boolean; instance?: ServiceInstance }> {
  const allowBusy = options.allowBusy ?? !options.wait;
  const deadline = Date.now() + (options.timeoutMs ?? (allowBusy ? 5000 : 30_000));
  const recorded = await readInstance(home);
  let controlled: ServiceInstance | undefined;
  if (allowBusy && recorded?.controlPort && alive(recorded.pid)) {
    try { controlled = await serviceControl(recorded, "/status"); }
    catch { /* 控制线程失联时只能通过主 HTTP 重新核验身份，不能据磁盘记录终止进程。 */ }
  }
  let instance: ServiceInstance;
  if (controlled) {
    instance = { ...recorded!, version: controlled.version, protocolVersion: controlled.protocolVersion };
  } else {
    const initial = await serviceStatus(home, { summary: true });
    if (!initial.running) {
      if (initial.state !== "stopped") throw new RequestError("SERVICE_IDENTITY_UNVERIFIED", "服务身份尚未核验，未停止任何进程", { key: "diagnostics.service.runtime.identity" });
      return { stopped: false };
    }
    instance = initial.instance!;
    let current = initial;
    while (!allowBusy && (current.status?.activeTasks?.length || ["pending", "running"].includes(current.status?.preparation?.state ?? ""))) {
      if (!options.wait) throw new RequestError("SERVICE_BUSY", "后台仍有任务运行，请等待任务完成后停止", { key: "diagnostics.service.runtime.busy" });
      if (Date.now() >= deadline) throw new RequestError("WAIT_TIMEOUT", "等待任务结束超时，后台仍继续运行", { key: "diagnostics.service.runtime.waitTimeout" });
      await delay(100);
      current = await serviceStatus(home, { summary: true });
      if (!current.running || current.instance?.id !== instance.id) throw new RequestError("SERVICE_IDENTITY_UNVERIFIED", "等待期间服务实例发生变化", { key: "diagnostics.service.runtime.identity" });
    }
  }
  if (instance.protocolVersion !== SERVICE_PROTOCOL_VERSION) throw new RequestError("SERVICE_VERSION_MISMATCH", "旧后台不支持安全停止协议", { key: "diagnostics.service.runtime.versionMismatch", params: { version: instance.version ?? "unknown", expected: VERSION } });
  const stopHttp = (target: ServiceInstance) => apiRequest(target, "/stop", "POST", allowBusy ? { allowBusy: true } : undefined,
    {}, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
  let stopFailure: unknown;
  try {
    if (controlled) {
      try { await serviceControl(instance, "/stop"); }
      catch (error) {
        if (!alive(instance.pid)) { await removeInstance(home, instance); return { stopped: true, instance }; }
        const current = await serviceStatus(home, { summary: true });
        if (!current.running || current.instance?.id !== instance.id) throw error;
        await stopHttp(current.instance);
      }
    } else await stopHttp(instance);
  } catch (error) {
    if (error instanceof RequestError && error.code !== "SERVICE_IDENTITY_UNVERIFIED") throw error;
    // 并发停止可能先关闭连接；只有确认目标已退出后才把连接中断视为停止成功。
    stopFailure = error;
  }
  for (;;) {
    // HTTP 完全关闭且实例记录移除后，才向调用者报告停止完成。
    const record = await readInstance(home);
    if (record?.id !== instance.id && !instance.controlPort) return { stopped: true, instance };
    if (!alive(instance.pid)) { await removeInstance(home, instance); return { stopped: true, instance }; }
    if (Date.now() >= deadline) throw stopFailure ?? new RequestError("STOP_TIMEOUT", "服务仍在停止，请查看状态和日志", { key: "diagnostics.service.runtime.stopTimeout" });
    await delay(100);
  }
}

export async function readServiceLogs(home = dataHome(), options: { lines?: number } = {}): Promise<{ path: string; text: string }> {
  const path = serviceLogPath(home), lines = options.lines ?? 100;
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > 10000) throw new RequestError("INVALID_INPUT", "日志行数必须是 1 到 10000 的整数", { key: "diagnostics.service.runtime.logLines" });
  let file;
  try { file = await open(path, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, text: "" }; throw error; }
  try {
    const size = (await file.stat()).size, length = Math.min(size, 2 * 1024 * 1024), buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const rows = buffer.toString("utf8").trimEnd().split("\n");
    if (length < size) rows.shift();
    return { path, text: rows.slice(-lines).join("\n") };
  } finally { await file.close(); }
}

export class RequestError extends Error {
  constructor(readonly code: string, message: string, readonly messageDescriptor?: MessageDescriptor) { super(message); }
}

export async function apiRequest<T>(instance: ServiceInstance, path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${serviceUrl(instance)}/api/v1${path}`, {
    method, headers: { ...headers, "x-agent-manor-instance": instance.id, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: signal ?? AbortSignal.timeout(30_000),
  });
  const data = await response.json() as T | ApiErrorResponse;
  if (!response.ok) {
    const error = data as ApiErrorResponse;
    throw new RequestError(error.error.code, error.error.message, error.error.messageDescriptor);
  }
  return data as T;
}
