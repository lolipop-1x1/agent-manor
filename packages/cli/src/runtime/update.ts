import { execFile } from "node:child_process";
import { access, cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { delimiter, dirname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { VERSION } from "../../../../src/version.js";
import { acquireLock, RequestError, serviceStatus, stopService } from "../../../../src/service/runtime.js";

const run = promisify(execFile);
const registry = "https://registry.npmjs.org/";
export interface UpdateOptions { home: string; target?: string; check?: boolean; wait?: boolean; timeoutMs?: number }
export interface Installation { kind: "global" | "local" | "ephemeral" | "source"; root: string; prefix?: string }
interface CommandResult { stdout: string; stderr: string }
export interface UpdateDependencies {
  root?: string;
  fetch?: typeof globalThis.fetch;
  command?: (args: string[], cwd?: string) => Promise<CommandResult>;
  status?: typeof serviceStatus;
  stop?: typeof stopService;
  restart?: (root: string, home: string) => Promise<unknown>;
}

export async function productRoot(start = dirname(fileURLToPath(import.meta.url))): Promise<string> {
  for (let directory = resolve(start); ; directory = dirname(directory)) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: string };
      if (metadata.name === "agent-manor") return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (directory === parse(directory).root) throw new RequestError("INSTALLATION_UNKNOWN", "Cannot locate the installed product package", { key: "cli.update.installationUnknown" });
  }
}

/** Windows 直接运行 npm 的 JS 入口，避免通过 shell 拼接安装路径。 */
async function npmCommand(args: string[], cwd?: string): Promise<CommandResult> {
  if (process.platform !== "win32") return run("npm", args, { cwd, timeout: 300_000, maxBuffer: 4_194_304 });
  const candidates = [process.env.npm_execpath, ...[dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)].map(path => join(path, "node_modules", "npm", "bin", "npm-cli.js"))];
  for (const candidate of candidates) {
    if (!candidate?.endsWith(".js")) continue;
    try { await access(candidate); } catch { continue; }
    return run(process.execPath, [candidate, ...args], { cwd, timeout: 300_000, maxBuffer: 4_194_304 });
  }
  throw new RequestError("INSTALLATION_UNKNOWN", "Cannot locate npm's JavaScript entry point", { key: "cli.update.installationUnknown" });
}

export async function detectInstallation(root: string, command = npmCommand): Promise<Installation> {
  const current = await realpath(root);
  if (current.split(sep).includes("_npx")) return { kind: "ephemeral", root: current };
  const global = (await command(["root", "--global"])).stdout.trim();
  try {
    if (await realpath(join(global, "agent-manor")) === current) {
      return { kind: "global", root: current, prefix: (await command(["prefix", "--global"])).stdout.trim() };
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (dirname(current).split(sep).at(-1) === "node_modules") return { kind: "local", root: current, prefix: dirname(dirname(current)) };
  return { kind: "source", root: current };
}

async function backupData(home: string, target: string): Promise<string> {
  const backup = `${home}.backups/update-${Date.now()}-${randomUUID()}`;
  await mkdir(backup, { recursive: true, mode: 0o700 });
  await cp(home, join(backup, "data"), { recursive: true, verbatimSymlinks: true, filter: source => !["service.json", "service.lock", "startup.lock", "update.lock", "logs"].includes(source.slice(home.length + 1).split(sep)[0] ?? "") });
  await writeFile(join(backup, "manifest.json"), JSON.stringify({ fromVersion: VERSION, targetVersion: target, createdAt: new Date().toISOString() }), { mode: 0o600 });
  return backup;
}

export async function updateProduct(options: UpdateOptions, dependencies: UpdateDependencies = {}): Promise<unknown> {
  const target = options.target ?? "latest";
  if (target !== "latest" && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(target)) throw new RequestError("INVALID_INPUT", "Expected an exact version or latest", { key: "cli.update.invalidVersion" });
  const root = dependencies.root ?? await productRoot();
  const command = dependencies.command ?? npmCommand;
  const installation = await detectInstallation(root, command);
  const response = await (dependencies.fetch ?? fetch)(`${registry}agent-manor/${encodeURIComponent(target)}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new RequestError("UPDATE_UNAVAILABLE", `The public registry returned HTTP ${response.status}`, { key: "cli.update.unavailable" });
  const metadata = await response.json() as { name?: string; version?: string };
  if (metadata.name !== "agent-manor" || typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version)) throw new RequestError("UPDATE_UNAVAILABLE", "Invalid product release metadata", { key: "cli.update.unavailable" });
  const result = { currentVersion: VERSION, targetVersion: metadata.version, updateAvailable: metadata.version !== VERSION, installation };
  if (options.check || !result.updateAvailable) return result;
  if (installation.kind === "source" || installation.kind === "ephemeral") throw new RequestError("INSTALLATION_UNSUPPORTED", "Install a persistent npm package before using self-update", { key: "cli.update.persistentRequired" });
  const release = await acquireLock(options.home, "update.lock");
  let releaseStartup: (() => Promise<void>) | undefined;
  let releaseService: (() => Promise<void>) | undefined;
  let backup: string | undefined;
  let stopped = false;
  try {
    releaseStartup = await acquireLock(options.home, "startup.lock", 20_000);
    const status = await (dependencies.status ?? serviceStatus)(options.home);
    if (!status.running && ["unreachable", "foreign"].includes(status.state)) throw new RequestError("SERVICE_IDENTITY_UNVERIFIED", "Cannot verify that the existing service is stopped", { key: "diagnostics.service.runtime.identity" });
    if (status.running) {
      await (dependencies.stop ?? stopService)(options.home, { wait: options.wait, timeoutMs: options.timeoutMs });
      stopped = true;
    }
    // 持有服务锁后才覆盖程序和备份，阻止尚在初始化的前台实例被误判为已停止。
    try { releaseService = await acquireLock(options.home, "service.lock"); }
    catch { throw new RequestError("SERVICE_BUSY", "Another service is starting or stopping", { key: "diagnostics.service.runtime.busy" }); }
    backup = await backupData(options.home, metadata.version);
    const args = ["install", ...(installation.kind === "global" ? ["--global"] : []), "--prefix", installation.prefix!, "--engine-strict", "--registry", registry, `agent-manor@${metadata.version}`];
    await command(args, installation.prefix);
    const installed = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: string };
    if (installed.version !== metadata.version) throw new Error("Installed version does not match the requested release");
    await releaseService();
    await releaseStartup();
    await release();
    let service: unknown;
    if (stopped) {
      if (dependencies.restart) service = await dependencies.restart(root, options.home);
      else {
        const restarted = await run(process.execPath, [join(root, "dist", "cli.js"), "start", "--home", options.home, "--json"], { timeout: options.timeoutMs ?? 60_000, maxBuffer: 1_048_576 });
        service = JSON.parse(restarted.stdout);
      }
    }
    return { ...result, updated: true, backup, service };
  } catch (error) {
    if (error instanceof RequestError && !stopped && !backup) throw error;
    throw new RequestError("UPDATE_FAILED", `Update did not complete. Recovery data: ${backup ?? "not created"}. ${error instanceof Error ? error.message : String(error)}`, { key: "cli.update.failed", params: { backup: backup ?? "—" } });
  } finally { await releaseService?.(); await releaseStartup?.(); await release(); }
}
