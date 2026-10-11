import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { usageFixture } from "./usage-fixture.mjs";

// 使用隔离合成数据与可控延迟验证后台准备状态，不访问个人历史或偏好。
const run = promisify(execFile);
const fixture = await usageFixture();
const artifacts = fileURLToPath(new URL("../.local/usage-preparation-e2e/", import.meta.url));
const session = `usage-preparation-${process.pid}`;
let opened = false;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${session}`, ...args], {
    cwd: fixture.directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
try {
  await mkdir(artifacts, { recursive: true });
  await browser(["open", `${fixture.base}/#usage`, "--headed", "--browser=chrome"]); opened = true;
  const verify = async (page, options) => {
    let checks = 0;
    const ensure = (condition, message) => { if (!condition) throw new Error(message); checks++; };
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(15_000);
    const button = name => page.getByRole("button", { name, exact: true });
    const ready = async () => { await page.locator(".usage-metrics").waitFor(); await page.waitForLoadState("networkidle"); };
    const tick = ms => page.waitForTimeout(ms);
    await page.setViewportSize({ width: 1440, height: 1000 }); await ready();
    const template = await page.evaluate(async () => {
      const index = await (await fetch("/api/v1/sessions/status?summary=true")).json();
      const pricing = await (await fetch("/api/v1/usage/pricing")).json();
      const query = new URLSearchParams({ version: index.version, priceVersion: pricing.version, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      return (await fetch(`/api/v1/usage?${query}`)).json();
    });
    let mode = "fast", status = { state: "preparing", preparedSessions: 2, totalSessions: 10 };
    let mismatched = false, holdNextStatus = false, heldStatus;
    const reports = [], statuses = [], pendingReports = [];
    const parameters = url => Object.fromEntries(url.split("?")[1].split("&").map(field => {
      const at = field.indexOf("="); return [decodeURIComponent(field.slice(0, at)), decodeURIComponent(field.slice(at + 1).replace(/\+/g, " "))];
    }));
    const fulfillReport = async route => {
      const values = parameters(route.request().url());
      const query = { ...template.query, from: values.from, to: values.to };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...template, query }) }).catch(() => {});
    };
    const releaseReports = async () => { for (const item of pendingReports.splice(0)) { await fulfillReport(item.route); item.release(); } };
    await page.route("**/api/v1/usage?**", route => {
      reports.push(route.request().url());
      if (mode === "fast") return fulfillReport(route);
      return new Promise(release => pendingReports.push({ route, release }));
    });
    await page.route("**/api/v1/usage/status?**", async route => {
      const values = parameters(route.request().url());
      const identity = { version: values.version, priceVersion: values.priceVersion, timezone: values.timezone };
      const result = { ...identity, ...status, ...(mismatched ? { version: "synthetic-unrelated-version" } : {}) };
      statuses.push(route.request().url());
      if (holdNextStatus) {
        holdNextStatus = false;
        await new Promise(release => { heldStatus = { route, result, release }; });
        return;
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(result) }).catch(() => {});
    });
    await button("刷新统计").click(); await ready(); await tick(1200);
    ensure(statuses.length === 0, "轻量查询结束后仍发起准备状态查询");
    mode = "slow"; await button("刷新统计").click();
    await page.getByText("正在准备统计…", { exact: true }).waitFor();
    const progress = page.getByRole("progressbar", { name: "正在准备统计…", exact: true });
    ensure(await progress.getAttribute("value") === "2" && await progress.getAttribute("max") === "10", "准备进度没有使用服务端会话计数");
    ensure(await page.getByText("已准备 2 / 10 个会话", { exact: true }).count() === 1, "准备数量未本地化");
    const reportIdentity = parameters(reports.at(-1)), statusIdentity = parameters(statuses.at(-1));
    ensure(["version", "priceVersion", "timezone"].every(key => reportIdentity[key] === statusIdentity[key]), "准备查询未绑定报告版本与时区");
    status = { state: "preparing", preparedSessions: 0, totalSessions: 0 };
    await progress.waitFor({ state: "hidden" });
    ensure(await page.getByText("正在准备统计…", { exact: true }).count() === 1, "未确定总量时丢失准备状态");
    ensure(!(await page.locator(".usage-loading").innerText()).includes("%"), "未确定总量时虚构百分比");
    const reportCount = reports.length;
    await button("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
    await page.getByText("Preparing usage statistics…", { exact: true }).waitFor();
    ensure(reports.length === reportCount, "语言切换重新查询统计");
    status = { state: "preparing", preparedSessions: 9, totalSessions: 10 }; holdNextStatus = true;
    for (let attempt = 0; attempt < 100 && !heldStatus; attempt++) await tick(25);
    ensure(!!heldStatus, "未捕获用于取消验收的状态请求");
    await page.getByRole("combobox", { name: "Date range", exact: true }).click();
    await page.getByRole("option", { name: "All dates", exact: true }).click();
    status = { state: "preparing", preparedSessions: 1, totalSessions: 10 };
    await page.getByText("Sessions prepared: 1 / 10", { exact: true }).waitFor();
    await heldStatus.route.fulfill({ contentType: "application/json", body: JSON.stringify(heldStatus.result) }).catch(() => {}); heldStatus.release();
    await tick(150);
    ensure(await page.getByText("Sessions prepared: 1 / 10", { exact: true }).count() === 1, "过期筛选状态覆盖了新查询");
    await button("Appearance").click(); await page.getByRole("combobox", { name: "Display mode", exact: true }).click();
    await page.getByRole("option", { name: "Dark", exact: true }).click(); await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.setViewportSize({ width: 390, height: 844 });
    ensure(await page.locator("html").getAttribute("data-theme") === "dark", "准备状态未保留深色主题");
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "窄屏准备状态产生横向溢出");
    await page.screenshot({ path: `${options.artifacts}/preparing-dark-mobile.png`, fullPage: true });
    mode = "fast"; await releaseReports(); await ready();
    ensure(await page.getByRole("progressbar").count() === 0, "报告完成后准备进度未消失");
    const stoppedCount = statuses.length; await tick(1200);
    ensure(statuses.length === stoppedCount, "报告完成后继续轮询准备状态");
    mode = "slow"; mismatched = true; await button("Refresh usage").click();
    const beforeMismatch = statuses.length;
    for (let attempt = 0; attempt < 100 && statuses.length === beforeMismatch; attempt++) await tick(25);
    ensure(statuses.length > beforeMismatch, "未查询不匹配版本状态");
    ensure(await page.getByText("Preparing usage statistics…", { exact: true }).count() === 0, "其他版本状态被显示为当前准备进度");
    mode = "fast"; await releaseReports(); await ready();
    mismatched = false; mode = "slow"; status = { state: "failed", preparedSessions: 1, totalSessions: 10 };
    await button("Refresh usage").click();
    await page.getByRole("alert").filter({ hasText: "could not be prepared" }).waitFor();
    ensure(await button("Retry").isVisible(), "准备失败没有沿用重试入口");
    const failedCount = statuses.length; await tick(1200);
    ensure(statuses.length === failedCount, "准备失败后继续轮询");
    mode = "fast"; await releaseReports(); await button("Retry").click(); await ready();
    await page.getByRole("alert").waitFor({ state: "hidden" });
    ensure(await button("Refresh usage").isEnabled(), "准备失败后相同版本重试未结束加载");
    ensure(errors.length === 0, errors.join(";"));
    return { passed: true, checks, errors, preparation: true, progress: true, staleQuery: true, language: true, failureRetry: true, themesAndMobile: true };
  };
  const output = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify({ artifacts })})`]);
  await writeFile(`${artifacts}/report.txt`, output); console.log(output.split("### Ran Playwright code")[0]);
} catch (error) {
  if (opened) await browser(["screenshot", `--filename=${artifacts}/failure.png`]).catch(() => {});
  throw error;
} finally { if (opened) await browser(["close"]).catch(() => {}); await fixture.close(); }
