import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { clientIds } from "../dist/clients.js";
import { startService } from "../dist/server.js";
import { resourceMapFixture } from "./resource-map-fixture.mjs";
const run = promisify(execFile);
const directory = await realpath(await mkdtemp("/tmp/manor-appearance-e2e-"));
const artifacts = fileURLToPath(new URL("../.local/appearance-e2e/", import.meta.url));
const session = `appearance${process.pid}`;
let service;
const browser = async args => {
  const result = await run("playwright-cli", [`-s=${session}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.stdout.includes("### Error")) throw new Error(result.stdout);
  return result.stdout;
};
try {
  await mkdir(artifacts, { recursive: true });
  const fixture = await resourceMapFixture(directory, 5);
  await mkdir(join(fixture.project, "src"), { recursive: true });
  await run("git", ["init", "-q", fixture.project]);
  for (let file = 0; file < 8; file++) await writeFile(join(fixture.project, "src", `sample-${file}.ts`), Array.from({ length: 350 }, (_, line) => `export const sample${line} = ${line};`).join("\n"));
  await run("git", ["-C", fixture.project, "add", "src"]);
  service = await startService({ home: fixture.home, roots: Object.fromEntries(clientIds.map(id => [id, []])), resourceInventory: { userHome: fixture.userHome }, startupRefresh: false, staticRoot: fileURLToPath(new URL("../dist/web", import.meta.url)) });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const api = async (path, method = "GET", body) => {
    const response = await fetch(`${base}/api/v1${path}`, { method, headers: { "x-agent-manor-instance": service.instance.id, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json(); assert.ok(response.ok, result.error?.message); return result;
  };
  await api("/preferences", "PUT", { language: "en" });
  const registration = await api("/repositories", "POST", { path: fixture.project });
  let complete = false;
  for (let attempt = 0; attempt < 500; attempt++) {
    const { job } = await api(`/jobs/${registration.job.id}`);
    if (job.status === "completed") { complete = true; break; }
    assert.notEqual(job.status, "failed"); await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(complete, "合成仓库分析未完成");
  await browser(["open", base, "--headed", "--browser=chrome"]);
  const verify = async page => {
    page.setDefaultTimeout(20_000);
    const checks = [], errors = [];
    const ensure = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); };
    page.on("pageerror", error => errors.push(error.message));
    const button = name => page.getByRole("button", { name, exact: true });
    const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const read = () => page.evaluate(async () => (await fetch("/api/v1/preferences")).json());
    const shared = async appearance => {
      await page.evaluate(async appearance => { const response = await fetch("/api/v1/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appearance }) }); if (!response.ok) throw new Error("save failed"); window.dispatchEvent(new Event("focus")); }, appearance);
      await page.waitForLoadState("networkidle"); await settled();
    };
    const choose = async name => {
      const saved = page.waitForResponse(response => response.url().endsWith("/api/v1/preferences") && response.request().method() === "PUT");
      await button(name).click(); await saved; await settled();
    };
    const mode = async name => { await page.getByRole("combobox", { name: "Display mode", exact: true }).click(); const saved = page.waitForResponse(response => response.url().endsWith("/api/v1/preferences") && response.request().method() === "PUT"); await page.getByRole("option", { name, exact: true }).click(); await saved; await settled(); };
    await page.setViewportSize({ width: 1440, height: 1000 });
    await button("Appearance").waitFor();
    // 首次服务端没有外观时，浏览器旧主题仅迁移一次。
    await page.evaluate(() => localStorage.setItem("agent-manor-theme", "dark"));
    await page.reload(); await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    ensure((await read()).appearance.mode === "dark", "旧 localStorage 深色迁移到共享偏好");
    ensure(await page.evaluate(() => localStorage.getItem("agent-manor-theme")) === null, "成功迁移移除旧浏览器键");
    await shared({ mode: "light", preset: "blue" });
    await page.evaluate(() => localStorage.setItem("agent-manor-theme", "dark"));
    await page.reload(); await button("Appearance").waitFor();
    ensure(await page.locator("html").getAttribute("data-theme") === "light", "服务端外观优先于旧 localStorage");
    await button("Appearance").focus(); await page.keyboard.press("Enter");
    await page.getByRole("combobox", { name: "Display mode", exact: true }).focus(); await page.keyboard.press("ArrowDown");
    await page.getByRole("option", { name: "Dark", exact: true }).focus();
    const keyboardSave = page.waitForResponse(response => response.url().endsWith("/api/v1/preferences") && response.request().method() === "PUT");
    await page.keyboard.press("Enter"); await keyboardSave; await settled();
    ensure(await page.locator("html").getAttribute("data-theme") === "dark", "键盘可切换显示模式");
    await page.keyboard.press("Escape");
    ensure(await button("Appearance").evaluate(element => element === document.activeElement), "Escape关闭外观弹层并恢复触发器焦点");
    await button("Appearance").click();
    const verifyFavicon = async () => page.evaluate(async () => {
      const link = document.querySelector('link[rel="icon"]');
      const icon = new Image(); icon.src = link.href; await icon.decode();
      const colors = getComputedStyle(document.documentElement);
      const rgb = name => colors.getPropertyValue(name).trim().slice(1).match(/../g).map(channel => parseInt(channel, 16));
      return [16, 32].every(size => {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
        const context = canvas.getContext("2d"); context.drawImage(icon, 0, 0, size, size);
        const background = [...context.getImageData(size / 2, size / 8, 1, 1).data].slice(0, 3);
        const foreground = [...context.getImageData(size / 2, size / 2, 1, 1).data].slice(0, 3);
        return JSON.stringify(background) === JSON.stringify(rgb("--accent")) && JSON.stringify(foreground) === JSON.stringify(rgb("--on-accent"));
      });
    });
    const accents = new Set();
    for (const preset of ["Blue", "Terracotta", "Celadon", "Amber", "Berry", "Graphite"]) {
      await choose(preset); ensure(await button(preset).getAttribute("aria-pressed") === "true", `预设 ${preset} 选中可见`);
      ensure(await verifyFavicon(), `预设 ${preset} 的16/32像素标签图标跟随主题`);
      accents.add(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent")));
    }
    ensure(accents.size === 6, "六种预设具有不同主题色");
    for (const display of ["Light", "Dark"]) {
      await mode(display);
      for (const color of ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00"]) {
        await page.getByLabel("Custom color", { exact: true }).fill(color); await choose("Apply");
        ensure(await verifyFavicon(), `${display} ${color} 标签图标可解码且颜色正确`);
        const ratios = await page.evaluate(() => {
          const style = getComputedStyle(document.documentElement), hex = name => style.getPropertyValue(name).trim();
          const lum = color => { const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; };
          const contrast = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
          return [contrast(hex("--accent"), hex("--accent-soft")), contrast(hex("--accent"), hex("--surface-alt")), contrast(hex("--accent"), hex("--on-accent")), contrast(hex("--accent-hover"), hex("--on-accent")), ...Array.from({ length: 5 }, (_, i) => contrast(hex(`--map-${i}`), hex(`--map-${i}-text`)))];
        });
        ensure(ratios.every(value => value >= 4.5), `${display} ${color} 按钮和地图文字对比度至少4.5`);
      }
    }
    ensure(await page.locator('.appearance-menu input[type="text"], .appearance-menu input:not([type])').count() === 0, "自定义主题无色值文本输入框");
    ensure(await page.getByLabel("Custom color", { exact: true }).getAttribute("type") === "color", "自定义色采用可点选原生色盘");
    await page.getByLabel("Custom color", { exact: true }).fill("#3268d4"); await choose("Apply");
    await mode("Use system"); await page.emulateMedia({ colorScheme: "dark" }); await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.emulateMedia({ colorScheme: "light" }); await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    ensure((await read()).appearance.mode === "auto", "跟随系统响应运行中系统变化且保持auto偏好");
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await page.locator(".appearance-menu").boundingBox(); ensure(bounds.x >= 0 && bounds.x + bounds.width <= 390, "窄屏外观弹层完整位于视口内");
    await page.keyboard.press("Escape"); await page.setViewportSize({ width: 1440, height: 1000 });
    // 独立浏览器 context 没有共享 localStorage，仍通过服务端同步。
    const context = await page.context().browser().newContext();
    const other = await context.newPage(); await other.goto(page.url()); await other.getByRole("button", { name: "Appearance", exact: true }).waitFor();
    await shared({ mode: "dark", preset: "berry" });
    await other.evaluate(() => window.dispatchEvent(new Event("focus"))); await other.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    ensure(await other.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent")) === await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent")), "独立context重新聚焦同步机器主题色");
    await context.close(); await page.bringToFront();
    await button("Appearance").click();
    const savedBefore = (await read()).appearance;
    await page.route("**/api/v1/preferences", route => route.request().method() === "PUT" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"message":"synthetic"}}' }) : route.continue());
    await choose("Blue"); await page.getByRole("alert").filter({ hasText: "Preferences were not saved" }).waitFor();
    ensure(JSON.stringify((await read()).appearance) === JSON.stringify(savedBefore), "保存失败有明确反馈且不覆盖原主题");
    await page.unroute("**/api/v1/preferences"); await page.keyboard.press("Escape");
    await shared({ mode: "light", preset: "blue" });
    await button("Select directory src").click();
    await page.locator(".map-file").first().click(); await page.locator(".file-path").waitFor(); await button("Zoom in").click(); await page.waitForLoadState("networkidle"); await settled();
    const state = async () => ({ file: await page.locator(".file-path").innerText(), scale: await page.locator(".code-map").getAttribute("data-scale"), directory: await page.locator('.directory-select[aria-current="location"]').getAttribute("aria-label") });
    const before = await state(); await shared({ mode: "dark", preset: "terracotta" });
    const after = await state(); ensure(JSON.stringify(after) === JSON.stringify(before), "切换主题保留地图选中文件目录和缩放 " + JSON.stringify({ before, after }));
    await button("View current code and ranges").click(); await page.locator(".cm-content").focus();
    await page.keyboard.press("Meta+f"); await page.locator('.cm-search input[name="search"]').fill("sample");
    await page.locator(".cm-content").focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Shift+ArrowRight");
    await settled();
    const editorBefore = await page.evaluate(() => {
      const editor = document.querySelector(".cm-editor"), scroller = document.querySelector(".cm-scroller");
      window.appearanceEditor = editor; scroller.scrollTop = 700;
      return { selection: window.getSelection().toString(), scroll: scroller.scrollTop };
    });
    ensure(editorBefore.scroll > 0 && editorBefore.selection.length > 0, "编辑器已建立非空选择与滚动位置");
    await shared({ mode: "light", preset: "celadon" });
    const editorAfter = await page.evaluate(() => ({ same: window.appearanceEditor === document.querySelector(".cm-editor"), selection: window.getSelection().toString(), scroll: document.querySelector(".cm-scroller").scrollTop }));
    ensure(editorAfter.same && editorAfter.selection === editorBefore.selection && Math.abs(editorAfter.scroll - editorBefore.scroll) <= 1, "主题切换保留CodeViewer实例选择与滚动位置 " + JSON.stringify({ editorBefore, editorAfter }));
    ensure(await page.locator('.cm-search input[name="search"]').inputValue() === "sample", "主题切换保留CodeViewer搜索");
    ensure(errors.length === 0, "Chrome没有运行异常");
    return { passed: true, checks, errors };
  };
  const output = await browser(["run-code", verify.toString()]);
  await writeFile(join(artifacts, "report.txt"), output); console.log(output.split("### Ran Playwright code")[0]);
  await browser(["run-code", 'async page => { await page.getByRole("button", {name:"Close dialog",exact:true}).click(); await page.getByRole("button",{name:"Appearance",exact:true}).click(); }']);
  await browser(["screenshot", `--filename=${join(artifacts, "appearance.png")}`]);
  await browser(["run-code", 'async page => { await page.getByLabel("Custom color",{exact:true}).click(); }']);
  await browser(["screenshot", `--filename=${join(artifacts, "picker-click.png")}`]);
  await browser(["run-code", 'async page => { await page.keyboard.press("Escape"); }']);
} catch (error) {
  await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]).catch(() => {});
  await writeFile(join(artifacts, "failure.txt"), String(error)); throw error;
} finally {
  await browser(["close"]).catch(() => {}); await service?.close(); await rm(directory, { recursive: true, force: true });
}
