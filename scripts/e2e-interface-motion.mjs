import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { weeklyReviewFixture } from "./weekly-review-fixture.mjs";

// 动效、焦点、减少动态效果及布局验收仅使用隔离合成历史与仓库。
const run = promisify(execFile), fixture = await weeklyReviewFixture(), session = `motion-${process.pid}`;
const artifacts = fileURLToPath(new URL("../.local/interface-motion/", import.meta.url));
let opened = false;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${session}`, ...args], { cwd: fixture.directory,
    env: { ...process.env, TMPDIR: "/tmp" }, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  assert.ok(!stdout.includes("### Error"), stdout); return stdout;
};
try {
  await mkdir(artifacts, { recursive: true });
  const repository = join(fixture.directory, "motion-repository"); await mkdir(join(repository, "src"), { recursive: true });
  await run("git", ["init", "-q", repository]);
  for (let index = 0; index < 32; index++) await writeFile(join(repository, "src", `sample-${index}.ts`), `export const sample${index} = ${index};\n`.repeat(30));
  const registered = await fetch(`${fixture.base}/api/v1/repositories`, { method: "POST", headers: { "Content-Type": "application/json", "x-agent-manor-instance": fixture.service.instance.id }, body: JSON.stringify({ path: repository }) });
  assert.equal(registered.status, 200); const registration = await registered.json();
  for (let attempt = 0; attempt < 500; attempt++) {
    const { job } = await (await fetch(`${fixture.base}/api/v1/jobs/${registration.job.id}`)).json();
    if (job.status === "completed") break;
    assert.notEqual(job.status, "failed"); if (attempt === 499) throw Error("合成分析未完成");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await browser(["open", `${fixture.base}/#overview`, "--headed", "--browser=chrome"]); opened = true;
  const verify = async (page, artifacts) => {
    const checks = [], errors = []; page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(30_000);
    const ensure = (value, description) => { if (!value) throw Error(description); checks.push(description); };
    const button = name => page.getByRole("button", { name, exact: true });
    const aligned = async selector => page.waitForFunction(selector => {
      const group = document.querySelector(selector), indicator = group?.querySelector(".selection-indicator"), selected = group?.querySelector('[aria-current="page"], [aria-selected="true"]');
      if (!indicator || !selected || indicator.hidden) return false;
      const a = indicator.getBoundingClientRect(), b = selected.getBoundingClientRect();
      return Math.abs(a.left - b.left) < 1 && Math.abs(a.width - b.width) < 1 && !indicator.getAnimations().some(animation => animation.playState === "running");
    }, selector);
    await page.evaluate(() => {
      window.motionDurations = [];
      const original = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) {
        if (this.classList.contains("selection-indicator")) window.motionDurations.push(typeof options === "number" ? options : options?.duration);
        return original.call(this, frames, options);
      };
    });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('.overview-results[aria-busy="false"]').waitFor();
    await page.locator('.weekly-review[aria-busy="false"] .weekly-review-groups').waitFor();
    ensure(await page.locator("html").evaluate(el => parseFloat(getComputedStyle(el).getPropertyValue("--motion-state"))) > 0, "动效复用共享时长");
    await aligned(".product-nav");
    for (const name of ["会话库", "代码地图", "用量统计", "资源管理", "总览"]) await button(name).click();
    await aligned(".product-nav"); ensure(await page.locator('.product-nav [aria-current="page"]').innerText() === "总览", "连续导航最终选择与底板对齐");
    ensure(await page.evaluate(() => window.motionDurations.includes(170)), "生产压缩后的时间单位仍产生170ms动态过渡");
    await page.getByRole("combobox", { name: "日期范围", exact: true }).click();
    ensure(await page.getByRole("listbox").evaluate(el => getComputedStyle(el).animationName) === "motion-menu-in", "共享筛选菜单使用短入场");
    await page.keyboard.press("Escape"); await page.getByRole("listbox").waitFor({ state: "hidden" });
    ensure(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")) === "日期范围", "菜单退出后焦点恢复");
    await page.locator(".weekly-review-metric").filter({ has: page.getByText("平均模型步骤", { exact: true }) }).click();
    await page.locator('.weekly-review-dialog .overview-investigation-body[aria-busy="false"]').waitFor();
    ensure(await page.locator(".weekly-review-dialog").evaluate(el => getComputedStyle(el).animationName) === "motion-panel-in", "统计详情复用面板动效且保留居中变换");
    ensure(await page.locator(".weekly-review-dialog").evaluate(el => el.getBoundingClientRect().left >= 0 && el.getBoundingClientRect().right <= innerWidth), "详情在桌面视口内");
    await page.keyboard.press("Escape"); await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator(".weekly-review-dialog").waitFor({ state: "hidden" });
    ensure(await page.locator('[data-radix-popper-content-wrapper]:has([data-state="closed"])').count() === 0, "退出途中开启减少动态效果后弹层完整卸载");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await button("代码地图").click(); await page.locator(".map-file").first().waitFor(); await aligned(".code-map-tabs");
    const file = page.locator(".map-file").first(); await file.click();
    const fitScale = Number(await page.locator(".code-map").getAttribute("data-scale"));
    await button("缩小地图").evaluate(button => button.addEventListener("click", () => {
      const map = document.querySelector(".code-map"), matrix = new DOMMatrix(getComputedStyle(map.querySelector(".map-scene")).transform);
      window.focusScaleAtInput = Number(map.dataset.scale) * matrix.a;
    }, { once: true, capture: true }));
    await button("定位所选文件").click(); await page.waitForFunction(() => Number(document.querySelector('.code-map')?.dataset.scale) > 1);
    await button("缩小地图").click();
    await page.waitForFunction(minimum => Math.abs(Number(document.querySelector(".code-map").dataset.scale) - Math.max(minimum, window.focusScaleAtInput / 1.4)) < .001, fitScale);
    ensure(await page.locator(".map-scene").evaluate(el => !el.getAnimations().some(a => a.playState === "running")), "手动缩放从视觉相机接续并中断旧聚焦");
    ensure(await page.locator(".map-focus-context").count() === 0, "中断定位后释放旧视口快照");
    await button("适应窗口").click();
    const before = await page.locator(".code-map").evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }));
    await page.getByRole("tab", { name: "活动回放", exact: true }).click(); await aligned(".code-map-tabs");
    await page.getByRole("tab", { name: "活动分布", exact: true }).click(); await aligned(".code-map-tabs");
    const after = await page.locator(".code-map").evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }));
    ensure(before.width === after.width && before.height === after.height, "切换地图页签保留分布布局尺寸");
    await page.screenshot({ path: `${artifacts}/motion-desktop-zh.png`, fullPage: true });
    await button("会话库").click(); await page.locator(".session-message").first().waitFor(); await page.waitForLoadState("networkidle");
    await button("下一轮").click();
    await page.waitForFunction(() => document.querySelector('.session-turn-position')?.getAttribute('data-turn') === "2");
    await page.waitForFunction(() => {
      const pane = document.querySelector('.session-message-scroll'), turn = pane?.querySelectorAll('.session-turn')[1];
      return turn && Math.abs(turn.getBoundingClientRect().top - pane.getBoundingClientRect().top - 10) < 2;
    });
    ensure(true, "近距离轮次跳转完成后准确停在目标");
    await button("下一轮").click(); await page.locator(".session-message-scroll").hover(); await page.mouse.wheel(0, 80);
    const settledScroll = await page.evaluate(() => new Promise(resolve => {
      const values = []; let count = 0;
      const sample = () => { values.push(document.querySelector('.session-message-scroll').scrollTop); if (++count < 30) requestAnimationFrame(sample); else resolve(values.slice(-6)); };
      requestAnimationFrame(sample);
    }));
    ensure(Math.max(...settledScroll) - Math.min(...settledScroll) < 2, "手动滚动打断定位后没有旧动画继续推动");
    const savedScroll = await page.locator(".session-message-scroll").evaluate(el => el.scrollTop);
    await button("资源管理").click(); await button("会话库").click();
    await page.waitForFunction(saved => Math.abs(document.querySelector('.session-message-scroll').scrollTop - saved) < 2, savedScroll);
    ensure(true, "跨页面返回保留阅读位置");
    await button("上一轮").click(); await button("执行轨迹").click(); await page.locator(".trace-ledger").waitFor();
    ensure(await page.locator(".session-message-scroll").evaluate(el => el.getAnimations({ subtree: true }).length === 0), "切换阅读模式取消原定位落点动画");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await button("总览").click(); await aligned(".product-nav");
    ensure(await page.locator("html").evaluate(el => parseFloat(getComputedStyle(el).getPropertyValue("--motion-state"))) === 0, "减少动态效果覆盖共享时长");
    await page.getByRole("combobox", { name: "日期范围", exact: true }).click();
    ensure(await page.getByRole("listbox").evaluate(el => getComputedStyle(el).animationName) === "none", "减少动态效果下菜单直接显示");
    await page.keyboard.press("Escape"); await page.getByRole("listbox").waitFor({ state: "hidden" });
    await button("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click(); await aligned(".product-nav");
    ensure(await page.locator('.product-nav [aria-current="page"]').innerText() === "Overview", "英文导航字宽变化后重新对齐");
    await page.emulateMedia({ reducedMotion: "no-preference" }); await page.setViewportSize({ width: 390, height: 844 }); await aligned(".product-nav");
    await button("Appearance").click(); await page.getByRole("combobox", { name: "Display mode", exact: true }).click(); await page.getByRole("option", { name: "Dark", exact: true }).click(); await page.keyboard.press("Escape");
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "英文深色窄屏无全局溢出");
    await button("Sessions").click(); await page.locator(".session-compact-actions button").first().click();
    await page.locator(".session-list-item").first().waitFor(); await aligned(".product-nav");
    ensure(await page.locator(".session-sidebar").evaluate(el => getComputedStyle(el).animationName) === "motion-drawer-left", "窄屏会话清单沿左侧展开");
    await page.screenshot({ path: `${artifacts}/motion-mobile-en-dark.png`, fullPage: true });
    await page.emulateMedia({ reducedMotion: "reduce" }); await page.setViewportSize({ width: 1440, height: 1000 });
    for (const name of ["Code map", "Resources", "Usage", "Overview"]) await button(name).click();
    await aligned(".product-nav"); ensure(await page.locator(".selection-indicator").first().evaluate(el => el.getAnimations().length === 0), "减少动态效果下连续导航没有残留动画");
    ensure(errors.length === 0, "浏览器没有运行错误"); return { passed: true, checks, errors };
  };
  const output = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify(artifacts)})`]);
  await writeFile(join(artifacts, "motion-e2e-result.txt"), output); console.log(output.split("### Ran Playwright code")[0]);
  assert.match(output, /"passed"\s*:\s*true/);
} finally { if (opened) await browser(["close"]).catch(() => undefined); await fixture.close(); }
