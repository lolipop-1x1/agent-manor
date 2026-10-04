import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import type { CoverageResult, EventsResponse, EvidenceResponse, FileDetail, JobResponse, RegisterRepositoryResponse, StatusResponse } from "../src/contracts.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const encode = (records: unknown[]) => records.map((record) => JSON.stringify(record) + "\n").join("");
const pause = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds));

test("npm tarball真实包外安装，原生SQLite与CLI/Worker/Web/Skill无需用户构建", { timeout: 180_000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-install-")));
  const cache = process.env.AGENT_MANOR_NPM_CACHE ?? join(tmpdir(), "agent-manor-npm-cache");
  const install = join(directory, "installed");
  const cwd = join(directory, "outside-cwd");
  const repository = join(directory, "repo");
  const home = join(directory, "data");
  const codex = join(directory, "codex");
  const claude = join(directory, "claude");
  const codeflicker = join(directory, "codeflicker");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  let cli: string | undefined;
  let bin: string | undefined;
  let completed = false;
  const env = { ...process.env, AGENT_MANOR_HOME: home, AGENT_MANOR_PORT: "0", AGENT_MANOR_CODEX_DIR: codex, AGENT_MANOR_CLAUDE_DIR: claude, AGENT_MANOR_CODEFLICKER_DIR: codeflicker };
  const command = async <T>(args: string[]): Promise<T> => {
    assert.ok(bin);
    const result = await run(bin, [...args, "--json"], { cwd, env, timeout: 30_000 });
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout) as T;
  };
  try {
    for (const path of [install, cwd, join(repository, "src"), codex, claude, codeflicker]) await mkdir(path, { recursive: true });
    const packed = await run(npm, ["pack", "--json", "--pack-destination", directory, "--cache", cache], { cwd: root, timeout: 60_000, maxBuffer: 5 * 1024 * 1024 });
    // prepack 的构建日志也可能写入 stdout，最终独立数组才是 npm pack 元数据。
    const metadataStart = packed.stdout.search(/^\[\s*$/m);
    assert.ok(metadataStart >= 0, "npm pack 未返回 JSON 元数据");
    const [pack] = JSON.parse(packed.stdout.slice(metadataStart)) as { filename: string; files: { path: string }[]; integrity: string; size: number }[];
    assert.ok(pack);
    const paths = new Set(pack.files.map((file) => file.path));
    for (const file of ["dist/cli.js", "dist/server.js", "dist/worker.js", "dist/web/index.html", "skills/agent-manor/SKILL.md", "docs/usage.md"]) assert.ok(paths.has(file), file);
    assert.ok([...paths].some((path) => path.startsWith("dist/web/assets/") && path.endsWith(".js")));
    assert.ok(![...paths].some((path) => path.startsWith("src/") || path.startsWith("tests/") || path.startsWith(".scratch/")));
    const tarball = join(directory, pack.filename);
    const installStarted = Date.now();
    const installation = await run(npm, ["install", "--prefix", install, "--omit=dev", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", "--cache", cache, tarball], {
      cwd, env: { ...process.env, npm_config_engine_strict: "true" }, timeout: 120_000, maxBuffer: 5 * 1024 * 1024,
    });
    const installMilliseconds = Date.now() - installStarted;
    const packageRoot = join(install, "node_modules/agent-manor");
    cli = join(packageRoot, "dist/cli.js");
    assert.ok((await realpath(cli)).startsWith(install + "/"));
    const sqlite = JSON.parse((await run(process.execPath, ["--input-type=module", "-e", "import Database from 'better-sqlite3'; const db = new Database(':memory:'); console.log(JSON.stringify({loaded: db.prepare('SELECT 1 AS loaded').get().loaded, sqlite: db.prepare('SELECT sqlite_version() AS version').get().version})); db.close();"], { cwd: install })).stdout) as { loaded: number; sqlite: string };
    assert.equal(sqlite.loaded, 1);
    assert.match(sqlite.sqlite, /^\d+\.\d+\./);
    assert.equal(existsSync(join(install, "node_modules/typescript")), false);
    assert.equal(existsSync(join(install, "node_modules/vite")), false);
    bin = join(install, `node_modules/.bin/agent-manor${process.platform === "win32" ? ".cmd" : ""}`);
    assert.equal((await run(bin, ["--version"], { cwd, env })).stdout.trim(), "0.1.0");
    const imported = await run(process.execPath, ["--input-type=module", "-e", `process.argv[1] = ${JSON.stringify(join(directory, "missing-entry"))}; await import(${JSON.stringify(pathToFileURL(cli).href)});`], { cwd, env });
    assert.equal(imported.stdout, "");
    assert.equal(existsSync(join(home, "service.json")), false);
    // 检查安装后的 Markdown 相对链接，避免白名单漏掉用户需要的文档。
    for (const file of [...paths].filter((path) => path.endsWith(".md"))) {
      const content = await readFile(join(packageRoot, file), "utf8");
      for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1]!;
        if (target.startsWith("https:") || target.startsWith("#")) continue;
        assert.ok(existsSync(resolve(dirname(join(packageRoot, file)), target.split("#")[0]!)), `${file}: ${target}`);
      }
    }
    await run("git", ["init", "-q", repository]);
    const alpha = "export const alpha = 1;\nexport const beta = 2;\nexport const gamma = 3;\n";
    const beta = "export const delta = 4;\nexport const epsilon = 5;\n";
    await writeFile(join(repository, "src/a.ts"), alpha);
    await writeFile(join(repository, "src/b.ts"), beta);
    await writeFile(join(repository, "src/c.ts"), "export const unread = true;\n");
    const codexSource = join(codex, "source.jsonl");
    const claudeSource = join(claude, "source.jsonl");
    await writeFile(codexSource, encode([
      { type: "session_meta", payload: { id: "install-codex", cwd: repository } },
      { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "read", arguments: JSON.stringify({ command: "cat src/a.ts", workdir: repository }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "read", output: `Exit code: 0\nOutput:\n${alpha}` } },
    ]));
    await writeFile(claudeSource, encode([
      { type: "assistant", uuid: "read-request", timestamp: "2026-01-02T00:00:01Z", cwd: repository, sessionId: "install-claude", message: { content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: join(repository, "src/b.ts") } }] } },
      { type: "user", uuid: "read-result", sourceToolAssistantUUID: "read-request", cwd: repository, sessionId: "install-claude", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "1\texport const delta = 4;\n2\texport const epsilon = 5;\n" }] }, toolUseResult: { type: "text", file: { filePath: join(repository, "src/b.ts"), content: beta, numLines: 2, startLine: 1, totalLines: 2 } } },
    ]));
    const sourceBytes = [await readFile(codexSource), await readFile(claudeSource)];
    const registered = await command<RegisterRepositoryResponse>(["register", repository, "--wait"]);
    assert.equal(registered.job.status, "completed", registered.job.error);
    const id = registered.repository.id;
    const coverage = await command<CoverageResult>(["coverage", id, "--directory", "src"]);
    assert.equal(coverage.summary.fileCount, 3);
    assert.equal(coverage.summary.lineCount, 6);
    assert.deepEqual(coverage.summary.readExact, { files: 2, lines: 5 });
    const query = ["--version", coverage.version, "--directory", "src"];
    const file = await command<FileDetail>(["file", id, "src/a.ts", ...query]);
    assert.equal(file.content, alpha);
    const events = await command<EventsResponse>(["events", id, "--path", "src/a.ts", ...query]);
    const evidence = await command<EvidenceResponse>(["evidence", id, events.events[0]!.id, ...query]);
    assert.equal(evidence.records.length, 2);
    assert.equal(evidence.unavailable.length, 0);
    assert.equal(evidence.version, coverage.version);
    const claudeCoverage = await command<CoverageResult>(["coverage", id, "--client", "claude"]);
    assert.deepEqual(claudeCoverage.summary.readExact, { files: 1, lines: 2 });
    assert.equal((await command<JobResponse>(["refresh", id, "--wait"])).job.status, "completed");
    assert.equal((await command<JobResponse>(["cacheclear", id, "--wait"])).job.status, "completed");
    assert.deepEqual((await command<CoverageResult>(["coverage", id])).summary, coverage.summary);
    const web = await command<{ url: string }>(["web", "--no-open"]);
    const html = await (await fetch(web.url)).text();
    const asset = html.match(/src="([^"]+\.js)"/)?.[1];
    assert.ok(asset);
    assert.equal((await fetch(new URL(asset, web.url))).status, 200);
    const status = await command<StatusResponse>(["status"]);
    assert.equal(status.repositories.length, 1);
    assert.deepEqual(await command(["stop"]), { stopping: true });
    for (let attempt = 0; attempt < 100 && existsSync(join(home, "service.json")); attempt++) await pause(50);
    assert.equal(existsSync(join(home, "service.json")), false);
    assert.deepEqual(await command(["stop"]), { stopping: false, running: false });
    assert.deepEqual(await readFile(codexSource), sourceBytes[0]);
    assert.deepEqual(await readFile(claudeSource), sourceBytes[1]);
    const evidenceSummary = { directory, tarball, integrity: pack.integrity, bytes: pack.size, fileCount: paths.size, platform: process.platform, architecture: process.arch, node: process.version, sqlite: sqlite.sqlite, installMilliseconds,
      cli, bin, skill: join(packageRoot, "skills/agent-manor/SKILL.md"), home, codex, claude, repository, repositoryId: id, npmOutput: installation.stdout.trim(), npmWarnings: installation.stderr.trim() };
    if (process.env.AGENT_MANOR_INSTALL_EVIDENCE) await writeFile(process.env.AGENT_MANOR_INSTALL_EVIDENCE, JSON.stringify(evidenceSummary, null, 2));
    console.log(`包外安装：${process.platform}/${process.arch} ${process.version}，${paths.size} 个交付文件，${installMilliseconds} ms，CLI/Worker/Web/SQLite/Skill 闭环通过`);
    completed = true;
  } finally {
    if (cli && existsSync(cli)) await command(["stop"]).catch(() => undefined);
    if (process.env.AGENT_MANOR_INSTALL_KEEP !== "1" || !completed) await rm(directory, { recursive: true, force: true });
  }
});
