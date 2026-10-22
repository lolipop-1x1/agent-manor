import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { usageFixture } from "./usage-fixture.mjs";

// 全部网络控制、偏好变更与写入均限定在隔离合成资源；默认无头 Chrome。
const run = promisify(execFile), fixture = await usageFixture({ speedTiming: true, days: 60, extraSpeedModels: 120 });
const artifacts = fileURLToPath(new URL("../.local/usage-review-fixes-e2e/", import.meta.url));
const session = `usage-fixes-${process.pid}`;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${session}`, ...args], {
    cwd: fixture.directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
try {
  await mkdir(artifacts, { recursive: true });
  await browser(["open", `${fixture.base}/#usage?window=all&sort=requests`, "--browser=chrome"]);
  const verify = async (page, options) => {
    let checks = 0; const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const ensure = (value, message) => { if (!value) throw new Error(message); checks++; };
    const button = name => page.getByRole("button", { name, exact: true });
    const ready = () => page.locator(".usage-results[aria-busy='false']").waitFor();
    const requests = page.getByRole("dialog", { name: "请求明细", exact: true });
    const rows = () => requests.locator("tbody tr");
    const pageNumber = () => requests.locator("[aria-current='page']").innerText();
    const reportResponse = response => /\/api\/v1\/usage(?:\?|$)/.test(response.url());
    await page.setViewportSize({ width: 1440, height: 1000 }); await ready();
    await button("查看请求明细").first().click(); await rows().first().waitFor();
    const before = await rows().allTextContents(), bounds = await requests.boundingBox();
    let release, markHeld;
    const held = new Promise(resolve => { markHeld = resolve; });
    await page.route("**/api/v1/usage/requests?*", async route => { markHeld(); await new Promise(resolve => { release = resolve; }); await route.continue(); });
    await button("请求明细下一页").click(); await held;
    await requests.locator(".loading--inline").waitFor();
    ensure(await rows().count() === before.length, "翻页等待清空旧请求表格");
    ensure(JSON.stringify(await rows().allTextContents()) === JSON.stringify(before), "等待期间替换了旧页");
    ensure(await pageNumber() === "1", "数据尚未返回时提前切换页码");
    ensure(Math.abs((await requests.boundingBox()).height - bounds.height) < 1, "翻页加载使弹窗高度跳动");
    ensure(await rows().first().evaluate(element => !!element.closest("[inert]")), "旧请求等待期间仍可下钻");
    await page.screenshot({ path: `${options.artifacts}/pending.png` });
    release(); await page.waitForFunction(() => document.querySelector(".usage-request-section [aria-current='page']")?.textContent === "2");
    await page.unroute("**/api/v1/usage/requests?*");
    ensure(JSON.stringify(await rows().allTextContents()) !== JSON.stringify(before), "新页未整体替换");
    const second = await rows().allTextContents();
    await page.route("**/api/v1/usage/requests?*", route => route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "synthetic query failure", messageDescriptor: { key: "common.error.http", params: { status: 503 } } } }) }));
    await button("请求明细下一页").click(); await requests.getByRole("alert").waitFor();
    ensure(JSON.stringify(await rows().allTextContents()) === JSON.stringify(second), "失败清空上一完整页");
    ensure(await pageNumber() === "2", "失败后页码与旧数据不一致");
    ensure(await rows().first().evaluate(element => !!element.closest("[inert]")), "失败后旧结果被当成新页下钻");
    ensure(await button("重试").isVisible(), "失败缺少重试入口");
    await page.unroute("**/api/v1/usage/requests?*"); await button("重试").click();
    await page.waitForFunction(() => document.querySelector(".usage-request-section [aria-current='page']")?.textContent === "3");
    ensure(!await rows().first().evaluate(element => !!element.closest("[inert]")), "重试成功仍不可操作");

    const identity = await requests.locator(".usage-request-header p").innerText();
    let releaseOld, oldHeld, oldFinished;
    const heldOld = new Promise(resolve => { oldHeld = resolve; });
    const finishedOld = new Promise(resolve => { oldFinished = resolve; });
    await page.route("**/api/v1/usage/requests?*", async route => {
      if (!/[?&]requestPage=4(?:&|$)/.test(route.request().url())) { await route.continue(); return; }
      const response = await route.fetch(); oldHeld(); await new Promise(resolve => { releaseOld = resolve; });
      await route.fulfill({ response }).catch(() => undefined); oldFinished();
    });
    await button("请求明细下一页").click(); await heldOld;
    await button("请求明细首页").click();
    await page.waitForFunction(() => document.querySelector(".usage-request-section [aria-current='page']")?.textContent === "1");
    const newest = await rows().allTextContents(); releaseOld(); await finishedOld;
    ensure(await pageNumber() === "1" && JSON.stringify(await rows().allTextContents()) === JSON.stringify(newest), "过期页覆盖了最新页");
    await page.unroute("**/api/v1/usage/requests?*");

    let releaseClosed, closedHeld, closedFinished;
    const heldClosed = new Promise(resolve => { closedHeld = resolve; });
    const finishedClosed = new Promise(resolve => { closedFinished = resolve; });
    await page.route("**/api/v1/usage/requests?*", async route => {
      if (!/[?&]requestPage=2(?:&|$)/.test(route.request().url())) { await route.continue(); return; }
      const response = await route.fetch(); closedHeld(); await new Promise(resolve => { releaseClosed = resolve; });
      await route.fulfill({ response }).catch(() => undefined); closedFinished();
    });
    await button("请求明细下一页").click(); await heldClosed;
    await button("关闭请求明细").click(); await requests.waitFor({ state: "hidden" });
    await button("查看请求明细").nth(1).click(); await rows().first().waitFor();
    ensure(await pageNumber() === "1", "切换会话没有重置请求页码");
    ensure(!(await requests.innerText()).includes("synthetic-speed-"), "新会话混入上一会话请求");
    ensure(await requests.locator(".usage-request-header p").innerText() !== identity, "未切换到目标会话");
    const switched = await rows().allTextContents(); releaseClosed(); await finishedClosed;
    ensure(JSON.stringify(await rows().allTextContents()) === JSON.stringify(switched), "关闭前的响应污染新会话");
    await page.unroute("**/api/v1/usage/requests?*");
    await button("关闭请求明细").click(); await requests.waitFor({ state: "hidden" });

    const speedLoaded = page.waitForResponse(reportResponse); await button("吐字速度").click();
    const speedReport = await (await speedLoaded).json(); await ready();
    ensure(speedReport.speed.groups.length > 120, "夹具没有覆盖足够多的速度分组");
    ensure(!await page.evaluate(() => new URLSearchParams(location.hash.split("?")[1]).has("speedGroups")), "默认全选仍展开进地址");
    const selected = speedReport.speed.groups.map(group => group.key);
    const longAddress = { window: "all", sort: "requests", trendMetric: "speed", speedGroups: JSON.stringify(selected) };
    const selectedLoaded = page.waitForResponse(reportResponse);
    await page.evaluate(value => { location.hash = `usage?${new URLSearchParams(value)}`; }, longAddress);
    const selectedResponse = await selectedLoaded; ensure(selectedResponse.request().method() === "POST" && selectedResponse.ok(), "显式长选择没有通过 POST 成功读取");
    ensure(JSON.stringify((await selectedResponse.json()).speed.selectedGroups) === JSON.stringify(selected), "长选择丢失分组或顺序"); await ready();
    const intervalLoaded = page.waitForResponse(reportResponse);
    await page.getByRole("combobox", { name: "时间粒度", exact: true }).click(); await page.getByRole("option", { name: "周", exact: true }).click();
    ensure((await intervalLoaded).ok(), "长选择切换时间粒度失败"); await ready();
    const refreshLoaded = page.waitForResponse(reportResponse); await button("刷新统计").click();
    ensure((await refreshLoaded).ok(), "长选择刷新失败"); await ready();
    const requestLoaded = page.waitForResponse(response => /\/usage\/requests(?:\?|$)/.test(response.url()));
    await button("查看请求明细").first().click(); const requestResponse = await requestLoaded;
    ensure(requestResponse.ok() && requestResponse.request().method() === "POST", "长选择请求明细未使用 POST");
    await rows().first().waitFor(); await button("关闭请求明细").click(); await requests.waitFor({ state: "hidden" });
    await page.reload(); await ready();
    ensure(JSON.stringify(await page.evaluate(() => JSON.parse(new URLSearchParams(location.hash.split("?")[1]).get("speedGroups")))) === JSON.stringify(selected), "重载丢失显式长选择");

    await button("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
    await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    await page.getByRole("button", { name: "Inspect requests", exact: true }).first().click();
    const englishDialog = page.getByRole("dialog", { name: "Request details", exact: true });
    await englishDialog.locator("tbody tr").first().waitFor();
    ensure((await englishDialog.boundingBox()).width <= 390, "英文窄屏请求弹窗越界");
    const englishBefore = await englishDialog.locator("tbody tr").allTextContents();
    let releaseEnglish, englishHeld;
    const heldEnglish = new Promise(resolve => { englishHeld = resolve; });
    await page.route("**/api/v1/usage/requests", async route => {
      englishHeld(); await new Promise(resolve => { releaseEnglish = resolve; }); await route.continue();
    });
    await button("Request details next page").click(); await heldEnglish;
    await englishDialog.getByRole("status", { name: "Updating statistics", exact: true }).waitFor();
    ensure(JSON.stringify(await englishDialog.locator("tbody tr").allTextContents()) === JSON.stringify(englishBefore), "英文窄屏等待丢失旧页");
    await page.screenshot({ path: `${options.artifacts}/english-mobile.png` });
    releaseEnglish(); await page.waitForFunction(() => document.querySelector(".usage-request-section [aria-current='page']")?.textContent === "2");
    await page.unroute("**/api/v1/usage/requests");
    ensure(errors.length === 0, errors.join(";"));
    return { passed: true, checks, errors, retainedPagination: true, errorRetry: true, longPostQueries: true, implicitAll: true, englishMobile: true };
  };
  const output = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify({ artifacts })})`]);
  await writeFile(`${artifacts}/report.txt`, output); console.log(output.split("### Ran Playwright code")[0]);
  assert.match(output, /"passed"\s*:\s*true/);
} catch (error) {
  await browser(["screenshot", `--filename=${artifacts}/failure.png`]).catch(() => undefined);
  throw error;
} finally { await browser(["close"]).catch(() => undefined); await fixture.close(); }
