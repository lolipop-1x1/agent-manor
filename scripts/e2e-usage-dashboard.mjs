import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { usageFixture } from "./usage-fixture.mjs";

// 所有延迟注入和偏好变更只作用于隔离合成数据。
const run = promisify(execFile), fixture = await usageFixture();
const artifacts = fileURLToPath(new URL("../.local/usage-dashboard-e2e/", import.meta.url));
const session = `usage-dashboard-${process.pid}`;
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
    let checks = 0; const errors = []; page.on("pageerror", error => errors.push(error.message));
    const ensure = (value, message) => { if (!value) throw new Error(message); checks++; };
    const button = name => page.getByRole("button", { name, exact: true });
    const ready = async () => { await page.locator(".usage-results[aria-busy='false']").waitFor(); await page.waitForLoadState("networkidle"); };
    const change = async action => { const response = page.waitForResponse(res => /\/api\/v1\/usage\?/.test(res.url())); await action(); await response; await ready(); };
    const choose = async (name, value) => { await page.getByRole("combobox", { name, exact: true }).click(); await change(() => page.getByRole("option", { name: value, exact: true }).click()); };
    await page.setViewportSize({ width: 1440, height: 1080 }); await ready();
    ensure(await page.getByRole("combobox", { name: "日期范围", exact: true }).innerText() === "近 30 天", "新入口不是近30天");
    ensure(await page.locator(".usage-metrics > div").count() === 5 && await page.locator(".usage-secondary-metrics > div").count() === 7, "摘要指标未齐全");
    const report = await page.evaluate(async () => {
      const params = new URLSearchParams({ from: new Date(Date.now() - 29 * 86400000).toLocaleDateString("sv-SE"), to: new Date().toLocaleDateString("sv-SE"), timezone: "Asia/Shanghai" });
      return (await fetch(`/api/v1/usage?${params}`)).json();
    });
    const summary = page.locator(".usage-secondary-metrics > div");
    ensure(await summary.nth(0).locator("strong span").getAttribute("title") === `${new Intl.NumberFormat("zh-CN").format(report.totals.inputTokens)} Token`, "总输入原值与API不符");
    ensure(await summary.nth(1).locator("strong span").getAttribute("title") === `${new Intl.NumberFormat("zh-CN").format(report.totals.outputTokens)} Token`, "总输出原值与API不符");
    const money = value => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
    const dated = report.days.filter(day => day.totals.estimatedCost !== null);
    ensure(await summary.nth(2).locator("strong").innerText() === money(dated.reduce((sum, day) => sum + day.totals.estimatedCost, 0) / report.days.length), "日均费用分母或金额错误");
    const peak = [...dated].sort((a, b) => b.totals.estimatedCost - a.totals.estimatedCost || a.key.localeCompare(b.key))[0];
    ensure(await summary.nth(3).locator("strong").innerText() === money(peak.totals.estimatedCost), "峰值金额错误");
    ensure(await summary.nth(3).locator("time").innerText() === new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(`${peak.key}T00:00:00`)), "峰值日期错误");
    ensure(await summary.nth(4).locator("strong").innerText() === String(report.projectCount), "项目数量错误");
    ensure(await summary.nth(5).locator("strong").innerText() === String(report.modelCount), "模型数量错误");
    ensure(await summary.nth(6).locator("strong").innerText() === String(report.days.filter(day => day.totals.requests > 0).length), "活跃天数错误");
    const secondaryValues = await summary.allTextContents();
    const pager = page.getByRole("navigation", { name: "会话明细", exact: true });
    await change(() => pager.getByRole("button", { name: "会话明细下一页", exact: true }).click());
    ensure(JSON.stringify(await summary.allTextContents()) === JSON.stringify(secondaryValues), "分页改变摘要");
    await change(() => pager.getByRole("button", { name: "会话明细首页", exact: true }).click());
    ensure(await button("矩形占比").getAttribute("aria-pressed") === "true" && await page.locator(".usage-attribution-tile").count() > 0, "没有默认矩形占比");
    let queries = 0; const countQuery = req => { if (/\/api\/v1\/usage\?/.test(req.url())) queries++; }; page.on("request", countQuery);
    const values = await page.locator(".usage-metric-overview").innerText();
    await button("横条排行").click(); ensure(await page.locator(".usage-rank-row").count() > 0, "横条未显示");
    await button("矩形占比").click(); ensure(queries === 0, "归因视图切换重新统计");
    ensure(await page.locator(".usage-metric-overview").innerText() === values, "视图切换改变统计值");
    page.off("request", countQuery);
    const hit = page.getByRole("slider", { name: "选择时间区间", exact: true });
    await hit.scrollIntoViewIfNeeded();
    const rect = await hit.boundingBox();
    const before = await page.locator(".usage-session-section").boundingBox();
    const originalHash = await page.evaluate(() => location.hash);
    for (const fraction of [.05, .25, .55, .85]) {
      await page.mouse.move(rect.x + rect.width * fraction, rect.y + rect.height * .5);
      await page.getByRole("dialog", { name: "时间区间明细", exact: true }).waitFor();
      ensure(Math.abs((await page.locator(".usage-session-section").boundingBox()).y - before.y) < 1, "悬停导致表格跳动");
    }
    ensure(await page.locator(".usage-chart-detail").count() === 0, "每日详情仍占页面布局");
    await hit.press("Home"); await hit.press("Enter");
    ensure(await page.evaluate(() => location.hash) === originalHash, "查看时间修改筛选");
    ensure(await page.getByRole("button", { name: /^只看这/ }).count() === 0, "仍有只看一天按钮");
    await button("关闭时间区间明细").click();
    await page.waitForFunction(() => document.activeElement?.matches(".usage-bucket-selector"));
    ensure(await page.locator(".usage-time-popover").count() === 0, "关闭按钮恢复焦点时重新打开浮层");
    await hit.press("Enter"); await page.keyboard.press("Escape"); ensure(await page.locator(".usage-time-popover").count() === 0, "Escape 未关闭时间浮层");
    let release; await page.route("**/api/v1/usage?*", async route => { await new Promise(resolve => { release = resolve; }); await route.continue(); });
    await button("估算费用").click(); await page.locator(".usage-results[aria-busy='true']").waitFor();
    await page.locator(".usage-page-heading .loading--inline").waitFor();
    ensure(await page.locator(".usage-page .loading--inline").count() === 1, "指标切换应只显示一个固定loading");
    ensure(await page.locator(".usage-metric-overview").innerText() === values, "等待期间清空原数据");
    while (!release) await page.waitForTimeout(25); release(); await ready(); await page.unroute("**/api/v1/usage?*");
    await page.route("**/api/v1/usage?*", async route => { await new Promise(resolve => { release = resolve; }); await route.continue(); }); release = undefined;
    await page.getByRole("combobox", { name: "归因维度", exact: true }).click(); await page.getByRole("option", { name: "项目", exact: true }).click(); await page.locator(".usage-results[aria-busy='true']").waitFor();
    ensure(await page.locator(".usage-page-heading .loading--inline").isVisible(), "分组切换缺更新提示");
    while (!release) await page.waitForTimeout(25); release(); await ready(); await page.unroute("**/api/v1/usage?*");
    ensure((await page.locator(".usage-attribution-map").innerText()).includes("atlas"), "分组返回后归因未更新");
    ensure(!(await page.locator(".usage-attribution-map").innerText()).includes("/synthetic/"), "矩形显示完整长路径");
    await page.locator(".usage-session-section").scrollIntoViewIfNeeded();
    const alignments = await page.locator(".usage-session-table").evaluate(table => {
      const cells = [...table.querySelectorAll("tbody tr:first-child td")], heads = [...table.querySelectorAll("th")];
      return [1, 2, 3, 4, 5].map(index => ({ head: getComputedStyle(heads[index]).textAlign, cell: getComputedStyle(cells[index]).textAlign }));
    });
    ensure(alignments.every(item => item.head === item.cell), "会话表头与正文对齐方向不一致");
    ensure((await page.locator(".usage-session-table tbody tr").first().locator("td").nth(2).innerText()).includes("M"), "会话表Token没有百万单位");
    await button("查看请求明细").first().click(); const dialog = page.getByRole("dialog", { name: "请求明细", exact: true }); await dialog.locator("tbody tr").first().waitFor();
    ensure(await dialog.locator("thead th").count() === 9, "请求表丢失九列");
    ensure((await dialog.locator("tbody tr").first().locator("td").nth(2).innerText()).includes("M"), "请求Token没有百万单位");
    ensure((await dialog.locator("tbody tr").first().locator("td").nth(2).locator("span").getAttribute("title")).includes("Token"), "请求没有完整原值提示");
    await button("关闭请求明细").click();
    await choose("日期范围", "今天"); await page.reload(); await ready(); ensure(await page.getByRole("combobox", { name: "日期范围", exact: true }).innerText() === "今天", "显式日期未恢复");
    await choose("日期范围", "近 30 天");
    await page.locator(".usage-page-heading").scrollIntoViewIfNeeded(); await page.screenshot({ path: `${options.artifacts}/zh-desktop.png`, fullPage: true });
    await button("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
    await page.getByText("Total input tokens", { exact: true }).waitFor();
    ensure((await page.locator(".usage-secondary-metrics").innerText()).includes("Daily average cost"), "英文新增指标缺失");
    ensure((await page.locator(".usage-metrics").innerText()).includes("M"), "英文Token没有百万单位");
    await page.setViewportSize({ width: 390, height: 844 });
    // 等待图表的 ResizeObserver 完成窄屏重测，再检查页面宽度。
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "窄屏页面溢出");
    await page.getByRole("slider").press("Home"); const popup = page.getByRole("dialog", { name: "Interval details", exact: true }); await popup.waitFor();
    const bounds = await popup.boundingBox(); ensure(bounds.x >= 0 && bounds.x + bounds.width <= 390, "窄屏时间浮层溢出");
    await page.keyboard.press("Escape"); await page.screenshot({ path: `${options.artifacts}/en-mobile.png`, fullPage: true });
    ensure(errors.length === 0, `浏览器错误：${errors.join(";")}`);
    return { passed: true, checks, errors, summary: true, millions: true, stableHover: true, localLoading: true, treemap: true, alignedHeaders: true, englishAndMobile: true };
  };
  const output = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify({ base: fixture.base, artifacts })})`]);
  console.log(output.split("### Ran Playwright code")[0]);
  await writeFile(`${artifacts}/result.txt`, output);
  assert.match(output, /"passed"\s*:\s*true/, "用量图表验收缺少成功结果");
} finally {
  if (opened) await browser(["close"]).catch(() => undefined);
  await fixture.close();
}
