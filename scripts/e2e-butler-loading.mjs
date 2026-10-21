import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { translate } from "../dist/i18n/index.js";
import { weeklyReviewFixture } from "./weekly-review-fixture.mjs";

// 全部延迟、偏好与截图只作用于隔离合成后台。
const run = promisify(execFile), fixture = await weeklyReviewFixture();
const artifacts = fileURLToPath(new URL("../.local/loading-polish-e2e/", import.meta.url));
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
  const entry = await fetch(`${fixture.base}/api/v1/knowledge/entries`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "合成知识：验证查询缓存", body: "查询缓存应随数据版本失效；验证返回的完整内容与版本一致。", scope: { kind: "global" } }) });
  if (!entry.ok) throw new Error(`无法创建隔离知识：${entry.status}`);
  const knowledge = await entry.json();
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
    const screenshot = name => page.screenshot({ path: `${options.artifacts}/${options.language}-${options.width}-${name}.png` });
    const visibleScene = selector => page.waitForFunction(selector => {
      const element = document.querySelector(selector);
      return element?.dataset.paused === "false" && Number(getComputedStyle(element.querySelector(".loading-art")).opacity) > .99;
    }, selector);
    const cold = async ({ name, hash, pattern, scene, ready }) => {
      const release = await hold(pattern);
      try {
        await page.goto(`${options.base}/?loading-preview=${name}#${hash}`);
        const loader = page.locator(scene);
        if (name === "overview") await page.locator(".weekly-review-groups").waitFor({ state: "attached" });
        await loader.waitFor(); await loader.scrollIntoViewIfNeeded();
        await visibleScene(scene);
        ensure(await loader.count() === 1, `${name} 首次加载使用单个管家`);
        ensure(await loader.locator(".loading-pour-arm").count() === 3, `${name} 袖子与手壶同步绘制`);
        ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} 无横向溢出`);
        if (name === "sessions" && options.width >= 1024) ensure(await page.locator(".session-profile .loading-skeleton--profile").isVisible(), "会话画像首次加载保留指标结构");
        await screenshot(`${name}-loading`);
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
    const skeleton = async ({ name, hash, pattern, selector, ready }) => {
      const release = await hold(pattern);
      try {
        await page.goto(`${options.base}/?loading-preview=${name}#${hash}`);
        if (name.startsWith("sessions") && options.width < 1024) await page.getByRole("button", { name: options.sessionList, exact: true }).click();
        const placeholder = page.locator(selector); await placeholder.waitFor();
        ensure(await placeholder.getAttribute("aria-label"), `${name} 有可访问的加载名称`);
        ensure(await placeholder.locator(".loading-skeleton-group").count() >= 3, `${name} 首屏显示结构占位`);
        ensure(await placeholder.locator(".loading--scene").count() === 0, `${name} 窄栏不放大插画`);
        ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} 无横向溢出`);
        await screenshot(name);
      } finally { await release(); }
      await page.locator(ready).first().waitFor();
      await page.locator(selector).waitFor({ state: "hidden" });
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
        if (name === "usage") {
          ensure(await page.locator(".usage-page .loading--inline").count() === 1, "用量更新只有一个主要进度图形");
          ensure(await page.locator(".usage-group-switch .filter-trigger > span:last-child").evaluate(element => getComputedStyle(element).visibility !== "hidden"), "更新时保留分组下拉箭头");
        }
        await screenshot(`${name}-refresh`);
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
      results: ".usage-results", body: ".usage-metric-overview, .usage-report-body", indicator: ".usage-page-heading .refresh-button .loading--inline" });
    await cold({ name: "resources", hash: "resources?kind=skill&view=list", pattern: "**/api/v1/resources/overview?**",
      scene: ".resource-loading .loading--scene", ready: ".resource-list-scroll[aria-busy='false']" });
    await skeleton({ name: "sessions-index", hash: "sessions", pattern: "**/api/v1/sessions/status?**", selector: ".session-sidebar .loading-skeleton--list", ready: ".session-list-item" });
    await skeleton({ name: "sessions-list", hash: "sessions", pattern: "**/api/v1/sessions?**", selector: ".session-sidebar .loading-skeleton--list", ready: ".session-list-item" });
    await cold({ name: "sessions", hash: "sessions?id=review-session-0", pattern: "**/api/v1/sessions/*/messages?**", scene: ".session-message-loading .loading--scene", ready: ".session-turn" });
    if (options.width < 1024) {
      const release = await hold("**/api/v1/sessions/*/messages?**");
      try {
        await page.goto(`${options.base}/?loading-preview=profile#sessions?id=review-session-0`);
        await page.getByRole("button", { name: options.sessionProfile, exact: true }).click();
        await page.locator(".session-profile .loading-skeleton--profile").waitFor();
        await screenshot("sessions-profile");
      } finally { await release(); }
    }
    await page.goto(`${options.base}/?loading-preview=session-filter#sessions`);
    await page.locator(".session-list-item").first().waitFor({ state: "attached" });
    if (options.width < 1024) await page.getByRole("button", { name: options.sessionList, exact: true }).click();
    const listText = await page.locator(".session-list").innerText();
    const releaseList = await hold("**/api/v1/sessions?**");
    try {
      await page.getByRole("button", { name: options.clientFilter, exact: true }).click();
      await page.getByRole("option", { name: "Codex", exact: true }).press("Enter");
      await page.getByRole("button", { name: options.apply, exact: true }).click();
      await page.locator(".session-list[aria-busy='true']").waitFor();
      ensure(await page.locator(".session-list").innerText() === listText, "会话筛选等待期间保留原列表");
      ensure(await page.locator(".session-search-icon svg").isVisible() && await page.locator(".session-search-icon .loading").count() === 0, "会话搜索始终保留放大镜");
      ensure(await page.locator(".session-search-progress .loading--inline").count() === 1, "会话更新使用独立固定进度槽位");
      ensure(await page.locator(".session-sidebar .loading-skeleton").count() === 0, "已有会话更新不重放骨架");
      await screenshot("sessions-filter");
    } finally { await releaseList(); }
    await page.locator(".session-list[aria-busy='false']").waitFor();
    await skeleton({ name: "knowledge-list", hash: "knowledge?review=pending", pattern: "**/api/v1/knowledge/entries?**", selector: ".knowledge-entry-list .loading-skeleton", ready: ".knowledge-entry" });
    const releaseDetail = await hold("**/api/v1/knowledge/entries/*?**");
    try {
      await page.goto(`${options.base}/?loading-preview=knowledge-detail#knowledge?review=pending&id=${options.knowledgeId}`);
      await page.locator(".knowledge-loading .loading--scene").waitFor();
      await visibleScene(".knowledge-loading .loading--scene");
      ensure(await page.getByText(options.noKnowledge, { exact: true }).count() === 0, "知识已选中时不会显示未选择");
      await screenshot("knowledge-detail");
    } finally { await releaseDetail(); }
    await page.locator(".knowledge-reader h1").waitFor();
    const knowledgeText = await page.locator(".knowledge-reader").textContent();
    const releaseKnowledge = await hold("**/api/v1/knowledge/entries/*?**");
    try {
      // 窄屏阅读面板保留完整内容；通过可见的页面更新动作触发同一后台读取。
      if (options.width < 720) await page.locator(".knowledge-reader").getByRole("button", { name: options.knowledgeBack, exact: true }).click();
      await page.getByRole("button", { name: options.knowledgeRefresh, exact: true }).click();
      await page.locator(".knowledge-reader[aria-busy='true']").waitFor({ state: "attached" });
      ensure(await page.locator(".knowledge-reader").textContent() === knowledgeText, "知识刷新保留完整正文");
      ensure(await page.locator(".knowledge-loading").count() === 0, "知识刷新不覆盖已有正文");
    } finally { await releaseKnowledge(); }
    await page.locator(".knowledge-reader[aria-busy='false']").waitFor({ state: "attached" });
    const failDetail = route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic read failure" }) });
    await page.route("**/api/v1/knowledge/entries/*?**", failDetail);
    await page.goto(`${options.base}/?loading-preview=knowledge-error#knowledge?review=pending&id=${options.knowledgeId}`);
    await page.locator(".knowledge-detail-slot [role='alert']").waitFor();
    ensure(await page.getByText(options.noKnowledge, { exact: true }).count() === 0 && await page.locator(".knowledge-loading").count() === 0, "知识读取失败明确呈现错误，不显示未选择或永久等待");
    await page.unroute("**/api/v1/knowledge/entries/*?**", failDetail);
    await page.locator(".knowledge-detail-slot").getByRole("button", { name: options.knowledgeRetry, exact: true }).click();
    await page.locator(".knowledge-reader h1").waitFor();
    ensure(true, "知识读取失败后可重试恢复");
    const releaseMap = await hold("**/api/v1/status?**");
    try {
      await page.goto(`${options.base}/?loading-preview=map#map`);
      await page.locator(".code-map-page .query-loading .loading--scene").waitFor();
      await visibleScene(".code-map-page .query-loading .loading--scene");
      ensure(await page.locator(".code-map-page .empty-state").count() === 0, "地图等待连接时不呈现空结果");
      await screenshot("map-loading");
    } finally { await releaseMap(); }
    await page.locator(".code-map-page .empty-state").waitFor();
    const failMap = route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic connection failure" }) });
    await page.route("**/api/v1/status?**", failMap);
    await page.goto(`${options.base}/?loading-preview=map-error#map`);
    await page.locator(".code-map-page [role='alert']").waitFor();
    ensure(await page.locator(".code-map-page .empty-state, .code-map-page .query-loading").count() === 0, "地图连接失败不误报空仓库或继续等待");
    await page.unroute("**/api/v1/status?**", failMap);
    ensure(errors.length === 0, errors.join("; ") || "页面无运行错误");
    return { language: options.language, width: options.width, checks };
  };
  const reports = [];
  for (const [language, mode, width] of [["zh-CN", "light", 1440], ["en", "dark", 1440], ["zh-CN", "dark", 390], ["en", "light", 390]]) {
    const saved = await fetch(`${fixture.base}/api/v1/preferences`, {
      method: "PUT", headers: { "Content-Type": "application/json", "x-agent-manor-instance": fixture.service.instance.id },
      body: JSON.stringify({ language, appearance: { mode } }),
    });
    if (!saved.ok) throw new Error(`无法设置合成偏好：${saved.status}`);
    const result = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify({
      base: fixture.base, artifacts, language, width,
      overviewRefresh: translate(language, "overview.refresh"), usageRefresh: translate(language, "usage.refresh"),
      sessionList: translate(language, "sessions.list.title"),
      sessionProfile: translate(language, "sessions.reading.stats"), noKnowledge: translate(language, "knowledge.noSelection"), knowledgeId: knowledge.id,
      clientFilter: translate(language, "sessions.filter.client"), knowledgeRefresh: translate(language, "knowledge.refresh"), knowledgeBack: translate(language, "knowledge.back"), knowledgeRetry: translate(language, "knowledge.retry"),
      apply: translate(language, "common.picker.apply"),
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
