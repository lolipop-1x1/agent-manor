import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";
import { writePreferences } from "../dist/service/preferences.js";

// 人工历史、独立后台和浏览器，避免修改日常会话及共享语言偏好。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-map-session-")));
const artifacts = fileURLToPath(new URL("../.local/map-session-filter-e2e/", import.meta.url));
const browserName = `map-session-${process.pid}`;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${browserName}`, ...args], {
    cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
const roots = Object.fromEntries(clientIds.map(client => [client, []]));
roots.codex = join(directory, "codex");
const repository = join(directory, "repo");
const encode = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const history = (id, title, file, parent) => [
  { type: "session_meta", timestamp: "2026-10-09T00:00:00Z", payload: { id, cwd: repository, title,
    ...(parent ? { source: { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: "/root/synthetic-child" } } } } : {}) } },
  { type: "response_item", timestamp: "2026-10-09T00:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: title }] } },
  ...(file ? [
    { type: "response_item", timestamp: "2026-10-09T00:00:02Z", payload: { type: "function_call", name: "shell_command", call_id: "read", arguments: JSON.stringify({ command: `cat src/${file}.ts`, workdir: repository }) } },
    { type: "response_item", timestamp: "2026-10-09T00:00:03Z", payload: { type: "function_call_output", call_id: "read", output: `Exit code: 0\nOutput:\n${file === "a" ? "alpha\nbeta" : "gamma"}\n` } },
  ] : []),
  { type: "response_item", timestamp: "2026-10-09T00:00:04Z", payload: { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: `完成。查看 [文件](src/${file ?? "a"}.ts)。` }] } },
];
let service;
let opened = false;
try {
  await mkdir(artifacts, { recursive: true }); await mkdir(roots.codex); await mkdir(join(repository, "src"), { recursive: true });
  await run("git", ["init", "-q", repository]);
  await writeFile(join(repository, "src/a.ts"), "alpha\nbeta\n"); await writeFile(join(repository, "src/b.ts"), "gamma\n");
  for (const [id, title, file, parent] of [["map-a", "读取入口", "a"], ["map-b", "读取配置", "b"], ["map-empty", "仅讨论方案"], ["map-child", "子任务读取", "b", "map-a"],
    ...Array.from({ length: 35 }, (_, index) => [`map-other-${index}`, index < 2 ? "同名会话" : `合成会话 ${index}`, "a"])]) {
    await writeFile(join(roots.codex, `${id}.jsonl`), encode(history(id, title, file, parent)));
  }
  const home = join(directory, "data"); await mkdir(home); await writePreferences(home, "zh-CN");
  service = await startService({ home, roots, resourceInventory: { environment: {} } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const api = async (path, body) => {
    const response = await fetch(`${base}/api/v1${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    assert.equal(response.status, 200); return response.json();
  };
  const registration = await api("/repositories", { path: repository });
  for (let attempt = 0; attempt < 200; attempt++) {
    const [{ job }, status] = await Promise.all([api(`/jobs/${registration.job.id}`), api("/sessions/status")]);
    assert.notEqual(job.status, "failed"); assert.notEqual(status.job?.status, "failed");
    if (job.status === "completed" && status.version) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const list = await api("/sessions?includeSubagents=true");
  const primary = list.sessions.find(session => session.clientSessionId === "map-a");
  assert.ok(primary);
  const mapBase = `/repositories/${registration.repository.id}`;
  const all = await api(`${mapBase}/coverage`);
  const mapList = await api(`${mapBase}/sessions?version=${all.version}`);
  assert.equal(mapList.sessions.length, 39);
  assert.equal(mapList.sessions.find(session => session.clientSessionId === "map-child").title, "子任务读取");
  await browser(["open", `${base}/#sessions?id=${encodeURIComponent(primary.id)}`, "--headed", "--browser=chrome"]); opened = true;
  const verify = async (page, fixture) => {
    const ensure = (condition, message) => { if (!condition) throw new Error(message); };
    page.setDefaultTimeout(15_000);
    const errors = []; page.on("pageerror", error => errors.push(String(error)));
    const button = name => page.getByRole("button", { name, exact: true });
    const map = page.getByRole("region", { name: "代码地图视图", exact: true });
    const picker = () => button("筛选会话");
    const settle = async () => { await page.locator(".code-map").waitFor(); await page.waitForLoadState("networkidle"); };
    const choose = async (id, name) => {
      await picker().click(); await page.getByRole("combobox", { name: "筛选会话搜索", exact: true }).fill(id);
      await page.getByRole("option").filter({ hasText: name }).click(); await settle();
    };
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("heading", { name: "读取入口", exact: true }).waitFor();
    await button("查看代码地图").click(); await settle();
    ensure((await picker().innerText()).includes("读取入口"), "会话库跳转没有选中当前会话");
    ensure((await map.locator(".metric-primary small").innerText()).includes("2 / 3"), "会话筛选改变分母或带入其他会话");
    await map.getByText("文件列表 · 2 个", { exact: true }).click();
    await map.getByRole("button", { name: "src/a.ts", exact: true }).click(); await page.getByRole("heading", { name: "a.ts", exact: true }).waitFor();
    ensure(await page.locator(".event-list").getByRole("button").count() === 1, "文件详情包含其他会话活动");
    await choose("map-b", "读取配置");
    ensure((await map.locator(".metric-primary small").innerText()).includes("1 / 3"), "独立切换没有更新覆盖");
    ensure(await page.locator(".event-list").getByRole("button").count() === 0, "所选文件保留上一个会话的活动");
    await choose("map-child", "子任务读取");
    ensure((await map.locator(".metric-primary small").innerText()).includes("1 / 3"), "子会话带入父会话活动");
    await choose("map-empty", "仅讨论方案");
    await page.getByText("此会话在当前筛选范围内没有已记录的代码活动。", { exact: true }).waitFor();
    ensure((await map.locator(".metric-primary small").innerText()).includes("0 / 3"), "空会话回退成全量");
    await button("清除会话筛选").click(); await settle();
    ensure((await picker().innerText()).includes("全部会话"), "清除没有恢复全量");
    ensure((await map.locator(".metric-primary small").innerText()).includes("3 / 3"), "全量覆盖未恢复");
    await button("会话库").click(); await page.getByRole("heading", { name: "读取入口", exact: true }).waitFor();
    await button("文件").click(); await settle();
    ensure((await picker().innerText()).includes("读取入口"), "消息文件链接没有携带所属会话");
    await page.getByRole("heading", { name: "a.ts", exact: true }).waitFor();
    ensure(await page.locator(".event-list").getByRole("button").count() === 1, "消息文件跳转显示其他会话的活动");
    await button("清除会话筛选").click(); await settle();
    await picker().click();
    const search = page.getByRole("combobox", { name: "筛选会话搜索", exact: true });
    await search.fill("不存在的会话"); await page.getByText("没有匹配结果", { exact: true }).waitFor();
    await search.fill("同名会话"); ensure(await page.getByRole("option").count() === 2, "同名会话无法搜索或区分");
    ensure((await page.getByRole("option").allTextContents()).every(text => text.includes("map-other-")), "同名选项缺少原生身份");
    await search.fill("");
    const last = page.getByRole("option").last(); await last.scrollIntoViewIfNeeded();
    ensure(await page.locator(".project-picker-options").evaluate(element => element.scrollTop) > 0, "长列表不能独立滚动");
    await search.press("Escape");
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "筛选会话");
    await picker().press("Enter"); await search.fill("读取入口");
    await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 1 && document.querySelector('[role="option"]')?.textContent.includes("读取入口"));
    await search.press("ArrowDown"); await search.press("Enter"); await settle();
    ensure((await picker().innerText()).includes("读取入口"), "键盘无法选择会话");
    // 页面切换仅隐藏非活动视图，保留页面节点、筛选与地图视野。
    const beforeScale = await page.locator(".code-map").getAttribute("data-scale");
    await button("放大地图").click();
    await page.waitForFunction(previous => Number(document.querySelector(".code-map").dataset.scale) > Number(previous), beforeScale);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const scale = await page.locator(".code-map").getAttribute("data-scale");
    const retained = await page.evaluateHandle(() => [".code-map", ".sessions-shell", ".resources-shell"].map(selector => document.querySelector(selector)));
    for (const [name, activeIndex] of [["资源管理", 2], ["会话库", 1], ["代码地图", 0]]) {
      await page.getByRole("navigation", { name: "功能导航", exact: true }).getByRole("button", { name, exact: true }).click();
      await page.waitForFunction(index => [...document.querySelectorAll(".product-view")].every((view, position) => view.hidden === (position !== index)), activeIndex);
      ensure(await page.evaluate(nodes => [".code-map", ".sessions-shell", ".resources-shell"].every((selector, index) => nodes[index]?.isConnected && nodes[index] === document.querySelector(selector)), retained), "跨页面切换重建了页面节点");
    }
    await settle();
    ensure((await picker().innerText()).includes("读取入口"), "跨页面切换丢失地图会话筛选");
    ensure(await page.locator(".code-map").getAttribute("data-scale") === scale, `跨页面切换丢失地图视野：${scale} → ${await page.locator(".code-map").getAttribute("data-scale")}`);
    await retained.dispose();
    await page.screenshot({ path: fixture.artifacts + "/session-selected.png" });
    await button("切换主题").click(); await picker().click(); await search.fill("map-child");
    await page.screenshot({ path: fixture.artifacts + "/session-dark-menu.png" }); await search.press("Escape");
    await button("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
    ensure((await button("Filter sessions").innerText()).includes("读取入口"), "语言切换丢失选中会话");
    await button("Filter sessions").click(); await page.getByRole("combobox", { name: "Search Filter sessions", exact: true }).fill("map-child");
    ensure((await page.getByRole("option").innerText()).includes("1 activity"), "英文单数或活动数错误");
    await page.getByRole("combobox", { name: "Search Filter sessions", exact: true }).press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await button("Filter sessions").click();
    const bounds = await page.locator(".project-picker-menu").boundingBox();
    ensure(bounds.x >= 12 && bounds.x + bounds.width <= 378 && bounds.y >= 12 && bounds.y + bounds.height <= 832, "窄屏菜单超出视口");
    await page.screenshot({ path: fixture.artifacts + "/session-mobile-menu.png" });
    await page.getByRole("combobox", { name: "Search Filter sessions", exact: true }).press("Escape");
    ensure(errors.length === 0, "浏览器脚本出现错误");
    return { passed: true, scopes: ["map-a", "map-b", "map-child", "map-empty", "all"], retainedPages: true, keyboard: true, languages: ["zh-CN", "en"], narrow: true };
  };
  const result = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify({ artifacts })})`]);
  await writeFile(join(artifacts, "result.txt"), result);
  console.log("地图会话筛选浏览器验收通过：自动跳转、切换与清除、详情范围、空活动、搜索、长列表、键盘、中英文、主题与窄屏。");
} catch (error) {
  if (opened) {
    await browser(["screenshot", "--filename", join(artifacts, "failure.png")]).catch(() => {});
    await writeFile(join(artifacts, "failure.txt"), String(error));
  }
  throw error;
} finally {
  if (opened) await browser(["close"]).catch(() => {});
  await service?.close(); await rm(directory, { recursive: true, force: true });
}
