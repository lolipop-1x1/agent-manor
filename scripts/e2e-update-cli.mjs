import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { VERSION } from "../dist/version.js";

// 调用真实编译后的 CLI；仅 registry 与 npm 安装子进程由预加载模块替换。
const run = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-cli-release-")));
const artifacts = join(repo, ".local", "software-updates", "cli");
const prefix = join(directory, "demo project");
const root = join(prefix, "node_modules", "agent-manor");
const home = join(directory, "demo data");
const config = join(directory, "config");
const entry = join(root, "dist", "cli.js");
const stateFile = join(directory, "mock.json");
const steps = [];
await mkdir(artifacts, { recursive: true });
try {
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "agent-manor", version: VERSION, type: "module" }));
  await writeFile(join(prefix, "package.json"), JSON.stringify({ name: "demo", dependencies: { "agent-manor": VERSION } }));
  await cp(join(repo, "dist"), join(root, "dist"), { recursive: true });
  // 依赖只读复用，安装目标和数据目录保持隔离。
  await symlink(join(repo, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const preload = join(directory, "preload.mjs");
  await writeFile(preload, `import cp from 'node:child_process';
import {promisify} from 'node:util';
import {syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
const stateFile=${JSON.stringify(stateFile)}, root=${JSON.stringify(root)}, prefix=${JSON.stringify(prefix)};
const original=cp.execFile, originalAsync=promisify(original);
async function command(file,args,options){
  if(file!=='npm') return originalAsync(file,args,options);
  const state=JSON.parse(await fs.readFile(stateFile,'utf8'));
  if(args[0]==='root') return {stdout:path.join(prefix,'absent-global'),stderr:''};
  if(args[0]==='prefix') return {stdout:prefix,stderr:''};
  if(args[0]==='install') {
    state.installs=(state.installs??0)+1; await fs.writeFile(stateFile,JSON.stringify(state));
    if(state.installFailure) throw new Error('Synthetic npm installation failure');
    const version=args.at(-1).slice('agent-manor@'.length);
    const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')); manifest.version=version;
    await fs.writeFile(path.join(root,'package.json'),JSON.stringify(manifest));
    const project=JSON.parse(await fs.readFile(path.join(prefix,'package.json'),'utf8')); project.dependencies['agent-manor']=version;
    await fs.writeFile(path.join(prefix,'package.json'),JSON.stringify(project));
    return {stdout:'Synthetic npm install completed',stderr:''};
  }
  throw new Error('Unexpected npm command');
}
const replacement=function(...args){return original(...args)}; replacement[promisify.custom]=command;
cp.execFile=replacement; syncBuiltinESMExports();
const originalFetch=globalThis.fetch;
globalThis.fetch=async (url,options)=>{
 if(String(url).startsWith('https://registry.npmjs.org/agent-manor/')) {
  const state=JSON.parse(await fs.readFile(stateFile,'utf8'));
  if(state.registryFailure)return new Response('missing',{status:404});
  return new Response(JSON.stringify({name:'agent-manor',version:state.version??'0.2.0',engines:{node:state.engines??'>=24'}}));
 }
 return originalFetch(url,options);
};
`);
  async function state(patch = {}) { await writeFile(stateFile, JSON.stringify({ version: "0.2.0", installs: 0, ...patch })); }
  async function cli(name, args, expectedCode = 0, language = "en") {
    let result;
    try { result = { ...await run(process.execPath, ["--import", preload, entry, "--home", home, "--lang", language, ...args], {
      timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, XDG_CONFIG_HOME: config, APPDATA: config, HOME: directory, USERPROFILE: directory, CI: "1" },
    }), code: 0 }; }
    catch (error) { result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code }; }
    await writeFile(join(artifacts, `${name}.txt`), `$ am ${args.join(" ")}\nexit: ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.code, expectedCode, name);
    const raw = result.code ? result.stderr : result.stdout;
    const value = args.includes("--json") ? JSON.parse(raw.trim()) : raw;
    steps.push({ name, code: result.code });
    return value;
  }
  await state();
  let value = await cli("01-status-before-check", ["update", "status", "--json"]);
  assert.equal(value.updateAvailable, null);
  value = await cli("02-check-new-version", ["update", "--check", "--json"]);
  assert.equal(value.latestVersion, "0.2.0"); assert.equal(value.updateAvailable, true);
  value = await cli("03-preview", ["update", "--dry-run", "--json"]);
  assert.equal(value.installation.kind, "local"); assert.equal(value.targetVersion, "0.2.0");
  value = await cli("04-confirmation-required", ["update", "--json"], 1);
  assert.equal(value.error.code, "CONFIRMATION_REQUIRED"); assert.equal(value.error.details.preview.targetVersion, "0.2.0");
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).installs, 0);
  await cli("05-settings-disable", ["update", "settings", "set", "--data", '{"autoCheck":false}', "--json"]);
  value = await cli("06-settings-get", ["update", "settings", "get", "--json"]); assert.equal(value.autoCheck, false);
  await cli("07-settings-ignore", ["update", "settings", "set", "--data", '{"ignoredVersion":"0.2.0"}', "--json"]);
  value = await cli("08-settings-invalid", ["update", "settings", "set", "--data", '{"autoCheck":"no"}', "--json"], 1);
  assert.equal(value.error.code, "INVALID_INPUT");
  await cli("09-check-chinese", ["update", "--check"], 0, "zh-CN");
  await state({ registryFailure: true });
  value = await cli("10-registry-not-found", ["update", "--check", "--json"], 1); assert.equal(value.error.code, "UPDATE_PACKAGE_NOT_FOUND");
  await state({ version: "0.0.1" });
  value = await cli("11-downgrade", ["update", "--to", "0.0.1", "--yes", "--json"], 1); assert.equal(value.error.code, "DOWNGRADE_UNSUPPORTED");
  value = await cli("12-prerelease-rejected", ["update", "--to", "0.2.0-beta.1", "--json"], 1); assert.equal(value.error.code, "INVALID_INPUT");
  await state({ engines: ">=999" });
  value = await cli("13-incompatible", ["update", "--dry-run", "--json"]); assert.ok(value.blockers.some(item => item.code === "UPDATE_INCOMPATIBLE"));
  await state({ installFailure: true });
  value = await cli("14-install-failure", ["update", "--yes", "--json"], 1); assert.equal(value.error.code, "UPDATE_FAILED");
  assert.ok(value.error.details.backup); assert.ok(value.error.details.logPath);
  assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, VERSION);
  await state();
  value = await cli("15-explicit-install-success", ["update", "--yes", "--json"]);
  assert.equal(value.updated, true); assert.equal(value.targetVersion, "0.2.0");
  assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, "0.2.0");
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).installs, 1);
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ syntheticRegistryAndInstaller: true, steps }, null, 2));
  console.log(`${steps.length} 项真实 CLI 子进程场景通过；registry 与安装器使用隔离 mock。`);
} finally { await rm(directory, { recursive: true, force: true }); }
