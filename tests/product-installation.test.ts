import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectInstallation } from "../src/service/product-installation.js";

test("自定义全局prefix须核验两个bin入口，缺入口或存在项目清单不推断全局覆盖", async t => {
  const directory = await mkdtemp(join(tmpdir(), "manor-custom-prefix-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "agent-manor");
  const bin = process.platform === "win32" ? directory : join(directory, "bin");
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(root, "dist", "cli.js"), "export {};\n");
  for (const name of ["am", "agent-manor"]) {
    if (process.platform === "win32") await writeFile(join(bin, `${name}.cmd`), '@node "%~dp0\\node_modules\\agent-manor\\dist\\cli.js" %*');
    else await symlink(join(root, "dist", "cli.js"), join(bin, name));
  }
  const command = async () => ({ stdout: join(directory, "different-global"), stderr: "" });
  const installation = await detectInstallation(root, command);
  assert.equal(installation.kind, "global");
  assert.equal(installation.prefix, await realpath(directory));
  await rm(join(bin, process.platform === "win32" ? "am.cmd" : "am"));
  assert.equal((await detectInstallation(root, command)).kind, "source");
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "demo-project" }));
  assert.equal((await detectInstallation(root, command)).kind, "source");
});

test("源码目录不探测npm配置，不把全局链接回源码的安装视为可覆盖包", async t => {
  const directory = await mkdtemp(join(tmpdir(), "manor-source-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  assert.equal((await detectInstallation(directory, async () => { calls++; throw new Error("Should not run"); })).kind, "source");
  assert.equal(calls, 0);
});
