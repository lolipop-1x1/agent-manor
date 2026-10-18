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

// 合成历史覆盖末页、长轮分段与轨迹详情，不访问日常历史。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-reading-")));
const artifacts = fileURLToPath(new URL("../.local/session-reading-e2e/", import.meta.url));
const browserName = `reading-${process.pid}`;
const browser = async args => {
  const result = await run("playwright-cli", [`-s=${browserName}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.stdout.includes("### Error")) throw new Error(result.stdout);
  return result.stdout;
};
const roots = Object.fromEntries(clientIds.map(client => [client, join(directory, `empty-${client}`)]));
roots.codex = join(directory, "codex");
const time = index => new Date(Date.parse("2026-10-11T10:00:00Z") + index * 1000).toISOString();
const reply = (id, role, text, channel = "final") => ({ type: "response_item", timestamp: time(1), payload: { type: "message", id, role, channel: role === "assistant" ? channel : undefined, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
const meta = (id, title, extra = {}) => [{ type: "session_meta", payload: { id, title, cwd: "/workspace/reading-demo", ...extra } }, { type: "turn_context", payload: { model: "demo-model", cwd: "/workspace/reading-demo" } }];
const session = meta("continuous", "连续阅读验收");
for (let turn = 1; turn <= 21; turn++) {
  session.push(reply(`u-${turn}`, "user", `连续问题 ${turn}`));
  session.push(reply(`a-${turn}`, "assistant", `连续回复 ${turn}\n\n` + "检查实现、补充测试并核对记录。\n\n".repeat(5), turn === 21 ? "commentary" : "final"));
  if (turn === 21) session.push({ type: "response_item", payload: { type: "function_call", call_id: "pending", name: "shell_command", arguments: "{}" } });
}
const long = meta("long", "长轮轨迹验收");
long.push(reply("long-user", "user", "检查长轮的每一条执行记录"));
for (let index = 1; index <= 660; index++) long.push(reply(`process-${index}`, "assistant", `过程片段 ${index}`, "commentary"));
const longBody = "### 验证结果\n\n```ts\n" + "const synthetic = true;\n".repeat(800) + "```\n\n长正文结束标记";
long.push(reply("long-final", "assistant", longBody));
long.push({ type: "response_item", timestamp: time(670), payload: { type: "function_call", call_id: "paired", name: "shell_command", arguments: '{"command":"synthetic check"}' } });
long.push({ type: "response_item", timestamp: time(671), payload: { type: "function_call_output", call_id: "paired", output: "合成工具结果" } });
const child = [...meta("child", "合成子任务", { source: { subagent: { thread_spawn: { parent_thread_id: "long", agent_path: "/root/synthetic-child" } } } }), reply("child-u", "user", "检查子任务"), reply("child-a", "assistant", "检查完成")];
let service;
try {
  await mkdir(artifacts, { recursive: true }); await mkdir(roots.codex, { recursive: true });
  for (const [name, records] of [["continuous", session], ["long", long], ["child", child]]) await writeFile(join(roots.codex, `${name}.jsonl`), records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const home = join(directory, "data"); await mkdir(home); await writePreferences(home, "zh-CN");
  service = await startService({ home, port: 0, roots, resourceInventory: { environment: {} } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await (await fetch(`${base}/api/v1/sessions/status`)).json();
    if (state.version) break;
    assert.notEqual(state.job?.status, "failed"); await new Promise(resolve => setTimeout(resolve, 100));
  }
  await browser(["open", `${base}/#sessions`, "--headed", "--browser=chrome"]);
  const verify = async page => {
    const checks = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const ensure = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
    const b = name => page.getByRole("button", { name, exact: true });
    const pane = page.locator(".session-message-scroll");
    const text = value => pane.locator(".session-message").getByText(value, { exact: true });
    const idle = () => page.waitForLoadState("networkidle");
    const scrollSettled = () => pane.evaluate(element => new Promise(resolve => {
      let previous = element.scrollTop, stable = 0, frames = 0;
      const sample = () => {
        stable = Math.abs(element.scrollTop - previous) < .5 ? stable + 1 : 0; previous = element.scrollTop;
        if (stable >= 4 || ++frames >= 90) resolve(); else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }));
    const boundary = direction => page.locator(`.session-reading-boundary[data-direction="${direction}"] button`);
    await page.setViewportSize({ width: 1560, height: 1000 });
    await page.getByRole("button", { name: /^连续阅读验收 Codex/ }).click();
    await text("连续问题 1").waitFor();
    await page.locator(".session-turn-position").click(); await b("末轮").click();
    await text("连续问题 21").waitFor(); await text("连续问题 20").waitFor(); await idle(); await scrollSettled();
    ensure(await page.locator(".session-turn-position").getAttribute("data-turn") === "21", "末轮预载前文后仍定位21轮");
    await pane.hover();
    // 设置边界与采集原锚点在同一帧完成，不让补载先于基准矩形发生。
    const before = await pane.evaluate(element => {
      element.scrollTop = 150;
      const node = [...element.querySelectorAll(".session-message p")].find(node => node.textContent === "连续问题 11");
      const rect = node?.getBoundingClientRect(); return rect?.width ? { y: rect.y } : null;
    });
    await page.mouse.wheel(0, -50); await text("连续问题 1").waitFor(); await idle(); await scrollSettled();
    const after = await text("连续问题 11").boundingBox();
    ensure(before && after, "上滑补载前后阅读锚点均可见");
    ensure(Math.abs(after.y - before.y - 50) <= 2, "上滑自动补入前文并保持可见消息位置");
    ensure(await text("连续问题 10").count() === 1 && await text("连续问题 20").count() === 1, "21轮跨页不重复不缺失");
    await pane.hover(); await page.mouse.wheel(0, -100000); await idle();
    await page.waitForFunction(() => document.querySelector(".session-message-scroll").scrollTop < 2);
    ensure(await text("连续问题 1").isVisible(), "末轮可连续上滑回首轮");
    ensure(await page.getByText("未确认结束", { exact: true }).count() === 0, "对话不常驻结束状态徽标");
    ensure((await page.locator(".session-message.kind-assistant header strong").first().innerText()) === "AI · demo-model", "AI与模型角色明确");
    const colors = await page.evaluate(() => ({ user: getComputedStyle(document.querySelector(".session-message.kind-user")).backgroundColor, ai: getComputedStyle(document.querySelector(".session-message.kind-assistant")).backgroundColor }));
    ensure(colors.user !== colors.ai, "用户问题具有独立主题底色");
    await page.screenshot({ path: ARTIFACTS + "/dialogue-light.png" });
    await page.getByRole("button", { name: /^长轮轨迹验收 Codex/ }).click(); await idle(); await b("全部记录").click(); await idle();
    // 切换模式保留用户消息定位并自动展开；等待真实内容，避免读取瞬态 open 后再把已展开轮次点成折叠。
    await text("过程片段 1").waitFor({ timeout: 5000 });
    ensure(await page.locator(".session-turn").evaluate(element => element.open), "全部记录保留定位轮次展开状态");
    await page.route("**/api/v1/sessions/*/messages?*", route => route.fulfill({ status: 500, json: { error: { code: "FIXTURE_FAILED", message: "合成后续内容读取错误" } } }), { times: 1 });
    await pane.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const laterBoundary = page.locator('.session-reading-boundary[data-direction="later"]');
    await laterBoundary.getByRole("alert").waitFor();
    ensure(await page.locator(".session-message").count() === 300, "补载失败保留已读分段");
    await laterBoundary.getByRole("button", { name: "重试", exact: true }).click();
    await text("过程片段 300").waitFor(); await idle();
    ensure(await laterBoundary.getByRole("alert").count() === 0, "后续内容边界可重试并清除错误");
    for (let step = 0; step < 3 && await boundary("later").count(); step++) { await pane.evaluate(element => { element.scrollTop = element.scrollHeight; }); await idle(); }
    await text("过程片段 660").waitFor();
    ensure(await page.locator(".session-message.kind-assistant").count() === 661, "单轮超过300条分段完整无重复");
    await b("执行轨迹").click(); await page.locator(".trace-ledger").waitFor(); await idle();
    ensure(await page.locator(".session-trace-children").count() === 0 && await page.locator(".session-profile .session-child").count() === 1, "子会话只保留画像入口");
    await page.locator(".trace-event button").nth(1).click();
    const inspector = page.locator(".trace-inspector"); await inspector.waitFor();
    ensure(await inspector.getByRole("tablist").count() === 0, "单正文不显示重复标签");
    const dimensions = await page.evaluate(() => ({ split: document.querySelector(".trace-split").clientHeight, detail: document.querySelector(".trace-detail-slot").clientHeight }));
    ensure(dimensions.detail / dimensions.split > .44 && dimensions.detail / dimensions.split < .52, "详情默认分配约一半高度");
    const resize = page.getByRole("separator", { name: "调整节点列表与详情高度", exact: true });
    await resize.focus(); await resize.press("ArrowUp"); ensure(await resize.getAttribute("aria-valuenow") === "50", "键盘调整详情高度");
    const handle = await resize.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down(); await page.mouse.move(handle.x + handle.width / 2, handle.y - 40, { steps: 5 }); await page.mouse.up();
    const resized = await resize.getAttribute("aria-valuenow"); ensure(Number(resized) < 50, "鼠标拖动调整详情高度");
    await b("收起时间线").click(); ensure(await page.locator(".trace-timeline-body").isVisible() === false, "时间线可收起"); await b("展开时间线").click();
    const ledger = page.locator(".trace-ledger-scroll");
    await ledger.evaluate(element => { element.scrollTop = 500; }); await page.locator(".trace-event button").first().click();
    const scroll = await ledger.evaluate(element => element.scrollTop);
    const title = await inspector.locator(".trace-detail-heading strong").innerText();
    await b("放大详情").click(); await b("返回轨迹").waitFor();
    ensure(await page.locator(".trace-upper").isVisible() === false, "放大详情占据中间工作区");
    await b("下一节点").click(); ensure(await inspector.locator(".trace-detail-heading strong").innerText() !== title, "放大中切换节点");
    await b("上一节点").click(); await b("返回轨迹").click();
    ensure(Math.abs((await ledger.evaluate(element => element.scrollTop)) - scroll) <= 2, "返回轨迹保留列表滚动位置");
    ensure(await resize.getAttribute("aria-valuenow") === resized, "返回轨迹保留分区比例");
    await b("放大详情").click(); await b("返回轨迹").press("Escape"); await b("放大详情").waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "放大详情");
    await page.screenshot({ path: ARTIFACTS + "/trace-light.png" });
    await page.reload(); await page.locator(".trace-event button").first().click();
    ensure(await resize.getAttribute("aria-valuenow") === resized, "重载保留分区比例");
    await b("当前轮次记录分页末页").click(); await idle();
    await page.locator(".trace-event button").first().press("End");
    await inspector.getByRole("tab", { name: "返回结果", exact: true }).click();
    await inspector.getByText("合成工具结果", { exact: true }).waitFor();
    ensure(await inspector.getByRole("tab", { name: "输入参数", exact: true }).isVisible(), "工具配对保留输入和结果切换");
    await b("放大详情").click(); await b("上一节点").click();
    await inspector.getByText("长正文结束标记", { exact: true }).waitFor();
    const detailScroll = inspector.locator(".trace-inspector-scroll");
    await detailScroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    ensure(await detailScroll.evaluate(element => element.scrollTop > 1000 && element.scrollHeight - element.clientHeight - element.scrollTop < 2), "放大长正文完整加载且可读到末尾");
    await b("返回轨迹").click();
    await b("外观").click(); await page.getByRole("combobox", { name: "显示模式", exact: true }).click(); await page.getByRole("option", { name: "深色", exact: true }).click(); await page.keyboard.press("Escape");
    await b("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click(); await idle();
    await page.screenshot({ path: ARTIFACTS + "/trace-dark-en.png" });
    await page.setViewportSize({ width: 390, height: 844 }); await b("Expand details").click();
    await page.screenshot({ path: ARTIFACTS + "/trace-mobile-expanded.png" });
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "窄屏放大详情无整页横向溢出");
    await b("Back to trace").click();
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "窄屏表格保持局部横向滚动");
    ensure(errors.length === 0, "浏览器无运行错误");
    return { passed: true, checks, errors };
  };
  const output = await browser(["run-code", verify.toString().replaceAll("ARTIFACTS", JSON.stringify(artifacts))]);
  await writeFile(join(artifacts, "report.txt"), output); console.log(output.split("### Ran Playwright code")[0]);
} catch (error) {
  await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]).catch(() => {});
  await writeFile(join(artifacts, "failure.txt"), await browser(["snapshot"]).catch(() => ""));
  throw error;
} finally {
  await browser(["close"]).catch(() => {}); await service?.close(); await rm(directory, { recursive: true, force: true });
}
