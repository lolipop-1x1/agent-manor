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

// 使用隔离数据目录和人工长会话，验证实际 Chrome 中的绘制与定位。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-trace-zoom-")));
const artifacts = fileURLToPath(new URL("../.local/session-trace-zoom-e2e/", import.meta.url));
const browserName = `trace-zoom-${process.pid}`;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${browserName}`, ...args], {
    cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
const roots = Object.fromEntries(clientIds.map(client => [client, []]));
roots.codex = join(directory, "codex");
const records = [{ type: "session_meta", payload: { id: "trace-zoom", cwd: "/workspace/trace-demo", title: "轨迹缩放验收" } }];
const at = index => new Date(Date.parse("2026-01-01T00:00:00Z") + index * 1000).toISOString();
const reply = (id, role, text, channel, timestamp) => ({ type: "response_item", timestamp,
  payload: { type: "message", id, role, channel, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
for (let turn = 0; turn < 80; turn++) {
  records.push(reply(`u-${turn}`, "user", `合成问题 ${turn + 1}`, undefined, at(turn * 100)));
  for (let step = 0; step < 20; step++) {
    const id = `call-${turn}-${step}`, time = turn * 100 + step * 3 + 1;
    records.push({ type: "response_item", timestamp: at(time), payload: { type: "function_call", call_id: id, name: "shell_command", arguments: '{"command":"synthetic"}' } });
    records.push({ type: "response_item", timestamp: at(time + 1), payload: { type: "function_call_output", call_id: id, output: "合成工具结果" } });
    records.push(reply(`a-${turn}-${step}`, "assistant", `合成回复 ${turn + 1} / ${step + 1}`, step === 19 ? "final" : "commentary", at(time + 2)));
  }
}
// 缺失时间仍进入顺序与轮次视图，记录时间视图保留直接可见的缺口。
records.push(reply("untimed", "user", "没有时间的合成问题"));
let service;
try {
  await mkdir(artifacts, { recursive: true }); await mkdir(roots.codex, { recursive: true });
  await writeFile(join(roots.codex, "trace.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const home = join(directory, "data"); await mkdir(home); await writePreferences(home, "zh-CN");
  service = await startService({ home, port: 0, roots, resourceInventory: { environment: {}, userHome: join(directory, "isolated-user") } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const api = async path => {
    const response = await fetch(`${base}/api/v1${path}`); assert.ok(response.ok); return response.json();
  };
  let status;
  for (let attempt = 0; attempt < 400; attempt++) {
    status = await api("/sessions/status");
    if (status.job?.status === "failed") throw new Error(status.job.error);
    if (status.version) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(status.version, "合成历史未完成索引");
  const session = (await api("/sessions")).sessions.find(value => value.clientSessionId === "trace-zoom"); assert.ok(session);
  const { events } = await api(`/sessions/${encodeURIComponent(session.id)}/timeline`);
  assert.ok(events.length > 4800);
  await browser(["open", `${base}/#sessions?id=${encodeURIComponent(session.id)}&mode=trace`, "--headed", "--browser=chrome"]);
  const verify = async page => {
    let checks = 0;
    const ensure = (value, message) => { checks++; if (!value) throw new Error(message); };
    const button = name => page.getByRole("button", { name, exact: true });
    const timeline = page.locator(".trace-timeline-viewport svg");
    const measure = () => page.locator(".trace-timeline-viewport").evaluate(element => {
      const svg = element.querySelector("svg"), selected = svg.querySelector(".trace-mark-selection");
      const bounds = element.getBoundingClientRect(), mark = svg.querySelector(".trace-mark")?.getBoundingClientRect();
      return { width: element.clientWidth, total: element.scrollWidth, scroll: element.scrollLeft,
        svgWidth: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height,
        marks: svg.querySelectorAll(".trace-mark").length, markWidth: mark?.width, markHeight: mark?.height,
        selected: selected ? selected.getBoundingClientRect().left + 4 - bounds.left : undefined };
    });
    const visibleSelection = async () => {
      await page.waitForFunction(() => {
        const viewport = document.querySelector(".trace-timeline-viewport"), mark = viewport?.querySelector(".trace-mark-selection");
        if (!mark) return false;
        const x = mark.getBoundingClientRect().left + 4 - viewport.getBoundingClientRect().left;
        return x >= 0 && x <= viewport.clientWidth;
      });
    };
    await page.setViewportSize({ width: 1440, height: 900 });
    await timeline.waitFor(); await button("放大轨迹图").waitFor();
    await page.getByText("全会话 · 3,281 个节点", { exact: true }).waitFor();
    ensure((await page.locator(".trace-timeline").innerText()).includes("3,281 个节点"), "长会话节点总数变化");
    ensure(!(await button("缩小轨迹图").isEnabled()), "适应窗口后仍可继续缩小");
    const initial = await measure();
    ensure(initial.total === initial.width && initial.height === 66, "初始总览不是适应窗口");
    for (let index = 0; index < 4; index++) await button("放大轨迹图").click();
    await page.getByRole("status", { name: "轨迹图缩放比例" }).filter({ hasText: "1,600%" }).waitFor();
    const zoomed = await measure();
    ensure(Math.abs(zoomed.total / zoomed.width - 16) < 0.01 && zoomed.scroll > 0, "节点未围绕当前中心放大");
    ensure(zoomed.height === initial.height && zoomed.markWidth === 5 && zoomed.markHeight === 9, "缩放改变了轨道或标记大小");
    ensure(zoomed.marks < 250, "放大后没有限制绘制到可见窗口");
    await timeline.press("End"); await visibleSelection();
    ensure((await page.locator(".trace-inspector").innerText()).includes("没有时间的合成问题"), "末节点没有联动详情");
    const atEnd = await measure(); ensure(atEnd.scroll >= atEnd.total - atEnd.width - 5, "末节点没有自动进入可见区");
    await timeline.press("Home"); await visibleSelection();
    ensure((await page.locator(".trace-inspector").innerText()).includes("合成问题 1"), "首节点没有联动详情");
    await timeline.press("ArrowRight"); await page.getByRole("tab", { name: "返回结果", exact: true }).waitFor();
    await page.getByRole("tab", { name: "返回结果", exact: true }).click(); await visibleSelection();
    ensure((await page.locator(".trace-inspector").innerText()).includes("合成工具结果"), "成对工具结果选择失效");
    await page.locator(".trace-timeline-viewport").evaluate(element => { element.scrollLeft = element.scrollWidth / 2; });
    await button("定位所选轨迹节点").click(); await visibleSelection();
    ensure((await measure()).scroll < 100, "定位按钮没有找回首轮所选工具");
    await page.locator(".trace-timeline .trace-mark.kind-tool_call").first().hover();
    await page.locator(".trace-timeline-tooltip").filter({ hasText: "shell_command" }).waitFor();
    await page.locator(".trace-timeline .trace-mark.kind-tool_call").first().click(); await visibleSelection();
    ensure(await page.getByRole("tab", { name: "返回结果", exact: true }).isVisible(), "放大后的点击选错节点");
    await page.locator(".trace-timeline-viewport").evaluate(element => { element.scrollLeft = element.scrollWidth / 3; });
    const beforeWheel = await measure(), bounds = await page.locator(".trace-timeline-viewport").boundingBox();
    const anchor = bounds.width / 3;
    const fraction = (beforeWheel.scroll + anchor - 5) / (beforeWheel.total - 10);
    await page.mouse.move(bounds.x + anchor, bounds.y + 30);
    await page.keyboard.down("Control"); await page.mouse.wheel(0, -60); await page.keyboard.up("Control");
    await page.waitForFunction(total => document.querySelector(".trace-timeline-viewport").scrollWidth > total, beforeWheel.total);
    const afterWheel = await measure();
    ensure(Math.abs((afterWheel.scroll + anchor - 5) / (afterWheel.total - 10) - fraction) < 0.001, "滚轮缩放没有保留指针锚点");
    const level = await page.getByRole("status", { name: "轨迹图缩放比例" }).innerText();
    await page.mouse.wheel(180, 0);
    await page.waitForFunction(scroll => document.querySelector(".trace-timeline-viewport").scrollLeft > scroll, afterWheel.scroll);
    ensure(await page.getByRole("status", { name: "轨迹图缩放比例" }).innerText() === level, "普通横向滚动误触缩放");
    await button("轮次").click(); await visibleSelection();
    ensure((await measure()).total > (await measure()).width, "切换排列方式丢失缩放");
    await timeline.press("End"); await visibleSelection();
    await button("记录时间").click();
    ensure((await page.locator(".trace-timeline").innerText()).includes("1 个节点时间未记录"), "时间缺失状态不再可见");
    ensure(!(await button("定位所选轨迹节点").isEnabled()), "缺失时间的选中节点仍可定位");
    await timeline.press("End"); await visibleSelection();
    ensure((await page.locator(".trace-inspector").innerText()).includes("合成回复 80 / 20"), "时间投影的末节点错误");
    await timeline.press("Home"); await visibleSelection();
    await timeline.press("+"); await timeline.press("+");
    ensure(!(await button("放大轨迹图").isEnabled()), "最大倍率没有限制");
    await timeline.press("-"); ensure(await button("放大轨迹图").isEnabled(), "键盘缩小失效");
    await timeline.press("0");
    ensure((await measure()).scroll === 0 && (await measure()).total === (await measure()).width, "键盘适应窗口失效");
    await button("放大轨迹图").click(); await button("放大轨迹图").click();
    const resizeBefore = await measure();
    const center = (resizeBefore.scroll + resizeBefore.width / 2 - 5) / (resizeBefore.total - 10);
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForFunction(width => document.querySelector(".trace-timeline-viewport").clientWidth !== width, resizeBefore.width);
    const resizeAfter = await measure();
    ensure(Math.abs((resizeAfter.scroll + resizeAfter.width / 2 - 5) / (resizeAfter.total - 10) - center) < 0.003, "调整窗口改变了当前浏览中心");
    await button("轨迹图适应窗口").click();
    ensure((await measure()).total === (await measure()).width, "按钮适应窗口失效");
    await button("执行轨迹说明").click();
    ensure((await page.getByRole("dialog", { name: "执行轨迹说明", exact: true }).innerText()).includes("横向缩放"), "现有帮助没有缩放操作说明");
    await page.getByRole("dialog", { name: "执行轨迹说明", exact: true }).press("Escape");
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "执行轨迹说明");
    for (let index = 0; index < 4; index++) await button("放大轨迹图").click();
    await button("定位所选轨迹节点").click();
    await page.screenshot({ path: ARTIFACTS + "/desktop-zoom.png" });
    await button("切换主题").click();
    await button("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
    await button("Zoom in trace timeline").waitFor();
    ensure(await page.getByRole("status", { name: "Trace timeline zoom level" }).innerText() === "1,600%", "语言切换丢失缩放状态");
    await page.setViewportSize({ width: 390, height: 844 });
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "缩放导致窄屏页面水平溢出");
    await button("Locate selected trace node").click(); await visibleSelection();
    const mobile = await page.locator(".trace-timeline").boundingBox();
    ensure(mobile.x >= 0 && mobile.x + mobile.width <= 390, "窄屏缩放控件超出阅读区域");
    await button("Zoom out trace timeline").click();
    ensure(await page.getByRole("status", { name: "Trace timeline zoom level" }).innerText() === "800%", "英文窄屏缩放失效");
    await page.screenshot({ path: ARTIFACTS + "/mobile-dark-en.png" });
    const cdp = await page.context().newCDPSession(page);
    const swipeBounds = await page.locator(".trace-timeline-viewport").boundingBox(), touchBefore = await measure();
    const x = swipeBounds.x + swipeBounds.width * 0.8, y = swipeBounds.y + 32;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 6; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - step * 20, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await cdp.detach();
    await page.waitForFunction(scroll => document.querySelector(".trace-timeline-viewport").scrollLeft > scroll, touchBefore.scroll);
    ensure((await measure()).scroll > touchBefore.scroll, "触屏横向浏览失效");
    await button("Fit full trace timeline").click();
    ensure((await measure()).total === (await measure()).width, "窄屏恢复全会话失效");
    return { checks, nodes: 3281, zoom: true, anchor: true, culling: true, selection: true, modes: true, keyboard: true, wheel: true, resize: true, touch: true, language: true, mobile: true };
  };
  const output = await browser(["run-code", verify.toString().replaceAll("ARTIFACTS", JSON.stringify(artifacts))]);
  await writeFile(join(artifacts, "report.txt"), output);
  console.log(output.split("### Ran Playwright code")[0]);
} catch (failure) {
  try { await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]); await writeFile(join(artifacts, "failure.txt"), await browser(["snapshot"])); } catch { /* 浏览器未启动时保留原错误。 */ }
  throw failure;
} finally {
  try { await browser(["close"]); } catch { /* 关闭已结束的会话不影响服务清理。 */ }
  await service?.close(); await rm(directory, { recursive: true, force: true });
}
