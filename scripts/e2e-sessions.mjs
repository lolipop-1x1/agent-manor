import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { encodeSession, sessionFixture, longSessionFixture } from "./session-fixture.mjs";

import { writePreferences } from "../dist/service/preferences.js";
import { clientIds } from "../dist/clients.js";

// 独立后台、人工历史和真实 Chrome；不读取日常历史或连接日常后台。
const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-sessions-e2e-")));
const artifacts = fileURLToPath(new URL("../.local/session-e2e/", import.meta.url));
const repository = join(directory, "sample-workspace");
const projectSlug = repository.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").toLowerCase();
const projectFolder = projectSlug.length <= 80 ? projectSlug : `${projectSlug.slice(0, 80)}-${createHash("sha1").update(repository).digest("hex").slice(0, 8)}`;
const session = `ms${process.pid}`;
const env = { ...process.env, ...Object.fromEntries(clientIds.map(client => [`AGENT_MANOR_${client.replaceAll("-", "_").toUpperCase()}_DIR`, join(directory, `missing-${client}`)])), AGENT_MANOR_HOME: join(directory, "data"), AGENT_MANOR_PORT: "0",
  AGENT_MANOR_CODEX_DIR: join(directory, "codex"), AGENT_MANOR_CLAUDE_DIR: join(directory, "claude"), AGENT_MANOR_CODEFLICKER_DESKTOP_DIR: join(directory, "missing-desktop"), AGENT_MANOR_CODEFLICKER_DIR: join(directory, "codeflicker", "projects", projectFolder) };
const command = async args => JSON.parse((await run(process.execPath, [cli, ...args, "--full", "--json"], { cwd: directory, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout);
const browser = async args => {
  const result = await run("playwright-cli", [`-s=${session}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.stdout.includes("### Error")) throw new Error(result.stdout);
  return result.stdout;
};

try {
  await mkdir(artifacts, { recursive: true });
  await mkdir(join(repository, "src"), { recursive: true });
  await writeFile(join(repository, "src/entry.ts"), "export const healthy = true;\n局部轨迹标记\n");
  await run("git", ["init", "-q", repository]);
  await run("git", ["-C", repository, "add", "src/entry.ts"]);
  const fixture = sessionFixture(repository);
  fixture.codeflicker = fixture.codeflicker.map(({ cwd, ...record }) => ({ ...record, entrypoint: "sdk-cli", version: "0.3.26" }));
  const reference = join(directory, "reference-workspace");
  await mkdir(reference);
  await run("git", ["init", "-q", reference]);
  await writeFile(join(reference, "entry.ts"), "export const reference = true;\n");
  for (const [index, path] of [join(repository, "src/entry.ts"), join(reference, "entry.ts")].entries()) {
    fixture.codeflicker.push({ type: "message", role: "assistant", uuid: `cf-read-${index}`, sessionId: "demo-flicker",
      content: [{ type: "tool_use", id: `cf-read-${index}`, name: "read", input: { file_path: path } }] });
  }
  fixture.codex[0].payload.title = "日志中的旧标题";
  const titleIndex = join(directory, "session_index.jsonl");
  await writeFile(titleIndex, encodeSession([{ id: "demo-codex", thread_name: "实现状态检查" }]));
  for (const client of ["codex", "claude", "codeflicker"]) {
    await mkdir(env[`AGENT_MANOR_${client.toUpperCase()}_DIR`], { recursive: true });
    await writeFile(join(env[`AGENT_MANOR_${client.toUpperCase()}_DIR`], "demo.jsonl"), encodeSession(fixture[client]));
  }
  await writeFile(join(directory, "codeflicker", "data.json"), JSON.stringify({ projects: { [repository]: { history: [] } } }));
  await writeFile(join(env.AGENT_MANOR_CODEX_DIR, "orphan.jsonl"), encodeSession(fixture.orphan));
  await writeFile(join(env.AGENT_MANOR_CODEX_DIR, "long.jsonl"), encodeSession(longSessionFixture(repository)));
  await writeFile(join(env.AGENT_MANOR_CODEX_DIR, "child.jsonl"), encodeSession([
    { type: "session_meta", ordinal: 0, payload: { id: "demo-child", session_id: "demo-long", cwd: repository,
      forked_from_id: "demo-long", subagent_history_start_ordinal: 5, source: { subagent: { thread_spawn: {
      parent_thread_id: "demo-long", agent_path: "/root/check_queries", agent_nickname: "Fixture Agent" } } } } },
    { type: "session_meta", ordinal: 1, payload: { id: "demo-long", cwd: repository, title: "复制的父标题" } },
    { type: "response_item", ordinal: 2, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "复制的父请求" }] } },
    { type: "response_item", ordinal: 3, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>合成项目规则</INSTRUCTIONS>" }] } },
    { type: "response_item", ordinal: 5, payload: { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "子任务搜索标记：查询已核对" }] } },
  ]));
  assert.equal((await command(["sessions", "refresh", "--wait"])).job.status, "complete");
  assert.equal((await command(["sessions", "list"])).total, 4, "默认排除 Quiet 会话");
  assert.equal((await command(["sessions", "list", "--execution-mode", "quiet"])).total, 1);
  const list = await command(["sessions", "list", "--execution-mode", "all"]);
  assert.equal(list.total, 5);
  const allSessions = await command(["sessions", "list", "--include-subagents", "--execution-mode", "all"]);
  assert.equal(allSessions.total, 6);
  const child = allSessions.sessions.find(item => item.clientSessionId === "demo-child");
  assert.equal(child.title, "check_queries");
  assert.equal(child.parentTitle, "长会话工作区验收");
  const codex = list.sessions.find(item => item.clientSessionId === "demo-codex");
  assert.ok(codex);
  assert.equal(codex.title, "实现状态检查", "CLI 应使用旁路索引的正式标题");
  const flicker = list.sessions.find(item => item.clientSessionId === "demo-flicker");
  assert.equal(flicker.project, repository, "跨仓库读取不改变正式项目归属");
  assert.equal(flicker.projectOrigin, "client_metadata");
  assert.deepEqual(flicker.executionEntries, [{ entrypoint: "sdk-cli", version: "0.3.26", recordLine: 1 }]);
  for (const item of list.sessions.filter(item => ["demo-codex", "demo-claude", "demo-flicker"].includes(item.clientSessionId))) {
    const profile = await command(["sessions", "profile", item.id]);
    assert.equal(profile.usage.inputTokens, 100);
    assert.equal(profile.usage.cachedInputTokens, 60);
    assert.equal(profile.usage.cacheReadRatio, 0.6);
  }
  const search = await command(["sessions", "search", "局部轨迹标记", "--kinds", "user,assistant,tool_result"]);
  assert.equal(search.total, 1);
  const located = await command(["sessions", "messages", codex.id, "--mode", "trace", "--message-id", search.hits[0].messageId]);
  assert.ok(located.messages.some(item => item.id === search.hits[0].messageId));
  assert.equal((await command(["register", repository, "--wait"])).job.status, "completed");
  const status = await command(["status"]);
  await writePreferences(env.AGENT_MANOR_HOME, "zh-CN");
  await browser(["open", `http://127.0.0.1:${status.instance.port}`, "--headed", "--browser=chrome"]);
  const code = async page => {
    const errors = [], checks = [];
    page.on("pageerror", error => errors.push(error.message));
    const ensure = (value, name) => { if (!value) throw new Error(name); checks.push(name); };
    const b = name => page.getByRole("button", { name, exact: true });
    const idle = () => page.waitForLoadState("networkidle");
    const count = value => page.waitForFunction(expected => document.querySelectorAll(".session-list-item").length === expected && document.querySelector('.session-list[aria-label]')?.getAttribute('aria-busy') === 'false', value);
    const more = async action => {
      await page.getByRole("button", { name: /^更多筛选/ }).click();
      await action();
      await page.getByRole("dialog", { name: "搜索范围", exact: true }).press("Escape");
    };
    const choose = async (label, values) => {
      await b(label).click();
      const menu = page.getByRole("dialog", { name: `${label}选择`, exact: true });
      if (await menu.getByRole("button", { name: "清空选择", exact: true }).isEnabled()) await menu.getByRole("button", { name: "清空选择", exact: true }).click();
      for (const name of values) await menu.getByRole("option").filter({ hasText: name }).click();
      await menu.getByRole("button", { name: "应用", exact: true }).click();
    };
    const theme = async name => { await b("外观").click(); await page.getByRole("combobox", { name: "显示模式", exact: true }).click(); await page.getByRole("option", { name, exact: true }).click(); await page.keyboard.press("Escape"); };
    await page.setViewportSize({ width: 1560, height: 1080 });
    const requests = [];
    page.on("request", request => { const url = request.url(); if (url.includes("/api/v1/sessions")) requests.push(url); });
    await b("会话库").click(); await count(4); await page.locator(".session-message").first().waitFor(); await page.locator(".session-usage-grid").first().waitFor();
    for (const suffix of ["/sessions", "/messages", "/profile"]) {
      const relevant = requests.filter(url => url.split("?")[0].endsWith(suffix));
      ensure(relevant.length === 1 && relevant.every(url => url.includes("version=")), `首次 ${suffix} 只读取确认版本一次`);
    }
    await more(async () => {
      await page.getByRole("combobox", { name: "筛选会话类型", exact: true }).click(); await page.getByRole("option", { name: "仅 Quiet", exact: true }).click();
    });
    await count(1); ensure((await page.locator(".session-list-item").innerText()).includes("Quiet 模式"), "Quiet 筛选保留入口身份");
    await more(async () => {
      await page.getByRole("combobox", { name: "筛选会话类型", exact: true }).click(); await page.getByRole("option", { name: "全部执行模式", exact: true }).click();
      await page.getByRole("combobox", { name: "会话关系", exact: true }).click(); await page.getByRole("option", { name: "全部关系", exact: true }).click();
    });
    await count(6); ensure((await page.locator(".session-list-item").filter({ hasText: "check_queries" }).innerText()).includes("属于 长会话工作区验收"), "子列表显示父会话");
    const global = page.getByRole("textbox", { name: "搜索会话标题和消息", exact: true });
    await global.fill("子任务搜索标记"); await page.locator(".session-search-group").waitFor(); await page.locator(".session-search-group .session-hit").click();
    await b("返回父会话").waitFor(); ensure((await page.locator(".sessions-main h1").innerText()) === "check_queries", "搜索定位子会话");
    await b("返回父会话").click(); await page.getByRole("heading", { name: "长会话工作区验收", exact: true }).waitFor();
    const parent = page.url();
    await page.locator(".session-profile .session-child").click(); await b("返回父会话").waitFor(); await page.goBack();
    await page.getByRole("heading", { name: "长会话工作区验收", exact: true }).waitFor(); ensure(page.url() === parent, "浏览器返回恢复父会话地址");
    await global.fill(""); await choose("筛选客户端", ["CodeFlicker CLI"]); await count(1);
    await page.locator(".session-list-item").click(); ensure((await page.locator(".session-main-meta").innerText()).includes("sample-workspace"), "客户端筛选保留正式项目");
    await choose("项目", ["sample-workspace"]); await count(1);
    await choose("筛选客户端", ["Codex"]); await choose("项目", ["无项目"]); await count(1);
    ensure((await page.locator(".session-list-item").innerText()).includes("无项目会话仍然可见"), "无项目筛选可访问");
    await choose("项目", []); await choose("筛选客户端", []);
    await global.fill("状态检查"); await page.locator(".session-search-group").waitFor(); await page.locator(".session-group-title").click();
    await page.getByRole("heading", { name: "实现状态检查", exact: true }).waitFor(); await page.locator(".session-message").first().waitFor();
    await b("全部记录").click(); await page.locator(".session-turn").first().waitFor(); await b("执行轨迹").click(); await page.locator(".trace-ledger").waitFor();
    const call = page.locator(".trace-row").filter({ hasText: "shell_command" }); await call.locator("button").click();
    await page.getByRole("tab", { name: "返回结果", exact: true }).click(); await page.locator(".trace-detail-body").filter({ hasText: "局部轨迹标记" }).waitFor();
    ensure((await call.innerText()).includes("局部轨迹标记"), "工具参数与结果配对");
    await page.locator(".trace-event button").first().focus(); await page.keyboard.press("Home");
    await page.locator(".trace-source summary").click();
    await page.locator(".trace-context-note").waitFor(); ensure((await page.locator(".trace-inspector").innerText()).includes("AGENTS.md"), "注入保留原始来源与分类");
    await more(async () => { await page.getByRole("checkbox", { name: "搜索过程记录", exact: true }).check(); });
    await global.fill("局部轨迹标记"); await page.locator(".session-search-group .session-hit").click();
    await page.locator(".trace-detail-body").filter({ hasText: "局部轨迹标记" }).waitFor();
    ensure(page.url().includes("message="), "过程搜索精确定位并同步地址");
    await global.fill("");
    const local = page.getByRole("textbox", { name: "在当前会话搜索", exact: true });
    await local.fill("不存在的合成搜索命中"); const localMenu = page.getByRole("dialog", { name: "当前会话命中", exact: true });
    await localMenu.getByText("没有找到匹配记录。", { exact: true }).waitFor();
    await local.press("Escape"); await localMenu.waitFor({ state: "hidden" }); ensure(await local.evaluate(element => element === document.activeElement), "搜索浮层关闭恢复焦点");
    await b("清除会话内搜索").click();
    await page.locator(".session-file-links summary").first().click(); await page.locator(".session-file-link").first().click();
    await page.locator(".map-main").waitFor({ state: "visible" }); await b("查看所属会话").click();
    await page.locator(".trace-detail-body").waitFor(); ensure(await page.locator(".sessions-shell").isVisible(), "地图与会话双向定位");
    await b("收起会话列表").click(); await b("展开会话列表").click(); await b("收起会话画像").click(); await b("展开会话画像").click();
    await page.getByRole("separator", { name: "调整会话列表宽度", exact: true }).press("ArrowRight");
    await page.getByRole("separator", { name: "调整会话画像宽度", exact: true }).press("ArrowLeft");
    await page.locator(".session-list-item").filter({ hasText: "长会话工作区验收" }).click(); await b("对话").click(); await idle();
    await page.locator(".session-message-text table").first().waitFor();
    ensure(await page.locator(".session-message-text img, .session-message-text script").count() === 0, "历史正文不执行 HTML 或加载外部图片");
    await page.getByRole("tab", { name: "用量", exact: true }).click(); await page.locator(".session-step-table tbody tr").first().waitFor();
    ensure(await page.locator(".session-step-table tbody tr").count() === 12, "请求明细按12条分页");
    await page.locator(".session-chart-hit").first().focus(); await page.keyboard.press("End"); await page.getByRole("tooltip").filter({ hasText: "请求 245" }).waitFor();
    ensure((await page.getByRole("tooltip").innerText()).includes("fixture-model"), "趋势覆盖末请求并显示模型");
    await page.keyboard.press("Home"); await page.keyboard.press("Enter"); await page.locator(".trace-detail-body.kind-system").waitFor();
    ensure(page.url().includes("message="), "请求趋势定位实际用量记录");
    await page.screenshot({ path: "workspace-light.png" });
    await theme("深色"); await page.screenshot({ path: "workspace-dark.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await b("会话统计").click(); await page.locator(".session-profile").waitFor({ state: "visible" }); await page.keyboard.press("Escape");
    await b("会话列表").click(); await page.locator(".session-sidebar").waitFor({ state: "visible" }); await b("返回对话").click({ position: { x: 380, y: 400 } });
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "窄屏独立抽屉无整页横向溢出");
    await b("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
    await b("Dialogue").waitFor(); ensure(await page.locator(".trace-ledger").isVisible(), "语言切换保留轨迹状态");
    await page.screenshot({ path: "workspace-narrow-en.png" });
    await b("Display language").click(); await page.getByRole("menuitemradio", { name: "Simplified Chinese", exact: true }).click();
    await page.setViewportSize({ width: 1560, height: 1080 });
    ensure(errors.length === 0, `浏览器无运行异常：${errors.join(";")}`);
    return { passed: true, checks, errors };
  };
  console.log((await browser(["run-code", code.toString()])).split("### Ran Playwright code")[0].trim());
  await Promise.all(["workspace-light.png", "workspace-dark.png", "workspace-narrow-en.png"].map(name => copyFile(join(directory, name), join(artifacts, name))));
  await browser(["screenshot", `--filename=${join(artifacts, "session-library.png")}`]);
  await writeFile(titleIndex, encodeSession([{ id: "demo-codex", thread_name: "状态检查改名验收" }]));
  console.log((await browser(["run-code", `async page => {
    await page.goto(${JSON.stringify(`http://127.0.0.1:${status.instance.port}/#sessions?id=${encodeURIComponent(codex.id)}`)});
    await page.locator(".sessions-main h1").filter({ hasText: "实现状态检查" }).waitFor();
    await page.getByRole("button", { name: "同步历史", exact: true }).click();
    await page.locator(".sessions-main h1").filter({ hasText: "状态检查改名验收" }).waitFor();
    await page.locator(".session-list-item").filter({ hasText: "状态检查改名验收" }).waitFor();
    return { titleRenamePassed: true };
  }`])).split("### Ran Playwright code")[0].trim());
  assert.equal((await command(["sessions", "messages", codex.id])).session.title, "状态检查改名验收");
  console.log("PASS 全局会话 CLI／HTTP／Chrome 端到端");
} catch (error) {
  await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]).catch(() => {});
  await writeFile(join(artifacts, "failure-state.txt"), await browser(["run-code", "async page => ({url:page.url(), text:(await page.locator('body').innerText()).slice(0,12000)})"]).catch(() => "状态无法读取"));
  throw error;
} finally {
  await browser(["close"]).catch(() => {});
  await command(["stop"]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
