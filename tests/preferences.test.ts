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
import { preferencesPath, readPreferences, writePreferences } from "../src/service/preferences.js";
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
  assert.deepEqual(await readPreferences(first), { language: "auto" });
  assert.deepEqual(await writePreferences(first, "zh-CN"), { language: "zh-CN" });
  assert.deepEqual(await readPreferences(first), { language: "zh-CN" });
  assert.deepEqual(await readPreferences(second), { language: "auto" });
  await writePreferences(second, "en");
  assert.deepEqual(await readPreferences(first), { language: "zh-CN" });
  assert.deepEqual(await readPreferences(second), { language: "en" });
  assert.equal((await stat(preferencesPath(first))).mode & 0o777, 0o600);
  await writePreferences(first, "auto");
  assert.deepEqual(JSON.parse(await readFile(preferencesPath(first), "utf8")), {});
  assert.deepEqual(await readPreferences(first), { language: "auto" });
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
  await assert.rejects(writePreferences(home, "en"), error => error instanceof ServiceError && error.message === "语言偏好未保存");
  assert.deepEqual(await readdir(home), ["preferences.json"]);
}));

test("真实 HTTP 设置读写遵循既有输入及跨站错误契约，写偏好不触发分析任务", async () => fixture(async directory => {
  const home = join(directory, "data");
  const service = await startService(options(directory, home));
  try {
    const before = await apiRequest<StatusResponse>(service.instance, "/status");
    assert.deepEqual(await apiRequest<PreferencesResponse>(service.instance, "/preferences"), { language: "auto" });
    assert.deepEqual(await apiRequest<PreferencesResponse>(service.instance, "/preferences", "PUT", { language: "en" }), { language: "en" });
    assert.deepEqual(await apiRequest<PreferencesResponse>(service.instance, "/preferences"), { language: "en" });
    for (const body of [{ language: "fr" }, { language: "en", extra: true }, {}, null]) {
      await assert.rejects(apiRequest(service.instance, "/preferences", "PUT", body), error => error instanceof RequestError && error.code === "INVALID_INPUT");
    }
    assert.deepEqual(await readPreferences(home), { language: "en" });
    const url = `http://127.0.0.1:${service.instance.port}/api/v1/preferences`;
    const forbidden = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://example.invalid" }, body: JSON.stringify({ language: "zh-CN" }) });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json() as { error: { code: string } }).error.code, "FORBIDDEN");
    const after = await apiRequest<StatusResponse>(service.instance, "/status");
    assert.deepEqual(after.jobs, before.jobs);
    assert.deepEqual(after.sessions, before.sessions);
    await apiRequest(service.instance, "/preferences", "PUT", { language: "auto" });
    assert.deepEqual(await readPreferences(home), { language: "auto" });
  } finally { await service.close(); }
}));

test("共享偏好在服务重启、会话索引清除及派生数据库移除后保留", async () => fixture(async directory => {
  const home = join(directory, "data");
  let service = await startService(options(directory, home));
  try {
    await apiRequest(service.instance, "/preferences", "PUT", { language: "zh-CN" });
    await service.close();
    service = await startService(options(directory, home));
    assert.deepEqual(await apiRequest<PreferencesResponse>(service.instance, "/preferences"), { language: "zh-CN" });
    const result = await apiRequest<{ job: SessionJob }>(service.instance, "/sessions/cache", "DELETE");
    let complete = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      const { job } = await apiRequest<{ job: SessionJob }>(service.instance, `/jobs/${result.job.id}`);
      if (job.status === "complete") { complete = true; break; }
      assert.notEqual(job.status, "failed", job.error);
      await delay(10);
    }
    assert.equal(complete, true, "隔离会话索引清除应完成");
    assert.deepEqual(await readPreferences(home), { language: "zh-CN" });
    await service.close();
    await rm(join(home, "index.sqlite"));
    service = await startService(options(directory, home));
    assert.deepEqual(await apiRequest<PreferencesResponse>(service.instance, "/preferences"), { language: "zh-CN" });
  } finally { await service.close(); }
}));

test("HTTP 保存与读取失败返回 INTERNAL_ERROR，不返回成功偏好", async () => fixture(async directory => {
  const home = join(directory, "data");
  const service = await startService(options(directory, home));
  try {
    await mkdir(preferencesPath(home));
    await assert.rejects(apiRequest(service.instance, "/preferences", "PUT", { language: "en" }), error => error instanceof RequestError && error.code === "INTERNAL_ERROR" && error.message === "语言偏好未保存");
    await assert.rejects(apiRequest(service.instance, "/preferences"), error => error instanceof RequestError && error.code === "INTERNAL_ERROR");
    assert.equal((await readdir(home)).some(name => name.startsWith("preferences.json.") && name.endsWith(".tmp")), false);
  } finally { await service.close(); }
}));
