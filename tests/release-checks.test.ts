import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { isMessageDescriptorKnown, translateMessage } from "../src/i18n/index.js";
import { ReleaseService, RELEASE_CHECK_INTERVAL, compareVersions, stableVersion } from "../src/service/releases.js";
import type { InstallationKind } from "../src/updates/contracts.js";

const run = promisify(execFile);
async function fixture(t: { after(callback: () => Promise<void>): void }, kind: InstallationKind = "global") {
  const directory = await mkdtemp(join(tmpdir(), "agent-manor-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "product"), configBase = join(directory, "config"), home = join(directory, "data's 中文");
  await mkdir(root);
  let now = Date.parse("2026-01-01T00:00:00Z");
  let payload: unknown = { name: "agent-manor", version: "0.2.0", engines: { node: ">=24 <25" } };
  let status = 200, calls = 0;
  let failure: Error | undefined;
  const fetcher: typeof fetch = async (input, options) => {
    calls++;
    assert.match(String(input), /^https:\/\/registry\.npmjs\.org\/agent-manor\/(latest|[\da-zA-Z.+%-]+)$/);
    assert.deepEqual(options?.headers, { Accept: "application/json" });
    assert.equal(options?.redirect, "error");
    assert.equal(options?.body, undefined);
    if (failure) throw failure;
    return new Response(JSON.stringify(payload), { status });
  };
  const options = { root, home, configBase, now: () => now, fetch: fetcher, installation: { kind, root }, currentVersion: "0.1.0", nodeVersion: "24.1.0", platform: "linux" as const, arch: "x64" };
  const service = new ReleaseService(options);
  return { directory, root, configBase, home, options, service, calls: () => calls,
    advance: (milliseconds: number) => { now += milliseconds; }, payload: (value: unknown) => { payload = value && typeof value === "object" ? { name: "agent-manor", ...value } : value; }, http: (value: number) => { status = value; }, fail: (value?: Error) => { failure = value; } };
}

test("稳定版本采用严格 SemVer，构建信息不改变排序", () => {
  assert.equal(compareVersions("1.9.9", "1.10.0"), -1);
  assert.equal(compareVersions("2.0.0+build.a", "2.0.0+build.b"), 0);
  assert.equal(stableVersion("1.2.3+build.2"), "1.2.3+build.2");
  for (const version of ["latest", "v1.2.3", "1.2", "01.2.3", "1.2.3-beta.1", "1.2.3\n", "1.2.3 || *", null, 123]) assert.equal(stableVersion(version), null);
});

test("状态读取不联网、不建立配置目录；没有元信息保持 unknown/null", async t => {
  const f = await fixture(t);
  const status = await f.service.status();
  assert.equal(f.calls(), 0);
  assert.equal(status.checkState, "unknown");
  assert.equal(status.latestVersion, null);
  assert.equal(status.updateAvailable, null);
  assert.equal(status.checkedAt, null);
  assert.equal(status.installationKind, "global");
  await assert.rejects(stat(f.configBase), { code: "ENOENT" });
});

for (const [version, relation, available] of [["0.2.0", "behind", true], ["0.1.0", "current", false], ["0.0.9", "ahead", false]] as const) {
  test(`版本 ${version} 关系为 ${relation}，自动尝试在24小时内复用正负缓存`, async t => {
    const f = await fixture(t);
    f.payload({ version });
    const result = await f.service.check({ automatic: true });
    assert.equal(result.versionRelation, relation);
    assert.equal(result.updateAvailable, available);
    assert.equal(result.stale, false);
    assert.equal(result.checkState, "ready");
    await f.service.check({ automatic: true });
    assert.equal(f.calls(), 1);
    await f.service.check();
    assert.equal(f.calls(), 2);
    f.advance(RELEASE_CHECK_INTERVAL);
    assert.equal((await f.service.status()).stale, true);
    await f.service.check({ automatic: true });
    assert.equal(f.calls(), 3);
  });
}

test("网络失败保留上次成功结果，停止提醒且自动失败同样受24小时限制", async t => {
  const f = await fixture(t);
  const first = await f.service.check();
  assert.ok(first.checkedAt);
  f.advance(5000);
  f.fail(new Error("synthetic network failure"));
  const failed = await f.service.check();
  assert.equal(failed.checkState, "failed");
  assert.equal(failed.latestVersion, "0.2.0");
  assert.equal(failed.checkedAt, first.checkedAt);
  assert.equal(failed.stale, true);
  assert.equal(failed.error?.code, "UPDATE_CHECK_FAILED");
  assert.equal(await f.service.claimNotice(), null);
  await f.service.check({ automatic: true });
  assert.equal(f.calls(), 2);
  f.advance(RELEASE_CHECK_INTERVAL);
  f.fail();
  assert.equal((await f.service.check({ automatic: true })).checkState, "ready");
  assert.equal(f.calls(), 3);
});

test("首次检查失败不谎报最新版，手动检查不受失败缓存限制", async t => {
  const f = await fixture(t);
  f.fail(new Error("offline"));
  const failed = await f.service.check({ automatic: true });
  assert.equal(failed.updateAvailable, null);
  assert.equal(failed.latestVersion, null);
  assert.equal(failed.checkState, "failed");
  await f.service.check({ automatic: true });
  assert.equal(f.calls(), 1);
  f.fail();
  assert.equal((await f.service.check()).updateAvailable, true);
  assert.equal(f.calls(), 2);
});

for (const payload of [{}, { name: "different-product", version: "0.2.0" }, { version: "no-version" }, { version: "0.2.0-beta.1" }, { version: "0.2.0", engines: { node: "no-range" } }, { version: "0.2.0", cpu: "x64" }]) {
  test(`无效或预发布元信息失败：${JSON.stringify(payload)}`, async t => {
    const f = await fixture(t);
    f.payload(payload);
    const status = await f.service.check();
    assert.equal(status.checkState, "failed");
    assert.equal(status.error?.code, "UPDATE_METADATA_INVALID");
    assert.equal(status.updateAvailable, null);
    assert.equal(await f.service.claimNotice(), null);
  });
}

test("HTTP404区分包与指定版本不存在；异常JSON保留稳定诊断", async t => {
  const f = await fixture(t);
  f.http(404);
  assert.equal((await f.service.check()).error?.code, "UPDATE_PACKAGE_NOT_FOUND");
  assert.equal((await f.service.check({ target: "0.2.0" })).error?.code, "UPDATE_VERSION_NOT_FOUND");
  const bad = new ReleaseService({ ...f.options, fetch: async () => new Response("<html>invalid</html>") });
  assert.equal((await bad.check()).error?.code, "UPDATE_METADATA_INVALID");
  const missingName = new ReleaseService({ ...f.options, fetch: async () => Response.json({ version: "0.2.0" }) });
  assert.equal((await missingName.check()).error?.code, "UPDATE_METADATA_INVALID");
});

test("超时主动中止请求；即使mock忽略signal也能结束，自动不会连续重试", async t => {
  const f = await fixture(t);
  let signal: AbortSignal | null | undefined;
  let calls = 0;
  const service = new ReleaseService({ ...f.options, requestTimeout: 15, fetch: async (_, init) => { signal = init?.signal; calls++; return await new Promise<Response>(() => {}); } });
  const status = await service.check({ automatic: true });
  assert.equal(status.error?.code, "UPDATE_CHECK_TIMEOUT");
  assert.equal(signal?.aborted, true);
  await service.check({ automatic: true });
  assert.equal(calls, 1);
});

for (const [release, reason] of [
  [{ version: "0.2.0", engines: { node: ">=25" } }, "node"],
  [{ version: "0.2.0", os: ["darwin", "win32"] }, "os"],
  [{ version: "0.2.0", os: ["any", "!linux"] }, "os"],
  [{ version: "0.2.0", cpu: ["arm64"] }, "arch"],
] as const) {
  test(`新版本运行环境不兼容仍保留版本信息：${reason}`, async t => {
    const f = await fixture(t);
    f.payload(release);
    const result = await f.service.check();
    assert.equal(result.updateAvailable, true);
    assert.equal(result.latestVersion, "0.2.0");
    assert.equal(result.compatibility.compatible, false);
    assert.equal(result.compatibility.reason, reason);
    for (const language of ["en", "zh-CN"] as const) {
      const text = translateMessage(language, result.compatibility.messageDescriptor!);
      assert.ok(text && !text.includes("updates.") && !text.includes("{{"));
    }
  });
}

test("Node engines支持成熟范围表达式，不靠字符串判断；黑名单架构正常接受其他架构", async t => {
  const f = await fixture(t);
  for (const range of ["^24.0.0 || ^26.0.0", "24.0.0 - 24.9.9", ">=24 <25"]) {
    f.payload({ version: "0.2.0", engines: { node: range }, os: ["!win32"], cpu: ["!arm64"] });
    assert.equal((await f.service.check()).compatibility.compatible, true);
  }
});

test("同安装多home并发检查只请求一次，返回命令分别保留自己的目录", async t => {
  const f = await fixture(t);
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; await delay(30); return Response.json({ name: "agent-manor", version: "0.2.0" }); };
  const one = new ReleaseService({ ...f.options, fetch: fetcher });
  const two = new ReleaseService({ ...f.options, home: join(f.directory, "second home"), fetch: fetcher });
  const [a, b] = await Promise.all([one.check(), two.check()]);
  assert.equal(calls, 1);
  assert.match(a.updateCommand, /data/);
  assert.match(b.updateCommand, /second home/);
  const changedRuntime = new ReleaseService({ ...f.options, currentVersion: "0.3.0" });
  assert.equal((await changedRuntime.status()).versionRelation, "ahead");
});

test("跨进程同时主动检查通过安装锁合并为同一请求", async t => {
  const f = await fixture(t);
  const counter = join(f.directory, "requests.txt");
  const script = `
    import { appendFile } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    import { ReleaseService } from ${JSON.stringify(new URL("../src/service/releases.ts", import.meta.url).href)};
    const [root, configBase, counter] = process.argv.slice(1);
    const service = new ReleaseService({root, configBase, installation:{root,kind:'global'}, fetch:async()=>{
      await appendFile(counter, 'request\\n'); await delay(500); return Response.json({name:'agent-manor',version:'0.2.0'});
    }});
    console.log(JSON.stringify(await service.check()));
  `;
  const args = ["--import", "tsx", "--input-type=module", "-e", script, f.root, f.configBase, counter];
  const results = await Promise.all([run(process.execPath, args), run(process.execPath, args)]);
  assert.equal((await readFile(counter, "utf8")).trim().split("\n").length, 1);
  for (const result of results) assert.equal(JSON.parse(result.stdout).latestVersion, "0.2.0");
});

test("独立CLI进程同时结束也只领取一次提醒，专用环境变量仅影响该进程", async t => {
  const f = await fixture(t);
  await f.service.check();
  const script = `
    import { ReleaseService } from ${JSON.stringify(new URL("../src/service/releases.ts", import.meta.url).href)};
    const [root, configBase] = process.argv.slice(1);
    const service = new ReleaseService({root, configBase, now:()=>Date.parse('2026-01-01T00:00:00Z'), installation:{root,kind:'global'}});
    console.log(JSON.stringify(await service.claimNotice()));
  `;
  const args = ["--import", "tsx", "--input-type=module", "-e", script, f.root, f.configBase];
  const disabled = await run(process.execPath, args, { env: { ...process.env, AGENT_MANOR_NO_UPDATE_CHECK: "1" } });
  assert.equal(JSON.parse(disabled.stdout), null);
  const results = await Promise.all([run(process.execPath, args), run(process.execPath, args)]);
  assert.equal(results.map(result => JSON.parse(result.stdout)).filter(Boolean).length, 1);
  assert.equal((await f.service.settings()).autoCheck, true);
});

test("检查进行中只显示checking，完成后恢复ready", async t => {
  const f = await fixture(t);
  let finish: ((response: Response) => void) | undefined;
  const service = new ReleaseService({ ...f.options, fetch: async () => new Promise(resolve => { finish = resolve; }) });
  const checking = service.check();
  for (let attempt = 0; attempt < 30 && !finish; attempt++) await delay(5);
  assert.equal((await service.status()).checkState, "checking");
  finish!(Response.json({ name: "agent-manor", version: "0.2.0" }));
  assert.equal((await checking).checkState, "ready");
});

test("不同安装分别缓存；规范化同路径与多home共享设置", async t => {
  const f = await fixture(t);
  await f.service.settings({ autoCheck: false, ignoredVersion: "0.2.0" });
  const shared = new ReleaseService({ ...f.options, root: join(f.root, "."), home: join(f.directory, "other") });
  assert.deepEqual(await shared.settings(), { autoCheck: false, ignoredVersion: "0.2.0" });
  const otherRoot = join(f.directory, "another-product");
  await mkdir(otherRoot);
  const separate = new ReleaseService({ ...f.options, root: otherRoot, installation: { kind: "global", root: otherRoot } });
  assert.deepEqual(await separate.settings(), { autoCheck: true, ignoredVersion: null });
  await f.service.check();
  assert.equal((await separate.status()).latestVersion, null);
});

test("设置合并原子保存，不因并发PATCH丢字段，设置与缓存采用用户权限", async t => {
  const f = await fixture(t);
  await Promise.all([f.service.settings({ autoCheck: false }), new ReleaseService(f.options).settings({ ignoredVersion: "0.2.0" })]);
  assert.deepEqual(await f.service.settings(), { autoCheck: false, ignoredVersion: "0.2.0" });
  await f.service.check();
  const parent = join(f.configBase, "agent-manor", "installations");
  const directory = join(parent, (await readdir(parent))[0]!);
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const file of ["settings.json", "release-check.json"]) assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
  }
  const stored = await readFile(join(directory, "release-check.json"), "utf8");
  assert.equal(stored.includes("updateAvailable"), false);
  assert.equal(stored.includes(f.home), false);
  await rm(join(directory, "release-check.json"));
  assert.deepEqual(await f.service.settings(), { autoCheck: false, ignoredVersion: "0.2.0" });
});

test("持久缓存只保留必要发布字段，不保存完整registry响应或请求身份", async t => {
  const f = await fixture(t);
  f.payload({ version: "0.2.0", name: "agent-manor", description: "ignored text", author: "synthetic author", dist: { tarball: "https://example.invalid/unused.tgz" }, arbitrary: "unnecessary field" });
  await f.service.check();
  const parent = join(f.configBase, "agent-manor", "installations");
  const file = join(parent, (await readdir(parent))[0]!, "release-check.json");
  const value = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(value.release, { version: "0.2.0" });
  assert.deepEqual(Object.keys(value).sort(), ["attemptedAt", "checkedAt", "release", "revision"]);
});

test("未知设置字段、错误类型、空对象和预发布ignore都拒绝", async t => {
  const f = await fixture(t);
  for (const value of [{}, { bad: true }, { autoCheck: "false" }, { ignoredVersion: "next" }, { ignoredVersion: "0.2.0-beta.1" }, { autoCheck: undefined }]) {
    await assert.rejects(f.service.settings(value as never), { code: "INVALID_INPUT" });
  }
  for (const target of ["next", "v0.2.0", "0.2.0-beta.1", "0.2.0\n"]) await assert.rejects(f.service.check({ target }), { code: "INVALID_INPUT" });
  assert.equal(f.calls(), 0);
});

test("关闭自动检查同时禁止提醒，主动检查仍有效；进程覆盖不改变持久开关", async t => {
  const f = await fixture(t);
  await f.service.settings({ autoCheck: false });
  await f.service.check({ automatic: true });
  assert.equal(f.calls(), 0);
  await f.service.check();
  assert.equal(f.calls(), 1);
  assert.equal(await f.service.claimNotice(), null);
  await f.service.settings({ autoCheck: true });
  const disabled = new ReleaseService({ ...f.options, disableAutomatic: true });
  await disabled.check({ automatic: true });
  assert.equal(await disabled.claimNotice(), null);
  assert.equal((await disabled.settings()).autoCheck, true);
  assert.equal((await disabled.status()).automaticDisabled, true);
  assert.equal((await f.service.status()).automaticDisabled, false);
  await disabled.check();
  assert.equal(f.calls(), 2);
});

test("默认源码和临时安装不自动检查，手动检查可用且不能自更新", async t => {
  for (const kind of ["source", "ephemeral"] as const) {
    const f = await fixture(t, kind);
    const result = await f.service.check({ automatic: true });
    assert.equal(result.autoCheck, false);
    assert.equal(result.selfUpdateSupported, false);
    assert.equal(f.calls(), 0);
    const checked = await f.service.check();
    assert.equal(checked.latestVersion, "0.2.0");
    if (kind === "source") assert.match(checked.updateCommand, / update --check$/);
    else assert.equal(checked.updateCommand, "npm install --global agent-manor@0.2.0 --registry=https://registry.npmjs.org/");
  }
});

test("同版本24小时提醒一次，多个CLI并发只claim一次，过期缓存不提醒", async t => {
  const f = await fixture(t);
  await f.service.check();
  const claims = await Promise.all(Array.from({ length: 5 }, () => new ReleaseService(f.options).claimNotice()));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await f.service.claimNotice(), null);
  f.advance(RELEASE_CHECK_INTERVAL);
  assert.equal(await f.service.claimNotice(), null);
  await f.service.check();
  assert.equal((await f.service.claimNotice())?.latestVersion, "0.2.0");
});

test("忽略与恢复跨home共享，不改变检查结果，更高版本恢复提醒", async t => {
  const f = await fixture(t);
  await f.service.check();
  await f.service.settings({ ignoredVersion: "0.2.0" });
  assert.equal(await new ReleaseService(f.options).claimNotice(), null);
  assert.equal((await f.service.check()).updateAvailable, true);
  await f.service.settings({ ignoredVersion: null });
  assert.ok(await f.service.claimNotice());
  await f.service.settings({ ignoredVersion: "0.2.0" });
  f.payload({ version: "0.3.0" });
  await f.service.check();
  assert.equal((await f.service.claimNotice())?.latestVersion, "0.3.0");
});

test("指定版本不覆盖稳定缓存，显式响应必须匹配固定版本", async t => {
  const f = await fixture(t);
  await f.service.check();
  f.payload({ version: "0.1.5" });
  assert.equal((await f.service.check({ target: "0.1.5" })).latestVersion, "0.1.5");
  assert.equal((await f.service.status()).latestVersion, "0.2.0");
  assert.equal((await f.service.check({ target: "0.1.6" })).error?.code, "UPDATE_METADATA_INVALID");
  assert.equal((await f.service.status()).checkState, "ready");
});

test("旧计时器每次读取持久开关；停止调度不再发起请求", async t => {
  const f = await fixture(t);
  const service = new ReleaseService({ ...f.options, schedulerInterval: 15 });
  const stop = service.startAutoChecks();
  t.after(async () => stop());
  for (let attempt = 0; attempt < 30 && f.calls() === 0; attempt++) await delay(5);
  assert.equal(f.calls(), 1);
  await f.service.settings({ autoCheck: false });
  f.advance(RELEASE_CHECK_INTERVAL);
  await delay(50);
  assert.equal(f.calls(), 1);
  stop();
  await f.service.settings({ autoCheck: true });
  await delay(50);
  assert.equal(f.calls(), 1);
});

test("复制命令按POSIX与PowerShell引用home，并保留具体目标版本", async t => {
  const f = await fixture(t);
  await f.service.check();
  const posix = await f.service.status();
  assert.ok(posix.updateCommand.includes("'\\''"));
  assert.match(posix.updateCommand, / --to 0\.2\.0$/);
  const powershell = await new ReleaseService({ ...f.options, platform: "win32" }).status();
  assert.equal(powershell.shell, "powershell");
  assert.ok(powershell.updateCommand.includes("data''s 中文"));
});

test("缓存损坏退回未知，读状态不触发联网；失败描述中英文都有文案", async t => {
  const f = await fixture(t);
  f.fail(new Error("offline"));
  const failed = await f.service.check();
  assert.ok(isMessageDescriptorKnown(failed.error!.messageDescriptor));
  for (const language of ["en", "zh-CN"] as const) assert.notEqual(translateMessage(language, failed.error!.messageDescriptor), failed.error!.messageDescriptor.key);
  const parent = join(f.configBase, "agent-manor", "installations");
  const directory = join(parent, (await readdir(parent))[0]!);
  await writeFile(join(directory, "release-check.json"), "{broken");
  assert.equal((await f.service.status()).checkState, "unknown");
  assert.equal(f.calls(), 1);
});
