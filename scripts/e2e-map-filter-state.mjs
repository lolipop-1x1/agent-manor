import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";
import { writePreferences } from "../dist/service/preferences.js";

// 合成仓库、独立后台及浏览器，覆盖筛选等待、失败、恢复与迟到响应。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-map-filter-")));
const artifacts = fileURLToPath(new URL("../.local/map-filter-state-e2e/", import.meta.url));
const session = `map-filter-${process.pid}`;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${session}`, ...args], {
    cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 120_000, maxBuffer: 5 * 1024 * 1024,
  });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
let service;
try {
  await mkdir(artifacts, { recursive: true });
  const repository = join(directory, "repo"), history = join(directory, "history");
  await mkdir(join(repository, "src"), { recursive: true }); await mkdir(history);
  await mkdir(join(repository, "docs"));
  await run("git", ["init", "-q", repository]);
  await writeFile(join(repository, "src/example.ts"), "export const example = 1;\n");
  await writeFile(join(repository, "docs/example.md"), "# Synthetic example\n");
  const records = [
    { type: "session_meta", timestamp: "2020-01-01T00:00:00Z", payload: { id: "synthetic-filter", cwd: repository } },
    { type: "response_item", timestamp: "2020-01-01T00:00:01Z", payload: { type: "function_call", name: "shell_command", call_id: "read",
      arguments: JSON.stringify({ command: "cat src/example.ts", workdir: repository }) } },
    { type: "response_item", timestamp: "2020-01-01T00:00:02Z", payload: { type: "function_call_output", call_id: "read", output: "Exit code: 0\nOutput:\nexport const example = 1;\n" } },
  ];
  await writeFile(join(history, "source.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const home = join(directory, "data"); await mkdir(home); await writePreferences(home, "zh-CN");
  service = await startService({ home, port: 0,
    roots: Object.fromEntries(clientIds.map(client => [client, client === "codex" ? history : []])),
    resourceInventory: { userHome: join(directory, "isolated-user"), environment: {} }, noUpdateCheck: true });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const api = async (path, body) => {
    const response = await fetch(`${base}/api/v1${path}`, body ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    } : {});
    assert.equal(response.status, 200); return response.json();
  };
  const registered = await api("/repositories", { path: repository });
  for (let attempt = 0; attempt < 200; attempt++) {
    const { job } = await api(`/jobs/${registered.job.id}`);
    assert.notEqual(job.status, "failed");
    if (job.status === "completed") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await browser(["open", `${base}/#map`, "--headed", "--browser=chrome"]);
  const verify = async (page, fixture) => {
    const { language, width, artifacts, repositoryId } = fixture;
    const zh = language === "zh-CN";
    const names = zh ? { time: "地图时间", all: "全部历史", week: "最近 7 天", month: "最近 30 天", custom: "自定义", retry: "重试",
      start: "地图开始日期", end: "地图结束日期", next: "下一月", today: "今天", clear: "清空", loading: "正在查询所选范围…" }
      : { time: "Map time", all: "All history", week: "Last 7 days", month: "Last 30 days", custom: "Custom", retry: "Retry",
        start: "Map start date", end: "Map end date", next: "Next month", today: "Today", clear: "Clear", loading: "Loading selected scope…" };
    const ensure = (value, message) => { if (!value) throw new Error(message); };
    page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(15_000);
    await page.setViewportSize({ width, height: 900 }); await page.reload();
    const ready = async () => { await page.locator(".map-results:not([inert])").waitFor(); await page.waitForLoadState("networkidle"); };
    await ready();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const chooseTime = async name => {
      await page.getByRole("combobox", { name: names.time, exact: true }).click();
      await page.getByRole("option", { name, exact: true }).click();
    };
    const state = () => page.evaluate(() => ({
      maps: document.querySelectorAll(".code-map").length, metrics: document.querySelector(".metrics")?.textContent,
      detail: document.querySelector("#file-details-content")?.textContent, largeLoading: document.querySelectorAll(".map-main > .query-loading").length,
      positions: [".metrics", ".code-map"].map(selector => { const rect = document.querySelector(selector).getBoundingClientRect();
        return [rect.top + scrollY, rect.left + scrollX, rect.width, rect.height]; }),
    }));
    const blocked = async () => ensure(await page.locator(".map-results").evaluate(element => element.inert)
      && await page.locator("#file-details-content").evaluate(element => element.inert), "旧结果下钻未暂停");
    await page.locator('.map-file[data-path="src/example.ts"]').click();
    await page.getByRole("heading", { name: "example.ts", exact: true }).waitFor();
    const before = await state();
    let release, seen, releaseFile, seenFile;
    const gate = new Promise(resolve => { release = resolve; }), intercepted = new Promise(resolve => { seen = resolve; });
    const fileGate = new Promise(resolve => { releaseFile = resolve; }), fileIntercepted = new Promise(resolve => { seenFile = resolve; });
    const reply = async (route, gate, seen) => { const response = await route.fetch(); seen(); await gate;
      await route.fulfill({ response }).catch(error => { if (!route.request().failure()) throw error; }); };
    await page.route("**/api/v1/repositories/*/coverage?**", route => reply(route, gate, seen));
    await page.route("**/api/v1/repositories/*/file?**", route => reply(route, fileGate, seenFile));
    try {
      await chooseTime(names.week); await intercepted;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const pending = await state();
      ensure(pending.maps === 1 && pending.metrics === before.metrics && pending.detail === before.detail, "筛选等待未保留完整结果");
      ensure(pending.largeLoading === 0, "筛选等待出现大块加载状态");
      const shift = Math.max(...before.positions.flatMap((rect, i) => rect.map((value, j) => Math.abs(value - pending.positions[i][j]))));
      ensure(shift <= 1, `筛选等待改变布局 ${shift}px`);
      await blocked(); await page.getByRole("status", { name: names.loading, exact: true }).waitFor();
      await page.screenshot({ path: `${artifacts}/${language}-${width}-pending.png`, fullPage: true });
      release(); await fileIntercepted;
      ensure((await state()).metrics === before.metrics, "文件详情未就绪时提前替换统计");
    } finally { release(); releaseFile(); }
    await ready(); await page.unrouteAll({ behavior: "wait" });
    const committed = await state();
    ensure(committed.metrics !== before.metrics && committed.detail !== before.detail, "筛选成功未整体替换统计与详情");
    await page.route("**/api/v1/repositories/*/coverage?**", route => route.fulfill({ status: 500,
      contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Synthetic query failure" } }) }));
    await chooseTime(names.month);
    await page.getByRole("alert").filter({ hasText: "Synthetic query failure" }).waitFor();
    const failed = await state();
    ensure(failed.maps === 1 && failed.metrics === committed.metrics && failed.detail === committed.detail, "筛选失败未保留完整结果");
    await blocked(); await page.screenshot({ path: `${artifacts}/${language}-${width}-failed.png`, fullPage: true });
    await page.unrouteAll({ behavior: "wait" });
    await page.getByRole("button", { name: names.retry, exact: true }).click(); await ready();
    let releaseLate, seenLate;
    let firstLate = true;
    const lateGate = new Promise(resolve => { releaseLate = resolve; }), lateSeen = new Promise(resolve => { seenLate = resolve; });
    await page.route("**/api/v1/repositories/*/coverage?**", route => {
      if (!firstLate) return route.continue();
      firstLate = false; return reply(route, lateGate, seenLate);
    });
    try {
      await chooseTime(names.all); await lateSeen;
      await chooseTime(names.month); await page.locator(".map-results:not([inert])").waitFor();
      ensure((await state()).metrics === committed.metrics, "返回已展示条件未解除等待");
    } finally { releaseLate(); }
    await page.unrouteAll({ behavior: "wait" }); await ready();
    ensure((await state()).metrics === committed.metrics, "迟到请求覆盖最新筛选");
    await chooseTime(names.custom); await ready();
    await page.getByRole("button", { name: names.start, exact: true }).click();
    await page.getByRole("button", { name: names.next, exact: true }).click();
    await page.locator(".date-picker-menu").getByRole("grid").getByRole("button").nth(15).click(); await ready();
    await page.getByRole("button", { name: names.end, exact: true }).click();
    await page.locator('.date-picker-menu[data-state="open"] .date-picker-actions').getByRole("button", { name: names.today, exact: true }).click();
    await page.getByRole("alert").waitFor(); await blocked();
    ensure(await page.locator(".code-map").isVisible(), "无效日期清空地图");
    await page.getByRole("button", { name: names.end, exact: true }).click();
    await page.locator('.date-picker-menu[data-state="open"] .date-picker-actions').getByRole("button", { name: names.clear, exact: true }).click(); await ready();
    // 模拟后台发布新版本，弹窗关闭后应回到未被暂停的详情折叠按钮。
    let releaseJob, seenJob;
    const jobGate = new Promise(resolve => { releaseJob = resolve; }), jobSeen = new Promise(resolve => { seenJob = resolve; });
    const job = { id: "synthetic-focus-job", repositoryId, status: "queued", phase: "queued", progress: 0 };
    await page.route("**/api/v1/repositories/*/refresh", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ job }) }));
    await page.route("**/api/v1/jobs/synthetic-focus-job", async route => {
      seenJob(); await jobGate;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ job: { ...job, status: "completed", progress: 1, version: "synthetic-focus-version" } }) });
    });
    try {
      await page.getByRole("button", { name: zh ? "刷新分析" : "Refresh analysis", exact: true }).click();
      await page.getByRole("button", { name: zh ? "查看当前代码与范围" : "View current code and ranges", exact: true }).click();
      await page.getByRole("dialog", { name: "src/example.ts", exact: true }).waitFor(); await jobSeen; releaseJob();
      await page.getByRole("dialog", { name: "src/example.ts", exact: true }).waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.activeElement?.matches(".pane-heading .panel-toggle"));
    } finally { releaseJob(); await page.unrouteAll({ behavior: "wait" }); }
    await page.reload(); await ready();
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "筛选状态导致窄屏横向溢出");
    ensure(errors.length === 0, errors.join(";"));
    return { passed: true, language, width, retained: true, atomic: true, retry: true, lateResponse: true, invalidDate: true, focusRecovery: true, errors };
  };
  const reports = [];
  for (const language of ["zh-CN", "en"]) {
    const saved = await fetch(`${base}/api/v1/preferences`, { method: "PUT", headers: { "Content-Type": "application/json", "x-agent-manor-instance": service.instance.id },
      body: JSON.stringify({ language, appearance: { mode: language === "en" ? "dark" : "light", preset: "blue" } }) });
    assert.equal(saved.status, 200);
    for (const width of [1440, 390]) {
      const report = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify({ language, width, artifacts, repositoryId: registered.repository.id })})`]);
      reports.push(report); console.log(report.split("### Ran Playwright code")[0]);
    }
  }
  await writeFile(join(artifacts, "report.txt"), reports.join("\n"));
} catch (error) {
  await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]).catch(() => {}); throw error;
} finally {
  await browser(["close"]).catch(() => {}); await service?.close(); await rm(directory, { recursive: true, force: true });
}
