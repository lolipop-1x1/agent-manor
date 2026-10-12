import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { usageFixture } from "./usage-fixture.mjs";

// 所有合成数据、延迟注入和显示偏好均在临时目录中隔离。
const run = promisify(execFile), fixture = await usageFixture({ days: 365 });
const artifacts = fileURLToPath(new URL("../.local/overview-trend-e2e/", import.meta.url));
const session = `overview-trend-${process.pid}`;
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
  await browser(["open", `${fixture.base}/#overview?window=365&interval=day&metric=requests`, "--headed", "--browser=chrome"]); opened = true;
  const verify = async (page, options) => {
    let checks = 0; const errors = []; page.on("pageerror", error => errors.push(error.message));
    const ensure = (value, message) => { if (!value) throw new Error(message); checks++; };
    const ready = async () => { await page.locator(".overview-results[aria-busy='false']").waitFor(); await page.getByRole("button", { name: "更新总览", exact: true }).waitFor(); await page.waitForLoadState("networkidle"); };
    const hit = () => page.getByRole("slider", { name: "选择用量时间区间", exact: true });
    const choose = async (name, value) => { await page.getByRole("combobox", { name, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
    const geometry = async () => page.locator(".overview-trend").evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, chart: el.dataset.chart,
      outside: Array.from(el.querySelectorAll(".overview-trend-bar")).some(bar => { const a=bar.getBoundingClientRect(), b=el.getBoundingClientRect(); return a.left < b.left || a.right > b.right; }) }));
    await page.setViewportSize({ width: 1280, height: 900 }); await ready();
    let size = await geometry(); ensure(size.scroll <= size.width && !size.outside && size.chart === "line", "全年每日绘制越界或未采用折线");
    ensure(await hit().getAttribute("aria-valuemax") === "365", "全年每日数据丢失");
    ensure((await page.locator(".overview-trend svg text").allTextContents()).length >= 6, "图表缺少日期或数值刻度");
    await hit().press("End"); ensure(await hit().getAttribute("aria-valuenow") === "365", "键盘不可达最后一天");
    const popup = page.getByRole("dialog", { name: "时间区间明细", exact: true }); await popup.waitFor();
    await hit().press("ArrowLeft"); ensure(await hit().getAttribute("aria-valuenow") === "364", "日期键盘移动错误");
    const request = page.waitForRequest(req => req.url().includes("/api/v1/overview/evidence?"));
    await hit().press("Enter"); const evidence = await page.evaluate(url => JSON.parse(new URL(url).searchParams.get("evidence")), (await request).url());
    ensure(evidence.from === evidence.to && evidence.kind === "requests", "趋势下钻没有保留单日范围");
    await page.locator(".overview-investigation").waitFor(); await page.keyboard.press("Escape");
    await page.mouse.move(0, 0);
    const reportBefore = await page.locator(".overview-composition").boundingBox(); await hit().scrollIntoViewIfNeeded();
    const bounds = await hit().boundingBox();
    for (const part of [.01, .3, .7, .99]) { await page.mouse.move(bounds.x + bounds.width * part, bounds.y + bounds.height / 2); await popup.waitFor(); }
    ensure(Math.abs((await page.locator(".overview-composition").boundingBox()).y - reportBefore.y) < 1, "悬停明细改变页面布局");
    await hit().press("Escape");
    let usageReads = 0; const countUsage = req => { if (req.url().includes("/api/v1/overview/panel?") && req.url().includes("panel=usage")) usageReads++; };
    page.on("request", countUsage);
    for (const value of ["每周", "每月", "每天"]) { await choose("时间粒度", value); ensure((await geometry()).chart === (value === "每天" ? "line" : "bar"), "粒度表现不符合约定"); }
    for (const value of ["Token 总量", "估算费用", "模型请求数"]) await choose("用量指标", value);
    ensure(usageReads === 0, "切换指标或粒度重新请求用量"); page.off("request", countUsage);
    await choose("日期范围", "近 30 天"); await ready(); size = await geometry();
    ensure(size.chart === "bar" && !size.outside && await hit().getAttribute("aria-valuemax") === "30", "短期每日柱形不正确");
    const held = await page.locator(".overview-trend svg").innerHTML();
    let release; const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/api/v1/overview/panel?**", async route => { await gate; await route.continue(); });
    await page.getByRole("button", { name: "更新总览", exact: true }).click();
    await page.locator(".overview-results[aria-busy='true']").waitFor();
    ensure(await hit().getAttribute("aria-disabled") === "true", "更新时趋势下钻未禁用");
    ensure(await page.locator(".overview-trend svg").innerHTML() === held, "更新时图表几何发生变化");
    release(); await ready(); await page.unroute("**/api/v1/overview/panel?**");
    await page.goto(`${options.base}/#overview?window=custom&from=2025-12-25&to=2026-01-03&interval=week&metric=requests`); await ready();
    ensure((await page.locator(".overview-trend svg > text").last().textContent()).includes("2026年"), "跨年末周的年份与末日不一致");
    await page.goto(`${options.base}/#overview?window=custom&from=2099-01-01&to=2099-01-07&interval=day&metric=requests`); await ready();
    ensure(await page.locator(".overview-trend-bar").count() === 7 && await page.locator(".overview-trend-bar").evaluateAll(bars => bars.every(bar => Number(bar.getAttribute("height")) === 0)), "零值被绘制成有高度的柱形");
    await page.goto(`${options.base}/#overview?window=365&interval=day&metric=requests`); await ready();
    await page.setViewportSize({ width: 390, height: 844 }); size = await geometry();
    ensure(size.scroll <= size.width && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "窄屏溢出");
    await hit().press("Home"); await popup.waitFor(); const p=await popup.boundingBox(); ensure(p.x >= 0 && p.x+p.width <= 390, "窄屏浮层越界");
    await hit().press("Escape"); await page.screenshot({ path: `${options.artifacts}/zh-mobile.png`, fullPage: true });
    await page.getByRole("button", { name: "显示语言", exact: true }).click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
    const english = page.getByRole("slider", { name: "Select usage interval", exact: true }); await english.waitFor(); await english.press("End");
    ensure((await english.getAttribute("aria-valuetext")).includes("Model requests"), "英文图表可访问文案不完整");
    await english.press("Escape");
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await choose("Display mode", "Dark");
    await page.keyboard.press("Escape");
    ensure(await page.locator("html").getAttribute("data-theme") === "dark", "深色主题未生效");
    await english.scrollIntoViewIfNeeded();
    const touchBounds = await english.boundingBox();
    await page.dispatchEvent(".overview-trend-selector", "pointerdown", { pointerType: "touch", clientX: touchBounds.x + touchBounds.width / 2, clientY: touchBounds.y + 20 });
    const touchPopup = page.getByRole("dialog", { name: "Interval details", exact: true }); await touchPopup.waitFor();
    ensure(await page.locator(".overview-investigation").count() === 0, "触屏第一次选择直接打开了调查");
    await page.dispatchEvent(".overview-trend-selector", "pointerleave", { pointerType: "touch" });
    await page.waitForTimeout(250);
    ensure(await touchPopup.isVisible(), `触屏详情未固定：${JSON.stringify({value:await english.getAttribute("aria-valuenow"),disabled:await english.getAttribute("aria-disabled"),dialogs:await page.locator(".overview-trend-popover").count()})}`);
    await touchPopup.getByRole("button", { name: "Close Interval details", exact: true }).click();
    await touchPopup.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.classList.contains("overview-trend-selector"), null, { timeout: 2000 });
    ensure(await english.evaluate(el => el === document.activeElement), `触屏详情关闭后未恢复图表焦点：${JSON.stringify(await page.evaluate(() => ({tag:document.activeElement?.tagName,cls:document.activeElement?.className,role:document.activeElement?.getAttribute("role"),label:document.activeElement?.getAttribute("aria-label")})))}`);
    await page.screenshot({ path: `${options.artifacts}/en-dark-mobile.png`, fullPage: true });
    ensure(errors.length === 0, `浏览器错误：${errors.join(";")}`);
    return { passed: true, checks, errors, yearDaily: true, boundaries: true, drill: true, keyboard: true, stableHover: true, refresh: true, mobile: true, english: true, dark: true, touch: true };
  };
  const output = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify({ artifacts, base: fixture.base })})`]);
  console.log(output.split("### Ran Playwright code")[0]); await writeFile(`${artifacts}/result.txt`, output);
  assert.match(output, /"passed"\s*:\s*true/, "总览趋势验收缺少成功结果");
} finally { if (opened) await browser(["close"]).catch(() => undefined); await fixture.close(); }
