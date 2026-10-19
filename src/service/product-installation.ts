import { execFile, spawn } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { basename, delimiter, dirname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { InstallationKind } from "../updates/contracts.js";
import { RequestError } from "./runtime.js";
import { WINDOWS_DESCENDANTS_MARKER, WINDOWS_MISSING_COMMAND_MARKER, windowsInstallLaunch } from "./windows-install.js";

const run = promisify(execFile);
export interface CommandResult { stdout: string; stderr: string }
export interface Installation { kind: InstallationKind; root: string; prefix?: string }
interface InstallProcessOptions { cwd?: string; signal?: AbortSignal; timeout?: number; maxBuffer?: number; killGrace?: number }

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; if ((error as NodeJS.ErrnoException).code === "EPERM") return true; throw error; }
}
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error(`Could not send ${signal} to install group: ${String(error)}`, { cause: error }); }
}
async function waitForGroup(pid: number): Promise<void> {
  let attempts = 0;
  while (groupExists(pid)) {
    // 无 init 回收的容器可能保留僵尸进程；它们已不能再执行安装写入。
    if (++attempts % 10 === 0) {
      const listing = await run("ps", ["-A", "-o", "pgid=,stat="], { timeout: 2000, maxBuffer: 4_194_304 });
      const states = listing.stdout.split("\n").map(line => line.trim().split(/\s+/)).filter(parts => parts[0] === String(pid)).map(parts => parts[1]!);
      if (!states.length || states.every(state => state.startsWith("Z"))) return;
    }
    await delay(20);
  }
}

/** 中断安装时先收束整棵进程树，再将失败交还持有安装锁的调用方。 */
export async function runInstallProcess(command: string, args: string[], options: InstallProcessOptions = {}): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  const launch = process.platform === "win32" ? windowsInstallLaunch(command, args, options.cwd) : { command, args, env: process.env };
  const child = spawn(launch.command, launch.args, { cwd: options.cwd, env: launch.env, detached: process.platform !== "win32", windowsHide: true, stdio: [process.platform === "win32" ? "pipe" : "ignore", "pipe", "pipe"] });
  child.stdin?.on("error", () => {});
  const maximum = options.maxBuffer ?? 4_194_304;
  const output: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  let failure: Error | undefined;
  let termination: Promise<void> | undefined;
  const terminate = (cause: Error) => {
    failure ??= cause;
    termination ??= (async () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        // wrapper 在 Job 外等待 ActiveProcesses 归零后退出；关闭句柄只承担异常兜底。
        child.stdin?.end("abort\n");
      } else {
        signalGroup(child.pid, "SIGTERM");
        const deadline = Date.now() + (options.killGrace ?? 500);
        while (groupExists(child.pid) && Date.now() < deadline) await delay(20);
        signalGroup(child.pid, "SIGKILL");
        await waitForGroup(child.pid);
      }
    })();
    // close 事件之前终止失败也不会产生未处理拒绝；下方仍会等待并报告错误。
    void termination.catch(() => {});
  };
  const collect = (stream: "stdout" | "stderr", data: Buffer) => {
    const remaining = Math.max(0, maximum - sizes[stream]);
    if (remaining) output[stream].push(data.subarray(0, remaining));
    sizes[stream] += data.length;
    if (sizes[stream] > maximum) terminate(Object.assign(new Error(`Installation ${stream} exceeded its output limit`), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
  };
  child.stdout!.on("data", data => collect("stdout", Buffer.from(data)));
  child.stderr!.on("data", data => collect("stderr", Buffer.from(data)));
  const aborted = () => terminate(Object.assign(new Error("Installation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: options.signal?.reason }));
  options.signal?.addEventListener("abort", aborted, { once: true });
  if (options.signal?.aborted) aborted();
  const timer = setTimeout(() => terminate(Object.assign(new Error("Installation timed out"), { code: "ETIMEDOUT" })), options.timeout ?? 300_000);
  let code: number | null = null, signal: NodeJS.Signals | null = null;
  try {
    await new Promise<void>(done => {
      child.once("error", cause => { failure ??= cause; });
      child.once("close", (exitCode, exitSignal) => { code = exitCode; signal = exitSignal; done(); });
    });
    if (!termination && child.pid && process.platform !== "win32" && groupExists(child.pid)) {
      terminate(Object.assign(new Error("Installation left child processes running"), { code: "INSTALL_PROCESS_DESCENDANTS_RUNNING" }));
    }
    if (termination) {
      try { await termination; }
      catch (cause) { failure = new Error(`Could not finish stopping the installation process tree: ${cause instanceof Error ? cause.message : String(cause)}`, { cause: failure }); }
    }
    const result = { stdout: Buffer.concat(output.stdout).toString("utf8"), stderr: Buffer.concat(output.stderr).toString("utf8") };
    if (!failure && process.platform === "win32" && code === 125 && result.stderr.includes(WINDOWS_DESCENDANTS_MARKER)) failure = Object.assign(new Error("Installation left child processes running"), { code: "INSTALL_PROCESS_DESCENDANTS_RUNNING" });
    if (!failure && process.platform === "win32" && code === 127 && result.stderr.includes(WINDOWS_MISSING_COMMAND_MARKER)) failure = Object.assign(new Error("Installation command was not found"), { code: "ENOENT" });
    if (failure || code !== 0) throw Object.assign(failure ?? new Error(`Installation exited with ${signal ?? code}`), result, { ...(failure ? {} : { code, signal }) });
    return result;
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", aborted); }
}

export async function productRoot(start = dirname(fileURLToPath(import.meta.url))): Promise<string> {
  for (let directory = resolve(start); ; directory = dirname(directory)) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: string };
      if (metadata.name === "agent-manor") return directory;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (directory === parse(directory).root) throw new RequestError("INSTALLATION_UNKNOWN", "Cannot locate the installed product package", { key: "cli.update.installationUnknown" });
  }
}

/** Windows 直接运行 npm 的 JS 入口，避免通过 shell 拼接安装路径。 */
export async function npmCommand(args: string[], cwd?: string, signal?: AbortSignal): Promise<CommandResult> {
  if (process.platform !== "win32") return args[0] === "install" ? runInstallProcess("npm", args, { cwd, signal }) : run("npm", args, { cwd, timeout: 300_000, maxBuffer: 4_194_304, signal });
  const candidates = [process.env.npm_execpath, ...[dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)].map(path => join(path, "node_modules", "npm", "bin", "npm-cli.js"))];
  for (const candidate of candidates) {
    if (!candidate?.endsWith(".js")) continue;
    try { await access(candidate); } catch { continue; }
    return args[0] === "install" ? runInstallProcess(process.execPath, [candidate, ...args], { cwd, signal }) : run(process.execPath, [candidate, ...args], { cwd, timeout: 300_000, maxBuffer: 4_194_304, signal });
  }
  throw new RequestError("INSTALLATION_UNKNOWN", "Cannot locate npm's JavaScript entry point", { key: "cli.update.installationUnknown" });
}

export async function detectInstallation(root: string, command = npmCommand): Promise<Installation> {
  const current = await realpath(root);
  if (current.split(sep).includes("_npx")) return { kind: "ephemeral", root: current };
  if (dirname(current).split(sep).at(-1) !== "node_modules") return { kind: "source", root: current };
  let global: string;
  try { global = (await command(["root", "--global"])).stdout.trim(); }
  catch { return { kind: "source", root: current }; }
  try {
    if (await realpath(join(global, "agent-manor")) === current) return { kind: "global", root: current, prefix: (await command(["prefix", "--global"])).stdout.trim() };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // 自定义全局 prefix 不一定等于 npm 当前配置；同时核验两个安装入口，不能只凭目录名判断。
  const parent = dirname(dirname(current));
  const customPrefix = process.platform === "win32" ? parent : basename(parent) === "lib" ? dirname(parent) : undefined;
  if (customPrefix) {
    try {
      let project = false;
      try { await access(join(customPrefix, "package.json")); project = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!project) {
        const bin = process.platform === "win32" ? customPrefix : join(customPrefix, "bin");
        const owned = await Promise.all(["am", "agent-manor"].map(async name => process.platform === "win32"
          ? (await readFile(join(bin, `${name}.cmd`), "utf8")).replaceAll("\\", "/").includes("node_modules/agent-manor/dist/cli.js")
          : await realpath(join(bin, name)) === await realpath(join(current, "dist", "cli.js"))));
        if (owned.every(Boolean)) return { kind: "global", root: current, prefix: customPrefix };
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (dirname(current).split(sep).at(-1) === "node_modules") {
    const prefix = dirname(dirname(current));
    try {
      const metadata = JSON.parse(await readFile(join(prefix, "package.json"), "utf8")) as Record<string, unknown>;
      const owned = ["dependencies", "devDependencies", "optionalDependencies"].some(key => metadata[key] && typeof metadata[key] === "object" && Object.hasOwn(metadata[key] as object, "agent-manor"));
      if (!owned) return { kind: "source", root: current };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "source", root: current }; throw error; }
    // workspace 的依赖归属不唯一，不推断应改动哪一份清单或锁文件。
    for (let ancestor = prefix; ; ancestor = dirname(ancestor)) {
      try {
        const metadata = JSON.parse(await readFile(join(ancestor, "package.json"), "utf8")) as { workspaces?: unknown };
        if (metadata.workspaces) return { kind: "source", root: current };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (ancestor === parse(ancestor).root) break;
    }
    return { kind: "local", root: current, prefix };
  }
  return { kind: "source", root: current };
}
