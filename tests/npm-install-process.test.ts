import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runInstallProcess } from "../src/service/product-installation.js";
import { WINDOWS_INSTALL_PAYLOAD, windowsArgument, windowsInstallLaunch } from "../src/service/windows-install.js";

const processTimeout = process.platform === "win32" ? 45_000 : 4000;

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "manor-install-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, marker: join(directory, "worker.pid"), output: join(directory, "writes.txt") };
}
async function ready(path: string): Promise<void> {
  for (let attempt = 0; attempt < (process.platform === "win32" ? 3000 : 200); attempt++) {
    try { if ((await stat(path)).size) return; } catch { /* 合成后代仍在启动。 */ }
    await delay(10);
  }
  throw new Error("Synthetic child did not start");
}
function scripts(marker: string, output: string, mode: "hold" | "stdout" | "stderr" | "exit" = "hold"): string[] {
  const worker = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
    fs.appendFileSync(${JSON.stringify(output)}, 'started\\n');
    setInterval(() => fs.appendFileSync(${JSON.stringify(output)}, 'write\\n'), 10);
  `;
  const root = `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    // Windows 的普通 Node 后代随 Node 自有 Job 退出；detached 才能独立检验外层安装 Job。
    spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], {stdio:'ignore', detached:${process.platform === "win32"}});
    process.stdout.write('synthetic install started\\n');
    process.stderr.write('synthetic lifecycle log\\n');
    setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(marker)})) return;
      ${mode === "stdout" || mode === "stderr" ? `process.${mode}.write('x'.repeat(4096));` : mode === "exit" ? "process.exit(0);" : ""}
    }, 10);
  `;
  return ["-e", root];
}
async function writesStopped(output: string): Promise<void> {
  const before = await readFile(output, "utf8");
  await delay(100);
  assert.equal(await readFile(output, "utf8"), before, "安装锁可释放时，后代不得继续写入");
}

test("安装进程成功和非零退出都保留各自标准输出与错误输出", async () => {
  assert.deepEqual(await runInstallProcess(process.execPath, ["-e", "process.stdout.write('out');process.stderr.write('err')"]), { stdout: "out", stderr: "err" });
  await assert.rejects(runInstallProcess(process.execPath, ["-e", "process.stdout.write('out');process.stderr.write('err');process.exit(3)"]), error => {
    assert.equal((error as { code?: number }).code, 3);
    assert.equal((error as { stdout?: string }).stdout, "out");
    assert.equal((error as { stderr?: string }).stderr, "err");
    return true;
  });
});

test("安装进程缺省或空cwd继承当前目录，明确cwd使用指定目录", async t => {
  const f = await fixture(t);
  for (const cwd of [undefined, "", f.directory]) {
    const result = await runInstallProcess(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.cwd()))"], { cwd, timeout: processTimeout });
    assert.equal(await realpath(JSON.parse(result.stdout)), await realpath(cwd || process.cwd()));
  }
});

test("Windows原生参数引用覆盖空值、空格、引号与末尾反斜杠", () => {
  assert.equal(windowsArgument(""), '""');
  assert.equal(windowsArgument("plain"), '"plain"');
  assert.equal(windowsArgument("two words"), '"two words"');
  assert.equal(windowsArgument('a"b'), '"a\\"b"');
  assert.equal(windowsArgument("C:\\space dir\\"), '"C:\\space dir\\\\"');
  assert.equal(windowsArgument('\\"'), '"' + "\\".repeat(3) + '""');
});

test("Windows wrapper代码与命令参数分离编码，在建立Job之后才启动安装器", () => {
  const command = "C:\\Program Files\\Node\\node.exe", args = ["", "space value", 'quote"value', "中文", "$(Write-Output injected); '&"], cwd = "C:\\test data\\中文";
  const environment = { SystemRoot: "C:\\Windows", SYNTHETIC: "preserved" };
  const launch = windowsInstallLaunch(command, args, cwd, environment);
  assert.equal(launch.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(launch.args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.ok(launch.command.length + launch.args.join(" ").length < 32767, "固定wrapper必须保留在Windows命令行长度限制内");
  const script = Buffer.from(launch.args.at(-1)!, "base64").toString("utf16le");
  assert.ok(!script.includes(command) && !script.includes(cwd) && !script.includes("Write-Output injected"));
  assert.ok(script.includes("SetLimits(job, 0x00002000)") && script.includes("0x08000004"));
  assert.ok(script.indexOf("AssignProcessToJobObject(job, child.Process)") < script.indexOf("ResumeThread(child.Thread)"));
  assert.ok(script.includes("while (Active(job) != 0) Thread.Sleep(10)") && script.includes('line == "abort"'));
  assert.ok(script.includes("directory = string.IsNullOrEmpty(directory) ? null : directory;"));
  assert.ok(!script.includes("GetCurrentProcess()"));
  const payload = JSON.parse(Buffer.from(launch.env[WINDOWS_INSTALL_PAYLOAD]!, "base64").toString("utf8"));
  assert.deepEqual(payload, { command, arguments: [command, ...args].map(windowsArgument).join(" "), cwd });
  assert.equal(launch.env.SYNTHETIC, "preserved");
  assert.equal(Object.hasOwn(environment, WINDOWS_INSTALL_PAYLOAD), false);
  assert.equal(windowsInstallLaunch("different.exe", ["other"]).args.at(-1), launch.args.at(-1));
});

test("实际安装执行保留复杂argv，不把引号或PowerShell表达式当作代码", async () => {
  const args = ["", "space value", 'embedded"quote', "C:\\folder\\", "中文", "$(Write-Output injected); '&", "line\nvalue"];
  const result = await runInstallProcess(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args]);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test("找不到可执行文件时正确结束，预先取消不启动安装进程", async t => {
  const f = await fixture(t);
  await assert.rejects(runInstallProcess(join(f.directory, "missing-command"), []), error => {
    assert.equal((error as { code?: string }).code, "ENOENT");
    if (process.platform === "win32") assert.match((error as { stderr: string }).stderr, /CreateProcessW \(Win32 [23]\)/);
    return true;
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runInstallProcess(process.execPath, scripts(f.marker, f.output), { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(stat(f.marker), { code: "ENOENT" });
});

test("取消会终止整个安装进程组，忽略SIGTERM的生命周期后代也不能在返回后继续写", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  t.after(async () => controller.abort());
  const operation = runInstallProcess(process.execPath, scripts(f.marker, f.output), { signal: controller.signal, killGrace: 40, timeout: processTimeout });
  const rejected = assert.rejects(operation, error => {
    assert.equal((error as { code?: string }).code, "ABORT_ERR", String(error));
    assert.match((error as { stdout: string }).stdout, /synthetic install started/);
    assert.match((error as { stderr: string }).stderr, /synthetic lifecycle log/);
    return true;
  });
  await ready(f.marker);
  controller.abort();
  await rejected;
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await writesStopped(f.output);
});

test("安装超时先停止后代再返回ETIMEDOUT，不留下继续写入的生命周期脚本", async t => {
  const f = await fixture(t);
  const operation = runInstallProcess(process.execPath, scripts(f.marker, f.output), { timeout: process.platform === "win32" ? 35_000 : 750, killGrace: 40 });
  const rejected = assert.rejects(operation, { code: "ETIMEDOUT" });
  await ready(f.marker);
  await rejected;
  await writesStopped(f.output);
});

for (const stream of ["stdout", "stderr"] as const) {
  test(`安装${stream}溢出时保留有界日志，停止整组后代`, async t => {
    const f = await fixture(t);
    await assert.rejects(runInstallProcess(process.execPath, scripts(f.marker, f.output, stream), { maxBuffer: 1024, killGrace: 40, timeout: processTimeout }), error => {
      assert.equal((error as { code?: string }).code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      assert.ok(Buffer.byteLength((error as unknown as Record<string, string>)[stream]!) <= 1024);
      return true;
    });
    await writesStopped(f.output);
  });
}

test("直接安装进程结束后若仍有活动后代，先收束后代并拒绝误报安装完成", async t => {
  const f = await fixture(t);
  await assert.rejects(runInstallProcess(process.execPath, scripts(f.marker, f.output, "exit"), { killGrace: 40, timeout: processTimeout }), { code: "INSTALL_PROCESS_DESCENDANTS_RUNNING" });
  await writesStopped(f.output);
});
