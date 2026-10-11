import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { usageFixture } from "./usage-fixture.mjs";

// 写操作和异常注入只使用隔离的合成历史、价格与偏好。
const run = promisify(execFile), fixture = await usageFixture();
const artifacts = fileURLToPath(new URL("../.local/usage-interface-e2e/", import.meta.url));
const session = `usage-interface-${process.pid}`;
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
    const api = path => page.evaluate(async path => (await fetch(`/api/v1${path}`)).json(), path);
    await page.setViewportSize({ width: 1440, height: 1080 }); await ready();
    const initialHash = await page.evaluate(() => location.hash);
    ensure((await page.locator(".usage-metrics").innerText()).includes("$"), "费用没有美元符号");
    ensure(!(await page.locator(".usage-page").innerText()).includes("价格版本"), "诊断版本仍然常驻");
    await button("时间趋势").click(); const slider = page.getByRole("slider", { name: "选择时间区间", exact: true });
    await slider.press("Home"); ensure(await slider.getAttribute("aria-valuenow") === "1", "Home 无法选择首区间");
    await slider.press("End"); ensure(await slider.getAttribute("aria-valuenow") === await slider.getAttribute("aria-valuemax"), "End 无法选择末区间");
    await button("日历热力图").click(); ensure(await page.getByRole("slider").count() === 0, "日历与趋势没有切换显示");
    ensure(await page.locator(".usage-heatmap button[tabindex='0']").count() === 1, "日历有多个 Tab 入口");
    await page.locator(".usage-heatmap button[tabindex='0']").press("Home");
    ensure(await page.locator(".usage-heatmap button").first().evaluate(element => element === document.activeElement), "日历 Home 没有移至首日");
    await button("时间趋势").click(); ensure(await page.evaluate(() => location.hash) === initialHash, "时间视图切换改变统计筛选");
    const trigger = page.locator(".usage-session-section tbody tr").nth(8).getByRole("button", { name: "查看请求明细", exact: true });
    await trigger.scrollIntoViewIfNeeded(); const scrollBefore = await page.evaluate(() => scrollY);
    await page.route("**/api/v1/usage/requests?**", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "synthetic failure", messageDescriptor: { key: "common.error.http", params: { status: 503 } } } }) }));
    await trigger.click(); let requests = page.getByRole("dialog", { name: "请求明细", exact: true });
    await requests.getByRole("alert").waitFor(); ensure(await requests.getByRole("button", { name: "重试", exact: true }).isVisible(), "请求错误无法重试");
    await page.unroute("**/api/v1/usage/requests?**"); await button("重试").click(); await requests.locator("tbody tr").first().waitFor();
    ensure(await requests.locator("thead th").count() === 9 && await requests.locator("tbody tr").first().evaluate(row => getComputedStyle(row.children[1]).textAlign === "left" && getComputedStyle(row.children[2]).textAlign === "right" && getComputedStyle(row.children[7]).textAlign === "left"), "请求明细没有保留九列或文字与数字对齐不正确");
    const bounds = await requests.boundingBox(); ensure(bounds.y >= 0 && bounds.y + bounds.height <= 1080, "请求明细超出当前视口");
    ensure(await requests.locator("details:not([open])").count() > 0, "价格元信息没有默认收起");
    await button("关闭请求明细").click();
    ensure(await trigger.evaluate(element => element === document.activeElement), "关闭明细没有恢复触发按钮焦点");
    ensure(Math.abs(await page.evaluate(() => scrollY) - scrollBefore) < 2, "关闭明细丢失列表滚动位置");
    await page.locator(".usage-session-section tbody tr").nth(8).locator("td").nth(4).click(); await requests.waitFor();
    ensure(await requests.isVisible(), "会话整行不能打开请求"); await button("关闭请求明细").click();
    await button("管理模型价格").click(); let prices = page.getByRole("dialog", { name: "模型价格", exact: true });
    ensure(await prices.getByRole("combobox", { name: "显示范围", exact: true }).innerText() === "已记录与配置", "价格默认显示完整目录");
    const priceScroll = prices.locator(".pricing-list-scroll"); await priceScroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const listPosition = await priceScroll.evaluate(element => element.scrollTop);
    const edit = prices.getByRole("button", { name: "修改价格", exact: true }).last(); await edit.click();
    ensure(await prices.getByLabel("原始模型名", { exact: true }).evaluate(element => element === document.activeElement), "价格编辑没有聚焦首字段");
    ensure(await prices.locator(".pricing-list").isHidden(), "编辑表单仍与列表堆叠");
    ensure(await button("保存配置").isVisible() && await button("返回价格列表").isVisible(), "编辑保存及返回入口不可见");
    await button("返回价格列表").click(); ensure(await edit.evaluate(element => element === document.activeElement), "返回价格列表未恢复行焦点");
    ensure(Math.abs(await priceScroll.evaluate(element => element.scrollTop) - listPosition) < 2, "返回价格列表丢失滚动位置");
    await prices.getByRole("combobox", { name: "显示范围", exact: true }).click(); await page.getByRole("option", { name: "完整价格目录", exact: true }).click();
    ensure(await prices.getByRole("combobox", { name: "显示范围", exact: true }).innerText() === "完整价格目录", "完整目录菜单被弹层挡住");
    await button("设置任意模型价格").click(); await prices.getByLabel("原始模型名", { exact: true }).fill("synthetic-custom-ui-model");
    await prices.getByLabel("普通输入单价", { exact: true }).fill("2"); await prices.getByLabel("输出单价", { exact: true }).fill("3");
    await page.route("**/api/v1/usage/pricing", route => route.request().method() === "PUT" ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "synthetic save failure", messageDescriptor: { key: "common.error.http", params: { status: 503 } } } }) }) : route.continue());
    await button("保存配置").click(); await prices.getByRole("alert").waitFor();
    ensure(await prices.getByLabel("原始模型名", { exact: true }).inputValue() === "synthetic-custom-ui-model", "保存失败丢失编辑内容");
    await page.unroute("**/api/v1/usage/pricing"); await button("保存配置").click(); await prices.locator(".pricing-editor").waitFor({ state: "hidden" });
    ensure((await api("/usage/pricing")).configuration.overrides.some(value => value.model === "synthetic-custom-ui-model" && value.input === 2), "重试没有保存用户价格");
    await button("关闭模型价格").click();
    await page.screenshot({ path: `${options.artifacts}/zh-desktop.png`, fullPage: true });
    for (const theme of ["dark", "light"]) {
      await button("外观").click(); await page.getByRole("combobox", { name: "显示模式", exact: true }).click(); await page.getByRole("option", { name: theme === "dark" ? "深色" : "明亮", exact: true }).click(); await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 390, height: 844 });
      ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "窄屏用量页整体横向溢出");
      ensure(await page.locator(".usage-metric-compact").first().isVisible(), "窄屏长数字未采用紧凑显示");
      await button("管理模型价格").click(); await button("设置任意模型价格").click();
      const saveBounds = await button("保存配置").boundingBox(); ensure(saveBounds.y >= 0 && saveBounds.y + saveBounds.height <= 844, "窄屏价格保存不可见");
      await page.screenshot({ path: `${options.artifacts}/zh-price-editor-${theme}.png` });
      await page.keyboard.press("Escape"); ensure(await prices.locator(".pricing-list").isVisible(), "编辑 Escape 未回到列表");
      await page.keyboard.press("Escape"); await prices.waitFor({ state: "hidden" });
    }
    await page.setViewportSize({ width: 1440, height: 1080 });
    await button("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click(); await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
    await button("Manage model prices").click(); await button("Add model mapping").click();
    ensure(await button("Save configuration").isVisible() && await button("Back to prices").isVisible(), "英文编辑操作未翻译");
    await button("Cancel").click(); await button("Close Model prices").click();
    ensure(errors.length === 0, `浏览器错误：${errors.join(";")}`);
    return { passed: true, checks, errors, requestRecovery: true, scrollAndFocus: true, pricingWorkspace: true, keyboard: true, currency: true, mobileAndThemes: true, english: true };
  };
  const output = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify({ artifacts })})`]);
  console.log(output.split("### Ran Playwright code")[0]); await writeFile(`${artifacts}/report.txt`, output);
  assert.match(output, /"passed"\s*:\s*true/);
} catch (error) {
  if (opened) await browser(["screenshot", `--filename=${artifacts}/failure.png`]).catch(() => undefined);
  throw error;
} finally { if (opened) await browser(["close"]).catch(() => undefined); await fixture.close(); }
