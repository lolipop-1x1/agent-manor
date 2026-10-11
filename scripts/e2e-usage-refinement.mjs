import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { usageFixture } from "./usage-fixture.mjs";

// 价格与映射写操作只作用于隔离的合成数据。
const run = promisify(execFile), fixture = await usageFixture({ matchingCandidates: true });
const artifacts = fileURLToPath(new URL("../.local/usage-refinement-e2e/", import.meta.url));
const session = `usage-refinement-${process.pid}`;
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
  await fetch(`${fixture.base}/api/v1/usage/pricing`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    overrides: Array.from({ length: 25 }, (_, index) => ({ model: `rate-${String(index).padStart(2, "0")}`, input: index, output: index * 10, cacheRead: index / 10, cacheWrite: index / 4 })),
    mappings: [{ model: "fixture-mapped", targetProvider: "fixture", targetModel: "fixture-fast" }],
  }) });
  await browser(["open", `${fixture.base}/#usage?window=all`, "--headed", "--browser=chrome"]); opened = true;
  const verify = async (page, options) => {
    let checks = 0; const errors = []; page.on("pageerror", error => errors.push(error.message));
    const ensure = (value, message) => { if (!value) throw new Error(message); checks++; };
    const button = name => page.getByRole("button", { name, exact: true });
    const ready = async () => { await page.locator(".usage-results[aria-busy='false']").waitFor(); await page.waitForLoadState("networkidle"); };
    await page.setViewportSize({ width: 1440, height: 1080 }); await ready();
    const controlGaps = async () => page.locator(".usage-chart-controls > div:last-child").evaluate(element => {
      const bounds = [...element.children].map(child => child.getBoundingClientRect());
      return bounds.slice(1).map((rect, index) => rect.x - bounds[index].right);
    });
    const gaps = await controlGaps(); ensure(gaps.length === 2 && gaps.every(gap => Math.abs(gap - 8) < .1), "控件间距没有统一为8像素");
    let release;
    await page.route("**/api/v1/usage?*", async route => { await new Promise(resolve => { release = resolve; }); await route.continue(); });
    await button("估算费用").click(); await page.locator(".usage-results[aria-busy='true']").waitFor();
    ensure(JSON.stringify(await controlGaps()) === JSON.stringify(gaps), "loading改变控件间距");
    ensure(await page.locator(".usage-group-switch .is-spinning").isVisible(), "分组进度没有保留");
    ensure(await page.locator(".usage-report-body").evaluate(element => getComputedStyle(element, "::before").content === "none"), "刷新蓝线仍存在");
    while (!release) await page.waitForTimeout(20); release(); await ready(); await page.unroute("**/api/v1/usage?*");
    await page.locator(".usage-attribution-map").scrollIntoViewIfNeeded();
    const tiles = page.locator(".usage-attribution-tile");
    const tileData = await tiles.evaluateAll(elements => elements.map(element => ({ label: element.getAttribute("aria-label"), tone: Number(element.className.match(/tone-(\d)/)[1]), area: element.offsetWidth * element.offsetHeight })));
    const byArea = [...tileData].sort((a, b) => b.area - a.area);
    ensure(byArea[0].tone === 4 && byArea.slice(1).every((tile, index) => byArea[index].tone >= tile.tone), "色阶没有跟随占比");
    const tinyIndex = await tiles.evaluateAll(elements => elements.findIndex(element => element.getBoundingClientRect().width < 38 || element.getBoundingClientRect().height < 28));
    ensure(tinyIndex >= 0, "合成样本缺少微小方块");
    const tiny = tiles.nth(tinyIndex), fullLabel = await tiny.getAttribute("aria-label");
    await tiny.hover(); const tooltip = page.locator(".usage-attribution-tooltip"); await page.waitForTimeout(150); ensure(await tooltip.count() === 1, `悬浮未打开：${JSON.stringify(await tiny.boundingBox())} ${fullLabel}`);
    ensure((await tooltip.innerText()).startsWith(fullLabel), "小方块悬浮信息不完整");
    ensure(fullLabel.includes("$") && fullLabel.includes("%"), "悬浮缺少金额与占比");
    await page.mouse.move(0, 0); await tiny.press("Shift+Tab"); await page.keyboard.press("Tab"); await page.locator(".usage-attribution-tooltip").waitFor({ timeout: 3000 });
    ensure((await page.locator(".usage-attribution-tooltip").innerText()).startsWith(fullLabel), "键盘焦点没有展示详情");
    await page.keyboard.press("Escape");
    const other = page.locator(".usage-attribution-tile[aria-disabled='true']");
    if (await other.count()) { const hash = await page.evaluate(() => location.hash); await other.hover(); await page.locator(".usage-attribution-tooltip").waitFor({ timeout: 3000 }); ensure((await page.locator(".usage-attribution-tooltip").innerText()).includes("其余合计"), "合计方块不能查看详情"); await other.dispatchEvent("click"); ensure(await page.evaluate(() => location.hash) === hash, "合计方块误追加筛选"); }
    await page.mouse.move(0, 0); await button("管理模型价格").click();
    const dialog = page.getByRole("dialog", { name: "模型价格", exact: true });
    const filter = dialog.getByRole("combobox", { name: "定价状态", exact: true });
    const select = async value => { await filter.click(); await page.getByRole("option", { name: value, exact: true }).click(); };
    const names = () => dialog.locator("tbody tr td:first-child").allTextContents();
    await select("未匹配"); ensure((await names()).includes("fixture-unpriced"), "未匹配筛选漏掉冲突模型");
    const search = dialog.getByRole("textbox", { name: "搜索原始模型、计价模型或服务商", exact: true });
    await search.fill("no-such-price"); ensure(await dialog.locator("tbody tr").count() === 0, "搜索与状态未组合");
    await search.fill("fixture-unpriced"); ensure(await dialog.locator("tbody tr").count() === 1, "搜索与未匹配未组合");
    await dialog.getByRole("button", { name: "修改映射", exact: true }).click(); await button("取消").click();
    ensure(await filter.innerText() === "未匹配" && await search.inputValue() === "fixture-unpriced", "编辑返回丢失筛选");
    await search.fill(""); await select("自动匹配"); const automatic = await names(); ensure(automatic.includes("fixture-fast") && !automatic.includes("fixture-unpriced") && !automatic.includes("fixture-mapped"), "自动匹配混入未匹配或手动模型");
    await select("手动映射"); ensure(JSON.stringify(await names()) === JSON.stringify(["fixture-mapped"]), "手动映射筛选错误");
    await select("用户定价"); ensure(await dialog.locator("tbody tr").count() === 20, "自定义价格分页不正确");
    await dialog.getByRole("button", { name: "普通输入单价", exact: true }).click(); ensure(await dialog.locator("th[aria-sort='ascending']").innerText() === "普通输入单价", "表头缺少排序状态");
    ensure((await names())[0] === "rate-00" && (await names()).at(-1) === "rate-19", "单价升序或跨页排序错误");
    const pager = dialog.getByRole("navigation", { name: "模型价格", exact: true });
    await pager.getByRole("button", { name: "模型价格下一页", exact: true }).click(); ensure((await names())[0] === "rate-20" && (await names()).at(-1) === "rate-24", "排序只应用到当前页");
    await dialog.getByRole("button", { name: "普通输入单价", exact: true }).click(); ensure((await names())[0] === "rate-24", "切换降序未返回首页");
    ensure(await dialog.locator("th[aria-sort='descending']").innerText() === "普通输入单价", "降序没有标识");
    for (const header of ["原始模型名", "定价依据", "输出单价", "缓存读取单价", "缓存写入单价"]) {
      await dialog.getByRole("button", { name: header, exact: true }).click(); ensure(await dialog.locator("th[aria-sort='ascending']").innerText() === header, `表头不可排序：${header}`);
    }
    await dialog.getByRole("button", { name: "缓存写入单价", exact: true }).press("Enter"); ensure((await names())[0] === "rate-24", "键盘未切换排序");
    await page.screenshot({ path: `${options.artifacts}/zh-price-filter-sort.png` });
    await button("关闭模型价格").click(); await button("外观").click(); await page.getByRole("combobox", { name: "显示模式", exact: true }).click(); await page.getByRole("option", { name: "深色", exact: true }).click(); await page.keyboard.press("Escape");
    await button("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
    await page.getByRole("heading", { name: "Usage", exact: true }).waitFor(); await page.setViewportSize({ width: 390, height: 844 });
    await tiles.nth(0).press("Shift+Tab"); await page.keyboard.press("Tab"); await page.locator(".usage-attribution-tooltip").waitFor({ timeout: 3000 });
    const bounds = await page.locator(".usage-attribution-tooltip").boundingBox(); ensure(bounds.x >= 0 && bounds.x + bounds.width <= 390, "窄屏归因浮层越界");
    await page.keyboard.press("Escape"); await button("Manage model prices").click();
    await page.getByRole("combobox", { name: "Pricing status", exact: true }).click(); await page.getByRole("option", { name: "Unmatched", exact: true }).click();
    ensure((await page.getByRole("dialog", { name: "Model prices", exact: true }).innerText()).includes("fixture-unpriced"), "英文筛选错误");
    await page.getByRole("button", { name: "Original model", exact: true }).click();
    ensure(await page.locator(".pricing-table th[aria-sort='ascending']").count() === 1, "英文排序状态错误");
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "窄屏页面溢出");
    await page.screenshot({ path: `${options.artifacts}/en-mobile-dark.png` });
    ensure(errors.length === 0, `浏览器错误：${errors.join(";")}`);
    return { passed: true, checks, errors, controlSpacing: true, noRefreshLine: true, monotonicTones: true, tinyTooltips: true, pricingFilters: true, globalSorting: true, keyboard: true, englishDarkMobile: true };
  };
  const output = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify({ artifacts })})`]);
  console.log(output.split("### Ran Playwright code")[0]); await writeFile(`${artifacts}/report.txt`, output);
} catch (error) {
  if (opened) await browser(["screenshot", `--filename=${artifacts}/failure.png`]).catch(() => {});
  throw error;
} finally { if (opened) await browser(["close"]).catch(() => {}); await fixture.close(); }
