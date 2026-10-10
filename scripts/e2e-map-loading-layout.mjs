import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";
import { writePreferences } from "../dist/service/preferences.js";

// 使用隔离服务和延迟响应，测量加载提示出现、消失前后的真实布局。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-map-loading-")));
const artifacts = fileURLToPath(new URL("../.local/map-loading-layout-e2e/", import.meta.url));
const browserName = `map-loading-${process.pid}`;
let service;
let opened = false;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${browserName}`, ...args], {
    cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
try {
  await mkdir(artifacts, { recursive: true });
  const repository = join(directory, "repo");
  await mkdir(join(repository, "src"), { recursive: true });
  await run("git", ["init", "-q", repository]);
  await writeFile(join(repository, "src/example.ts"), "export const example = 1;\n");
  const home = join(directory, "data");
  await mkdir(home); await writePreferences(home, "zh-CN");
  service = await startService({ home, roots: Object.fromEntries(clientIds.map(client => [client, []])),
    staticRoot: fileURLToPath(new URL("../dist/web", import.meta.url)),
    resourceInventory: { userHome: join(directory, "isolated-user"), environment: {} } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const registered = await fetch(`${base}/api/v1/repositories`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: repository }),
  });
  assert.equal(registered.status, 200);
  const { job } = await registered.json();
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await (await fetch(`${base}/api/v1/jobs/${job.id}`)).json();
    assert.notEqual(result.job.status, "failed");
    if (result.job.status === "completed") break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await browser(["open", base, "--headed", "--browser=chrome"]); opened = true;
  const verify = async (page, fixture) => {
    page.setDefaultTimeout(15_000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const { language, width, kind } = fixture;
    const ensure = (condition, message) => { if (!condition) throw new Error(message); };
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const positions = () => page.evaluate(() => [".metrics", ".code-map"].map(selector => document.querySelector(selector).getBoundingClientRect().top));
    await page.setViewportSize({ width, height: 900 });
    await page.reload(); await page.locator(".code-map").waitFor(); await page.waitForLoadState("networkidle");
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const pattern = `**/api/v1/repositories/*/${kind}?**`;
    await page.route(pattern, async route => {
      const response = await route.fetch(); await gate; await route.fulfill({ response });
    });
    const text = language === "zh-CN" ? kind === "sessions" ? "正在读取地图会话…" : "正在查询所选范围…"
      : kind === "sessions" ? "Loading map sessions…" : "Loading selected scope…";
    const loading = page.getByRole("status").filter({ hasText: text });
    try {
      if (kind === "sessions") await page.reload();
      else await page.getByRole("button", { name: language === "zh-CN" ? "刷新分析" : "Refresh analysis", exact: true }).click();
      await loading.waitFor(); await page.locator(".metrics").waitFor(); await page.locator(".code-map").waitFor();
      await frames();
      const before = await positions();
      const height = (await loading.boundingBox()).height;
      await page.screenshot({ path: `${fixture.artifacts}/${language}-${width}-${kind}-loading.png` });
      release(); await loading.waitFor({ state: "hidden" }); await page.waitForLoadState("networkidle"); await frames();
      const after = await positions();
      const shift = Math.max(...before.map((value, index) => Math.abs(value - after[index])));
      ensure(shift <= 1, `${language} ${width}px ${kind} 加载结束后地图及统计位移 ${shift}px`);
      ensure(height <= 24, `${kind} 加载提示占用 ${height}px 高度`);
      ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "加载提示导致横向溢出");
      ensure(errors.length === 0, errors.join(";"));
      return { passed: true, language, width, kind, height, shift, errors };
    } finally { release(); await page.unroute(pattern); }
  };
  const reports = [];
  for (const language of ["zh-CN", "en"]) {
    const saved = await fetch(`${base}/api/v1/preferences`, {
      method: "PUT", headers: { "Content-Type": "application/json", "x-agent-manor-instance": service.instance.id },
      body: JSON.stringify({ language }),
    });
    assert.equal(saved.status, 200);
    for (const width of [1440, 390]) for (const kind of ["sessions", "coverage"]) {
      if (kind === "coverage") await appendFile(join(repository, "src/example.ts"), "// 合成刷新改动\n");
      const result = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify({ language, width, kind, artifacts })})`]);
      reports.push(result);
      console.log(result.split("### Ran Playwright code")[0]);
    }
  }
  await writeFile(join(artifacts, "report.txt"), reports.join("\n"));
} catch (error) {
  if (opened) await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]).catch(() => {});
  throw error;
} finally {
  if (opened) await browser(["close"]).catch(() => {});
  await service?.close(); await rm(directory, { recursive: true, force: true });
}
