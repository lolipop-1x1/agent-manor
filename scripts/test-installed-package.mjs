import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sandbox = await mkdtemp(join(tmpdir(), "agent-manor-installed-"));
const install = join(sandbox, "installation");
const outside = join(sandbox, "outside");
const home = join(sandbox, "data");
const skillDirectory = join(sandbox, "skill-target");
const environment = {
  ...process.env,
  AGENT_MANOR_HOME: home,
  AGENT_MANOR_PORT: "0",
  MYFLICKER_HOME: join(sandbox, "history", "myflicker"),
};
const npmCli = process.env.npm_execpath;
assert.ok(npmCli && npmCli.endsWith(".js"), "通过 npm run test:package 执行安装验收");
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: outside, env: environment, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}
function npm(args, options = {}) { return run(process.execPath, [npmCli, ...args], options); }
let cli;
let tarball;
let started = false;
try {
  await mkdir(outside, { recursive: true });
  if (process.argv[2]) tarball = resolve(process.argv[2]);
  else {
    const output = npm(["pack", "--json", "--ignore-scripts", "--pack-destination", sandbox], { cwd: root });
    tarball = join(sandbox, JSON.parse(output.stdout)[0].filename);
  }
  npm(["install", "--prefix", install, "--omit=dev", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/", tarball], { env: { ...environment, npm_config_engine_strict: "true" } });
  const packageRoot = join(install, "node_modules", "agent-manor");
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const { clientIds } = await import(pathToFileURL(join(packageRoot, "dist/clients.js")).href);
  for (const client of clientIds) environment[`AGENT_MANOR_${client.toUpperCase().replaceAll("-", "_")}_DIR`] = join(sandbox, "history", client);
  assert.equal(metadata.license, "MIT");
  assert.equal(metadata.bin.am, metadata.bin["agent-manor"]);
  assert.equal(existsSync(join(install, "node_modules", "typescript")), false);
  assert.equal(existsSync(join(install, "node_modules", "@agent-manor", "cli")), false);
  cli = join(packageRoot, "dist/cli.js");
  const command = args => JSON.parse(run(process.execPath, [cli, ...args, "--json"]).stdout);
  const bindir = join(install, "node_modules/.bin");
  function bin(name, args) {
    const executable = join(bindir, `${name}${process.platform === "win32" ? ".cmd" : ""}`);
    if (process.platform !== "win32") return run(executable, args);
    const quote = value => `"${String(value).replaceAll('"', '""')}"`;
    return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[executable, ...args].map(quote).join(" ")}"`]);
  }
  assert.equal(bin("am", ["--version"]).stdout.trim(), metadata.version);
  assert.equal(bin("agent-manor", ["--version"]).stdout.trim(), metadata.version);
  run(process.execPath, ["--input-type=module", "-e", `process.argv[1] = "nonexistent-entry"; await import(${JSON.stringify(pathToFileURL(cli).href)});`]);
  assert.equal(command(["status"]).running, false);
  assert.equal(existsSync(home), false, "版本、导入和未运行状态不得创建后台或数据目录");
  const require = createRequire(join(packageRoot, "package.json"));
  const Database = require("better-sqlite3");
  const vector = require("sqlite-vec");
  const db = new Database(":memory:");
  vector.load(db);
  assert.equal(db.prepare("SELECT vec_distance_cosine('[1,0]', '[0,1]') AS distance").get().distance, 1);
  const sqlite = db.prepare("SELECT sqlite_version() AS version").get().version;
  db.close();
  const installedSkill = command(["skills", "install", "--target", "custom", "--directory", skillDirectory]);
  assert.equal(installedSkill.status, "installed");
  assert.ok(existsSync(join(installedSkill.targetPath, "references/sessions.md")));
  assert.equal(command(["skills", "install", "--target", "custom", "--directory", skillDirectory]).status, "current");
  await writeFile(join(installedSkill.targetPath, "SKILL.md"), "User edited skill\n");
  const conflict = spawnSync(process.execPath, [cli, "skills", "update", "--target", "custom", "--directory", skillDirectory, "--json"], { cwd: outside, env: environment, encoding: "utf8" });
  assert.notEqual(conflict.status, 0);
  const updatedSkill = command(["skills", "update", "--target", "custom", "--directory", skillDirectory, "--overwrite"]);
  assert.equal(updatedSkill.status, "updated");
  assert.equal(await readFile(join(updatedSkill.backupPath, "SKILL.md"), "utf8"), "User edited skill\n");
  command(["start", "--wait-data"]);
  started = true;
  const status = command(["status"]);
  assert.equal(status.running, true);
  const web = command(["web", "--no-open"]);
  const htmlResponse = await fetch(web.url);
  assert.equal(htmlResponse.status, 200);
  const html = await htmlResponse.text();
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset, "Web 必须包含实际构建的脚本入口");
  assert.equal((await fetch(new URL(asset, web.url))).status, 200);
  const roots = command(["repositories"]);
  assert.ok(Array.isArray(roots.repositories));
  const stop = command(["stop"]);
  assert.equal(stop.stopped, true);
  assert.equal(command(["status"]).running, false);
  assert.equal(existsSync(join(home, "service.json")), false);
  started = false;
  assert.equal(command(["skills", "remove", "--target", "custom", "--directory", skillDirectory]).status, "removed");
  const evidence = { platform: process.platform, architecture: process.arch, node: process.version, sqlite, libc: process.report?.getReport().header.glibcVersionRuntime ?? null, version: metadata.version, checks: ["both-bins", "read-only-status", "native-sqlite-vector", "skill-install-conflict-backup-remove", "background-start-worker-web-stop"] };
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (started && cli) spawnSync(process.execPath, [cli, "stop", "--json"], { cwd: outside, env: environment, timeout: 30_000 });
  await rm(sandbox, { recursive: true, force: true });
}
