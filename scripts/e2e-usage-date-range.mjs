import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { usageFixture } from "./usage-fixture.mjs";

// 跨年长历史使用隔离合成来源；断言图表可见范围与真实统计接口一致。
const run = promisify(execFile);
const fixture = await usageFixture({ days: 315, now: new Date(2026, 9, 11, 12) });
const artifacts = fileURLToPath(new URL("../.local/usage-date-range-e2e/", import.meta.url));
const session = `usage-dates-${process.pid}`;
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
  await browser(["open", `${fixture.base}/#usage?window=all`, "--headed", "--browser=chrome"]); opened = true;
  const verify = async (page, options) => {
    let checks = 0; const errors = []; page.on("pageerror", error => errors.push(error.message));
    const ensure = (condition, message) => { if (!condition) throw new Error(message); checks++; };
    const button = name => page.getByRole("button", { name, exact: true });
    const ready = async () => { await page.locator(".usage-metrics").waitFor(); await page.waitForLoadState("networkidle"); };
    const navigate = async query => { await page.goto(`${options.base}/#usage?${query}`); await ready(); };
    const layout = async () => page.locator(".usage-trend-plot").evaluate(plot => {
      const bounds = plot.getBoundingClientRect(), scroll = plot.parentElement;
      const selector = plot.querySelector("[role=slider]");
      const ticks = [...plot.querySelectorAll("svg > text")].map(tick => {
        const box = tick.getBoundingClientRect(); return { label: tick.textContent, left: box.left, right: box.right };
      });
      return { count: Number(selector?.getAttribute("aria-valuemax")), first: ticks[0]?.label, last: ticks.at(-1)?.label,
        left: bounds.left, right: bounds.right, width: scroll.clientWidth, scrollWidth: scroll.scrollWidth, ticks,
        lastVisible: selector?.getBoundingClientRect().right <= scroll.getBoundingClientRect().right + 1 };
    });
    const verifyLayout = async (firstYear, lastYear) => {
      const chart = await layout();
      ensure(chart.scrollWidth <= chart.width + 1, "趋势图横向溢出，完整日期范围没有同时可见");
      ensure(chart.lastVisible, "末日期柱没有出现在可见区间");
      ensure(chart.first.includes(firstYear) && chart.last.includes(lastYear), "首末请求日期没有年份");
      ensure(chart.ticks.every(tick => /20\d{2}/.test(tick.label)), "横轴有缺少年份的日期");
      ensure(chart.ticks[0].label.includes(firstYear) && chart.ticks.at(-1).label.includes(lastYear), "横轴没有保留区间两端");
      ensure(chart.ticks.every(tick => tick.left >= chart.left - 1 && tick.right <= chart.right + 1), "日期刻度被图表边界裁剪");
      ensure(chart.ticks.every((tick, index) => !index || tick.left >= chart.ticks[index - 1].right + 4), "日期刻度相互重叠");
      return chart;
    };
    for (const language of ["zh-CN", "en"]) {
      const zh = language === "zh-CN";
      if (!zh) { await button("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click(); await ready(); }
      await page.setViewportSize({ width: 1440, height: 1080 });
      await navigate("window=all&clients=%5B%22codex%22%5D&interval=day");
      const all = await verifyLayout("2025", "2026");
      ensure(all.count === 315, "全部日期图表遗漏日桶");
      const range = await page.locator(".usage-range").innerText();
      ensure(range.includes("2025") && range.includes("2026") && !range.includes(zh ? "全部日期" : "All dates"), "全部日期范围没有采用实际起止");
      await button(zh ? "日历热力图" : "Calendar heatmap").click();
      ensure((await page.locator(".usage-heatmap-months").innerText()).includes("2025") && (await page.locator(".usage-heatmap-months").innerText()).includes("2026"), "热力图月份缺少年份");
      await button(zh ? "时间趋势" : "Usage over time").click();
      await page.screenshot({ path: `${options.artifacts}/${language}-all.png`, fullPage: true });
      const values = await page.locator(".usage-metrics").innerText();
      await button(zh ? "折线" : "Lines").click(); await verifyLayout("2025", "2026");
      ensure(await page.locator(".usage-metrics").innerText() === values, "切换图形改变统计数值");
      for (const interval of ["week", "month"]) {
        await navigate(`window=all&interval=${interval}`); await verifyLayout("2025", "2026");
      }
      await navigate("window=custom&from=2025-12-28&to=2026-01-04&interval=day");
      ensure((await verifyLayout("2025", "2026")).count === 8, "跨年自定义区间边界错误");
      await page.getByRole("slider").press("Home");
      ensure((await page.locator('[aria-labelledby="usage-time-title"] .usage-chart-detail').innerText()).includes("2025"), "选中日期缺少年份");
      await button(zh ? "筛选这个区间" : "Filter this interval").click(); await ready();
      const selected = await page.evaluate(() => location.hash);
      ensure(selected.includes("from=2025-12-28") && selected.includes("to=2025-12-28"), "带年份日期下钻改变了真实边界");
      ensure((await verifyLayout("2025", "2025")).count === 1, "单日图表没有保留唯一日期");
      await navigate("window=custom&from=2026-09-12&to=2026-10-11&interval=day");
      ensure((await verifyLayout("2026", "2026")).count === 30, "30天区间没有保留完整日桶");
      await navigate("window=custom&from=2025-12-31&to=2026-01-01&interval=hour");
      ensure((await verifyLayout("2025", "2026")).count === 48, "跨年小时区间没有保留全部小时");
      await page.getByRole("slider").press("End");
      ensure((await page.locator('[aria-labelledby="usage-time-title"] .usage-chart-detail').innerText()).includes("2026"), "小时提示缺少年份");
      await page.setViewportSize({ width: 390, height: 844 }); await verifyLayout("2025", "2026");
      await navigate("window=all&interval=day"); await verifyLayout("2025", "2026");
      ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "窄屏图表使整页横向溢出");
      await page.screenshot({ path: `${options.artifacts}/${language}-mobile.png`, fullPage: true });
    }
    ensure(errors.length === 0, `浏览器运行错误：${errors.join(";")}`);
    return { passed: true, checks, errors, completeRange: true, years: true, customAndCrossYear: true, intervals: true, mobile: true };
  };
  const output = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify({ base: fixture.base, artifacts })})`]);
  console.log(output.split("### Ran Playwright code")[0]);
  assert.match(output, /"passed"\s*:\s*true/, "日期范围浏览器验收缺少成功结果");
} finally {
  if (opened) await browser(["close"]).catch(() => undefined);
  await fixture.close();
}
