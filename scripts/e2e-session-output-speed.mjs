import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";
import { summarizeRequestSpeed } from "../dist/session-speed.js";
import { SessionStore } from "../dist/sessions/store.js";
import { writePreferences } from "../dist/service/preferences.js";
import { sessionSpeedFixture, indexSpeedBranchFixture } from "./session-speed-fixture.mjs";
import { encodeSession } from "./session-fixture.mjs";

// 仅合成来源、独立服务与独立浏览器；--api-only 供界面集成前核验验收数据。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-speed-e2e-")));
const artifacts = fileURLToPath(new URL("../.local/session-output-speed-e2e/", import.meta.url));
const browserName = `speed-${process.pid}`;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${browserName}`, ...args], {
    cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
const roots = Object.fromEntries(clientIds.map(client => [client, []]));
const fixture = sessionSpeedFixture();
let service;
let opened = false;
try {
  await mkdir(artifacts, { recursive: true });
  for (const source of fixture.files) {
    roots[source.client] = join(directory, source.client);
    await mkdir(roots[source.client], { recursive: true });
    await writeFile(join(roots[source.client], source.name), encodeSession(source.records));
  }
  const home = join(directory, "data");
  await mkdir(home); await writePreferences(home, "zh-CN");
  service = await startService({ home, port: 0, roots, resourceInventory: { environment: {}, userHome: join(directory, "isolated-user") } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const api = async path => {
    const response = await fetch(`${base}/api/v1${path}`);
    assert.ok(response.ok, `HTTP ${response.status}: ${path}`);
    return response.json();
  };
  let status;
  for (let attempt = 0; attempt < 400; attempt++) {
    status = await api("/sessions/status");
    if (status.job?.status === "failed") throw new Error(status.job.error);
    if (status.version) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(status.version, "合成历史未能发布索引");
  const list = await api("/sessions?includeSubagents=true");
  const profiles = [];
  for (const source of fixture.files) {
    const session = list.sessions.find(item => item.clientSessionId === source.id);
    assert.ok(session, `未发现 ${source.id}`);
    const profile = await api(`/sessions/${encodeURIComponent(session.id)}/profile`);
    const speed = summarizeRequestSpeed(profile.steps);
    assert.deepEqual(speed, source.expected, `${source.client} 请求速度与覆盖`);
    profiles.push({ client: source.client, source: source.id, speed });
  }
  const parent = list.sessions.find(item => item.clientSessionId === "speed-codex");
  const tree = await api(`/sessions/${encodeURIComponent(parent.id)}/profile?includeChildren=true`);
  assert.deepEqual(summarizeRequestSpeed(tree.steps), fixture.treeExpected, "父子范围平均");

  // 已发布的原生历史保持原样；额外索引仅用于可控的分支速度界面验证。
  const store = new SessionStore(join(home, "index.sqlite"));
  let branch;
  try {
    const existing = store.cachedRevisions();
    branch = indexSpeedBranchFixture(store, join(directory, "synthetic-branch-ui.jsonl"));
    store.publish(store.createJob().id, [...existing, branch], []);
  } finally { store.close(); }
  await writeFile(join(artifacts, "api-report.json"), JSON.stringify({ profiles, tree: summarizeRequestSpeed(tree.steps),
    directIndexBranchFixture: { purpose: "只验证 UI 分支范围", session: branch.id } }, null, 2) + "\n");
  if (!process.argv.includes("--api-only")) {
    await browser(["open", `${base}/#sessions?id=${encodeURIComponent(parent.id)}&mode=brief`, "--headed", "--browser=chrome"]);
    opened = true;
    const verify = async page => {
      page.setDefaultTimeout(15_000);
      const button = name => page.getByRole("button", { name, exact: true });
      const ensure = (value, message) => { if (!value) throw new Error(message); };
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole("heading", { name: "吐字速度验收", exact: true }).waitFor();
      await page.getByText(/平均.*≈\s*26\s*tok\/s/).first().waitFor();
      await button("吐字速度说明").click();
      const help = page.getByRole("dialog", { name: "吐字速度说明", exact: true });
      await help.waitFor();
      ensure((await help.innerText()).includes("200") && (await help.innerText()).includes("1 秒"), "帮助缺少计算门槛");
      await help.press("Escape");
      ensure(await button("吐字速度说明").evaluate(element => element === document.activeElement), "关闭帮助未返回触发按钮");
      await button("全部记录").click();
      await page.getByText(/请求.*≈\s*40\s*tok\/s/).first().waitFor();
      await button("执行轨迹").click();
      await page.getByRole("columnheader", { name: "速度", exact: true }).waitFor();
      ensure(new URLSearchParams((await page.evaluate(() => location.hash)).split("?")[1]).get("mode") === "trace", "显示改名改变稳定模式参数");
      await page.getByRole("tab", { name: "用量", exact: true }).click();
      await page.locator(".session-profile").getByText(/平均.*≈\s*26\s*tok\/s/).first().waitFor();
      await page.screenshot({ path: ARTIFACTS + "/desktop-speed.png" });
      return { nativeApiVerified: true, fourViews: true, algorithmHelp: true, stableTraceMode: true };
    };
    const output = await browser(["run-code", verify.toString().replaceAll("ARTIFACTS", JSON.stringify(artifacts))]);
    await writeFile(join(artifacts, "browser-report.txt"), output);
    console.log(output.split("### Ran Playwright code")[0]);
  }
  assert.ok(JSON.parse(await readFile(join(artifacts, "api-report.json"), "utf8")).profiles.length === 8);
  console.log(process.argv.includes("--api-only") ? "合成原生数据 API 验收通过；浏览器未执行。" : "合成历史与四处速度界面验收通过。");
} catch (failure) {
  if (opened) {
    try {
      await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]);
      await writeFile(join(artifacts, "failure-state.txt"), await browser(["snapshot"]));
    } catch { /* 浏览器关闭时保留最初的失败。 */ }
  }
  throw failure;
} finally {
  if (opened) try { await browser(["close"]); } catch { /* 失败路径也清理隔离服务。 */ }
  await service?.close();
  await rm(directory, { recursive: true, force: true });
}
