import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { translate } from "../dist/i18n/index.js";
import { weeklyReviewFixture } from "./weekly-review-fixture.mjs";

// 全部延迟、偏好与截图只作用于隔离合成后台。
const run = promisify(execFile), fixture = await weeklyReviewFixture();
const artifacts = fileURLToPath(new URL("../.local/butler-loading-e2e/", import.meta.url));
const session = `butler-loading-${process.pid}`;
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
  await browser(["open", fixture.base, "--headed", "--browser=chrome"]); opened = true;
  const verify = async (page, options) => {
    page.setDefaultTimeout(15_000);
    const checks = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const ensure = (value, description) => { if (!value) throw new Error(description); checks.push(description); };
    await page.setViewportSize({ width: options.width, height: 950 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const hold = async pattern => {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route(pattern, async route => {
        const response = await route.fetch(); await gate;
        if (!route.request().failure()) await route.fulfill({ response }).catch(error => {
          if (!String(error).includes("Route is already handled")) throw error;
        });
      });
      return async () => { release(); await page.unroute(pattern); };
    };
    const cold = async ({ name, hash, pattern, scene, ready }) => {
      const release = await hold(pattern);
      try {
        await page.goto(`${options.base}/?loading-preview=${name}#${hash}`);
        const loader = page.locator(scene);
        if (name === "sessions" && options.width < 1024) {
          await page.getByRole("button", { name: options.sessionList, exact: true }).click();
        }
        await loader.waitFor(); await loader.scrollIntoViewIfNeeded();
        await page.waitForFunction(selector => {
          const element = document.querySelector(selector);
          return element?.dataset.paused === "false" && Number(getComputedStyle(element.querySelector(".loading-art")).opacity) > .99;
        }, scene);
        ensure(await loader.count() === 1, `${name} 首次加载使用单个管家`);
        ensure(await loader.locator(".loading-pour-arm").count() === 3, `${name} 袖子与手壶同步绘制`);
        ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} 无横向溢出`);
        await page.screenshot({ path: `${options.artifacts}/${options.language}-${name}-loading.png` });
        if (name === "overview") {
          await page.setViewportSize({ width: options.width, height: 360 });
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForFunction(selector => document.querySelector(selector)?.dataset.paused === "true", scene);
          ensure(true, "管家离开视口暂停循环");
          await page.setViewportSize({ width: options.width, height: 950 });
          await loader.scrollIntoViewIfNeeded();
          await page.waitForFunction(selector => document.querySelector(selector)?.dataset.paused === "false", scene);
          ensure(true, "管家回到视口继续循环");
          await page.emulateMedia({ reducedMotion: "reduce" });
          ensure(await loader.evaluate(element => element.getAnimations({ subtree: true }).length === 0
            && Number(getComputedStyle(element.querySelector(".loading-steam")).opacity) > 0), "减少动态效果显示静态端茶姿态");
          await page.emulateMedia({ reducedMotion: "no-preference" });
        }
      } finally { await release(); }
      await page.locator(ready).first().waitFor();
      await page.locator(scene).waitFor({ state: "hidden" });
      await page.waitForLoadState("networkidle");
      ensure(true, `${name} 数据返回后退出管家`);
    };
    const refresh = async ({ name, pattern, button, results, body, indicator }) => {
      const snapshot = () => page.locator(body).evaluateAll(elements => elements.map(element => ({
        text: element.innerText, height: element.getBoundingClientRect().height,
      })));
      const content = await snapshot();
      const release = await hold(pattern);
      try {
        await page.getByRole("button", { name: button, exact: true }).click();
        await page.locator(`${results}[aria-busy='true']`).waitFor();
        await page.locator(indicator).first().waitFor();
        const refreshedContent = await snapshot();
        ensure(JSON.stringify(refreshedContent.map(value => value.text)) === JSON.stringify(content.map(value => value.text)), `${name} 刷新保留旧完整结果`);
        ensure(refreshedContent.length === content.length && refreshedContent.every((value, index) => Math.abs(value.height - content[index].height) < 1), `${name} 刷新保持区域高度`);
        ensure(await page.locator(body).locator(".loading--scene").count() === 0, `${name} 刷新不覆盖图表`);
        ensure(await page.locator(indicator).first().evaluate(element => element.getBoundingClientRect().height <= 20), `${name} 紧凑茶杯不扩大固定槽位`);
        if (name === "usage") ensure(await page.locator(".usage-group-switch .filter-trigger > span:last-child").evaluate(element => getComputedStyle(element).visibility === "hidden"), "茶杯出现时隐藏分组下拉箭头");
        await page.screenshot({ path: `${options.artifacts}/${options.language}-${name}-refresh.png` });
      } finally { await release(); }
      await page.locator(`${results}[aria-busy='false']`).waitFor();
      await page.locator(indicator).first().waitFor({ state: "hidden" });
    };
    await cold({ name: "overview", hash: "overview", pattern: "**/api/v1/overview/snapshot?**",
      scene: ".overview-loading .loading--scene", ready: ".overview-results[aria-busy='false']" });
    await refresh({ name: "overview", pattern: "**/api/v1/overview/snapshot?**", button: options.overviewRefresh,
      results: ".overview-results", body: ".overview-report-body", indicator: ".overview-range .loading--inline" });
    await cold({ name: "usage", hash: "usage", pattern: "**/api/v1/usage?**",
      scene: ".usage-loading .loading--scene", ready: ".usage-results[aria-busy='false']" });
    await refresh({ name: "usage", pattern: "**/api/v1/usage?**", button: options.usageRefresh,
      results: ".usage-results", body: ".usage-metric-overview, .usage-report-body", indicator: ".usage-chart-controls .loading--inline" });
    await cold({ name: "resources", hash: "resources?kind=skill&view=list", pattern: "**/api/v1/resources/overview?**",
      scene: ".resource-loading .loading--scene", ready: ".resource-list-scroll[aria-busy='false']" });
    await cold({ name: "sessions", hash: "sessions", pattern: "**/api/v1/sessions?**",
      scene: ".session-list-loading .loading--scene", ready: ".session-list-item" });
    ensure(errors.length === 0, errors.join("; ") || "页面无运行错误");
    return { language: options.language, width: options.width, checks };
  };
  const reports = [];
  for (const [language, mode, width] of [["zh-CN", "dark", 1440], ["en", "light", 390]]) {
    const saved = await fetch(`${fixture.base}/api/v1/preferences`, {
      method: "PUT", headers: { "Content-Type": "application/json", "x-agent-manor-instance": fixture.service.instance.id },
      body: JSON.stringify({ language, appearance: { mode } }),
    });
    if (!saved.ok) throw new Error(`无法设置合成偏好：${saved.status}`);
    const result = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify({
      base: fixture.base, artifacts, language, width,
      overviewRefresh: translate(language, "overview.refresh"), usageRefresh: translate(language, "usage.refresh"),
      sessionList: translate(language, "sessions.list.title"),
    })})`, "--raw"]);
    reports.push(JSON.parse(result.trim()));
    console.log(result);
  }
  await writeFile(`${artifacts}/report.json`, JSON.stringify(reports, null, 2));
} catch (error) {
  if (opened) await browser(["screenshot", `--filename=${artifacts}/failure.png`]).catch(() => {});
  throw error;
} finally {
  if (opened) await browser(["close"]).catch(() => {});
  await fixture.close();
}
