import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sandbox = await mkdtemp(join(tmpdir(), "agent-manor-installed space-"));
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
let occupiedPort;
try {
  await mkdir(outside, { recursive: true });
  const userDirectory = join(sandbox, "synthetic-user");
  await mkdir(userDirectory);
  const isolation = join(sandbox, "isolate-user.mjs");
  await writeFile(isolation, `import os from "node:os"; import { syncBuiltinESMExports } from "node:module"; os.homedir = () => ${JSON.stringify(userDirectory)}; syncBuiltinESMExports();`);
  environment.NODE_OPTIONS = `--import=${pathToFileURL(isolation).href}`;
  for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "DSH_HOME", "DSH_AGENTS_HOME", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR", "GEMINI_CLI_HOME", "QWEN_HOME", "KIMI_CODE_HOME", "CODEWHALE_CONFIG_PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "APPDATA", "LOCALAPPDATA"]) delete environment[key];
  if (process.argv[2]) tarball = resolve(process.argv[2]);
  else {
    const output = npm(["pack", "--json", "--ignore-scripts", "--pack-destination", sandbox], { cwd: root });
    tarball = join(sandbox, JSON.parse(output.stdout)[0].filename);
  }
  npm(["install", "--global", "--prefix", install, "--omit=dev", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/", tarball], { env: { ...environment, npm_config_engine_strict: "true" } });
  const packageRoot = join(install, process.platform === "win32" ? "node_modules" : "lib/node_modules", "agent-manor");
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const { clientIds } = await import(pathToFileURL(join(packageRoot, "dist/clients.js")).href);
  for (const client of clientIds) environment[`AGENT_MANOR_${client.toUpperCase().replaceAll("-", "_")}_DIR`] = join(sandbox, "history", client);
  assert.equal(metadata.license, "MIT");
  assert.equal(metadata.bin.am, metadata.bin["agent-manor"]);
  assert.equal(existsSync(join(packageRoot, "node_modules", "typescript")), false);
  assert.equal(existsSync(join(packageRoot, "node_modules", "@agent-manor", "cli")), false);
  cli = join(packageRoot, "dist/cli.js");
  const command = args => JSON.parse(run(process.execPath, [cli, ...args, "--json"]).stdout);
  const bindir = process.platform === "win32" ? install : join(install, "bin");
  function bin(name, args) {
    const executable = join(bindir, `${name}${process.platform === "win32" ? ".cmd" : ""}`);
    if (process.platform !== "win32") return run(executable, args);
    const quote = value => `"${String(value).replaceAll('"', '""')}"`;
    // cmd 自己解释这层引号，禁止 Node 再按普通 Windows 程序参数转义。
    return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[executable, ...args].map(quote).join(" ")}"`], { windowsVerbatimArguments: true });
  }
  assert.equal(bin("am", ["--version"]).stdout.trim(), metadata.version);
  assert.equal(bin("agent-manor", ["--version"]).stdout.trim(), metadata.version);
  run(process.execPath, ["--input-type=module", "-e", `process.argv[1] = "nonexistent-entry"; await import(${JSON.stringify(pathToFileURL(cli).href)});`]);
  assert.equal(command(["status"]).running, false);
  const releases = command(["update", "status"]);
  assert.equal(releases.currentVersion, metadata.version);
  assert.equal(releases.installationKind, "global", "自定义全局 prefix 也应识别真实安装范围");
  assert.equal(releases.selfUpdateSupported, true);
  assert.equal(releases.updateAvailable, null, "只读安装验收不能发起发布检查");
  assert.equal(existsSync(home), false, "版本、导入和未运行状态不得创建后台或数据目录");
  // 从实际安装产物加载受控执行器，三个系统的安装矩阵都核验取消与遗留后代。
  run(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { readFile, realpath, writeFile } from "node:fs/promises";
    import { setTimeout as pause } from "node:timers/promises";
    import { runInstallProcess } from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist/service/product-installation.js")).href)};
    const directory = ${JSON.stringify(sandbox)};
    for (const cwd of [undefined, "", directory]) {
      const result = await runInstallProcess(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.cwd()))"], { cwd, timeout: 45000 });
      assert.equal(await realpath(JSON.parse(result.stdout)), await realpath(cwd || process.cwd()));
    }
    for (const mode of ["abort", "orphan"]) {
      const marker = directory + "/process-" + mode + ".txt";
      const child = "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync("+JSON.stringify(marker)+",'ready');setInterval(()=>fs.appendFileSync("+JSON.stringify(marker)+",'x'),10);";
      const parent = "const{spawn}=require('node:child_process');spawn(process.execPath,['-e',"+JSON.stringify(child)+"],{stdio:'ignore'});" + (mode === "orphan" ? "const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync("+JSON.stringify(marker)+")){clearInterval(t);process.exit(0)}},10);" : "setInterval(()=>{},1000);");
      const controller = new AbortController();
      const result = runInstallProcess(process.execPath, ["-e", parent], { signal: controller.signal, timeout: 45000 });
      const rejected = assert.rejects(result, error => mode === "abort" ? error.code === "ABORT_ERR" : error.code === "INSTALL_PROCESS_DESCENDANTS_RUNNING");
      let ready = false;
      for (let i=0; i<3000; i++) { try { await readFile(marker); ready=true; break; } catch {} await pause(10); }
      assert.equal(ready,true,"合成安装后代未启动");
      if (mode === "abort") controller.abort();
      await rejected;
      const before = await readFile(marker,"utf8"); await pause(100);
      assert.equal(await readFile(marker,"utf8"),before,"受控安装返回后，后代仍在写入");
    }
  `]);
  // 原生扩展在独立进程验证并卸载，避免 Windows 清理时仍映射安装包里的 DLL。
  const native = JSON.parse(run(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from "node:module";
    const require = createRequire(${JSON.stringify(join(packageRoot, "package.json"))});
    const Database = require("better-sqlite3"), vector = require("sqlite-vec");
    const db = new Database(":memory:"); vector.load(db);
    const result = { sqlite: db.prepare("SELECT sqlite_version() AS version").get().version,
      distance: db.prepare("SELECT vec_distance_cosine('[1,0]', '[0,1]') AS distance").get().distance };
    db.close(); console.log(JSON.stringify(result));
  `]).stdout);
  assert.equal(native.distance, 1);
  const sqlite = native.sqlite;
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
  occupiedPort = createServer();
  await new Promise((resolve, reject) => {
    occupiedPort.once("error", error => error.code === "EADDRINUSE" ? resolve() : reject(error));
    occupiedPort.listen(16666, "127.0.0.1", resolve);
  });
  const automaticPort = { ...environment }; delete automaticPort.AGENT_MANOR_PORT;
  const portConflict = spawnSync(process.execPath, [cli, "start", "--port", "16666", "--home", join(sandbox, "conflicting-data"), "--json"], { cwd: outside, env: automaticPort, encoding: "utf8", timeout: 120_000 });
  assert.equal(portConflict.error, undefined, `固定端口失败命令未正常退出：${portConflict.stderr}`);
  assert.equal(portConflict.status, 1, "显式端口占用时必须明确失败");
  const start = JSON.parse(run(process.execPath, [cli, "start", "--wait-data", "--json"], { env: automaticPort }).stdout);
  assert(start.instance.port > 16666 && start.instance.port <= 16765, "默认端口占用后必须在约定范围内顺延");
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
  const evidence = { platform: process.platform, architecture: process.arch, node: process.version, sqlite, libc: process.report?.getReport().header.glibcVersionRuntime ?? null, version: metadata.version, checks: ["both-bins", "read-only-status", "release-status-custom-prefix", "install-process-default-empty-and-explicit-cwd", "install-process-tree-abort-and-orphan", "native-sqlite-vector", "skill-install-conflict-backup-remove", "default-port-fallback-and-explicit-conflict", "background-start-worker-web-stop"] };
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  console.error(error);
  throw error;
} finally {
  if (started && cli) spawnSync(process.execPath, [cli, "stop", "--json"], { cwd: outside, env: environment, timeout: 30_000 });
  if (cli) spawnSync(process.execPath, [cli, "stop", "--home", join(sandbox, "conflicting-data"), "--json"], { cwd: outside, env: environment, timeout: 30_000 });
  if (occupiedPort?.listening) await new Promise(resolve => occupiedPort.close(resolve));
  await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
