import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { StatusResponse } from "../src/contracts.js";
import type { SessionJob } from "../src/session-contracts.js";
import type { PreferencesResponse } from "../src/i18n/types.js";
import { startService } from "../src/server.js";
import { ServiceError } from "../src/service/input.js";
import { preferencesPath, readPreferences, updatePreferences, writePreferences } from "../src/service/preferences.js";
import { apiRequest, delay, RequestError } from "../src/service/runtime.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-preferences-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

const options = (directory: string, home: string) => ({ home, startupRefresh: false, roots: isolatedHistoryRoots(), resourceInventory: { userHome: join(directory, "synthetic-user"), environment: {} } });

test("共享偏好按数据目录隔离，自动模式清除手动覆盖，设置文件限制访问", async () => fixture(async directory => {
  const first = join(directory, "first"), second = join(directory, "second");
  assert.deepEqual(await readPreferences(first), { language: "auto", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 });
  assert.deepEqual(await writePreferences(first, "zh-CN"), { language: "zh-CN", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 });
  assert.deepEqual(await readPreferences(first), { language: "zh-CN", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 });
  assert.deepEqual(await readPreferences(second), { language: "auto", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 });
  await writePreferences(second, "en");
  assert.deepEqual(await readPreferences(first), { language: "zh-CN", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 });
  assert.deepEqual(await readPreferences(second), { language: "en", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 });
  assert.equal((await stat(preferencesPath(first))).mode & 0o777, 0o600);
  await writePreferences(first, "auto");
  assert.deepEqual(JSON.parse(await readFile(preferencesPath(first), "utf8")), {});
  assert.deepEqual(await readPreferences(first), { language: "auto", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 });
  assert.deepEqual(await readdir(first), ["preferences.json"]);
}));

test("读取损坏或不可读设置与原子保存失败如实报错，临时文件清理", async () => fixture(async directory => {
  const home = join(directory, "data");
  await mkdir(home);
  await writeFile(preferencesPath(home), "{invalid");
  await assert.rejects(readPreferences(home), error => error instanceof ServiceError && error.code === "INTERNAL_ERROR");
  await writeFile(preferencesPath(home), JSON.stringify({ language: "unsupported" }));
  await assert.rejects(readPreferences(home), error => error instanceof ServiceError && error.code === "INTERNAL_ERROR");
  await rm(preferencesPath(home));
  await mkdir(preferencesPath(home));
  await assert.rejects(readPreferences(home), error => error instanceof ServiceError && error.code === "INTERNAL_ERROR");
  await assert.rejects(writePreferences(home, "en"), error => error instanceof ServiceError && error.message === "偏好设置未保存");
  assert.deepEqual(await readdir(home), ["preferences.json"]);
}));

test("真实 HTTP 设置读写遵循既有输入及跨站错误契约，写偏好不触发分析任务", async () => fixture(async directory => {
  const home = join(directory, "data");
  const service = await startService(options(directory, home));
  try {
    const before = await apiRequest<StatusResponse>(service.instance, "/status");
    assert.deepEqual(await apiRequest<PreferencesResponse>(service.instance, "/preferences"), { language: "auto", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 });
    assert.deepEqual(await apiRequest<PreferencesResponse>(service.instance, "/preferences", "PUT", { language: "en", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 }), { language: "en", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 });
    assert.deepEqual(await apiRequest<PreferencesResponse>(service.instance, "/preferences"), { language: "en", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 });
    for (const body of [{ language: "fr" }, { language: "en", extra: true }, {}, null]) {
      await assert.rejects(apiRequest(service.instance, "/preferences", "PUT", body), error => error instanceof RequestError && error.code === "INVALID_INPUT");
    }
    assert.deepEqual(await readPreferences(home), { language: "en", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 });
    const url = `http://127.0.0.1:${service.instance.port}/api/v1/preferences`;
    const forbidden = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://example.invalid" }, body: JSON.stringify({ language: "zh-CN", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 }) });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json() as { error: { code: string } }).error.code, "FORBIDDEN");
    const after = await apiRequest<StatusResponse>(service.instance, "/status");
    assert.deepEqual(after.jobs, before.jobs);
    assert.deepEqual(after.sessions, before.sessions);
    await apiRequest(service.instance, "/preferences", "PUT", { language: "auto", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 });
    assert.deepEqual(await readPreferences(home), { language: "auto", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 });
  } finally { await service.close(); }
}));

test("共享偏好在服务重启、会话索引清除及派生数据库移除后保留", async () => fixture(async directory => {
  const home = join(directory, "data");
  let service = await startService(options(directory, home));
  try {
    await apiRequest(service.instance, "/preferences", "PUT", { language: "zh-CN", sessionsAutoRefreshInterval: 300_000, mapAutoRefreshInterval: 600_000 });
    await service.close();
    service = await startService(options(directory, home));
    assert.deepEqual(await apiRequest<PreferencesResponse>(service.instance, "/preferences"), { language: "zh-CN", sessionsAutoRefreshInterval: 300_000, mapAutoRefreshInterval: 600_000 });
    const result = await apiRequest<{ job: SessionJob }>(service.instance, "/sessions/cache", "DELETE");
    let complete = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      const { job } = await apiRequest<{ job: SessionJob }>(service.instance, `/jobs/${result.job.id}`);
      if (job.status === "complete") { complete = true; break; }
      assert.notEqual(job.status, "failed", job.error);
      await delay(10);
    }
    assert.equal(complete, true, "隔离会话索引清除应完成");
    assert.deepEqual(await readPreferences(home), { language: "zh-CN", sessionsAutoRefreshInterval: 300_000, mapAutoRefreshInterval: 600_000 });
    await service.close();
    await rm(join(home, "index.sqlite"));
    service = await startService(options(directory, home));
    assert.deepEqual(await apiRequest<PreferencesResponse>(service.instance, "/preferences"), { language: "zh-CN", sessionsAutoRefreshInterval: 300_000, mapAutoRefreshInterval: 600_000 });
  } finally { await service.close(); }
}));

test("HTTP 保存与读取失败返回 INTERNAL_ERROR，不返回成功偏好", async () => fixture(async directory => {
  const home = join(directory, "data");
  const service = await startService(options(directory, home));
  try {
    await mkdir(preferencesPath(home));
    await assert.rejects(apiRequest(service.instance, "/preferences", "PUT", { language: "en", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 }), error => error instanceof RequestError && error.code === "INTERNAL_ERROR" && error.message === "偏好设置未保存");
    await assert.rejects(apiRequest(service.instance, "/preferences"), error => error instanceof RequestError && error.code === "INTERNAL_ERROR");
    assert.equal((await readdir(home)).some(name => name.startsWith("preferences.json.") && name.endsWith(".tmp")), false);
  } finally { await service.close(); }
}));


test("旧偏好默认关闭，独立与并发更新保留其他字段，失败后可以重试", async () => fixture(async directory => {
  const home = join(directory, "data"); await mkdir(home);
  await writeFile(preferencesPath(home), JSON.stringify({ language: "en" }));
  assert.deepEqual(await readPreferences(home), { language: "en", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 });
  await Promise.all([updatePreferences(home, { sessionsAutoRefreshInterval: 5_000 }), updatePreferences(home, { mapAutoRefreshInterval: 60_000 }), writePreferences(home, "zh-CN")]);
  assert.deepEqual(await readPreferences(home), { language: "zh-CN", sessionsAutoRefreshInterval: 5_000, mapAutoRefreshInterval: 60_000 });
  await writePreferences(home, "auto");
  assert.deepEqual(await readPreferences(home), { language: "auto", sessionsAutoRefreshInterval: 5_000, mapAutoRefreshInterval: 60_000 });
  await writeFile(preferencesPath(home), "invalid");
  await assert.rejects(updatePreferences(home, { sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 }));
  assert.equal(await readFile(preferencesPath(home), "utf8"), "invalid");
  await writeFile(preferencesPath(home), "{}");
  assert.deepEqual(await updatePreferences(home, { sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 }), { language: "auto", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 });
}));

test("刷新间隔通过 HTTP 严格校验并持久化，历史开关交给后台而地图不主动分析", async () => fixture(async directory => {
  const home = join(directory, "data");
  const service = await startService(options(directory, home));
  try {
    await apiRequest(service.instance, "/preferences", "PUT", { language: "en" });
    const expected = { language: "en", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 };
    for (const field of ["sessionsAutoRefreshInterval", "mapAutoRefreshInterval"] as const) {
      for (const interval of [0, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000]) {
        expected[field] = interval;
        assert.deepEqual(await apiRequest(service.instance, "/preferences", "PUT", { [field]: interval }), expected);
        assert.deepEqual(await readPreferences(home), expected);
      }
      for (const interval of [-1, 1, 4999, 5000.5, "5000", null, true]) {
        await assert.rejects(apiRequest(service.instance, "/preferences", "PUT", { [field]: interval }), { code: "INVALID_INPUT" });
      }
    }
    const status = await apiRequest<StatusResponse>(service.instance, "/status");
    assert.equal(status.jobs.length, 0);
    assert.ok(status.sessions?.job, "首次开启历史策略会立即提交全局检查");
    assert.equal(status.sessions.job.client, undefined);
    assert.equal(status.sessions.job.mode, "quick");
  } finally { await service.close(); }
}));

test("外观局部与并发更新不覆盖语言和刷新设置，旧文件保留迁移信号", async () => fixture(async directory => {
  const home = join(directory, "appearance");
  assert.equal((await readPreferences(home)).appearance, undefined);
  await Promise.all([
    updatePreferences(home, { appearance: { mode: "dark" } }),
    updatePreferences(home, { appearance: { preset: "custom", customColor: "#aabbcc" } }),
    updatePreferences(home, { language: "en", sessionsAutoRefreshInterval: 5_000 }),
  ]);
  const expected = { appearance: { mode: "dark", preset: "custom", customColor: "#aabbcc" }, language: "en", sessionsAutoRefreshInterval: 5_000, mapAutoRefreshInterval: 0 };
  assert.deepEqual(await readPreferences(home), expected);
  for (const appearance of [{}, null, { mode: "system" }, { preset: "missing" }, { customColor: "#abc" }, { extra: true }]) assert.throws(() => updatePreferences(home, { appearance }), { code: "INVALID_INPUT" });
  assert.deepEqual(await readPreferences(home), expected);
  await writeFile(preferencesPath(home), JSON.stringify({ appearance: { mode: "dark" } }));
  await assert.rejects(readPreferences(home), { code: "INTERNAL_ERROR" });
}));

test("HTTP 外观偏好校验与合并，保存不启动索引任务", async () => fixture(async directory => {
  const home = join(directory, "data"), service = await startService(options(directory, home));
  try {
    const before = await apiRequest<StatusResponse>(service.instance, "/status");
    await apiRequest(service.instance, "/preferences", "PUT", { appearance: { mode: "light", preset: "berry" } });
    const value = await apiRequest<PreferencesResponse>(service.instance, "/preferences", "PUT", { appearance: { customColor: "#123456" }, language: "en" });
    assert.deepEqual(value.appearance, { mode: "light", preset: "berry", customColor: "#123456" });
    for (const appearance of [{ preset: "unknown" }, { preset: { toString: {} } }, { preset: [] }, { customColor: "red" }, { mode: "auto", extra: true }, null]) await assert.rejects(apiRequest(service.instance, "/preferences", "PUT", { appearance }), { code: "INVALID_INPUT" });
    assert.deepEqual(await readPreferences(home), value);
    assert.deepEqual((await apiRequest<StatusResponse>(service.instance, "/status")).jobs, before.jobs);
  } finally { await service.close(); }
}));
