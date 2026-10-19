import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireInstallationOperation, assertInstalledVersion, installationContext, listInstallationServices, registerInstallationService } from "../src/service/installation.js";
import { updateProduct, type UpdateDependencies } from "../packages/cli/src/runtime/update.js";
import { acquireLock } from "../src/service/runtime.js";
import type { serviceStatus } from "../src/service/runtime.js";
import { VERSION } from "../src/version.js";

test("同一安装的其他home运行或仍在启动时拒绝更新，绝不停止另一个home", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-install-guard-"));
  const root = join(directory, "node_modules", "agent-manor"), a = join(directory, "home-a"), b = join(directory, "home-b");
  await mkdir(root, { recursive: true }); await mkdir(a); await mkdir(b);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "agent-manor", version: VERSION }));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "synthetic-project", dependencies: { "agent-manor": VERSION } }));
  const context = await installationContext(root);
  const release = await acquireInstallationOperation(context);
  const registration = await registerInstallationService(context, b); await release();
  let installed = false, stopped = false;
  const dependencies: UpdateDependencies = { root, configBase: join(directory, "configuration"),
    fetch: async () => new Response(JSON.stringify({ name: "agent-manor", version: "0.2.0" })),
    command: async args => { if (args[0] === "install") installed = true; return { stdout: join(directory, "global"), stderr: "" }; },
    status: (async () => ({ running: false, state: "stopped" })) as typeof serviceStatus,
    stop: async () => { stopped = true; return { stopped: true }; },
  };
  try {
    await assert.rejects(updateProduct({ home: a, yes: true }, dependencies), error => {
      assert.equal((error as { code?: string }).code, "SERVICE_BUSY");
      const details = (error as { details: { services: { home: string; state: string; pid: number }[] } }).details;
      assert.ok(details.services[0]!.home.endsWith("home-b")); assert.equal(details.services[0]!.state, "starting"); assert.equal(details.services[0]!.pid, process.pid);
      return true;
    });
    assert.equal(installed, false); assert.equal(stopped, false);
    await registration.running({ id: "synthetic-service-identity-b", pid: process.pid, host: "127.0.0.1", port: 1, startedAt: new Date().toISOString() });
    await assert.rejects(updateProduct({ home: a, yes: true, wait: true }, dependencies), { code: "SERVICE_BUSY" });
    assert.equal(installed, false); assert.equal(stopped, false);
    assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, VERSION);
    assert.equal((await listInstallationServices(context))[0]!.home.endsWith("home-b"), true);
    await registration.remove();
    const releaseStartup = await acquireLock(a, "startup.lock");
    const start = Date.now();
    try { await assert.rejects(updateProduct({ home: a, yes: true }, dependencies), { code: "SERVICE_BUSY" }); }
    finally { await releaseStartup(); }
    assert.ok(Date.now() - start < 1000, "更新不持安装锁等待启动父进程，避免锁顺序互等");
    const current = await registerInstallationService(context, a);
    try {
      await assert.rejects(updateProduct({ home: a, yes: true }, dependencies), { code: "SERVICE_BUSY" });
      await current.running({ id: "synthetic-unverified-service-a", pid: process.pid, host: "127.0.0.1", port: 1, startedAt: new Date().toISOString() });
      await assert.rejects(updateProduct({ home: a, yes: true }, dependencies), { code: "SERVICE_IDENTITY_UNVERIFIED" });
      assert.equal(installed, false); assert.equal(stopped, false);
    } finally { await current.remove(); }
  } finally { await registration.remove(); await rm(directory, { recursive: true, force: true }); }
});

test("安装级锁串行化启动与覆盖；canonical root归一且不同安装互不阻拦", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-install-lock-"));
  const root = join(directory, "install-a"), other = join(directory, "install-b"), base = join(directory, "private-registry");
  await mkdir(root); await mkdir(other);
  for (const path of [root, other]) await writeFile(join(path, "package.json"), JSON.stringify({ name: "agent-manor", version: VERSION }));
  await mkdir(base, { mode: 0o755 }); await chmod(base, 0o755);
  const a = await installationContext(root, base), b = await installationContext(other, base);
  const release = await acquireInstallationOperation(a);
  let acquired = false;
  const waiting = acquireInstallationOperation(a).then(done => { acquired = true; return done; });
  try {
    const releaseOther = await acquireInstallationOperation(b); await releaseOther();
    if (process.platform !== "win32") {
      assert.equal((await stat(base)).mode & 0o777, 0o755, "不改变用户指定父目录权限");
      assert.equal((await stat(a.directory)).mode & 0o777, 0o700);
    }
    assert.equal(acquired, false);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "agent-manor", version: "0.2.0" }));
    await release(); const releaseWaiting = await waiting;
    try { await assert.rejects(assertInstalledVersion(a), { code: "SERVICE_VERSION_MISMATCH" }); }
    finally { await releaseWaiting(); }
    if (process.platform !== "win32") {
      const alias = join(directory, "install-alias"); await symlink(root, alias, "dir");
      assert.deepEqual(await installationContext(alias, base), a);
    }
    const record = await registerInstallationService(b, join(directory, "home-b"));
    assert.equal((await listInstallationServices(a)).length, 0);
    await record.remove();
  } finally { await release(); await rm(directory, { recursive: true, force: true }); }
});
