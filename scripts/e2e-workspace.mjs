import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { writePreferences } from "../dist/service/preferences.js";
import { clientIds } from "../dist/clients.js";

// 使用真实后台和合成仓库验收交互；需要本机 playwright-cli 与 Chrome。
const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-workspace-e2e-")));
const session = `mw${process.pid}`;
const artifacts = fileURLToPath(new URL("../.local/workspace-e2e/", import.meta.url));
const env = { ...process.env, ...Object.fromEntries(clientIds.map(client => [`AGENT_MANOR_${client.replaceAll("-", "_").toUpperCase()}_DIR`, join(directory, `missing-${client}`)])), AGENT_MANOR_HOME: join(directory, "data"), AGENT_MANOR_PORT: "0",
  AGENT_MANOR_CODEX_DIR: join(directory, "codex"), AGENT_MANOR_CLAUDE_DIR: join(directory, "claude"), AGENT_MANOR_CODEFLICKER_DESKTOP_DIR: join(directory, "missing-desktop"), AGENT_MANOR_CODEFLICKER_DIR: join(directory, "codeflicker") };
const command = async args => JSON.parse((await run(process.execPath, [cli, ...args, "--json"], { cwd: directory, env, timeout: 30_000 })).stdout);
const browser = async args => {
  // macOS Unix socket 有路径长度限制，浏览器控制套接字使用短临时目录。
  const result = await run("playwright-cli", [`-s=${session}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.stdout.includes("### Error")) throw new Error(result.stdout);
  return result.stdout;
};
try {
  await mkdir(artifacts, { recursive: true });
  for (const path of [env.AGENT_MANOR_CODEX_DIR, env.AGENT_MANOR_CLAUDE_DIR, env.AGENT_MANOR_CODEFLICKER_DIR]) await mkdir(path, { recursive: true });
  for (const name of ["workspace-demo", "second-demo"]) {
    const repository = join(directory, name);
    await mkdir(repository);
    await run("git", ["init", "-q", repository]);
    for (const path of ["src/entry.ts", "src/deep/lib/a.ts", "src/deep/other.ts", "src/space dir/child/b.ts", "tests/deep/check.ts", "standalone.ts"]) {
      await mkdir(join(repository, path, ".."), { recursive: true });
      await writeFile(join(repository, path), `export const value = ${JSON.stringify(path)};\n`.repeat(12));
    }
    assert.equal((await command(["register", repository, "--wait"])).job.status, "completed");
  }
  const status = await command(["status"]);
  await writePreferences(env.AGENT_MANOR_HOME, "zh-CN");
  await browser(["open", `http://127.0.0.1:${status.instance.port}/#map`, "--headed", "--browser=chrome"]);
  const code = async page => {
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const ensure = (condition, message) => { if (!condition) throw new Error(message); };
    const button = name => page.getByRole("button", { name, exact: true });

    const toggleTheme = async () => {
      const english = await page.locator("html").getAttribute("lang") === "en";
      const dark = await page.locator("html").getAttribute("data-theme") !== "dark";
      await button(english ? "Appearance" : "外观").click();
      await page.getByRole("combobox", { name: english ? "Display mode" : "显示模式", exact: true }).click();
      const saved = page.waitForResponse(response => response.url().endsWith("/api/v1/preferences") && response.request().method() === "PUT");
      await page.getByRole("option", { name: english ? dark ? "Dark" : "Light" : dark ? "深色" : "明亮", exact: true }).click();
      await saved;
      await page.waitForFunction(dark => document.documentElement.dataset.theme === (dark ? "dark" : "light"), dark);
      await page.keyboard.press("Escape");
      await page.locator(".appearance-menu").waitFor({ state: "hidden" });
    };
    const map = page.getByRole("group", { name: "文件行数决定面积的代码活动地图" });
    const selectedDirectory = async () => page.locator(".directory-select[aria-current=location]").getAttribute("aria-label");
    const width = async () => (await map.boundingBox()).width;
    const fits = async () => page.waitForFunction(() => {
      const bounds = document.querySelector(".code-map").getBoundingClientRect();
      return [...document.querySelectorAll(".map-file")].every(tile => tile.getBoundingClientRect().right <= bounds.right);
    });
    const settled = async label => {
      try { await map.waitFor({ state: "visible" }); await page.locator(".map-file").first().waitFor({ state: "visible" }); }
      catch (error) { throw new Error(`${label}：${error.message}\n${await page.locator("body").innerText()}`); }
    };
    const navigate = async (action, directory, count, label) => {
      const response = page.waitForResponse(response => {
        const url = response.url();
        return url.includes("/coverage?") && decodeURIComponent(url.match(/[?&]directory=([^&]*)/)?.[1] ?? "") === directory && response.ok();
      });
      await action(); await response.catch(error => { throw new Error(`${label}：${error.message}`); });
      await settled(label);
      await page.waitForFunction(({ directory, count }) => {
        const selected = document.querySelector('.directory-select[aria-current="location"]');
        return (selected?.getAttribute("aria-label") ?? "") === (directory ? `选择目录 ${directory}` : "")
          && document.querySelectorAll(".map-file").length === count && !document.querySelector(".map-main .query-loading");
      }, { directory, count });
    };
    await page.setViewportSize({ width: 1440, height: 1000 });
    await settled("初始地图");
    if (!(await page.locator(".repository-trigger").innerText()).includes("workspace-demo")) {
      await page.locator(".repository-trigger").click();
      await navigate(() => page.getByRole("menuitem", { name: /workspace-demo/ }).click(), "", 6, "选择验收仓库");
    }
    ensure(await button("选择目录 src").isVisible(), "顶层目录缺失");
    ensure(await button("选择目录 src/deep").count() === 0, "深层目录应默认折叠");
    await button("展开目录 src").click();
    ensure(await button("选择目录 src/deep").isVisible(), "展开后子目录不可见");
    const controls = await button("展开目录 src/space dir").getAttribute("aria-controls");
    ensure(!controls.includes(" ") && await page.locator(`[id="${controls}"]`).count() === 1, "含空格目录的可访问性关联无效");
    ensure(await selectedDirectory() === null, "展开箭头不应改变统计目录");
    await button("展开目录 src/deep").click();
    await navigate(() => button("选择目录 src/deep/lib").click(), "src/deep/lib", 1, "选择深层目录");
    ensure(await selectedDirectory() === "选择目录 src/deep/lib", "目录筛选未更新");
    ensure(await page.locator(".map-file").count() === 1, "目录地图包含范围外文件");
    await button("折叠目录 src").click();
    ensure(await button("选择目录 src/deep").count() === 0, "折叠后仍有子目录");
    ensure(await page.locator(".breadcrumbs").innerText().then(text => text.includes("lib")), "折叠不应改变筛选");
    await button("展开目录 src").click();
    ensure(await button("选择目录 src/deep/lib").isVisible(), "父目录展开后未保留子目录展开状态");
    await page.locator(".map-file").click();
    await page.locator(".file-path").waitFor({ state: "visible" });
    const originalFile = await page.locator(".file-path").innerText();
    const originalWidth = await width();
    await button("收起仓库导航").click();
    const leftWidth = await width();
    ensure(leftWidth > originalWidth + 140, "左侧收起没有释放地图宽度");
    ensure(await page.getByRole("navigation", { name: "仓库目录" }).isHidden(), "收起后目录仍可访问");
    await button("收起文件详情").click();
    const bothWidth = await width();
    await fits();
    ensure(bothWidth > leftWidth + 250, "右侧收起没有释放地图宽度");
    ensure(await page.locator(".file-path").isHidden(), "收起后详情仍可访问");
    await button("展开仓库导航").click();
    ensure(await width() < bothWidth - 140, "恢复左侧未恢复布局");
    ensure(await selectedDirectory() === "选择目录 src/deep/lib", "收起导航丢失目录选择");
    await button("展开文件详情").click();
    ensure(await page.locator(".file-path").innerText() === originalFile, "收起详情丢失文件选择");
    await button("收起文件详情").click();
    await page.locator(".map-file").click();
    ensure(await button("收起文件详情").isVisible(), "地图选择文件未自动展开详情");
    await navigate(() => page.getByRole("button", { name: /^整个仓库/ }).click(), "", 6, "回到仓库根目录");
    await button("折叠目录 src").click();
    await navigate(() => button("进入目录 src").click(), "src", 4, "下钻 src");
    await navigate(() => button("进入目录 src/deep").click(), "src/deep", 2, "下钻 src/deep");
    await button("选择目录 src/deep").waitFor({ state: "visible" });
    await button("折叠目录 src").focus();
    await page.keyboard.press("Enter");
    ensure(await button("展开目录 src").getAttribute("aria-expanded") === "false", "键盘无法折叠");
    await page.keyboard.press("Space");
    ensure(await button("折叠目录 src").getAttribute("aria-expanded") === "true", "键盘无法展开");
    await button("收起仓库导航").focus();
    await page.keyboard.press("Enter");
    ensure(await button("展开仓库导航").evaluate(element => element === document.activeElement), "面板切换丢失键盘焦点");
    await page.keyboard.press("Enter");
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 900, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (viewport.width === 1920) {
        const width = await page.getByRole("region", { name: "代码地图视图", exact: true }).locator(".workspace").evaluate(element => element.getBoundingClientRect().width);
        const available = await page.evaluate(() => document.documentElement.clientWidth);
        ensure(Math.abs(width - available) < 1, `大屏地图仍被最大宽度限制：${width} / ${available}`);
      }
      await toggleTheme();
      const collapseNavigation = page.getByRole("button", { name: /^收起仓库导航/ });
      if (!await collapseNavigation.isVisible()) await page.getByRole("button", { name: /^展开仓库导航/ }).click();
      await collapseNavigation.click();
      await button("收起文件详情").click();
      await page.getByRole("button", { name: /^展开仓库导航/ }).click();
      await button("展开文件详情").click();
      await fits();
      ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "窄屏页面横向溢出");
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator(".repository-trigger").click();
    await navigate(() => page.getByRole("menuitem", { name: /second-demo/ }).click(), "", 6, "切换第二个仓库");
    ensure(await button("选择目录 src/deep").count() === 0, "切换仓库未重置目录展开状态");
    ensure(errors.length === 0, `浏览器运行异常：${errors.join("; ")}`);
    if (await page.locator("html").getAttribute("data-theme") === "dark") await toggleTheme();
    await page.locator(".app-header").scrollIntoViewIfNeeded();
    return { status: "passed", originalWidth, leftWidth, bothWidth, errors };
  };
  console.log((await browser(["run-code", code.toString()])).split("### Ran Playwright code")[0].trim());
  await browser(["screenshot", `--filename=${join(artifacts, "expanded.png")}`]);
  await browser(["run-code", "async page => { await page.getByRole('button', { name: '收起仓库导航', exact: true }).click(); await page.getByRole('button', { name: '收起文件详情', exact: true }).click(); await page.locator('.app-header').scrollIntoViewIfNeeded(); }"]);
  await browser(["screenshot", `--filename=${join(artifacts, "collapsed.png")}`]);
  console.log("PASS 目录层级、筛选、面板组合、选择保留、键盘、主题与响应式真实浏览器验收");
} finally {
  await browser(["close"]).catch(() => {});
  await command(["stop"]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
