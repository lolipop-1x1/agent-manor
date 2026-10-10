import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";
import { updatePreferences } from "../dist/service/preferences.js";

// 独立合成历史、数据目录与 Chrome 会话；错误注入只影响验收页面。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-repository-lifecycle-")));
const artifacts = fileURLToPath(new URL("../.local/repository-lifecycle-e2e/", import.meta.url));
const browserName = `repository-lifecycle-${process.pid}`;
const roots = Object.fromEntries(clientIds.map(client => [client, []]));
roots.codex = join(directory, "codex"); roots.claude = join(directory, "claude");
const alpha = join(directory, "alpha-repository");
const beta = join(directory, "beta-repository");
const globalProject = join(directory, "global-client-project");
const checks = [];
let service;
let opened = false;
let fixture;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${browserName}`, ...args], {
    cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
function ui(page, english = false) {
  const ensure = (value, message) => { if (!value) throw new Error(message); };
  const names = english ? { choose: "Choose repository", register: "Register repository", empty: "Register local repository", title: "Register a local Git repository", project: "Choose a session project", search: "Search Choose a session project", path: "Repository absolute path", submit: "Register and analyze", cancel: "Cancel", deleteCurrent: "Delete current repository", delete: "Delete repository" }
    : { choose: "选择仓库", register: "登记仓库", empty: "登记本机仓库", title: "登记本机 Git 仓库", project: "选择会话项目", search: "选择会话项目搜索", path: "仓库绝对路径", submit: "登记并分析", cancel: "取消", deleteCurrent: "删除当前仓库", delete: "删除仓库" };
  const button = name => page.getByRole("button", { name, exact: true });
  const dialog = () => page.getByRole("dialog", { name: names.title, exact: true });
  const deletion = () => page.getByRole("dialog", { name: names.delete, exact: true });
  const navigation = async () => {
    if (!await button(names.choose).isVisible()) {
      const expand = page.getByRole("button", { name: english ? /^Expand repository navigation/ : /^展开仓库导航/ });
      if (await expand.isVisible()) await expand.click();
    }
  };
  const register = async () => {
    if (await button(names.empty).isVisible()) await button(names.empty).click();
    else { await navigation(); await button(names.choose).click(); await page.getByRole("menuitem", { name: names.register, exact: true }).click(); }
    await dialog().waitFor();
  };
  const remove = async () => {
    await navigation(); await button(names.choose).click(); await page.getByRole("menuitem", { name: names.deleteCurrent, exact: true }).click(); await deletion().waitFor();
  };
  const choose = async path => {
    await navigation(); await button(names.choose).click(); await page.getByRole("menuitem").filter({ hasText: path }).click();
  };
  const map = async name => {
    await button(names.choose).filter({ hasText: name }).waitFor(); await page.locator(".code-map").waitFor();
  };
  return { ensure, names, button, dialog, deletion, register, remove, choose, map };
}
const step = async (name, action, english = false) => {
  const code = `async page => { page.setDefaultTimeout(12000); const f=${JSON.stringify(fixture)}; const ui=(${ui.toString()}); const u=ui(page,${english}); await (${action.toString()})(page,f,u); return {passed:${JSON.stringify(name)}}; }`;
  await writeFile(join(artifacts, "current-check.mjs"), `export default ${code};`);
  const result = await browser(["run-code", code]);
  await writeFile(join(artifacts, `check-${checks.length + 1}.txt`), result);
  checks.push(name); console.log(`PASS ${name}`);
};
const history = (id, cwd) => [
  { type: "session_meta", timestamp: "2026-10-10T00:00:00Z", payload: { id, cwd, title: `合成项目 ${id}` } },
  { type: "response_item", timestamp: "2026-10-10T00:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "检查人工合成项目" }] } },
  { type: "response_item", timestamp: "2026-10-10T00:00:02Z", payload: { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "合成检查完成" }] } },
];
try {
  await mkdir(artifacts, { recursive: true });
  await mkdir(roots.codex); await mkdir(roots.claude);
  for (const path of [alpha, beta]) {
    await mkdir(join(path, "src"), { recursive: true }); await run("git", ["init", "-q", path]);
    await writeFile(join(path, "src", path === alpha ? "alpha.ts" : "beta.ts"), "export const synthetic = 1;\n");
  }
  const projects = [alpha, beta, join(alpha, "src"), ...Array.from({ length: 45 }, (_, index) => join(directory, `synthetic-project-${String(index).padStart(2, "0")}`)), join(directory, "first/shared"), join(directory, "second/shared")];
  for (const [index, path] of projects.entries()) await writeFile(join(roots.codex, `project-${index}.jsonl`), history(`project-${index}`, path).map(row => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(join(roots.codex, "no-project.jsonl"), history("no-project").map(row => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(join(roots.claude, "global.jsonl"), [
    { type: "user", uuid: "global-user", timestamp: "2026-10-10T00:00:00Z", sessionId: "global-example", cwd: globalProject, message: { content: [{ type: "text", text: "合成全局客户端项目" }] } },
    { type: "assistant", uuid: "global-answer", timestamp: "2026-10-10T00:00:01Z", sessionId: "global-example", cwd: globalProject, message: { content: [{ type: "text", text: "合成完成" }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const home = join(directory, "data");
  await updatePreferences(home, { language: "zh-CN", appearance: { mode: "light" } });
  service = await startService({ home, roots, resourceInventory: { userHome: join(directory, "isolated-user"), environment: {} } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const api = async (path, method = "GET", body) => {
    const response = await fetch(`${base}/api/v1${path}`, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, path); return response.json();
  };
  const initial = await api("/repositories", "POST", { path: alpha });
  for (let attempt = 0; attempt < 400; attempt++) {
    const [{ job }, sessions] = await Promise.all([api(`/jobs/${initial.job.id}`), api("/sessions/status?summary=true")]);
    assert.notEqual(job.status, "failed"); assert.notEqual(sessions.job?.status, "failed");
    if (job.status === "completed" && sessions.version) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const indexed = await api("/sessions/status?summary=true");
  assert.ok(indexed.projects.includes(globalProject));
  fixture = { alpha, beta, globalProject, alphaId: initial.repository.id, base, artifacts, count: indexed.projects.length };
  await browser(["open", base, "--headed", "--browser=chrome"]); opened = true;
  await step("全局项目、已登记标记、名称与路径搜索、同名项目、长列表和键盘", async (page, f, u) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.addInitScript(() => { globalThis.__lifecycleErrors = []; });
    await page.evaluate(() => { globalThis.__lifecycleErrors = []; });
    page.on("pageerror", error => page.evaluate(value => globalThis.__lifecycleErrors.push(value), String(error)).catch(() => {}));
    await u.map("alpha-repository"); await u.register(); await u.button(u.names.project).click();
    const search = page.getByRole("combobox", { name: u.names.search, exact: true });
    u.ensure(await page.getByRole("option").count() === f.count, "候选没有来自完整全局索引");
    u.ensure(!(await page.getByRole("option").allTextContents()).some(text => text === "无项目"), "无项目成为候选");
    await search.fill("alpha-repository"); u.ensure((await page.getByRole("option").allTextContents()).some(text => text.includes("已登记")), "缺少已登记标记");
    await search.fill(f.globalProject); await page.getByRole("option").filter({ hasText: f.globalProject }).waitFor();
    await search.fill("shared"); await page.getByRole("option").filter({ hasText: "/first/shared" }).waitFor();
    u.ensure(await page.getByRole("option").filter({ hasText: /\/(first|second)\/shared/ }).count() === 2, "同名项目缺少完整路径");
    await search.fill(f.alpha.replace("alpha-repository", "first/shared")); await page.getByRole("option").filter({ hasText: "/first/shared" }).click();
    u.ensure((await u.dialog().getByRole("textbox", { name: u.names.path, exact: true }).inputValue()).endsWith("/first/shared"), "完整路径未区分同名项目");
    await u.button(u.names.project).click();
    await search.fill("synthetic-project-44"); await page.waitForFunction(count => document.querySelectorAll('[role="option"]').length < count, f.count);
    await page.getByRole("option").filter({ hasText: "synthetic-project-44" }).waitFor();
    await search.fill("zzzzzzzzzzzzzzzzzzzzzzzz"); await page.getByText("没有匹配结果", { exact: true }).waitFor();
    await search.fill(""); await page.waitForFunction(count => document.querySelectorAll('[role="option"]').length === count, f.count); await page.getByRole("option").last().scrollIntoViewIfNeeded();
    u.ensure(await page.locator(".project-picker-options").evaluate(node => node.scrollTop) > 0, "长列表不能独立滚动");
    await page.screenshot({ path: f.artifacts + "/register-projects-zh-light.png" });
    await search.press("Escape"); u.ensure(await u.dialog().isVisible(), "关闭项目列表同时关闭登记弹窗");
    await page.waitForFunction(label => document.activeElement?.getAttribute("aria-label") === label, u.names.project);
    await u.button(u.names.project).press("Enter"); await search.press("ArrowDown"); await search.fill(f.beta);
    await page.waitForFunction(path => document.querySelector('[role="option"][data-selected="true"]')?.textContent.includes(path), f.beta); await search.press("Enter");
    u.ensure(await u.dialog().getByRole("textbox", { name: u.names.path, exact: true }).inputValue() === f.beta, "键盘选择未填入路径");
    await u.dialog().getByRole("button", { name: u.names.cancel, exact: true }).click();
  });
  await step("候选失败和重试、手动无效路径、子目录与重复登记不启动任务", async (page, f, u) => {
    const pattern = "**/api/v1/sessions/status?summary=true";
    await page.route(pattern, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "SYNTHETIC_FAILURE", message: "synthetic-project-failure" } }) }));
    await u.register(); await u.dialog().getByText("会话项目加载失败", { exact: true }).waitFor();
    await u.dialog().getByRole("textbox", { name: u.names.path, exact: true }).fill("/nonexistent-synthetic-repository");
    await u.dialog().getByRole("button", { name: u.names.submit, exact: true }).click();
    await u.dialog().getByText("path 必须是可读取的 Git 仓库", { exact: true }).waitFor();
    await page.unroute(pattern); await u.dialog().getByRole("button", { name: "重试", exact: true }).click(); await u.button(u.names.project).waitFor();
    await u.dialog().getByRole("textbox", { name: u.names.path, exact: true }).fill(f.alpha + "/src");
    const response = page.waitForResponse(item => item.url().endsWith("/api/v1/repositories") && item.request().method() === "POST");
    await u.dialog().getByRole("button", { name: u.names.submit, exact: true }).click();
    const body = await (await response).json(); u.ensure(body.repository.id === f.alphaId && !Object.hasOwn(body, "job"), "重复子目录登记创建了任务");
    await u.map("alpha-repository");
  });
  await step("候选为空时仍可手动登记新仓库", async (page, f, u) => {
    const pattern = "**/api/v1/sessions/status?summary=true";
    await page.route(pattern, async route => { const response = await route.fetch(); const data = await response.json(); await route.fulfill({ response, json: { ...data, projects: [] } }); });
    await u.register(); await u.dialog().getByText("暂无会话项目，可在下方手动输入仓库路径。", { exact: true }).waitFor();
    await u.dialog().getByRole("textbox", { name: u.names.path, exact: true }).fill(f.beta);
    await u.dialog().getByRole("button", { name: u.names.submit, exact: true }).click(); await u.map("beta-repository"); await page.unroute(pattern);
  });
  await step("旧候选请求关闭后返回不会污染下一次登记", async (page, f, u) => {
    const pattern = "**/api/v1/sessions/status?summary=true";
    let release; let hit; let once = true;
    const held = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { hit = resolve; });
    await page.route(pattern, async route => {
      if (!once) { await route.continue(); return; } once = false;
      const response = await route.fetch(); const data = await response.json(); hit(); await held;
      await route.fulfill({ response, json: { ...data, projects: ["/synthetic/old-request-project"] } }).catch(() => {});
    });
    await u.register(); await started; await u.dialog().getByRole("button", { name: u.names.cancel, exact: true }).click();
    await u.register(); await u.button(u.names.project).waitFor(); release(); await u.button(u.names.project).click();
    u.ensure(await page.getByRole("option").count() === f.count, "旧候选覆盖新候选");
    await page.getByRole("combobox", { name: u.names.search, exact: true }).press("Escape");
    await u.dialog().getByRole("button", { name: u.names.cancel, exact: true }).click(); await page.unroute(pattern);
  });
  await step("删除确认范围、取消、Escape 焦点与删除失败后重试", async (page, f, u) => {
    await u.remove(); u.ensure((await u.deletion().innerText()).includes(f.beta), "确认弹窗未显示完整路径");
    u.ensure((await u.deletion().innerText()).includes("全局会话与资源数据、本地 Git 目录及原始历史文件。"), "保留范围不可见");
    await page.screenshot({ path: f.artifacts + "/delete-zh-light.png" });
    await u.deletion().getByRole("button", { name: u.names.cancel, exact: true }).click(); await u.map("beta-repository");
    await u.remove(); await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "选择仓库");
    const pattern = "**/api/v1/repositories/*";
    await page.route(pattern, route => route.request().method() === "DELETE" ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "SYNTHETIC_FAILURE", message: "synthetic-delete-failure" } }) }) : route.continue());
    await u.remove(); await u.deletion().getByRole("button", { name: u.names.delete, exact: true }).click();
    await u.deletion().getByText(/synthetic-delete-failure/).waitFor();
    u.ensure(await u.deletion().getByRole("button", { name: u.names.delete, exact: true }).isEnabled(), "失败后无法重试");
    await page.unroute(pattern); await u.deletion().getByRole("button", { name: u.names.delete, exact: true }).click(); await u.map("alpha-repository");
    await u.register(); await u.dialog().getByRole("textbox", { name: u.names.path, exact: true }).fill(f.beta); await u.dialog().getByRole("button", { name: u.names.submit, exact: true }).click(); await u.map("beta-repository");
  });
  await step("删除时旧统计请求被丢弃，另一标签页自动恢复到剩余仓库", async (page, f, u) => {
    await u.choose(f.alpha); await u.map("alpha-repository");
    const other = await page.context().newPage(); await other.goto(f.base); const second = ui(other); await second.map("alpha-repository");
    let release; let hit; let once = true;
    const held = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { hit = resolve; });
    const pattern = `**/api/v1/repositories/${f.alphaId}/coverage?*`;
    await page.route(pattern, async route => {
      if (!once) { await route.continue(); return; } once = false;
      const response = await route.fetch(); hit(); await held; await route.fulfill({ response }).catch(() => {});
    });
    await page.reload(); await started; await u.remove(); await u.deletion().getByRole("button", { name: u.names.delete, exact: true }).click(); await u.map("beta-repository");
    release(); await page.unroute(pattern); await page.waitForTimeout(100);
    u.ensure(await u.button(u.names.choose).innerText() === "beta-repository", "旧请求恢复已删除仓库");
    await second.map("beta-repository"); await other.close();
  });
  await step("全部删除后空状态、焦点恢复与立即重新登记", async (page, f, u) => {
    await u.remove(); await u.deletion().getByRole("button", { name: u.names.delete, exact: true }).click(); await u.button(u.names.empty).waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent.includes("登记本机仓库"));
    await page.screenshot({ path: f.artifacts + "/empty-zh-light.png" });
    await u.button(u.names.empty).press("Enter"); await u.dialog().getByRole("textbox", { name: u.names.path, exact: true }).fill(f.beta); await u.dialog().getByRole("button", { name: u.names.submit, exact: true }).click(); await u.map("beta-repository");
    u.ensure((await page.evaluate(() => globalThis.__lifecycleErrors)).length === 0, "页面出现脚本错误");
    await u.button("外观").click(); await page.getByRole("combobox", { name: "显示模式", exact: true }).click();
    const saved = page.waitForResponse(response => response.url().endsWith("/preferences") && response.request().method() === "PUT");
    await page.getByRole("option", { name: "深色", exact: true }).click(); await saved; await page.keyboard.press("Escape");
    await u.button("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
  });
  await step("英文、深色、390px 登记项目选择和删除确认", async (page, f, u) => {
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.setViewportSize({ width: 390, height: 844 }); await u.register(); await u.button(u.names.project).click();
    const search = page.getByRole("combobox", { name: u.names.search, exact: true }); await search.fill(f.beta);
    u.ensure((await page.getByRole("option").filter({ hasText: f.beta }).innerText()).includes("Registered"), "英文已登记标记缺失");
    const bounds = await page.locator(".project-picker-menu").boundingBox(); u.ensure(bounds.x >= 12 && bounds.x + bounds.width <= 378 && bounds.y >= 12 && bounds.y + bounds.height <= 832, "窄屏项目菜单超出视口");
    await page.screenshot({ path: f.artifacts + "/register-en-dark-mobile.png" });
    await search.press("Escape"); await u.dialog().getByRole("button", { name: u.names.cancel, exact: true }).click(); await u.remove();
    u.ensure((await u.deletion().innerText()).includes("Global sessions and resource data"), "英文保留范围缺失");
    const dialogBounds = await u.deletion().boundingBox(); u.ensure(dialogBounds.x >= 0 && dialogBounds.x + dialogBounds.width <= 390 && dialogBounds.y >= 0 && dialogBounds.y + dialogBounds.height <= 844, "窄屏确认框超出视口");
    await page.screenshot({ path: f.artifacts + "/delete-en-dark-mobile.png" });
    await u.deletion().getByRole("button", { name: u.names.cancel, exact: true }).click();
  }, true);
  const retained = await api("/sessions/status?summary=true");
  assert.deepEqual(retained.projects, indexed.projects); assert.equal(retained.sessionCount, indexed.sessionCount);
  assert.equal(await readFile(join(alpha, "src/alpha.ts"), "utf8"), "export const synthetic = 1;\n");
  assert.equal(await readFile(join(beta, "src/beta.ts"), "utf8"), "export const synthetic = 1;\n");
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ passed: true, checks, languages: ["zh-CN", "en"], themes: ["light", "dark"], viewport: [1440, 390], sessionsRetained: true }, null, 2) + "\n");
  console.log(`仓库生命周期浏览器验收通过：${checks.length} 组。`);
} catch (error) {
  if (opened) await browser(["screenshot", "--filename", join(artifacts, "failure.png")]).catch(() => {});
  if (opened) await writeFile(join(artifacts, "failure-state.txt"), await browser(["run-code", "async page => ({options:await page.getByRole('option').allTextContents(),dialogs:await page.getByRole('dialog').allTextContents(),active:await page.evaluate(()=>({tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label')}))})"]).catch(String));
  await writeFile(join(artifacts, "failure.txt"), String(error)); throw error;
} finally {
  if (opened) await browser(["close"]).catch(() => {});
  await service?.close(); await rm(directory, { recursive: true, force: true });
}
