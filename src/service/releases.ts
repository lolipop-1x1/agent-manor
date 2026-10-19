import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { compare, prerelease, satisfies, valid, validRange } from "semver";
import type { MessageDescriptor } from "../i18n/types.js";
import type { InstallationKind, ReleaseStatus, UpdateSettings } from "../updates/contracts.js";
import { VERSION } from "../version.js";
import { detectInstallation, productRoot, type Installation } from "./product-installation.js";
import { acquireLock, dataHome, RequestError } from "./runtime.js";

export const RELEASE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const REGISTRY = "https://registry.npmjs.org/agent-manor/";
const CHECK_TIMEOUT = 5000;
interface ReleaseMetadata { version: string; engines?: { node?: string }; os?: string[]; cpu?: string[] }
interface CheckCache {
  revision: string;
  attemptedAt: number;
  checkedAt?: number;
  release?: ReleaseMetadata;
  error?: NonNullable<ReleaseStatus["error"]>;
}
interface ReleaseServiceOptions {
  root?: string;
  home?: string;
  configBase?: string;
  fetch?: typeof fetch;
  now?: () => number;
  currentVersion?: string;
  installation?: Installation;
  installationKind?: InstallationKind;
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  disableAutomatic?: boolean;
  requestTimeout?: number;
  schedulerInterval?: number;
}
const pending = new Map<string, Promise<ReleaseStatus>>();

/** 只接受精确的稳定发布版本；不把 tag 或宽松前缀变成版本号。 */
export function stableVersion(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:\+[\da-zA-Z.-]+)?$/.test(value) || !valid(value) || prerelease(value)) return null;
  return value;
}
export function compareVersions(left: string, right: string): number { return compare(left, right); }

function error(code: string, message: string, key: string, params?: MessageDescriptor["params"]): NonNullable<ReleaseStatus["error"]> {
  return { code, message, messageDescriptor: { key, ...(params ? { params } : {}) } };
}
async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT" || cause instanceof SyntaxError) return undefined; throw cause; }
}
async function writeJson(directory: string, name: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, join(directory, name));
  } finally { await rm(temporary, { force: true }); }
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function metadata(value: unknown): ReleaseMetadata | undefined {
  if (!record(value) || !stableVersion(value.version)) return undefined;
  if (value.name !== undefined && value.name !== "agent-manor") return undefined;
  if (value.engines !== undefined && (!record(value.engines) || value.engines.node !== undefined && (typeof value.engines.node !== "string" || !validRange(value.engines.node)))) return undefined;
  for (const key of ["os", "cpu"] as const) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(item => typeof item !== "string"))) return undefined;
  return { version: value.version as string, ...(record(value.engines) && typeof value.engines.node === "string" ? { engines: { node: value.engines.node } } : {}),
    ...(Array.isArray(value.os) ? { os: value.os as string[] } : {}), ...(Array.isArray(value.cpu) ? { cpu: value.cpu as string[] } : {}) };
}
function cache(value: unknown): CheckCache | undefined {
  if (!record(value) || typeof value.revision !== "string" || !Number.isFinite(value.attemptedAt)) return undefined;
  const release = metadata(value.release);
  const failure = record(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string" && record(value.error.messageDescriptor)
    && typeof value.error.messageDescriptor.key === "string" ? value.error as unknown as NonNullable<ReleaseStatus["error"]> : undefined;
  return { revision: value.revision, attemptedAt: value.attemptedAt as number,
    ...(typeof value.checkedAt === "number" && Number.isFinite(value.checkedAt) && release ? { checkedAt: value.checkedAt, release } : {}), ...(failure ? { error: failure } : {}) };
}
function allows(values: string[] | undefined, selected: string): boolean {
  if (!values) return true;
  if (values.includes(`!${selected}`)) return false;
  if (values.includes("any")) return true;
  const included = values.filter(value => !value.startsWith("!"));
  return !included.length || included.includes(selected);
}
function shellQuote(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
}

/** 只保存产品发布元信息；多个业务数据目录共享安装级设置和检查锁。 */
export class ReleaseService {
  private readonly options: ReleaseServiceOptions;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private readonly platform: NodeJS.Platform;
  private readonly currentVersion: string;
  private contextPromise?: Promise<{ directory: string; installation: Installation }>;
  constructor(options: ReleaseServiceOptions = {}) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetch ?? fetch;
    this.platform = options.platform ?? process.platform;
    this.currentVersion = options.currentVersion ?? VERSION;
  }
  private context(): Promise<{ directory: string; installation: Installation }> {
    return this.contextPromise ??= (async () => {
      const root = await realpath(this.options.root ?? this.options.installation?.root ?? await productRoot());
      const installation = this.options.installation ?? (this.options.installationKind ? { root, kind: this.options.installationKind } : await detectInstallation(root));
      const user = String(process.getuid?.() ?? userInfo().username);
      const identity = createHash("sha256").update(`${user}\0${root}`).digest("hex");
      const configuration = this.options.configBase ?? (this.platform === "win32" ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
        : this.platform === "darwin" ? join(homedir(), "Library", "Application Support") : process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
      return { directory: join(configuration, "agent-manor", "installations", identity), installation };
    })();
  }
  private async readSettings(): Promise<UpdateSettings> {
    const { directory, installation } = await this.context();
    const value = await readJson(join(directory, "settings.json"));
    return { autoCheck: record(value) && typeof value.autoCheck === "boolean" ? value.autoCheck : installation.kind === "global" || installation.kind === "local",
      ignoredVersion: record(value) ? stableVersion(value.ignoredVersion) : null };
  }
  async settings(patch?: Partial<UpdateSettings>): Promise<UpdateSettings> {
    if (patch === undefined) return this.readSettings();
    if (!record(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => key !== "autoCheck" && key !== "ignoredVersion")
      || "autoCheck" in patch && typeof patch.autoCheck !== "boolean" || "ignoredVersion" in patch && patch.ignoredVersion !== null && !stableVersion(patch.ignoredVersion)) {
      throw new RequestError("INVALID_INPUT", "Update settings must contain autoCheck or a stable ignoredVersion", { key: "updates.invalidSettings" });
    }
    const { directory } = await this.context();
    const release = await acquireLock(directory, "settings.lock", 7000);
    try {
      const updated = { ...await this.readSettings(), ...patch };
      await writeJson(directory, "settings.json", updated);
      return updated;
    } finally { await release(); }
  }
  private async readCache(name = "release-check.json"): Promise<CheckCache | undefined> {
    return cache(await readJson(join((await this.context()).directory, name)));
  }
  private async checking(): Promise<boolean> {
    const owner = await readJson(join((await this.context()).directory, "check.lock", "owner.json"));
    if (!record(owner) || !Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1) return false;
    try { process.kill(owner.pid as number, 0); return true; } catch (cause) { return (cause as NodeJS.ErrnoException).code === "EPERM"; }
  }
  private compatibility(release?: ReleaseMetadata): ReleaseStatus["compatibility"] {
    if (!release) return { compatible: true, reason: null };
    const node = this.options.nodeVersion ?? process.versions.node;
    if (release.engines?.node && !satisfies(node, release.engines.node)) return { compatible: false, reason: "node", messageDescriptor: { key: "updates.incompatibleNode", params: { required: release.engines.node, current: node } } };
    if (!allows(release.os, this.platform)) return { compatible: false, reason: "os", messageDescriptor: { key: "updates.incompatibleOs", params: { current: this.platform } } };
    const arch = this.options.arch ?? process.arch;
    if (!allows(release.cpu, arch)) return { compatible: false, reason: "arch", messageDescriptor: { key: "updates.incompatibleArch", params: { current: arch } } };
    return { compatible: true, reason: null };
  }
  private async result(value: CheckCache | undefined, active = false): Promise<ReleaseStatus> {
    const settings = await this.readSettings();
    const { installation } = await this.context();
    const latestVersion = value?.release?.version ?? null;
    const relation = latestVersion && valid(this.currentVersion) ? compareVersions(this.currentVersion, latestVersion) : undefined;
    const selectedHome = dataHome(this.options.home);
    const homeFlag = selectedHome === resolve(homedir(), ".agent-manor") ? "" : ` --home ${shellQuote(selectedHome, this.platform)}`;
    const updateCommand = installation.kind === "source" ? `am${homeFlag} update --check`
      : installation.kind === "ephemeral" ? `npm install --global agent-manor${latestVersion ? `@${latestVersion}` : "@latest"} --registry=https://registry.npmjs.org/`
      : `am${homeFlag} update${latestVersion ? ` --to ${latestVersion}` : ""}`;
    return { ...settings, automaticDisabled: this.automaticDisabled(), currentVersion: this.currentVersion, latestVersion,
      checkState: active ? "checking" : value?.error ? "failed" : latestVersion ? "ready" : "unknown",
      checkedAt: value?.checkedAt === undefined ? null : new Date(value.checkedAt).toISOString(),
      stale: value?.checkedAt === undefined || this.now() - value.checkedAt >= RELEASE_CHECK_INTERVAL || this.now() < value.checkedAt || Boolean(value.error),
      updateAvailable: relation === undefined ? null : relation < 0, versionRelation: relation === undefined ? "unknown" : relation < 0 ? "behind" : relation > 0 ? "ahead" : "current",
      installationKind: installation.kind, selfUpdateSupported: installation.kind === "global" || installation.kind === "local", compatibility: this.compatibility(value?.release),
      updateCommand, shell: this.platform === "win32" ? "powershell" : "posix", ...(value?.error ? { error: value.error } : {}) };
  }
  async status(): Promise<ReleaseStatus> { return this.result(await this.readCache(), await this.checking()); }
  private automaticDisabled(): boolean { return this.options.disableAutomatic === true || process.env.AGENT_MANOR_NO_UPDATE_CHECK === "1"; }
  async check(options: { automatic?: boolean; target?: string } = {}): Promise<ReleaseStatus> {
    const target = options.target ?? "latest";
    if (target !== "latest" && !stableVersion(target)) throw new RequestError("INVALID_INPUT", "Only exact stable release versions are supported", { key: "updates.invalidVersion" });
    if (options.automatic && (this.automaticDisabled() || !(await this.readSettings()).autoCheck)) return this.status();
    const { directory } = await this.context();
    const name = target === "latest" ? "release-check.json" : `release-target-${createHash("sha256").update(target).digest("hex")}.json`;
    const key = join(directory, name);
    const ongoing = pending.get(key);
    if (ongoing) { await ongoing; return this.result(await this.readCache(name)); }
    const operation = this.performCheck(target, name, Boolean(options.automatic));
    pending.set(key, operation);
    try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
  }
  private async performCheck(target: string, name: string, automatic: boolean): Promise<ReleaseStatus> {
    const { directory } = await this.context();
    const before = await this.readCache(name);
    if (automatic && before && this.now() >= before.attemptedAt && this.now() - before.attemptedAt < RELEASE_CHECK_INTERVAL) return this.status();
    const unlock = await acquireLock(directory, "check.lock", (this.options.requestTimeout ?? CHECK_TIMEOUT) + 3000);
    try {
      const previous = await this.readCache(name);
      if (previous && previous.revision !== before?.revision) return this.result(previous);
      if (automatic && (this.automaticDisabled() || !(await this.readSettings()).autoCheck)) return this.result(previous);
      if (automatic && previous && this.now() >= previous.attemptedAt && this.now() - previous.attemptedAt < RELEASE_CHECK_INTERVAL) return this.result(previous);
      const attemptedAt = this.now();
      const started = { ...previous, revision: randomUUID(), attemptedAt };
      await writeJson(directory, name, started);
      let next: CheckCache;
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const expiry = new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("release_check_timeout")); }, this.options.requestTimeout ?? CHECK_TIMEOUT); });
        const request = async () => {
          const response = await this.fetcher(`${REGISTRY}${encodeURIComponent(target)}`, { signal: controller.signal, redirect: "error", headers: { Accept: "application/json" } });
          if (!response.ok) throw new RequestError(response.status === 404 ? target === "latest" ? "UPDATE_PACKAGE_NOT_FOUND" : "UPDATE_VERSION_NOT_FOUND" : "UPDATE_CHECK_FAILED",
            `Release registry returned HTTP ${response.status}`, { key: response.status === 404 ? "updates.notFound" : "updates.httpError", params: { status: response.status } });
          let parsed: unknown;
          try { parsed = await response.json(); } catch { throw new RequestError("UPDATE_METADATA_INVALID", "Release metadata is not valid JSON", { key: "updates.invalidMetadata" }); }
          const release = record(parsed) && parsed.name === "agent-manor" ? metadata(parsed) : undefined;
          if (!release || target !== "latest" && release.version !== target) throw new RequestError("UPDATE_METADATA_INVALID", "Release metadata is missing or invalid", { key: "updates.invalidMetadata" });
          return release;
        };
        const release = await Promise.race([request(), expiry]);
        next = { revision: randomUUID(), attemptedAt, checkedAt: this.now(), release };
      } catch (cause) {
        const failed = cause instanceof RequestError ? error(cause.code, cause.message, cause.messageDescriptor?.key ?? "updates.checkFailed", cause.messageDescriptor?.params)
          : controller.signal.aborted ? error("UPDATE_CHECK_TIMEOUT", "Release check timed out", "updates.checkTimeout")
          : error("UPDATE_CHECK_FAILED", cause instanceof Error ? cause.message : "Release check failed", "updates.checkFailed");
        next = { ...previous, revision: randomUUID(), attemptedAt, error: failed };
      } finally { if (timeout) clearTimeout(timeout); }
      await writeJson(directory, name, next);
      return await this.result(next);
    } finally { await unlock(); }
  }
  async claimNotice(): Promise<ReleaseStatus | null> {
    if (this.automaticDisabled()) return null;
    const { directory } = await this.context();
    const unlock = await acquireLock(directory, "notice.lock", 7000);
    try {
      const status = await this.status();
      if (!status.autoCheck || status.stale || status.checkState !== "ready" || !status.updateAvailable || status.ignoredVersion === status.latestVersion) return null;
      const previous = await readJson(join(directory, "notice.json"));
      const notices = record(previous) ? previous : {};
      const last = notices[status.latestVersion!];
      if (typeof last === "number" && this.now() >= last && this.now() - last < RELEASE_CHECK_INTERVAL) return null;
      const recent = Object.fromEntries(Object.entries(notices).filter(([, at]) => typeof at === "number" && this.now() >= at && this.now() - at < RELEASE_CHECK_INTERVAL));
      await writeJson(directory, "notice.json", { ...recent, [status.latestVersion!]: this.now() });
      return status;
    } finally { await unlock(); }
  }
  startAutoChecks(): () => void {
    let stopped = false;
    const run = () => { if (!stopped) void this.check({ automatic: true }).catch(() => {}); };
    const start = setTimeout(run, 0);
    start.unref();
    // 每次重新读取共享设置，其他后台关闭自动检查后也会生效。
    const timer = setInterval(run, this.options.schedulerInterval ?? 60_000);
    timer.unref();
    return () => { stopped = true; clearTimeout(start); clearInterval(timer); };
  }
}
