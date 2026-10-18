import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { updateProduct, type UpdateDependencies } from "../packages/cli/src/runtime/update.js";
import { RequestError, serviceStatus, stopService } from "../src/service/runtime.js";
import { VERSION } from "../src/version.js";

async function fixture(operation: (context: { root: string; home: string; commands: string[][]; dependencies: UpdateDependencies }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-update space-"));
  const root = join(directory, "install", "node_modules", "agent-manor");
  const home = join(directory, "data");
  const commands: string[][] = [];
  await mkdir(root, { recursive: true }); await mkdir(home);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "agent-manor", version: VERSION }));
  await writeFile(join(home, "preferences.json"), JSON.stringify({ language: "en" }), { mode: 0o600 });
  const dependencies: UpdateDependencies = {
    root,
    fetch: async () => new Response(JSON.stringify({ name: "agent-manor", version: "0.2.0" })),
    command: async args => {
      commands.push(args);
      if (args[0] === "root") return { stdout: join(directory, "global"), stderr: "" };
      if (args[0] === "install") await writeFile(join(root, "package.json"), JSON.stringify({ name: "agent-manor", version: "0.2.0" }));
      return { stdout: "", stderr: "" };
    },
    status: (async () => ({ running: false })) as typeof serviceStatus,
  };
  try { await operation({ root, home, commands, dependencies }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("更新检查只读取版本，实际本地更新使用官方源且保留数据备份", async () => fixture(async ({ root, home, commands, dependencies }) => {
  const check = await updateProduct({ home, check: true }, dependencies) as { installation: { kind: string }; updateAvailable: boolean };
  assert.equal(check.installation.kind, "local"); assert.equal(check.updateAvailable, true);
  assert.equal(commands.some(command => command[0] === "install"), false);
  const updated = await updateProduct({ home, target: "0.2.0" }, dependencies) as { updated: boolean; backup: string };
  assert.equal(updated.updated, true);
  assert.equal(await readFile(join(home, "preferences.json"), "utf8"), await readFile(join(updated.backup, "data", "preferences.json"), "utf8"));
  const install = commands.find(command => command[0] === "install")!;
  assert.deepEqual(install, ["install", "--prefix", await realpath(dirname(dirname(root))), "--engine-strict", "--registry", "https://registry.npmjs.org/", "agent-manor@0.2.0"]);
  assert.equal(JSON.parse(await readFile(join(updated.backup, "manifest.json"), "utf8")).fromVersion, VERSION);
}));

test("更新在途任务拒绝时不覆盖安装，显式等待后切换服务", async () => fixture(async ({ root, home, commands, dependencies }) => {
  dependencies.status = (async () => ({ running: true })) as typeof serviceStatus;
  dependencies.stop = (async () => { throw new RequestError("SERVICE_BUSY", "Synthetic active job"); }) as typeof stopService;
  await assert.rejects(updateProduct({ home }, dependencies), (error: unknown) => error instanceof RequestError && error.code === "SERVICE_BUSY");
  assert.equal(commands.some(command => command[0] === "install"), false);
  let waited = false;
  dependencies.stop = (async (_home, options) => { waited = options?.wait === true; return { stopped: true }; }) as typeof stopService;
  let restarted = false;
  dependencies.restart = async (installedRoot, dataDirectory) => { assert.equal(installedRoot, root); assert.equal(dataDirectory, home); restarted = true; return { running: true }; };
  await updateProduct({ home, wait: true }, dependencies);
  assert.equal(waited, true); assert.equal(restarted, true);
}));

test("更新安装失败保留恢复材料，源代码目录和临时安装不自覆盖", async () => fixture(async ({ root, home, commands, dependencies }) => {
  dependencies.command = async args => {
    commands.push(args);
    if (args[0] === "root") return { stdout: join(root, "absent-global"), stderr: "" };
    throw new Error("Synthetic installation failure");
  };
  await assert.rejects(updateProduct({ home }, dependencies), (error: unknown) => error instanceof RequestError && error.code === "UPDATE_FAILED" && error.message.includes(".backups"));
  assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, VERSION);
  await assert.rejects(updateProduct({ home, target: "0.2.0; invalid" }, dependencies), (error: unknown) => error instanceof RequestError && error.code === "INVALID_INPUT");
  dependencies.root = home;
  await assert.rejects(updateProduct({ home }, dependencies), (error: unknown) => error instanceof RequestError && error.code === "INSTALLATION_UNSUPPORTED");
}));
