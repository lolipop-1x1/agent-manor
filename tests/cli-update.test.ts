import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { updateProduct, type UpdateDependencies, type UpdatePreview, updateStopCommand } from "../packages/cli/src/runtime/update.js";
import { allowsUpdateNotice, cachedUpdateNotice } from "../packages/cli/src/runtime/update-notice.js";
import { ReleaseService } from "../src/service/releases.js";
import { RequestError, serviceStatus, stopService } from "../src/service/runtime.js";
import { VERSION } from "../src/version.js";

async function fixture(operation: (context: { root: string; home: string; commands: string[][]; dependencies: UpdateDependencies }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-update space-"));
  const root = join(directory, "install", "node_modules", "agent-manor"), home = join(directory, "data"), commands: string[][] = [];
  await mkdir(root, { recursive: true }); await mkdir(home);
  await writeFile(join(directory, "install", "package.json"), JSON.stringify({ name: "example-project", dependencies: { "agent-manor": VERSION } }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "agent-manor", version: VERSION }));
  await writeFile(join(home, "preferences.json"), JSON.stringify({ language: "en" }), { mode: 0o600 });
  const dependencies: UpdateDependencies = {
    root, configBase: join(directory, "configuration"),
    fetch: async () => new Response(JSON.stringify({ name: "agent-manor", version: "0.2.0" })),
    command: async args => {
      commands.push(args);
      if (args[0] === "root") return { stdout: join(directory, "global"), stderr: "" };
      if (args[0] === "install") {
        await writeFile(join(root, "package.json"), JSON.stringify({ name: "agent-manor", version: "0.2.0" }));
        const path = join(directory, "install", "package.json"), manifest = JSON.parse(await readFile(path, "utf8"));
        manifest.dependencies["agent-manor"] = "^0.2.0"; await writeFile(path, JSON.stringify(manifest));
      }
      return { stdout: "Synthetic npm output", stderr: "" };
    },
    status: (async () => ({ running: false, state: "stopped" })) as typeof serviceStatus,
  };
  try { await operation({ root, home, commands, dependencies }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const runningStatus = () => ({ running: true, state: "running", instance: { id: "synthetic-instance", pid: process.pid, host: "127.0.0.1", port: 16669, startedAt: "2026-01-01T00:00:00Z" } });

test("检查不安装；无授权返回预览，dry-run 不停止服务或安装", async () => fixture(async ({ home, commands, dependencies }) => {
  const check = await updateProduct({ home, check: true }, dependencies) as { installationKind: string; updateAvailable: boolean };
  assert.equal(check.installationKind, "local"); assert.equal(check.updateAvailable, true);
  dependencies.status = runningStatus as typeof serviceStatus;
  let stopped = false; dependencies.stop = async () => { stopped = true; return { stopped: true }; };
  await assert.rejects(updateProduct({ home }, dependencies), (error: unknown) => {
    assert.equal((error as RequestError).code, "CONFIRMATION_REQUIRED");
    assert.equal((error as { details: { preview: UpdatePreview } }).details.preview.targetVersion, "0.2.0"); return true;
  });
  const preview = await updateProduct({ home, dryRun: true }, dependencies) as UpdatePreview;
  assert.equal(preview.service.port, 16669); assert.ok(preview.estimatedBackupBytes > 0);
  assert.equal(stopped, false); assert.equal(commands.some(command => command[0] === "install"), false);
}));

test("明确确认后安装精确版本、记录日志并保留数据备份", async () => fixture(async ({ root, home, commands, dependencies }) => {
  let confirmed = false; dependencies.confirm = async preview => { confirmed = preview.targetVersion === "0.2.0"; return true; };
  const updated = await updateProduct({ home }, dependencies) as { updated: boolean; backup: string; logPath: string };
  assert.equal(updated.updated, true); assert.equal(confirmed, true);
  assert.equal(await readFile(join(home, "preferences.json"), "utf8"), await readFile(join(updated.backup, "data", "preferences.json"), "utf8"));
  assert.deepEqual(commands.find(command => command[0] === "install"), ["install", "--prefix", await realpath(dirname(dirname(root))), "--engine-strict", "--registry", "https://registry.npmjs.org/", "agent-manor@0.2.0"]);
  assert.equal(JSON.parse(await readFile(join(updated.backup, "manifest.json"), "utf8")).fromVersion, VERSION);
  assert.match(await readFile(updated.logPath, "utf8"), /Synthetic npm output/);
}));

test("确认固定首次目标，不跟随确认期间发布的另一个 latest", async () => fixture(async ({ home, dependencies }) => {
  const targets: string[] = [];
  dependencies.fetch = async input => { targets.push(String(input)); return new Response(JSON.stringify({ name: "agent-manor", version: targets.length === 1 || String(input).endsWith("/0.2.0") ? "0.2.0" : "0.3.0" })); };
  await updateProduct({ home, yes: true }, dependencies);
  assert.equal(targets.length, 2); assert.match(targets[0]!, /\/latest$/); assert.match(targets[1]!, /\/0\.2\.0$/);
}));

test("版本相同不安装，降级、测试版本与不可用发布明确拒绝", async () => fixture(async ({ home, commands, dependencies }) => {
  dependencies.fetch = async () => new Response(JSON.stringify({ name: "agent-manor", version: VERSION }));
  const current = await updateProduct({ home, yes: true }, dependencies) as UpdatePreview; assert.equal(current.updateAvailable, false);
  dependencies.fetch = async () => new Response(JSON.stringify({ name: "agent-manor", version: "0.0.1" }));
  await assert.rejects(updateProduct({ home, yes: true }, dependencies), { code: "DOWNGRADE_UNSUPPORTED" });
  for (const target of ["0.2.0-beta.1", "v0.2.0", "0.2.0; invalid"]) await assert.rejects(updateProduct({ home, target, yes: true }, dependencies), { code: "INVALID_INPUT" });
  dependencies.fetch = async () => new Response("missing", { status: 404 });
  await assert.rejects(updateProduct({ home, check: true }, dependencies), error => (error as RequestError).code.startsWith("UPDATE_"));
  assert.equal(commands.some(command => command[0] === "install"), false);
}));

test("环境不兼容和空间不足能预览阻断原因，安装前不停止后台", async () => fixture(async ({ home, commands, dependencies }) => {
  let stopped = false; dependencies.stop = async () => { stopped = true; return { stopped: true }; };
  dependencies.fetch = async () => new Response(JSON.stringify({ name: "agent-manor", version: "0.2.0", engines: { node: ">=999" } }));
  const preview = await updateProduct({ home, dryRun: true }, dependencies) as UpdatePreview;
  assert.equal(preview.blockers[0]?.code, "UPDATE_INCOMPATIBLE");
  await assert.rejects(updateProduct({ home, yes: true }, dependencies), { code: "UPDATE_INCOMPATIBLE" });
  dependencies.fetch = async () => new Response(JSON.stringify({ name: "agent-manor", version: "0.2.0" })); dependencies.space = async () => 0;
  await assert.rejects(updateProduct({ home, yes: true }, dependencies), { code: "UPDATE_SPACE_INSUFFICIENT" });
  assert.equal(stopped, false); assert.equal(commands.some(command => command[0] === "install"), false);
}));

test("在途任务拒绝或显式等待，升级后恢复原端口及本次检查覆盖", async () => fixture(async ({ root, home, commands, dependencies }) => {
  dependencies.status = (async () => ({ ...runningStatus(), status: { activeTasks: ["synthetic-job"] } })) as unknown as typeof serviceStatus;
  await assert.rejects(updateProduct({ home, yes: true }, dependencies), { code: "SERVICE_BUSY" });
  assert.equal(commands.some(command => command[0] === "install"), false);
  let waited = false;
  dependencies.stop = async (_home, options) => { waited = options?.wait === true; return { stopped: true }; };
  let restarted = false;
  dependencies.restart = async (installedRoot, dataDirectory, options) => { assert.equal(installedRoot, root); assert.equal(dataDirectory, home); assert.equal(options?.port, 16669); assert.equal(options.noUpdateCheck, true); restarted = true; return { running: true }; };
  await updateProduct({ home, yes: true, wait: true, noUpdateCheck: true }, dependencies);
  assert.equal(waited, true); assert.equal(restarted, true);
}));

test("等待超时与确认后实例变更均不安装", async () => fixture(async ({ home, commands, dependencies }) => {
  dependencies.status = runningStatus as typeof serviceStatus;
  dependencies.stop = async () => { throw new RequestError("TIMEOUT", "Synthetic task wait timeout"); };
  await assert.rejects(updateProduct({ home, yes: true, wait: true }, dependencies), { code: "TIMEOUT" });
  let calls = 0; dependencies.status = (async () => ({ ...runningStatus(), instance: { ...runningStatus().instance, id: ++calls === 1 ? "first" : "second" } })) as typeof serviceStatus;
  await assert.rejects(updateProduct({ home, yes: true }, dependencies), { code: "UPDATE_PREVIEW_CHANGED" });
  assert.equal(commands.some(command => command[0] === "install"), false);
}));

test("备份失败恢复未变更的原后台，npm失败保留日志并不自动回滚", async () => fixture(async ({ home, commands, dependencies }) => {
  dependencies.status = runningStatus as typeof serviceStatus; dependencies.stop = async () => ({ stopped: true });
  let restarted = 0; dependencies.restart = async () => { restarted++; return { running: true }; };
  dependencies.backup = async () => { throw new Error("Synthetic backup error"); };
  await assert.rejects(updateProduct({ home, yes: true }, dependencies), error => {
    const details = (error as { details: { installStarted: boolean; recoveryService: unknown } }).details;
    assert.equal(details.installStarted, false); assert.ok(details.recoveryService); return true;
  });
  assert.equal(restarted, 1); assert.equal(commands.some(command => command[0] === "install"), false);
  dependencies.backup = undefined; const original = dependencies.command!;
  dependencies.command = async args => { if (args[0] === "install") throw Object.assign(new Error("Synthetic npm failure"), { stderr: "Synthetic npm diagnostic" }); return original(args); };
  let failureLog: string | undefined;
  await assert.rejects(updateProduct({ home, yes: true }, dependencies), error => {
    const details = (error as { details: { backup: string; logPath: string; installStarted: boolean } }).details;
    assert.equal(details.installStarted, true); assert.ok(details.backup); failureLog = details.logPath; return true;
  });
  assert.match(await readFile(failureLog!, "utf8"), /Synthetic npm diagnostic/);
  assert.equal(restarted, 1);
}));

test("安装版本不符或重启失败不误报完成，恢复材料保留", async () => fixture(async ({ home, dependencies }) => {
  const original = dependencies.command!;
  dependencies.command = async args => args[0] === "install" ? { stdout: "No changes", stderr: "" } : original(args);
  await assert.rejects(updateProduct({ home, yes: true }, dependencies), { code: "UPDATE_FAILED" });
  dependencies.command = original; dependencies.status = runningStatus as typeof serviceStatus; dependencies.stop = async () => ({ stopped: true });
  dependencies.restart = async () => { throw new Error("Synthetic restart failure"); };
  await assert.rejects(updateProduct({ home, yes: true }, dependencies), { code: "UPDATE_FAILED" });
}));

test("自动提醒不污染JSON、帮助、状态、CI及非交互输出", async () => {
  const interactive = { tty: true, ci: false, disabled: false };
  assert.equal(allowsUpdateNotice(["sessions", "list"], interactive), true);
  for (const args of [["sessions", "list", "--json"], ["sessions", "--help"], ["status"], ["update", "status"], ["--version"], ["--no-update-check", "web"]]) assert.equal(allowsUpdateNotice(args, interactive), false);
  assert.equal(allowsUpdateNotice(["sessions", "list"], { ...interactive, ci: true }), false);
  assert.equal(allowsUpdateNotice(["sessions", "list"], { ...interactive, tty: false }), false);
  assert.equal(allowsUpdateNotice(["sessions", "list"], { ...interactive, disabled: true }), false);
});

test("提醒仅用缓存并输出中英文；忽略、恢复和跨命令节流共用安装设置", async () => fixture(async ({ root, home, dependencies }) => {
  let network = 0;
  const service = new ReleaseService({ root, home, configBase: dependencies.configBase, installation: { root, kind: "local", prefix: dirname(dirname(root)) }, fetch: async () => { network++; return new Response(JSON.stringify({ name: "agent-manor", version: "0.2.0" })); } });
  await service.check();
  const environment = { tty: true, ci: false, disabled: false };
  const text = await cachedUpdateNotice(["sessions", "list"], "zh-CN", { service, environment }); assert.match(text!, /0.2.0 已发布/);
  assert.equal(await cachedUpdateNotice(["web"], "en", { service, environment }), undefined); assert.equal(network, 1);
  const fake = { claimNotice: async () => ({ latestVersion: "0.3.0", updateCommand: "am update" }) } as unknown as Pick<ReleaseService, "claimNotice">;
  assert.match((await cachedUpdateNotice(["sessions", "list"], "en", { service: fake, environment }))!, /0.3.0 is available/);
  await service.settings({ ignoredVersion: "0.2.0" }); assert.equal(await cachedUpdateNotice(["web"], "en", { service, environment }), undefined);
  await service.settings({ ignoredVersion: null }); assert.equal((await service.status()).ignoredVersion, null);
}));

test("全局安装保留 --global 与真实 prefix", async () => fixture(async ({ root, home, commands, dependencies }) => {
  const original = dependencies.command!;
  dependencies.command = async (args, cwd) => {
    if (args[0] === "root") return { stdout: dirname(root), stderr: "" };
    if (args[0] === "prefix") return { stdout: dirname(dirname(root)), stderr: "" };
    return original(args, cwd);
  };
  const result = await updateProduct({ home, yes: true }, dependencies) as { installation: { kind: string } };
  assert.equal(result.installation.kind, "global"); assert.ok(commands.find(args => args[0] === "install")?.includes("--global"));
}));

test("源码、临时包和workspace仅检查，普通local必须有明确依赖归属", async () => fixture(async ({ root, home, commands, dependencies }) => {
  const prefix = dirname(dirname(root));
  await writeFile(join(prefix, "package.json"), JSON.stringify({ name: "example-workspace", workspaces: ["packages/*"], dependencies: { "agent-manor": VERSION } }));
  let preview = await updateProduct({ home, dryRun: true }, dependencies) as UpdatePreview;
  assert.equal(preview.installation.kind, "source"); assert.equal(preview.blockers[0]?.code, "INSTALLATION_UNSUPPORTED");
  await assert.rejects(updateProduct({ home, yes: true }, dependencies), { code: "INSTALLATION_UNSUPPORTED" });
  await writeFile(join(prefix, "package.json"), JSON.stringify({ name: "unrelated-project" }));
  preview = await updateProduct({ home, dryRun: true }, dependencies) as UpdatePreview; assert.equal(preview.installation.kind, "source");
  const temporaryRoot = join(prefix, "_npx", "synthetic", "node_modules", "agent-manor");
  await mkdir(temporaryRoot, { recursive: true }); await writeFile(join(temporaryRoot, "package.json"), JSON.stringify({ name: "agent-manor", version: VERSION }));
  dependencies.root = temporaryRoot;
  preview = await updateProduct({ home, dryRun: true }, dependencies) as UpdatePreview; assert.equal(preview.installation.kind, "ephemeral");
  await assert.rejects(updateProduct({ home, yes: true }, dependencies), { code: "INSTALLATION_UNSUPPORTED" });
  dependencies.root = prefix;
  preview = await updateProduct({ home, dryRun: true }, dependencies) as UpdatePreview; assert.equal(preview.installation.kind, "source");
  assert.equal(commands.some(args => args[0] === "install"), false);
}));

test("安装中断等待注入命令结束后清锁，可重新执行升级且不泄漏信号监听", async () => fixture(async ({ home, dependencies }) => {
  const original = dependencies.command!, controller = new AbortController();
  const before = process.listenerCount("SIGINT"); dependencies.signal = controller.signal;
  dependencies.command = async (args, cwd, signal) => {
    if (args[0] !== "install") return original(args, cwd);
    const aborted = new Promise<never>((_resolve, reject) => { signal!.addEventListener("abort", () => { reject(new Error("Synthetic interrupted install")); }, { once: true }); });
    controller.abort(); return aborted;
  };
  await assert.rejects(updateProduct({ home, yes: true }, dependencies), { code: "UPDATE_INTERRUPTED" });
  assert.equal(process.listenerCount("SIGINT"), before);
  dependencies.command = original; dependencies.signal = undefined;
  const result = await updateProduct({ home, yes: true }, dependencies) as { updated: boolean }; assert.equal(result.updated, true);
}));

test("停止命令按POSIX或PowerShell安全引用路径", () => {
  const path = "/workspace/Project O'Neil";
  assert.equal(updateStopCommand(path, "darwin"), "am --home '/workspace/Project O'\\''Neil' stop");
  assert.equal(updateStopCommand("C:\\Work O'Neil\\Data", "win32"), "am --home 'C:\\Work O''Neil\\Data' stop");
});

test("取消交互确认不安装；确认期间依赖文件变化要求重新预览", async () => fixture(async ({ root, home, commands, dependencies }) => {
  dependencies.confirm = async () => false;
  assert.equal((await updateProduct({ home }, dependencies) as UpdatePreview).cancelled, true);
  dependencies.confirm = async () => { await writeFile(join(dirname(dirname(root)), "package-lock.json"), "{}"); return true; };
  await assert.rejects(updateProduct({ home }, dependencies), { code: "UPDATE_PREVIEW_CHANGED" });
  assert.equal(commands.some(args => args[0] === "install"), false);
}));

test("本地清单和锁文件保留恢复副本，npm不得改动无关清单字段", async () => fixture(async ({ root, home, dependencies }) => {
  const prefix = dirname(dirname(root)), lock = join(prefix, "package-lock.json"); await writeFile(lock, '{"lockfileVersion":3}');
  const original = dependencies.command!;
  dependencies.command = async (args, cwd) => {
    const result = await original(args, cwd);
    if (args[0] === "install") {
      const path = join(prefix, "package.json"), manifest = JSON.parse(await readFile(path, "utf8")); manifest.name = "unexpected-project"; await writeFile(path, JSON.stringify(manifest));
    }
    return result;
  };
  let backup: string | undefined;
  await assert.rejects(updateProduct({ home, yes: true }, dependencies), error => {
    assert.equal((error as RequestError).code, "UPDATE_FAILED"); backup = (error as { details: { backup: string } }).details.backup; return true;
  });
  assert.equal(JSON.parse(await readFile(join(backup!, "installation-files", "package.json"), "utf8")).name, "example-project");
  assert.equal(await readFile(join(backup!, "installation-files", "package-lock.json"), "utf8"), '{"lockfileVersion":3}');
}));
