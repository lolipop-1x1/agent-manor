import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceInstance } from "../contracts.js";
import { VERSION } from "../version.js";
import { acquireLock, RequestError } from "./runtime.js";

export interface InstallationContext { root: string; directory: string }
export interface InstallationService { nonce: string; home: string; pid: number; state: "starting" | "running"; instance?: ServiceInstance }
export interface InstallationRegistration {
  nonce: string;
  transfer(pid: number): Promise<void>;
  running(instance: ServiceInstance): Promise<void>;
  remove(): Promise<void>;
}
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
export async function canonicalHome(home: string): Promise<string> {
  let directory = resolve(home);
  const missing: string[] = [];
  for (;;) {
    try { return join(await realpath(directory), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || directory === parse(directory).root) throw error;
      missing.unshift(basename(directory)); directory = dirname(directory);
    }
  }
}
export async function installationContext(root?: string, registryBase?: string): Promise<InstallationContext> {
  if (!root) for (let directory = dirname(fileURLToPath(import.meta.url)); ; directory = dirname(directory)) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: string };
      if (metadata.name === "agent-manor") { root = directory; break; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (directory === parse(directory).root) throw new RequestError("INSTALLATION_UNKNOWN", "Cannot locate the installed product package", { key: "cli.update.installationUnknown" });
  }
  const canonical = await realpath(root!);
  const user = createHash("sha256").update(String(process.getuid?.() ?? userInfo().username)).digest("hex").slice(0, 16);
  const base = registryBase ?? join(tmpdir(), `agent-manor-runtime-${user}`);
  return { root: canonical, directory: join(base, createHash("sha256").update(canonical).digest("hex")) };
}
export async function acquireInstallationOperation(context: InstallationContext): Promise<() => Promise<void>> {
  await mkdir(context.directory, { recursive: true, mode: 0o700 });
  await chmod(context.directory, 0o700);
  try { return await acquireLock(context.directory, "operation.lock", 20_000); }
  catch { throw new RequestError("SERVICE_BUSY", "Another operation is changing this installation", { key: "diagnostics.service.runtime.updating" }); }
}
export async function assertInstalledVersion(context: InstallationContext): Promise<void> {
  const metadata = JSON.parse(await readFile(join(context.root, "package.json"), "utf8")) as { version?: string };
  if (metadata.version !== VERSION) throw new RequestError("SERVICE_VERSION_MISMATCH", "The installation changed while this command was starting", { key: "diagnostics.service.runtime.versionMismatch", params: { version: metadata.version ?? "unknown", expected: VERSION } });
}
export async function listInstallationServices(context: InstallationContext): Promise<InstallationService[]> {
  let names: string[];
  try { names = await readdir(context.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: InstallationService[] = [];
  for (const name of names.filter(value => /^service-[a-f0-9-]+\.json$/.test(value))) {
    const path = join(context.directory, name);
    let item: InstallationService;
    try { item = JSON.parse(await readFile(path, "utf8")) as InstallationService; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new RequestError("SERVICE_BUSY", "An installation registration cannot be verified", { key: "diagnostics.service.runtime.identity" }); }
    if (typeof item.nonce !== "string" || typeof item.home !== "string" || !Number.isSafeInteger(item.pid)) throw new RequestError("SERVICE_BUSY", "An installation registration cannot be verified", { key: "diagnostics.service.runtime.identity" });
    if (alive(item.pid)) result.push(item);
    else await rm(path, { force: true });
  }
  return result;
}
export async function assertNoOtherInstallationService(context: InstallationContext, home: string): Promise<void> {
  const selected = await canonicalHome(home);
  const others = (await listInstallationServices(context)).filter(item => item.home !== selected);
  if (others.length) {
    const error = new RequestError("SERVICE_BUSY", "Another data directory is using this installation; stop that service before updating", { key: "diagnostics.service.runtime.busy" });
    Object.assign(error, { details: { installation: context.root, services: others.map(item => ({ home: item.home, state: item.state, pid: item.pid, ...(item.instance ? { instanceId: item.instance.id } : {}) })) } });
    throw error;
  }
}
export async function registerInstallationService(context: InstallationContext, home: string, reservation?: string): Promise<InstallationRegistration> {
  const selected = await canonicalHome(home);
  let item: InstallationService = { nonce: randomUUID(), home: selected, pid: process.pid, state: "starting" };
  if (reservation) {
    if (!/^[a-f0-9-]+$/.test(reservation)) throw new RequestError("SERVICE_BUSY", "Invalid startup reservation", { key: "diagnostics.service.runtime.identity" });
    const reserved = JSON.parse(await readFile(join(context.directory, `service-${reservation}.json`), "utf8")) as InstallationService;
    if (reserved.home !== selected || reserved.pid !== process.pid || reserved.nonce !== reservation) throw new RequestError("SERVICE_BUSY", "The startup reservation belongs to another service", { key: "diagnostics.service.runtime.identity" });
    item = reserved;
  }
  const path = join(context.directory, `service-${item.nonce}.json`);
  const save = async () => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(item), { mode: 0o600 });
    await rename(temporary, path);
  };
  await save();
  return { nonce: item.nonce,
    async transfer(pid) { item = { ...item, pid }; await save(); },
    async running(instance) { item = { ...item, pid: instance.pid, state: "running", instance }; await save(); },
    async remove() { await rm(path, { force: true }); },
  };
}
