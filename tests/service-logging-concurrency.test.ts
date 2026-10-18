import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { serviceLog } from "../src/service/logging.js";
import { startService } from "../src/server.js";
import { installationContext, listInstallationServices } from "../src/service/installation.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";
const run = promisify(execFile);

test("八进程并发写入与轮换不会ENOENT退出，日志仍是完整JSON行且最多五份", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-log-concurrency-"));
  const module = fileURLToPath(new URL("../src/service/logging.ts", import.meta.url));
  const hook = fileURLToPath(import.meta.resolve("tsx/esm"));
  try {
    const script = `import {serviceLog} from ${JSON.stringify(module)}; for(let index=0;index<100;index++) serviceLog(process.argv[1], 'synthetic.event', {index,pid:process.pid}, 1024);`;
    await Promise.all(Array.from({ length: 8 }, () => run(process.execPath, ["--import", hook, "--input-type=module", "-e", script, home], { timeout: 30_000 })));
    const files = (await readdir(join(home, "logs"))).filter(name => /^service\.log(?:\.[1-4])?$/.test(name));
    assert.ok(files.length > 1 && files.length <= 5);
    for (const file of files) {
      const path = join(home, "logs", file); const content = await readFile(path, "utf8");
      assert.ok(Buffer.byteLength(content) <= 1024);
      for (const line of content.trim().split("\n")) assert.equal(JSON.parse(line).event, "synthetic.event");
      if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("日志目录不可写或变成文件时，启动与关闭仍清理实例、锁和安装登记", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-log-unwritable-"));
  const context = await installationContext();
  try {
    await writeFile(join(home, "logs"), "synthetic non-directory");
    assert.doesNotThrow(() => serviceLog(home, "synthetic.test"));
    const service = await startService({ home, port: 0, startupRefresh: false, roots: isolatedHistoryRoots() });
    assert.ok((await listInstallationServices(context)).some(item => item.instance?.id === service.instance.id));
    await service.close();
    await assert.rejects(readFile(join(home, "service.json")), { code: "ENOENT" });
    await assert.rejects(stat(join(home, "service.lock")), { code: "ENOENT" });
    assert.equal((await listInstallationServices(context)).some(item => item.instance?.id === service.instance.id), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
