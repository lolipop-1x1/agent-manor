import { execFile } from "node:child_process";
import { appendFile, cp, lstat, mkdir, readFile, readdir, statfs, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, sep } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { satisfies } from "semver";
import { VERSION } from "../../../../src/version.js";
import type { StatusResponse } from "../../../../src/contracts.js";
import { acquireInstallationOperation, assertInstalledVersion, canonicalHome, installationContext, listInstallationServices } from "../../../../src/service/installation.js";
import { detectInstallation, npmCommand, productRoot, type Installation, type CommandResult } from "../../../../src/service/product-installation.js";
import { ReleaseService, compareVersions, stableVersion } from "../../../../src/service/releases.js";
import type { ReleaseStatus } from "../../../../src/updates/contracts.js";
import { acquireLock, delay, RequestError, serviceStatus, stopService } from "../../../../src/service/runtime.js";

export { detectInstallation, productRoot } from "../../../../src/service/product-installation.js";
export type { Installation } from "../../../../src/service/product-installation.js";
const run = promisify(execFile), registry = "https://registry.npmjs.org/";
export type UpdatePhase = "preflight" | "backup" | "install" | "restart" | "complete";
export interface UpdateOptions { home: string; target?: string; check?: boolean; dryRun?: boolean; yes?: boolean; wait?: boolean; timeoutMs?: number; noUpdateCheck?: boolean }
export interface UpdatePreview {
  cancelled?: boolean;
  currentVersion: string; targetVersion: string; updateAvailable: boolean; installation: Installation;
  home: string; backup: string; estimatedBackupBytes: number; availableBytes: number;
  service: { running: boolean; port?: number; activeTasks: number }; otherServices: { home: string; pid: number; state: string; stopCommand: string }[];
  blockers: { code: string; message: string; messageDescriptor: { key: string } }[];
  dependencyFiles: string[];
}
export interface UpdateDependencies {
  root?: string; configBase?: string; fetch?: typeof globalThis.fetch;
  command?: (args: string[], cwd?: string, signal?: AbortSignal) => Promise<CommandResult>;
  status?: typeof serviceStatus; stop?: typeof stopService;
  restart?: (root: string, home: string, options?: { port?: number; noUpdateCheck?: boolean; waitData: true }) => Promise<unknown>;
  restartCommand?: (args: string[], options: { timeout: number; signal: AbortSignal }) => Promise<CommandResult>;
  backup?: (home: string, target: string, destination: string) => Promise<string>;
  space?: (directory: string) => Promise<number>;
  confirm?: (preview: UpdatePreview) => Promise<boolean>;
  progress?: (phase: UpdatePhase, status?: StatusResponse) => void;
  signal?: AbortSignal;
}
export interface UpdateResult extends Omit<UpdatePreview, "service"> {
  updated: boolean; logPath?: string; service?: unknown;
  installationState: "installed"; serviceState: "ready" | "not_running"; preparationState: "ready" | "not_started";
}
const exclusions = ["service.json", "service.lock", "startup.lock", "update.lock", "logs"];
async function backupBytes(directory: string, top = true): Promise<number> {
  let names: string[];
  try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  let total = 0;
  for (const name of names) {
    if (top && exclusions.includes(name)) continue;
    const path = join(directory, name), entry = await lstat(path);
    total += entry.isDirectory() ? await backupBytes(path, false) : entry.size;
  }
  return total;
}
async function availableBytes(directory: string): Promise<number> {
  const space = await statfs(directory); return space.bavail * space.bsize;
}
async function backupData(home: string, target: string, backup: string): Promise<string> {
  await mkdir(backup, { recursive: true, mode: 0o700 });
  let exists = true;
  try { await lstat(home); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; exists = false; }
  if (exists) await cp(home, join(backup, "data"), { recursive: true, verbatimSymlinks: true, filter: source => !exclusions.includes(source.slice(home.length + 1).split(sep)[0] ?? "") });
  else await mkdir(join(backup, "data"), { recursive: true, mode: 0o700 });
  await writeFile(join(backup, "manifest.json"), JSON.stringify({ fromVersion: VERSION, targetVersion: target, createdAt: new Date().toISOString() }), { mode: 0o600 });
  return backup;
}
function failure(code: string, message: string, key: string, details?: unknown): RequestError {
  const error = new RequestError(code, message, { key }); if (details) Object.assign(error, { details }); return error;
}
export function updateStopCommand(home: string, platform = process.platform): string {
  return `am --home '${home.replaceAll("'", platform === "win32" ? "''" : "'\\''")}' stop`;
}
function manifestExceptProduct(text: string): Record<string, unknown> {
  const result = JSON.parse(text) as Record<string, unknown>;
  for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
    if (result[group] && typeof result[group] === "object") {
      const dependencies = { ...result[group] as Record<string, unknown> }; delete dependencies["agent-manor"];
      result[group] = dependencies;
    }
  }
  return result;
}
function assertProductDependency(text: string, version: string): void {
  const manifest = JSON.parse(text) as Record<string, Record<string, unknown> | undefined>;
  const ranges = ["dependencies", "devDependencies", "optionalDependencies"].flatMap(group => typeof manifest[group]?.["agent-manor"] === "string" ? [manifest[group]!["agent-manor"] as string] : []);
  if (!ranges.length || ranges.some(range => !satisfies(version, range))) throw new Error("The local package manifest does not select the confirmed product version");
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function assertLockFile(text: string, manifestText: string, version: string): void {
  const lock: unknown = JSON.parse(text), manifest = JSON.parse(manifestText) as Record<string, unknown>;
  if (!object(lock) || lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3 || !object(lock.packages)
    || !object(lock.packages[""]) || !object(lock.packages["node_modules/agent-manor"])) throw new Error("The local npm lock file has an unsupported or incomplete structure");
  const root = lock.packages[""], product = lock.packages["node_modules/agent-manor"];
  if (product.version !== version || product.link === true) throw new Error("The local npm lock file does not pin the confirmed product version");
  for (const key of ["name", "version"]) if (manifest[key] !== undefined && (root[key] !== manifest[key] || lock[key] !== undefined && lock[key] !== manifest[key])) throw new Error("The local npm lock file root does not match the project manifest");
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
    if (!isDeepStrictEqual(root[key] ?? {}, manifest[key] ?? {})) throw new Error("The local npm lock file dependencies do not match the project manifest");
  }
  if (lock.lockfileVersion === 2 && (!object(lock.dependencies) || !object(lock.dependencies["agent-manor"]) || lock.dependencies["agent-manor"].version !== version)) throw new Error("The legacy npm lock index does not pin the confirmed product version");
}
function statusFingerprint(status: Awaited<ReturnType<typeof serviceStatus>>): string {
  return JSON.stringify({ running: status.running, state: status.state, id: status.instance?.id, port: status.instance?.port });
}
function releaseError(status: ReleaseStatus): never {
  const error = status.error;
  throw new RequestError(error?.code ?? "UPDATE_UNAVAILABLE", error?.message ?? "No valid release metadata", error?.messageDescriptor ?? { key: "cli.update.unavailable" });
}
export async function updateProduct(options: UpdateOptions, dependencies: UpdateDependencies = {}): Promise<ReleaseStatus | UpdatePreview | UpdateResult> {
  const target = options.target ?? "latest";
  if (target !== "latest" && !stableVersion(target)) throw failure("INVALID_INPUT", "Expected an exact stable version or latest", "cli.update.invalidVersion");
  const root = dependencies.root ?? await productRoot(), command = dependencies.command ?? npmCommand;
  const installation = await detectInstallation(root, command);
  const releases = new ReleaseService({ root, home: options.home, configBase: dependencies.configBase, fetch: dependencies.fetch, installation });
  const checked = await releases.check({ target });
  if (checked.checkState !== "ready" || !checked.latestVersion) releaseError(checked);
  if (options.check) return checked;
  const version = checked.latestVersion;
  if (compareVersions(version, VERSION) < 0) throw failure("DOWNGRADE_UNSUPPORTED", "Downgrades are not supported", "cli.update.downgrade");
  const context = await installationContext(root), status = await (dependencies.status ?? serviceStatus)(options.home);
  const selectedHome = await canonicalHome(options.home);
  const registrations = await listInstallationServices(context);
  const others = registrations.filter(item => item.home !== selectedHome);
  const backup = `${options.home}.backups/update-${Date.now()}-${randomUUID()}`;
  const estimatedBackupBytes = await backupBytes(options.home);
  const free = await (dependencies.space ?? availableBytes)(dirname(options.home));
  const blockers: UpdatePreview["blockers"] = [];
  const block = (code: string, message: string, key: string) => blockers.push({ code, message, messageDescriptor: { key } });
  if (!checked.selfUpdateSupported) block("INSTALLATION_UNSUPPORTED", "A persistent npm installation is required", "cli.update.persistentRequired");
  if (!checked.compatibility.compatible) block("UPDATE_INCOMPATIBLE", checked.compatibility.reason ?? "Release is incompatible", "cli.update.incompatible");
  if (others.length) block("SERVICE_BUSY", "Other data directories are using this installation", "diagnostics.service.runtime.busy");
  if (status.state === "starting" || registrations.some(item => item.home === selectedHome && item.state === "starting")) block("SERVICE_BUSY", "The selected service is starting", "diagnostics.service.runtime.busy");
  if (!status.running && ["unreachable", "foreign"].includes(status.state)) block("SERVICE_IDENTITY_UNVERIFIED", "The selected service identity cannot be verified", "diagnostics.service.runtime.identity");
  const activeTasks = (status.status?.activeTasks?.length ?? 0) + (["pending", "running"].includes(status.status?.preparation?.state ?? "") ? 1 : 0);
  if (activeTasks && !options.wait) block("SERVICE_BUSY", "The selected service has active tasks; pass --wait to wait", "diagnostics.service.runtime.busy");
  if (free < estimatedBackupBytes) block("UPDATE_SPACE_INSUFFICIENT", "Insufficient space for the data backup", "cli.update.spaceInsufficient");
  const dependencyFiles: string[] = [];
  const dependencySnapshots = new Map<string, string>();
  if (installation.kind === "local") for (const name of ["package.json", "package-lock.json", "npm-shrinkwrap.json"]) {
    const path = join(installation.prefix!, name);
    try { const contents = await readFile(path, "utf8"); dependencyFiles.push(path); dependencySnapshots.set(path, contents); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const preview: UpdatePreview = { currentVersion: VERSION, targetVersion: version, updateAvailable: compareVersions(version, VERSION) > 0,
    installation, home: options.home, backup, estimatedBackupBytes, availableBytes: free,
    service: { running: status.running, ...(status.instance?.port ? { port: status.instance.port } : {}), activeTasks },
    otherServices: others.map(item => ({ home: item.home, pid: item.pid, state: item.state, stopCommand: updateStopCommand(item.home) })), blockers, dependencyFiles };
  if (options.dryRun || !preview.updateAvailable) return preview;
  if (blockers.length) { const first = blockers[0]!; throw failure(first.code, first.message, first.messageDescriptor.key, { preview, services: preview.otherServices }); }
  if (!options.yes) {
    if (!dependencies.confirm) throw failure("CONFIRMATION_REQUIRED", "Review the update preview and explicitly confirm installation", "cli.update.confirmationRequired", { preview });
    if (!await dependencies.confirm(preview)) return { ...preview, cancelled: true };
  }
  dependencies.progress?.("preflight");
  const releaseInstallation = await acquireInstallationOperation(context);
  const cancellation = new AbortController();
  const interrupt = () => { cancellation.abort(); };
  dependencies.signal?.addEventListener("abort", interrupt, { once: true });
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  if (dependencies.signal?.aborted) interrupt();
  let releaseUpdate: (() => Promise<void>) | undefined, releaseStartup: (() => Promise<void>) | undefined, releaseService: (() => Promise<void>) | undefined;
  let stopped = false, installStarted = false, savedBackup: string | undefined, logPath: string | undefined;
  const unlock = async () => { await releaseService?.(); releaseService = undefined; await releaseStartup?.(); releaseStartup = undefined; await releaseUpdate?.(); releaseUpdate = undefined; await releaseInstallation(); };
  const restart = async () => {
    const restartOptions = { port: status.instance?.port, noUpdateCheck: options.noUpdateCheck, waitData: true as const };
    if (dependencies.restart) return dependencies.restart(root, options.home, restartOptions);
    const timeout = options.timeoutMs ?? 120_000;
    const args = [join(root, "dist", "cli.js"), "start", "--home", options.home, "--json", "--wait-data", "--timeout", String(timeout / 1000), ...(status.instance?.port ? ["--port", String(status.instance.port)] : []), ...(options.noUpdateCheck ? ["--no-update-check"] : [])];
    // 子进程负责完整准备期限；父进程留出退出宽限，避免先于子进程终止等待。
    const childOptions = { timeout: timeout + 5000, signal: cancellation.signal };
    const child = dependencies.restartCommand ? dependencies.restartCommand(args, childOptions) : run(process.execPath, args, { ...childOptions, maxBuffer: 1_048_576 });
    if (dependencies.progress) {
      let settled = false;
      const completion = child.then(() => { settled = true; }, () => { settled = true; });
      while (!settled) {
        const current = await Promise.resolve((dependencies.status ?? serviceStatus)(options.home, { summary: true })).catch(() => null);
        if (current?.running && current.status && current.instance?.id !== status.instance?.id) dependencies.progress("restart", current.status);
        if (!settled) await Promise.race([completion, delay(250)]);
      }
    }
    return JSON.parse((await child).stdout) as unknown;
  };
  try {
    cancellation.signal.throwIfAborted();
    await assertInstalledVersion(context);
    const fixed = await releases.check({ target: version });
    if (fixed.checkState !== "ready" || fixed.latestVersion !== version) releaseError(fixed);
    if (!fixed.compatibility.compatible) throw failure("UPDATE_INCOMPATIBLE", fixed.compatibility.reason ?? "Release is incompatible", "cli.update.incompatible");
    const registered = await listInstallationServices(context);
    if (registered.some(item => item.home !== selectedHome)) throw failure("SERVICE_BUSY", "Other services appeared after confirmation", "diagnostics.service.runtime.busy", { services: registered.filter(item => item.home !== selectedHome).map(item => ({ ...item, stopCommand: updateStopCommand(item.home) })) });
    const freshInstallation = await detectInstallation(root, command);
    if (freshInstallation.kind !== installation.kind || freshInstallation.prefix !== installation.prefix) throw failure("UPDATE_PREVIEW_CHANGED", "Installation ownership changed after confirmation", "cli.update.previewChanged");
    for (const name of ["package.json", "package-lock.json", "npm-shrinkwrap.json"]) if (installation.kind === "local") {
      const path = join(installation.prefix!, name);
      let contents: string | undefined;
      try { contents = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (contents !== dependencySnapshots.get(path)) throw failure("UPDATE_PREVIEW_CHANGED", "Local dependency files changed after confirmation", "cli.update.previewChanged");
    }
    releaseUpdate = await acquireLock(options.home, "update.lock");
    try { releaseStartup = await acquireLock(options.home, "startup.lock"); } catch { throw failure("SERVICE_BUSY", "The selected service is starting", "diagnostics.service.runtime.busy"); }
    let current = await (dependencies.status ?? serviceStatus)(options.home);
    if (!status.running && status.state === "stopped" && !current.running && current.state === "starting" && !current.instance) {
      // startup.lock 已由本次更新持有；同时取得服务锁后，才可排除其他实例正在启动。
      try { releaseService = await acquireLock(options.home, "service.lock"); }
      catch { throw failure("SERVICE_BUSY", "Another service is starting or stopping", "diagnostics.service.runtime.busy"); }
      current = await (dependencies.status ?? serviceStatus)(options.home);
      if (!current.running && current.state === "starting" && !current.instance) current = { ...current, state: "stopped" };
    }
    if (statusFingerprint(current) !== statusFingerprint(status)) throw failure("UPDATE_PREVIEW_CHANGED", "Service identity changed after confirmation; review a fresh preview", "cli.update.previewChanged");
    if (registered.some(item => item.home === selectedHome && (item.state === "starting" || !current.running || item.instance?.id !== current.instance?.id))) throw failure("SERVICE_IDENTITY_UNVERIFIED", "A registered service identity cannot be verified", "diagnostics.service.runtime.identity");
    if (current.running) { await (dependencies.stop ?? stopService)(options.home, { wait: options.wait, timeoutMs: options.timeoutMs }); stopped = true; }
    if (!releaseService) try { releaseService = await acquireLock(options.home, "service.lock"); } catch { throw failure("SERVICE_BUSY", "Another service is starting or stopping", "diagnostics.service.runtime.busy"); }
    if (await (dependencies.space ?? availableBytes)(dirname(options.home)) < await backupBytes(options.home)) throw failure("UPDATE_SPACE_INSUFFICIENT", "Insufficient space for the data backup", "cli.update.spaceInsufficient");
    dependencies.progress?.("backup");
    savedBackup = await (dependencies.backup ?? backupData)(options.home, version, backup);
    if (dependencySnapshots.size) {
      const directory = join(savedBackup, "installation-files"); await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const [path, contents] of dependencySnapshots) await writeFile(join(directory, path.slice(installation.prefix!.length + 1)), contents, { mode: 0o600 });
    }
    cancellation.signal.throwIfAborted();
    logPath = join(savedBackup, "installation.log");
    dependencies.progress?.("install"); installStarted = true;
    try {
      const result = await command(["install", ...(installation.kind === "global" ? ["--global"] : []), "--prefix", installation.prefix!, "--engine-strict", "--registry", registry, `agent-manor@${version}`], installation.prefix, cancellation.signal);
      await writeFile(logPath, `${result.stdout}\n${result.stderr}`, { mode: 0o600 });
    } catch (error) {
      const output = error as { stdout?: string; stderr?: string };
      await writeFile(logPath, `${output.stdout ?? ""}\n${output.stderr ?? ""}\n${error instanceof Error ? error.message : String(error)}`, { mode: 0o600 });
      throw error;
    }
    const installed = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: string };
    cancellation.signal.throwIfAborted();
    if (installed.version !== version) throw new Error("Installed version does not match the confirmed release");
    if (installation.kind === "local") {
      const path = join(installation.prefix!, "package.json"), before = dependencySnapshots.get(path)!, after = await readFile(path, "utf8");
      assertProductDependency(after, version);
      if (!isDeepStrictEqual(manifestExceptProduct(before), manifestExceptProduct(after))) throw new Error("npm changed unrelated local package manifest fields; inspect the saved installation files");
      for (const name of ["package-lock.json", "npm-shrinkwrap.json"]) {
        const lockPath = join(installation.prefix!, name);
        let contents: string | undefined;
        try { contents = await readFile(lockPath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (contents === undefined) {
          if (dependencySnapshots.has(lockPath)) throw new Error("npm removed a previously existing local lock file");
        } else assertLockFile(contents, after, version);
      }
    }
    await unlock();
    let service: unknown;
    if (stopped) { dependencies.progress?.("restart"); service = await restart(); }
    dependencies.progress?.("complete");
    return { ...preview, updated: true, backup: savedBackup, logPath, installationState: "installed", serviceState: stopped ? "ready" : "not_running", preparationState: stopped ? "ready" : "not_started", ...(service ? { service } : {}) };
  } catch (error) {
    if (installStarted && logPath) await appendFile(logPath, `\n${error instanceof Error ? error.message : String(error)}\n`).catch(() => { /* 原错误与恢复材料仍由返回值保留。 */ });
    await unlock();
    let recoveryService: unknown;
    if (stopped && !installStarted) {
      try { await assertInstalledVersion(context); recoveryService = await restart(); }
      catch (recoveryError) { recoveryService = { restored: false, error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError) }; }
    }
    if (error instanceof RequestError && !stopped && !savedBackup) throw error;
    const current = await Promise.resolve((dependencies.status ?? serviceStatus)(options.home)).catch(() => null);
    throw failure(cancellation.signal.aborted ? "UPDATE_INTERRUPTED" : "UPDATE_FAILED", `Update did not complete. ${error instanceof Error ? error.message : String(error)}`, "cli.update.failed", {
      backup: savedBackup ?? null, logPath: logPath ?? null, installStarted, recoveryService: recoveryService ?? null,
      installationState: installStarted ? "unverified" : "unchanged", serviceState: current?.state ?? "unknown", preparationState: current?.status?.preparation?.state ?? "unknown",
    });
  } finally {
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); dependencies.signal?.removeEventListener("abort", interrupt);
    await unlock();
  }
}
