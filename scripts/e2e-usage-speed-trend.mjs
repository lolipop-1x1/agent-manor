import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { usageFixture } from "./usage-fixture.mjs";

// 延迟、失败与偏好写入只作用于隔离的合成历史，截图保存在忽略目录。
const run = promisify(execFile), now = new Date(), fixture = await usageFixture({ speedTiming: true, now });
const artifacts = fileURLToPath(new URL("../.local/usage-speed-trend-e2e/", import.meta.url));
const session = `usage-speed-${process.pid}`;
let opened = false;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${session}`, ...args], {
    cwd: fixture.directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
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
    const ready = async () => { await page.locator(".usage-results[aria-busy='false']").waitFor(); await page.waitForLoadState("networkidle"); };
    const change = async action => {
      const response = page.waitForResponse(value => /\/api\/v1\/usage\?/.test(value.url()) && value.status() === 200);
      await action(); await response; await ready();
    };
    const api = async params => page.evaluate(async params => {
      const query = new URLSearchParams(params); const response = await fetch(`/api/v1/usage?${query}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json();
    }, params);
    const address = () => page.evaluate(() => location.hash);
    const parameter = name => page.evaluate(name => new URLSearchParams(location.hash.split("?")[1]).get(name), name);
    const addressState = () => page.evaluate(() => JSON.stringify([...new URLSearchParams(location.hash.split("?")[1])].sort(([left], [right]) => left.localeCompare(right))));
    const navigate = async values => {
      await change(() => page.evaluate(values => { location.hash = `usage?${new URLSearchParams(values)}`; }, values));
    };
    await page.setViewportSize({ width: 1440, height: 1080 }); await ready();
    const summary = await page.locator(".usage-metric-overview").innerText();
    const composition = await page.locator(".usage-composition-values").innerText();
    const normal = await api({ timezone: "Asia/Shanghai" });
    ensure(normal.speed === undefined, "普通查询带上了额外速度结果");
    await button("折线").click(); await button("日历热力图").click();
    await change(() => button("吐字速度").click());
    const slider = page.getByRole("slider", { name: "选择速度时间区间", exact: true });
    const chart = page.getByRole("img", { name: "吐字速度趋势", exact: true });
    await slider.waitFor();
    ensure(await button("吐字速度").getAttribute("aria-pressed") === "true", "速度指标未选中");
    ensure(await page.locator(".usage-metric-overview").innerText() === summary, "切换速度改变普通汇总");
    ensure(await page.locator(".usage-composition-values").innerText() === composition, "速度错误地变成了组成度量");
    ensure(await button("日历热力图").count() === 0 && await button("柱状").count() === 0, "速度仍显示日历或柱状切换");
    const speedAddress = await address();
    const selected = await parameter("speedGroup");
    ensure(selected && speedAddress.includes("trendMetric=speed"), "速度或默认分组没有同步地址");
    const report = await api({ timezone: "Asia/Shanghai", includeSpeed: "true", speedGroup: selected });
    ensure(JSON.stringify(report.totals) === JSON.stringify(normal.totals), "速度附加查询改变用量汇总");
    ensure(report.speed.buckets.length === report.buckets.length, "速度日期范围与用量不一致");
    ensure(report.speed.groups.some(group => group.client === "dsh" && group.window === "generation" && group.basis === "recorded"), "缺原生输出阶段组");
    ensure(report.speed.groups.some(group => group.client === "codex" && group.window === "response" && group.basis === "estimated"), "缺历史响应区间组");
    const keys = report.speed.groups.map(group => JSON.stringify([group.client, group.model, group.window, group.basis, group.method]));
    ensure(new Set(keys).size === keys.length, "分组身份重复");
    const group = report.speed.groups.find(group => group.key === selected);
    const eligible = report.speed.buckets.filter(bucket => bucket.tokensPerSecond !== null);
    for (const bucket of eligible) ensure(Math.abs(bucket.tokensPerSecond - bucket.outputTokens * 1000 / bucket.durationMs) < 1e-10, "日期速度未使用合格总量加权");
    ensure(Math.abs(group.tokensPerSecond - eligible.reduce((total, bucket) => total + bucket.outputTokens, 0) * 1000 / eligible.reduce((total, bucket) => total + bucket.durationMs, 0)) < 1e-10, "分组速度未使用总量加权");
    ensure(report.speed.buckets.some(bucket => bucket.tokensPerSecond === null && bucket.outputTokens === null && bucket.durationMs === null), "无样本日期被补成零");
    ensure(await page.locator(".usage-speed-line").count() > 1, "速度折线跨越无样本日期连接");
    await page.mouse.move(0, 0);
    await page.locator(".usage-speed-analysis").screenshot({ path: `${options.artifacts}/zh-desktop-speed-region.png` });
    const native = report.speed.groups.find(group => group.client === "dsh" && group.model === "fixture-large");
    const nativeReport = await api({ timezone: "Asia/Shanghai", includeSpeed: "true", speedGroup: native.key });
    // 原生合成会话只有一个来源，直接从生成公式校验门槛及未舍入速度。
    const expectedNative = Array.from({ length: 28 }, (_, day) => day).filter(day => day % 3 === 0 && day !== 9).map(day => {
      const output = 540 + day * 30; return { output, duration: Math.round(output * 1000 / (22 + day)) };
    });
    ensure(native.eligibleRequests === expectedNative.length && native.outputTokens === expectedNative.reduce((sum, row) => sum + row.output, 0)
      && native.durationMs === expectedNative.reduce((sum, row) => sum + row.duration, 0), "原生组与独立合成公式不一致");
    ensure(nativeReport.speed.buckets.filter(bucket => bucket.tokensPerSecond !== null).length === expectedNative.length, "稀疏日期点数量错误");
    const missingDate = new Date(options.now); missingDate.setDate(missingDate.getDate() - 5);
    const missingKey = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(missingDate);
    const belowThreshold = report.speed.buckets.find(bucket => bucket.key === missingKey);
    ensure(belowThreshold?.tokensPerSecond === null && belowThreshold.requests > 0, "不足200 Token的日期没有保留覆盖与未知值");
    const originalTrend = await chart.innerHTML();
    const pager = page.getByRole("navigation", { name: "会话明细", exact: true });
    await change(() => pager.getByRole("button", { name: "会话明细下一页", exact: true }).click());
    ensure(await chart.innerHTML() === originalTrend, "会话分页改变完整速度曲线");
    await change(() => pager.getByRole("button", { name: "会话明细首页", exact: true }).click());

    await slider.scrollIntoViewIfNeeded(); const plotBounds = await slider.boundingBox();
    const before = await page.locator(".usage-session-section").boundingBox();
    await page.mouse.move(plotBounds.x + plotBounds.width * .25, plotBounds.y + plotBounds.height / 2);
    const popup = page.getByRole("dialog", { name: "速度区间明细", exact: true }); await popup.waitFor();
    ensure(Math.abs((await page.locator(".usage-session-section").boundingBox()).y - before.y) < 1, "速度浮层推动页面布局");
    await slider.press("Home"); ensure(await slider.getAttribute("aria-valuenow") === "1", "速度键盘Home未选首区间");
    await slider.press("End"); ensure(await slider.getAttribute("aria-valuenow") === await slider.getAttribute("aria-valuemax"), "速度键盘End未选末区间");
    ensure((await popup.innerText()).includes("≈"), "估算速度缺少近似标记");
    await button("关闭速度区间明细").click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "选择速度时间区间");
    ensure(await popup.count() === 0, "关闭速度浮层时因焦点恢复重新打开");
    await slider.press("Enter"); await popup.waitFor(); await page.keyboard.press("Escape");
    ensure(await popup.count() === 0, "Escape未关闭速度浮层");

    const picker = button("计时分组"); await picker.click();
    const search = page.getByRole("combobox", { name: "计时分组搜索", exact: true });
    await search.fill("no-such-synthetic-model"); ensure(await page.getByRole("option").count() === 0, "分组搜索空结果仍显示选项");
    await search.fill("");
    const list = page.getByRole("listbox", { name: "计时分组选项", exact: true });
    const scrollable = await list.evaluate(element => element.scrollHeight > element.clientHeight);
    ensure(scrollable, "分组长列表未形成独立滚动");
    await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
    ensure(await list.evaluate(element => element.scrollTop) > 0, "分组列表不能滚动");
    await search.fill("fixture-large DeepSeek Harness");
    await search.press("ArrowDown"); await change(() => search.press("Enter"));
    ensure(await parameter("speedGroup") === native.key, "键盘选择未切换到原生组");
    ensure(await page.locator(".usage-speed-point").count() >= expectedNative.length, "孤立速度点不可见");
    await slider.press("End"); await popup.waitFor(); ensure(!(await popup.locator(".usage-time-total").innerText()).includes("≈"), "原生速度被标记为估算");
    await page.keyboard.press("Escape");
    await change(() => button("已记录 Token").click());
    ensure(await button("折线").getAttribute("aria-pressed") === "true" && await button("日历热力图").getAttribute("aria-pressed") === "true", "普通图表偏好没有恢复");
    await change(() => button("吐字速度").click());
    ensure(await parameter("speedGroup") === native.key, "来回切换丢失速度分组");
    const nativeAddress = await addressState(); await page.reload(); await ready();
    ensure(await addressState() === nativeAddress && await button("吐字速度").getAttribute("aria-pressed") === "true", "刷新没有恢复速度与分组");
    await button("总览").click(); await button("用量统计").click(); await ready();
    ensure(await addressState() === nativeAddress && await button("吐字速度").getAttribute("aria-pressed") === "true", "隐藏再显示丢失速度分组");

    const oldLabel = await picker.innerText(); const oldChart = await chart.innerHTML();
    let release; await page.route("**/api/v1/usage?*", async route => { await new Promise(resolve => { release = resolve; }); await route.continue(); });
    await picker.click(); await search.fill(group.model); await page.getByRole("option").filter({ hasText: "Codex" }).first().click();
    await page.locator(".usage-results[aria-busy='true']").waitFor();
    ensure(await picker.innerText() === oldLabel && await chart.innerHTML() === oldChart, "等待期间图与真实分组不一致");
    ensure(await page.locator(".usage-report-body").getAttribute("inert") !== null, "等待期间旧图仍可交互");
    ensure(await page.locator(".usage-query-feedback .is-spinning").count() > 0, "等待期间缺固定进度图标");
    while (!release) await page.waitForTimeout(25); release(); await ready(); await page.unroute("**/api/v1/usage?*");
    const confirmedLabel = await picker.innerText(), confirmedChart = await chart.innerHTML();
    await page.route("**/api/v1/usage?*", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "synthetic failure", messageDescriptor: { key: "common.error.http", params: { status: 503 } } } }) }));
    await button("估算费用").click(); await page.getByRole("alert").waitFor();
    ensure(await picker.innerText() === confirmedLabel && await chart.innerHTML() === confirmedChart, "失败丢失完整速度图");
    ensure(await button("吐字速度").getAttribute("aria-pressed") === "true", "失败期间选择状态冒充新结果");
    await page.unroute("**/api/v1/usage?*"); await change(() => button("重试").click());
    ensure(await button("估算费用").getAttribute("aria-pressed") === "true", "重试没有完成原指标切换");
    await change(() => button("吐字速度").click());
    let releaseStale, staleFinished;
    await page.route("**/api/v1/usage?*", async route => {
      if (!/[?&]metric=requests(?:&|$)/.test(route.request().url())) { await route.continue(); return; }
      const response = await route.fetch(); await new Promise(resolve => { releaseStale = resolve; });
      await route.fulfill({ response }).catch(() => undefined); staleFinished = true;
    });
    await button("已记录请求").click(); await page.locator(".usage-results[aria-busy='true']").waitFor();
    while (!releaseStale) await page.waitForTimeout(25);
    await change(() => button("已记录 Token").click()); releaseStale();
    while (!staleFinished) await page.waitForTimeout(25);
    await page.waitForTimeout(100); await page.unroute("**/api/v1/usage?*");
    ensure(await button("已记录 Token").getAttribute("aria-pressed") === "true", "晚到旧请求覆盖新指标");
    await change(() => button("吐字速度").click());

    await navigate({ window: "today", trendMetric: "speed", speedGroup: native.key, clients: JSON.stringify(["claude"]) });
    const filteredGroup = await parameter("speedGroup");
    ensure(filteredGroup && filteredGroup !== native.key && (await picker.innerText()).includes("Claude"), "筛选移除选中组后未回退同范围分组");
    ensure(await slider.getAttribute("aria-valuemax") === "1", "日期筛选未限制速度时间范围");
    await navigate({ window: "custom", from: missingKey, to: missingKey, trendMetric: "speed" });
    ensure(await page.getByText("当前范围没有可计算吐字速度的合格样本。", { exact: true }).isVisible()
      && await slider.count() === 0, "只有低于门槛请求时未显示明确空状态");
    await navigate({ window: "all", trendMetric: "speed", speedGroup: native.key });
    const stableAddress = await address();
    for (const theme of ["深色", "明亮"]) {
      await button("外观").click(); await page.getByRole("combobox", { name: "显示模式", exact: true }).click();
      await page.getByRole("option", { name: theme, exact: true }).click(); await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 390, height: 844 });
      ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "速度窄屏横向溢出");
      await slider.press("Home"); await popup.waitFor();
      const bounds = await popup.boundingBox(); ensure(bounds.x >= 0 && bounds.x + bounds.width <= 390, "速度窄屏浮层越界");
      await page.keyboard.press("Escape"); await page.screenshot({ path: `${options.artifacts}/zh-mobile-${theme === "深色" ? "dark" : "light"}.png`, fullPage: true });
    }
    await button("外观").click(); await page.getByRole("combobox", { name: "显示模式", exact: true }).click();
    await page.getByRole("option", { name: "深色", exact: true }).click(); await page.keyboard.press("Escape");
    await button("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
    await button("Output speed").waitFor(); ensure(await address() === stableAddress, "语言主题切换改变速度筛选");
    await button("Timing group").click(); await page.getByRole("combobox", { name: "Search Timing group", exact: true }).fill("fixture");
    ensure(await page.getByRole("option").count() > 0, "英文分组选择器无法搜索"); await page.keyboard.press("Escape");
    await page.getByRole("slider", { name: "Select speed interval", exact: true }).press("Home");
    await page.getByRole("dialog", { name: "Speed interval details", exact: true }).waitFor(); await page.keyboard.press("Escape");
    await page.screenshot({ path: `${options.artifacts}/en-mobile-dark.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.locator(".usage-speed-analysis").screenshot({ path: `${options.artifacts}/en-desktop-speed-region.png` });
    await page.screenshot({ path: `${options.artifacts}/en-desktop.png`, fullPage: true });

    const touchContext = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const touch = await touchContext.newPage(); await touch.goto(`${options.base}/${stableAddress}`);
      await touch.locator(".usage-results[aria-busy='false']").waitFor();
      const touchSlider = touch.getByRole("slider", { name: /Select speed interval|选择速度时间区间/ });
      await touchSlider.tap(); const touchPopup = touch.getByRole("dialog", { name: /Speed interval details|速度区间明细/ }); await touchPopup.waitFor();
      const bounds = await touchPopup.boundingBox(); ensure(bounds.x >= 0 && bounds.x + bounds.width <= 390, "触屏速度详情越界");
      await touchPopup.getByRole("button", { name: /Close Speed interval details|关闭速度区间明细/ }).tap();
      ensure(await touchPopup.count() === 0, "触屏无法关闭速度详情");
      await touch.screenshot({ path: `${options.artifacts}/touch-mobile.png`, fullPage: true });
    } finally { await touchContext.close(); }
    ensure(errors.length === 0, `浏览器错误：${errors.join(";")}`);
    return { passed: true, checks, errors, weightedSpeed: true, thresholdsAndGaps: true, isolatedPoints: true,
      searchAndKeyboard: true, stableLoadingAndFailure: true, staleResponse: true, paginationAndFilters: true,
      addressAndPreferences: true, hoverAndFocus: true, englishAndThemes: true, mobileAndTouch: true };
  };
  const output = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify({ base: fixture.base, artifacts, now: now.toISOString() })})`]);
  console.log(output.split("### Ran Playwright code")[0]); await writeFile(`${artifacts}/report.txt`, output);
  assert.match(output, /"passed"\s*:\s*true/, "速度趋势验收缺少成功结果");
} catch (error) {
  if (opened) await browser(["screenshot", `--filename=${artifacts}/failure.png`]).catch(() => undefined);
  throw error;
} finally { if (opened) await browser(["close"]).catch(() => undefined); await fixture.close(); }
