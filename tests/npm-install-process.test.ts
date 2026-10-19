import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runInstallProcess } from "../src/service/product-installation.js";

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "manor-install-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, marker: join(directory, "worker.pid"), output: join(directory, "writes.txt") };
}
async function ready(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
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
    spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], {stdio:'ignore'});
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

test("找不到可执行文件时正确结束，预先取消不启动安装进程", async t => {
  const f = await fixture(t);
  await assert.rejects(runInstallProcess(join(f.directory, "missing-command"), []), { code: "ENOENT" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runInstallProcess(process.execPath, scripts(f.marker, f.output), { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(stat(f.marker), { code: "ENOENT" });
});

test("取消会终止整个安装进程组，忽略SIGTERM的生命周期后代也不能在返回后继续写", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  t.after(async () => controller.abort());
  const operation = runInstallProcess(process.execPath, scripts(f.marker, f.output), { signal: controller.signal, killGrace: 40, timeout: 4000 });
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
  const operation = runInstallProcess(process.execPath, scripts(f.marker, f.output), { timeout: 750, killGrace: 40 });
  const rejected = assert.rejects(operation, { code: "ETIMEDOUT" });
  await ready(f.marker);
  await rejected;
  await writesStopped(f.output);
});

for (const stream of ["stdout", "stderr"] as const) {
  test(`安装${stream}溢出时保留有界日志，停止整组后代`, async t => {
    const f = await fixture(t);
    await assert.rejects(runInstallProcess(process.execPath, scripts(f.marker, f.output, stream), { maxBuffer: 1024, killGrace: 40, timeout: 4000 }), error => {
      assert.equal((error as { code?: string }).code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      assert.ok(Buffer.byteLength((error as unknown as Record<string, string>)[stream]!) <= 1024);
      return true;
    });
    await writesStopped(f.output);
  });
}

test("直接安装进程结束后若仍有活动后代，先收束后代并拒绝误报安装完成", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  await assert.rejects(runInstallProcess(process.execPath, scripts(f.marker, f.output, "exit"), { killGrace: 40, timeout: 4000 }), { code: "INSTALL_PROCESS_DESCENDANTS_RUNNING" });
  await writesStopped(f.output);
});
