import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";
import { VERSION } from "../dist/version.js";
import { ReleaseService } from "../dist/service/releases.js";

// 真实后台和 Chrome 交互，只有公共 registry 的响应使用合成数据。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-release-browser-")));
const artifacts = fileURLToPath(new URL("../.local/software-updates/browser/", import.meta.url));
const session = `updates-${process.pid}`;
const root = join(directory, "node_modules", "agent-manor");
const home = join(directory, "demo data's 庄园");
const state = { version: "0.2.0", failure: false, engines: ">=24", delay: 0, now: Date.now(), calls: 0 };
let service;
let browserOpened = false;
const control = createServer(async (request, response) => {
  if (request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    Object.assign(state, JSON.parse(body));
  }
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(state));
});
async function browser(args) {
  const result = await run("playwright-cli", [`-s=${session}`, ...args], { cwd: directory,
    env: { ...process.env, TMPDIR: tmpdir(), PLAYWRIGHT_DAEMON_SESSION_DIR: join(directory, "browser") },
    timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.stdout.includes("### Error")) throw new Error(result.stdout);
  return result.stdout;
}
try {
  await mkdir(artifacts, { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "agent-manor", version: VERSION }));
  await new Promise(resolve => control.listen(0, "127.0.0.1", resolve));
  const controlUrl = `http://127.0.0.1:${control.address().port}`;
  await new ReleaseService({ root, configBase: join(directory, "config"), installationKind: "local" }).settings({ autoCheck: false });
  service = await startService({ home, port: 0, startupRefresh: false,
    roots: Object.fromEntries(clientIds.map(client => [client, []])), resourceInventory: { userHome: directory },
    staticRoot: fileURLToPath(new URL("../dist/web", import.meta.url)),
    releaseChecks: { root, configBase: join(directory, "config"), installationKind: "local", now: () => state.now,
      fetch: async () => {
        state.calls++;
        if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
        if (state.failure) throw new TypeError("Synthetic registry connection failure");
        return new Response(JSON.stringify({ name: "agent-manor", version: state.version, engines: { node: state.engines } }));
      } },
  });
  const base = `http://127.0.0.1:${service.instance.port}`;
  await fetch(`${base}/api/v1/preferences`, { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: "zh-CN", appearance: { mode: "light" } }) });
  await browser(["open", `${base}/#sessions`, "--headed", "--browser=chrome"]);
  browserOpened = true;
  const verify = async (page, fixture) => {
    const steps = [];
    const screenshots = [];
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(15_000);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.base });
    const button = name => page.getByRole("button", { name, exact: true });
    const screenshot = async name => { await page.screenshot({ path: `${fixture.artifacts}/${name}.png` }); screenshots.push(`${name}.png`); };
    const setRelease = data => page.request.post(fixture.controlUrl, { data });
    const calls = async () => (await (await page.request.get(fixture.controlUrl)).json()).calls;
    const waitSaved = async action => { await Promise.all([page.waitForResponse(response => response.url().endsWith("/update/settings") && response.request().method() === "PATCH"), action()]); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); };
    const check = async (label = "检查更新") => {
      const saved = page.waitForResponse(response => response.url().endsWith("/update/check"));
      await button(label).click(); await saved;
    };
    await page.setViewportSize({ width: 1440, height: 960 });
    await button("版本与更新").waitFor();
    await button("版本与更新").click();
    await page.getByRole("dialog", { name: "版本与更新", exact: true }).waitFor();
    await page.locator(".software-updates-summary").filter({ hasText: "检查是否有新版本" }).waitFor();
    if (await calls() !== 0) throw new Error("读取状态错误触发联网");
    await screenshot("01-unknown-zh-light"); steps.push("初始状态与纯缓存读取");
    await check();
    await page.locator(".software-updates-summary").filter({ hasText: "有新版本可用" }).waitFor();
    await waitSaved(() => page.getByRole("checkbox", { name: "自动检查更新", exact: true }).click());
    await button("复制命令").click();
    await button("命令已复制").waitFor();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const command = await page.getByLabel("终端命令", { exact: true }).innerText();
    if (copied !== command || !copied.includes("--home") || !copied.includes("update")) throw new Error("复制命令未保留数据目录");
    await screenshot("02-update-available-zh-light"); steps.push("手动检查与安全复制命令");
    await waitSaved(() => button("忽略此版本").click());
    await button("恢复提醒").waitFor();
    if (await page.locator(".software-updates-badge").count()) throw new Error("忽略后仍有提醒标记");
    await screenshot("03-ignored-version");
    await check();
    await button("恢复提醒").waitFor();
    if (await page.locator(".software-updates-badge").count()) throw new Error("手动检查错误清除忽略设置");
    await setRelease({ version: "0.3.0" }); await check();
    await page.locator(".software-updates-badge").waitFor(); steps.push("忽略仅影响自动提醒，更高版本重新提醒");
    await waitSaved(() => page.getByRole("checkbox", { name: "自动检查更新", exact: true }).click());
    if (await page.locator(".software-updates-badge").count()) throw new Error("关闭自动行为后仍提示");
    await check();
    await waitSaved(() => page.getByRole("checkbox", { name: "自动检查更新", exact: true }).click());
    steps.push("关闭自动检查后手动检查仍可使用");
    await setRelease({ failure: true }); await check();
    await page.getByRole("alert").waitFor();
    if (!(await page.locator(".software-updates-versions").innerText()).includes("0.3.0")) throw new Error("失败清除了旧结果");
    await screenshot("04-check-failure-keeps-result"); steps.push("检查失败可见且保留上一份结果");
    await setRelease({ failure: false, version: fixture.version }); await check();
    await page.locator(".software-updates-summary").filter({ hasText: "当前已是最新版本" }).waitFor();
    await screenshot("05-up-to-date");
    await setRelease({ version: "0.4.0", engines: ">=999" }); await check();
    await page.locator(".software-updates-boundary").first().waitFor();
    await screenshot("06-runtime-incompatible"); steps.push("相同版本与运行环境不兼容");
    await setRelease({ engines: ">=24", now: fixture.now + 48 * 3600_000 });
    await page.keyboard.press("Escape");
    if (!await button("版本与更新").evaluate(element => element === document.activeElement)) throw new Error("关闭对话框未恢复焦点");
    await button("版本与更新").click();
    await page.locator(".software-updates-summary").filter({ hasText: "上次检查结果" }).waitFor();
    await screenshot("07-stale-result"); steps.push("过期结果与焦点恢复");
    await setRelease({ version: "0.5.0", delay: 700 });
    const response = page.waitForResponse(value => value.url().endsWith("/update/check"));
    await button("检查更新").click();
    await page.getByRole("status", { name: "正在检查更新", exact: true }).waitFor().catch(() => {});
    await screenshot("08-checking-keeps-layout"); await response;
    await page.keyboard.press("Escape");
    const address = page.url();
    await button("显示语言").click();
    await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
    await button("Version and updates").waitFor();
    if (page.url() !== address) throw new Error("语言切换改变了当前页面位置");
    await button("Version and updates").click();
    await screenshot("09-update-available-en-light");
    await page.keyboard.press("Escape");
    await button("Appearance").click();
    await page.getByRole("combobox", { name: "Display mode", exact: true }).click();
    await page.getByRole("option", { name: "Dark", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.setViewportSize({ width: 390, height: 844 });
    await button("Version and updates").click();
    await page.getByRole("dialog", { name: "Version and updates", exact: true }).waitFor();
    if (!await page.getByRole("checkbox", { name: "Automatically check for updates", exact: true }).isChecked()) throw new Error("切换语言和主题后设置丢失");
    const bounds = await page.getByRole("dialog").boundingBox();
    if (!bounds || bounds.x < 0 || bounds.x + bounds.width > 391) throw new Error("窄屏弹层横向溢出");
    await screenshot("10-update-available-en-dark-mobile");
    steps.push("中英文、深浅主题、390px窄屏与页面状态保留");
    if (errors.length) throw new Error(`Chrome运行时异常：${JSON.stringify(errors)}`);
    return { steps, screenshots, errors, registryCalls: await calls() };
  };
  const fixture = { base, controlUrl, artifacts, version: VERSION, now: state.now };
  const report = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify(fixture)})`]);
  await writeFile(join(artifacts, "report.txt"), report);
  console.log(report.split("### Ran Playwright code")[0]);
  assert.equal(state.calls > 0, true);
  await writeFile(join(artifacts, "fixture-summary.json"), JSON.stringify({ currentVersion: VERSION, registryCalls: state.calls, synthetic: true }, null, 2));
} catch (error) {
  if (browserOpened) {
    await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]).catch(() => {});
    await writeFile(join(artifacts, "failure-state.txt"), await browser(["run-code", "async page => ({url:page.url(),text:await page.locator('body').innerText()})"]).catch(() => "Snapshot unavailable"));
  }
  throw error;
} finally {
  if (browserOpened) await browser(["close"]).catch(() => {});
  await service?.close();
  await new Promise(resolve => control.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
