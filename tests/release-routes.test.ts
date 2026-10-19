import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startService } from "../src/server.js";
import { VERSION } from "../src/version.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";
import type { ReleaseStatus } from "../src/updates/contracts.js";

// 发布查询使用隔离依赖；实际路由、同源检查和后台生命周期仍按产品路径执行。
test("更新路由纯读不联网、主动检查失败可见、设置与业务目录独立且保留同源保护", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-release-routes-"));
  const home = join(directory, "home");
  const root = join(directory, "node_modules", "agent-manor");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "agent-manor", version: VERSION }));
  let requests = 0;
  let failure = false;
  const service = await startService({ home, port: 0, startupRefresh: false, noUpdateCheck: true,
    roots: isolatedHistoryRoots(), resourceInventory: { userHome: directory },
    releaseChecks: { root, configBase: join(directory, "config"), installationKind: "local",
      fetch: async () => { requests++; return failure ? new Response("missing", { status: 404 })
        : new Response(JSON.stringify({ name: "agent-manor", version: "0.2.0", engines: { node: ">=24" } })); } },
  });
  const inject = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, headers?: Record<string, string>) =>
    service.app.inject({ method, url: `/api/v1/update/${url}`, ...(payload === undefined ? {} : { payload }), headers: { host: `127.0.0.1:${service.instance.port}`, ...headers } });
  try {
    let result = await inject("GET", "status");
    assert.equal(result.statusCode, 200);
    assert.equal(result.json<ReleaseStatus>().checkState, "unknown");
    assert.equal(result.json<ReleaseStatus>().updateAvailable, null);
    assert.equal(requests, 0);
    result = await inject("POST", "check");
    assert.equal(result.statusCode, 200);
    assert.equal(result.json<ReleaseStatus>().latestVersion, "0.2.0");
    assert.equal(result.json<ReleaseStatus>().updateAvailable, true);
    assert.equal(requests, 1);
    await inject("GET", "status");
    assert.equal(requests, 1);
    result = await inject("PATCH", "settings", { ignoredVersion: "0.2.0", autoCheck: false });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json<ReleaseStatus>().ignoredVersion, "0.2.0");
    assert.equal(result.json<ReleaseStatus>().autoCheck, false);
    assert.equal(result.json<ReleaseStatus>().updateAvailable, true);
    result = await inject("PATCH", "settings", { ignoredVersion: null });
    assert.equal(result.json<ReleaseStatus>().ignoredVersion, null);
    for (const payload of [{ autoCheck: "false" }, { registry: "https://example.invalid" }, {}, []]) {
      assert.equal((await inject("PATCH", "settings", payload)).statusCode, 400);
    }
    assert.equal((await inject("POST", "check", { target: "0.3.0" })).statusCode, 400);
    for (const headers of [{ origin: "https://example.invalid" }, { "sec-fetch-site": "cross-site" }, { "x-agent-manor-instance": "different" }]) {
      assert.equal((await inject("PATCH", "settings", { autoCheck: true }, headers)).statusCode, 403);
    }
    assert.equal((await inject("POST", "install")).statusCode, 404);
    failure = true;
    result = await inject("POST", "check");
    const failed = result.json<ReleaseStatus>();
    assert.equal(failed.checkState, "failed");
    assert.ok(failed.error?.code);
    assert.equal(failed.latestVersion, "0.2.0");
    assert.equal(requests, 2);
    assert.equal((await service.app.inject({ url: "/api/v1/preferences", headers: { host: `127.0.0.1:${service.instance.port}` } })).json().language, "auto");
    assert.equal((await service.app.inject({ url: "/api/v1/status?response=summary", headers: { host: `127.0.0.1:${service.instance.port}` } })).statusCode, 200);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
