import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Baseline, BaselineFile, FileCategory, Repository } from "../contracts.js";

export const BASELINE_RULE_VERSION = "baseline-v1";

const run = promisify(execFile);
const excludedDirectories = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "coverage", "target", "out",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", "__pycache__", ".venv", "venv",
]);
const sourceExtensions = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".java", ".kt", ".kts",
  ".py", ".pyi", ".go", ".rs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".cs",
  ".swift", ".m", ".mm", ".rb", ".php", ".vue", ".svelte", ".html", ".htm", ".css",
  ".scss", ".sass", ".less", ".sh", ".bash", ".zsh", ".fish", ".sql", ".proto", ".r",
  ".lua", ".pl", ".ex", ".exs", ".erl", ".clj", ".cljs", ".scala", ".dart", ".f90",
]);
const configExtensions = new Set([
  ".json", ".jsonc", ".json5", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".config", ".properties", ".xml", ".env", ".gradle", ".cmake",
]);
const docsExtensions = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".asciidoc", ".tex"]);
const configNames = new Set([
  "Dockerfile", "Containerfile", "Makefile", "GNUmakefile", "CMakeLists.txt", "Procfile",
  ".gitignore", ".gitattributes", ".editorconfig", ".npmrc", ".nvmrc", ".prettierrc", ".eslintrc",
]);
const generatedNames = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock",
  "poetry.lock", "uv.lock", "Pipfile.lock", ".DS_Store",
]);

export function hashContent(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 物理行包含空白和注释；末尾行分隔符不额外形成一行。 */
export function textLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function classifyFile(path: string): FileCategory {
  const name = basename(path);
  const extension = extname(name).toLowerCase();
  if (configNames.has(name) || name.startsWith(".env.")) return "config";
  if (sourceExtensions.has(extension)) return "source";
  if (configExtensions.has(extension)) return "config";
  if (docsExtensions.has(extension) || /^(README|LICENSE|NOTICE|CHANGELOG|AUTHORS)(\.|$)/i.test(name)) {
    return "docs";
  }
  return "unknown";
}

async function git(path: string, args: string[]): Promise<string> {
  const result = await run("git", ["-C", path, ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.stdout;
}

async function optionalGit(path: string, args: string[]): Promise<string | undefined> {
  try {
    return (await git(path, args)).trim() || undefined;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: number | string };
    if (typeof failure.code === "number" && (failure.code === 1 || failure.code === 128)) return undefined;
    throw error;
  }
}

export async function getRepository(path: string): Promise<Repository> {
  const root = await realpath((await git(resolve(path), ["rev-parse", "--show-toplevel"])).trim());
  const common = (await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  const commonDir = await realpath(resolve(root, common));
  return {
    id: hashContent(JSON.stringify([root, commonDir])).slice(0, 24),
    path: root,
    commonDir,
    name: basename(root),
    stale: true,
  };
}

function pathExclusion(path: string): string | undefined {
  if (path.split("/").some((part) => excludedDirectories.has(part))) return "dependency_or_generated_directory";
  if (generatedNames.has(basename(path)) || /(?:\.min\.(?:js|css)|\.map|\.tsbuildinfo|\.pyc|\.class)$/i.test(path)) {
    return "generated_file";
  }
  return undefined;
}

export async function scanRepository(path: string): Promise<Baseline> {
  const repository = await getRepository(path);
  const root = repository.path;
  const [tracked, untracked, stage, head, branch, status] = await Promise.all([
    git(root, ["ls-files", "-z", "--cached"]),
    git(root, ["ls-files", "-z", "--others", "--exclude-standard"]),
    git(root, ["ls-files", "-z", "--stage"]),
    optionalGit(root, ["rev-parse", "--verify", "HEAD"]),
    optionalGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]),
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
  ]);
  const submodules = new Set(stage.split("\0").filter((entry) => entry.startsWith("160000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1)));
  const paths = [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort();
  const files: BaselineFile[] = [];
  const excluded: Baseline["excluded"] = [];
  for (const path of paths) {
    let reason = pathExclusion(path);
    if (submodules.has(path)) reason = "submodule_independent_repository";
    if (reason) {
      excluded.push({ path, reason });
      continue;
    }
    const absolute = join(root, path);
    let metadata;
    try {
      metadata = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        excluded.push({ path, reason: "deleted_from_worktree" });
        continue;
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      excluded.push({ path, reason: "symlink_not_followed" });
      continue;
    }
    if (!metadata.isFile()) {
      excluded.push({ path, reason: "not_regular_file" });
      continue;
    }
    if (await realpath(absolute) !== absolute) {
      excluded.push({ path, reason: "symlink_not_followed" });
      continue;
    }
    const bytes = await readFile(absolute);
    let content: string;
    try {
      if (bytes.includes(0)) throw new Error("含 NUL 的文件");
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      excluded.push({ path, reason: "binary_or_non_utf8" });
      continue;
    }
    if (/(?:^|\n)\s*(?:\/\/|\/\*|\*|#|<!--)\s*(?:@generated|Code generated [^\n]*DO NOT EDIT|<auto-generated>)/i.test(content.slice(0, 2048))) {
      excluded.push({ path, reason: "generated_header" });
      continue;
    }
    files.push({ path, category: classifyFile(path), lineCount: textLines(content).length, hash: hashContent(bytes), content });
  }
  return {
    repository,
    hash: hashContent(JSON.stringify([BASELINE_RULE_VERSION, repository.id, files.map(({ path, hash, category, lineCount }) => [path, hash, category, lineCount])])),
    createdAt: new Date().toISOString(),
    git: { head, branch, dirty: status.length > 0 },
    files,
    excluded,
  };
}
