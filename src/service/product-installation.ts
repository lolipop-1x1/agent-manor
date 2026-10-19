import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { InstallationKind } from "../updates/contracts.js";
import { RequestError } from "./runtime.js";

const run = promisify(execFile);
export interface CommandResult { stdout: string; stderr: string }
export interface Installation { kind: InstallationKind; root: string; prefix?: string }
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
  if (process.platform !== "win32") return run("npm", args, { cwd, timeout: 300_000, maxBuffer: 4_194_304, signal });
  const candidates = [process.env.npm_execpath, ...[dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)].map(path => join(path, "node_modules", "npm", "bin", "npm-cli.js"))];
  for (const candidate of candidates) {
    if (!candidate?.endsWith(".js")) continue;
    try { await access(candidate); } catch { continue; }
    return run(process.execPath, [candidate, ...args], { cwd, timeout: 300_000, maxBuffer: 4_194_304, signal });
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
