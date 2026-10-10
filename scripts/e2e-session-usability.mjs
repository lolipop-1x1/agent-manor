import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";
import { writePreferences } from "../dist/service/preferences.js";

// 人工历史、隔离后台与独立 Chrome 会话，不连接日常数据目录。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-usability-")));
const artifacts = fileURLToPath(new URL("../.local/session-usability-e2e/", import.meta.url));
const browserName = `usability-${process.pid}`;
const browser = async args => {
  const result = await run("playwright-cli", [`-s=${browserName}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.stdout.includes("### Error")) throw new Error(result.stdout);
  return result.stdout;
};
const roots = Object.fromEntries(clientIds.map(client => [client, join(directory, `empty-${client}`)]));
roots.codex = join(directory, "codex"); roots.codeflicker = join(directory, "codeflicker");
const line = records => records.map(record => JSON.stringify(record)).join("\n") + "\n";
const reply = (id, role, text, extra = {}) => ({ type: "response_item", timestamp: "2026-10-09T09:00:00Z", payload: { type: "message", id, role, content: [{ type: role === "user" ? "input_text" : "output_text", text }], ...extra } });
const bulk = [{ type: "session_meta", payload: { id: "bulk", cwd: "/workspace/session-demo", title: "长会话验收" } }];
bulk.push({ type: "turn_context", payload: { model: "demo-model", cwd: "/workspace/session-demo" } });
for (let round = 1; round <= 110; round++) {
  bulk.push(reply(`u-${round}`, "user", `检索标记：合成问题 ${round}`));
  bulk.push(reply(`a-${round}`, "assistant", round === 1 ? "```ts\n" + "const synthetic = true;\n".repeat(1000) + "```\n完整代码后的说明" : `合成回复 ${round}`, { channel: round === 110 ? "commentary" : "final" }));
  if (round === 110) bulk.push({ type: "response_item", payload: { type: "function_call", id: "pending-call", call_id: "pending", name: "shell_command", arguments: '{"command":"fixture"}' } });
  bulk.push({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100 + round, output_tokens: 10, total_tokens: 110 + round, ...(round === 1 ? {} : { cached_input_tokens: 50 }) }, total_token_usage: { input_tokens: round * 100, output_tokens: round * 10 } } } });
}
for (let index = 0; index < 3; index++) bulk.push({ type: "compacted", timestamp: `2026-10-09T10:0${index}:00Z`, payload: { message: index === 0 ? "合成压缩摘要" : `合成压缩摘要 ${index + 1}` } });
let service;
try {
  await mkdir(artifacts, { recursive: true });
  for (const path of [roots.codex, roots.codeflicker]) await mkdir(path, { recursive: true });
  await writeFile(join(roots.codex, "bulk.jsonl"), line(bulk));
  for (let index = 0; index < 7; index++) await writeFile(join(roots.codex, `${index}.jsonl`), line([
    { type: "session_meta", payload: { id: `other-${index}`, cwd: "/workspace/other", title: `另一个会话 ${index}`, ...(index === 0 ? { source: { subagent: { thread_spawn: { parent_thread_id: "bulk", agent_path: "/root/synthetic-child" } } } } : {}) } }, reply(`other-u-${index}`, "user", "检索标记"), reply(`other-a-${index}`, "assistant", "已完成", { channel: "final" }),
  ]));
  await writeFile(join(roots.codeflicker, "failure.jsonl"), line([
    { type: "message", sessionId: "failure", uuid: "u", role: "user", content: "失败调用定位样本", timestamp: "2026-10-08T10:00:00Z", cwd: "/workspace/session-demo" },
    ...Array.from({ length: 12 }, (_, index) => [
      { type: "message", sessionId: "failure", uuid: `a-${index}`, role: "assistant", timestamp: new Date(Date.parse("2026-10-08T10:00:00Z") + index * 60_000).toISOString(), content: [{ type: "tool_use", id: `failure-call-${index}`, name: "read", input: { file_path: `/synthetic/missing-${index}.txt` } }] },
      { type: "message", sessionId: "failure", uuid: `r-${index}`, role: "user", content: [{ type: "tool_result", tool_use_id: `failure-call-${index}`, is_error: true, content: index === 0 ? "合成读取失败" : `合成读取失败 ${index + 1}` }] },
    ]).flat(),
    { type: "message", sessionId: "failure", uuid: "final", role: "assistant", content: "失败已核对", stop_reason: "end_turn" },
  ]));
  const home = join(directory, "data"); await mkdir(home); await writePreferences(home, "zh-CN");
  service = await startService({ home, port: 0, roots, resourceInventory: { environment: {} } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await (await fetch(`${base}/api/v1/sessions/status`)).json();
    if (state.version) break;
    if (state.job?.status === "failed") throw new Error("人工来源索引失败");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await browser(["open", `${base}/#sessions`, "--headed", "--browser=chrome"]);
  const verify = async page => {
    const ensure = (value, message) => { if (!value) throw new Error(message); };
    const button = name => page.getByRole("button", { name, exact: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: /^长会话验收 Codex/ }).click();
    await page.getByRole("heading", { name: "长会话验收", exact: true }).waitFor();
    await page.getByRole("button", { name: /^更多筛选/ }).click();
    const filters = page.getByRole("dialog", { name: "更多筛选", exact: true });
    ensure(await button("起始日期").isVisible() && await page.getByRole("checkbox", { name: "显示子 Agent 会话", exact: true }).isVisible(), "次级筛选缺失");
    await button("起始日期").click();
    await page.getByRole("dialog", { name: "起始日期日历", exact: true }).press("Escape");
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "起始日期");
    ensure(await filters.isVisible(), "日期 Escape 同时关闭更多筛选");
    await filters.press("Escape");
    await page.waitForFunction(() => document.activeElement?.classList.contains("session-more-filters"));
    ensure(await button("全部记录").isVisible() && await button("执行轨迹").isVisible() && await button("导出当前分支对话").isVisible(), "查看功能仍在更多菜单中");
    await page.locator(".session-profile .session-bar-row").filter({ hasText: "demo-model" }).waitFor();
    await page.locator(".session-profile .session-child").first().waitFor();
    ensure(await page.getByRole("heading", { name: "会话内容", exact: true }).isVisible(), "原有画像概览未恢复");
    const collapse = button("收起会话画像");
    const openedArrow = await collapse.locator("svg").innerHTML();
    const leftClosingArrow = await button("收起会话列表").locator("svg").innerHTML();
    ensure(openedArrow !== leftClosingArrow, "右栏收起箭头仍与左栏同向");
    await collapse.click(); await button("展开会话画像").waitFor();
    ensure(await button("展开会话画像").getAttribute("aria-expanded") === "false", "右栏未收起");
    ensure(await button("展开会话画像").locator("svg").innerHTML() === leftClosingArrow, "右栏展开箭头没有向左");
    await page.screenshot({ path: ARTIFACTS + "/right-collapsed.png" });
    await button("展开会话画像").click(); await button("收起会话画像").waitFor();
    await button("全部记录").click(); await page.locator('.session-mode-tabs button[aria-pressed="true"]').filter({ hasText: "全部记录" }).waitFor();
    await button("执行轨迹").click(); await page.locator(".trace-ledger").waitFor();
    await button("对话").click(); await button("复制代码").waitFor();
    await button("复制代码").click();
    await page.locator(".session-code-block [role='status']").filter({ hasText: "已复制" }).waitFor();
    ensure((await page.evaluate(() => navigator.clipboard.readText())).length === 24000, "代码复制被预览截断");
    await button("按问题跳转").click();
    await button("轮次导航下一页").click(); await button("轮次导航下一页").click();
    await button("第 110 轮 检索标记：合成问题 110").click();
    await page.getByText("未确认结束", { exact: true }).waitFor();
    ensure(await page.getByRole("spinbutton", { name: "跳转轮次" }).inputValue() === "110", "目录跳转丢失轮次");
    await button("复制本轮问答").last().click();
    await page.locator(".session-turn").last().locator("[role='status']").filter({ hasText: "已复制" }).waitFor();
    ensure((await page.evaluate(() => navigator.clipboard.readText())).includes("未确认结束"), "本轮复制丢失终态边界");
    await page.getByRole("tab", { name: "用量", exact: true }).click();
    ensure(await page.getByText("已记录 109 / 110 条", { exact: true }).isVisible(), "部分缓存范围未显示");
    ensure(await page.getByText("缓存读取占比", { exact: true }).count() === 0, "不完整缓存仍显示比例");
    ensure(await page.getByText("缓存写入 Token", { exact: true }).count() === 0, "空指标卡未隐藏");
    const download = page.waitForEvent("download"); await button("导出当前分支对话").click();
    await (await download).saveAs(ARTIFACTS + "/dialogue.md");
    await page.getByRole("textbox", { name: "搜索会话标题和消息", exact: true }).fill("检索标记");
    await page.locator(".session-search-group").first().waitFor();
    ensure(await page.locator(".session-search-group").count() === 8, "全局搜索未按会话去重");
    await button("展开全部命中").click(); await page.getByRole("button", { name: "当前会话命中下一页", exact: true }).waitFor();
    await button("筛选项目").click(); await page.getByRole("option", { name: "other /workspace/other", exact: true }).click();
    await page.getByText("当前会话不在筛选结果中", { exact: true }).waitFor();
    const readingScroll = await page.locator(".session-message-scroll").evaluate(element => element.scrollTop);
    await page.reload(); await page.getByText("当前会话不在筛选结果中", { exact: true }).waitFor();
    ensure(await page.getByRole("textbox", { name: "搜索会话标题和消息", exact: true }).inputValue() === "检索标记", "刷新丢失搜索");
    await page.getByText("未确认结束", { exact: true }).waitFor();
    await page.waitForFunction(expected => Math.abs(document.querySelector(".session-message-scroll").scrollTop - expected) <= 2, readingScroll);
    await page.goBack(); await page.getByRole("button", { name: "筛选项目", exact: true }).filter({ hasText: "全部项目" }).waitFor();
    await button("清除搜索").click(); await page.getByRole("tab", { name: "概览", exact: true }).click();
    const readingBounds = await page.locator(".session-message-scroll").boundingBox();
    await page.route("**/api/v1/sessions/*/timeline?*", route => route.fulfill({ status: 500, json: { error: { code: "FIXTURE_FAILED", message: "合成证据读取错误" } } }), { times: 1 });
    await button("3 条压缩记录").click();
    const compressionList = page.getByRole("dialog", { name: "压缩记录", exact: true });
    await compressionList.getByRole("alert").waitFor(); await compressionList.getByRole("button", { name: "重试", exact: true }).click();
    await compressionList.getByRole("button", { name: /^压缩 / }).first().waitFor();
    ensure(JSON.stringify(await page.locator(".session-message-scroll").boundingBox()) === JSON.stringify(readingBounds), "压缩列表挤占阅读区");
    ensure(await page.locator(".session-evidence-results").count() === 0, "旧证据块仍在阅读区");
    await page.screenshot({ path: ARTIFACTS + "/compression-popover.png" });
    await compressionList.press("Escape");
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "3 条压缩记录");
    await button("3 条压缩记录").click();
    await compressionList.getByRole("button", { name: /^压缩 / }).first().click();
    await compressionList.waitFor({ state: "hidden" });
    await page.locator(".trace-inspector").getByText("合成压缩摘要", { exact: true }).waitFor();
    await button("最大单次输入 · 210 Token").click(); await page.locator(".trace-inspector .trace-usage").getByText("210", { exact: true }).waitFor();
    await page.getByRole("button", { name: /^失败调用定位样本 CodeFlicker CLI/ }).click();
    await page.getByRole("heading", { name: "失败调用定位样本", exact: true }).waitFor();
    await page.waitForLoadState("networkidle");
    const failureReadingBounds = await page.locator(".session-message-scroll").boundingBox();
    await button("12 次失败调用").click();
    const failureList = page.getByRole("dialog", { name: "失败调用", exact: true });
    await failureList.getByText("/synthetic/missing-0.txt", { exact: true }).waitFor();
    ensure(await failureList.locator(".session-evidence-row").count() === 8, "第一页证据数量错误");
    await failureList.getByRole("button", { name: "失败调用下一页", exact: true }).click();
    await failureList.getByText("/synthetic/missing-8.txt", { exact: true }).waitFor();
    ensure(await failureList.locator(".session-evidence-row").count() === 4, "第二页证据数量错误");
    ensure(await failureList.getByText("/synthetic/missing-0.txt", { exact: true }).count() === 0, "证据分页残留上一页摘要");
    await page.screenshot({ path: ARTIFACTS + "/failure-page-2.png" });
    await failureList.getByRole("button", { name: "失败调用上一页", exact: true }).click();
    await failureList.getByText("/synthetic/missing-0.txt", { exact: true }).waitFor();
    ensure(JSON.stringify(await page.locator(".session-message-scroll").boundingBox()) === JSON.stringify(failureReadingBounds), "失败列表挤占阅读区");
    const listStyle = await failureList.evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
      nameSize: getComputedStyle(element.querySelector(".session-evidence-copy > span")).fontSize, timeSize: getComputedStyle(element.querySelector("time")).fontSize,
      scrolls: element.querySelector(".session-evidence-list").scrollHeight > element.querySelector(".session-evidence-list").clientHeight }));
    ensure(listStyle.width <= 300 && listStyle.height <= 360 && listStyle.scrolls, "证据浮层没有限制尺寸或内部滚动");
    ensure(listStyle.nameSize === "12px" && listStyle.timeSize === "10px", "名称或时间字号异常");
    await failureList.getByRole("button", { name: /^read / }).last().scrollIntoViewIfNeeded();
    ensure(await failureList.locator(".session-evidence-list").evaluate(element => element.scrollTop) > 0, "长证据列表不能滚动");
    await failureList.getByRole("button", { name: /^read / }).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: ARTIFACTS + "/failure-popover.png" });
    await failureList.getByRole("button", { name: /^read / }).first().focus(); await failureList.press("Escape");
    await page.waitForFunction(() => document.activeElement?.textContent === "12 次失败调用");
    await button("12 次失败调用").click(); await button("关闭失败调用").click();
    await button("12 次失败调用").click(); await page.getByRole("heading", { name: "失败调用定位样本", exact: true }).click();
    await failureList.waitFor({ state: "hidden" });
    await button("12 次失败调用").click(); await failureList.getByRole("button", { name: "失败调用下一页", exact: true }).click();
    await failureList.getByText("/synthetic/missing-8.txt", { exact: true }).waitFor();
    await failureList.getByRole("button", { name: /read \/synthetic\/missing-8.txt/ }).click();
    await failureList.waitFor({ state: "hidden" });
    await page.getByRole("tab", { name: "返回结果", exact: true }).click();
    await page.locator(".trace-inspector").getByText("合成读取失败 9", { exact: true }).waitFor();
    ensure(!(await page.locator(".trace-ledger").innerText()).includes("耗时未记录"), "执行表重复显示空耗时");
    await page.setViewportSize({ width: 390, height: 844 });
    await button("会话统计").click(); await button("12 次失败调用").click();
    await failureList.getByRole("button", { name: /^read / }).first().waitFor();
    await failureList.getByText("/synthetic/missing-0.txt", { exact: true }).waitFor();
    const mobileBounds = await failureList.boundingBox();
    ensure(mobileBounds.x >= 12 && mobileBounds.x + mobileBounds.width <= 378 && mobileBounds.y >= 12 && mobileBounds.y + mobileBounds.height <= 832, "窄屏证据浮层超出视口");
    await page.screenshot({ path: ARTIFACTS + "/mobile-evidence-popover.png" });
    await failureList.press("Escape");
    ensure(await page.locator(".sessions-shell").getAttribute("data-compact-panel") === "profile", "关闭证据浮层同时关闭统计侧栏");
    await button("12 次失败调用").press("Escape");
    await button("会话列表").click(); await page.getByRole("button", { name: /^更多筛选/ }).click(); await button("起始日期").click(); await button("今天").click();
    await button("起始日期").click(); await button("清空").click();
    await button("起始日期").click(); await button("起始日期").press("Escape");
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "起始日期");
    ensure(await filters.isVisible(), "窄屏日期关闭同时关闭了父筛选浮层");
    ensure(await page.locator(".sessions-shell").getAttribute("data-compact-panel") === "list", "窄屏日期关闭同时关闭了列表");
    await filters.press("Escape");
    await page.waitForFunction(() => document.activeElement?.classList.contains("session-more-filters"));
    await page.getByRole("combobox", { name: "筛选客户端", exact: true }).press("ArrowDown");
    await page.getByRole("option", { name: "Codex", exact: true }).press("Enter");
    await page.getByRole("combobox", { name: "筛选客户端", exact: true }).press("Escape"); await button("外观").click(); await page.getByRole("combobox", { name: "显示模式", exact: true }).click(); await page.getByRole("option", { name: "深色", exact: true }).click(); await page.getByRole("dialog", { name: "外观", exact: true }).press("Escape");
    await button("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
    await page.getByRole("button", { name: "Jump by question", exact: true }).waitFor();
    ensure(page.url().includes("client=codex"), "语言切换改变筛选");
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "窄屏出现页面水平溢出");
    await button("Session statistics").click(); await button("12 failed calls").click();
    const englishEvidence = page.getByRole("dialog", { name: "Failed calls", exact: true });
    await englishEvidence.getByRole("button", { name: /^read / }).first().waitFor();
    await englishEvidence.getByText("/synthetic/missing-0.txt", { exact: true }).waitFor();
    ensure(await englishEvidence.getByRole("button", { name: "Close Failed calls", exact: true }).isVisible(), "英文证据浮层关闭名称错误");
    await page.screenshot({ path: ARTIFACTS + "/mobile-dark-evidence-en.png" });
    await englishEvidence.press("Escape"); await button("12 failed calls").press("Escape");
    await button("Dialogue").click(); await page.locator(".session-turn").first().waitFor();
    await page.screenshot({ path: ARTIFACTS + "/mobile-dark-en.png" });
    await button("Display language").click(); await page.getByRole("menuitemradio", { name: "Simplified Chinese", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 720 }); await button("外观").click(); await page.getByRole("combobox", { name: "显示模式", exact: true }).click(); await page.getByRole("option", { name: "明亮", exact: true }).click(); await page.getByRole("dialog", { name: "外观", exact: true }).press("Escape");
    await page.getByRole("button", { name: /^长会话验收 Codex/ }).click();
    await button("对话").click(); await page.getByText("未确认结束", { exact: true }).waitFor();
    await page.screenshot({ path: ARTIFACTS + "/desktop.png" });
    return { advancedFilters: true, nestedDateEscape: true, evidencePreviewPagination: true, directModes: true, restoredProfile: true, panelToggle: true, directory: true, copy: true, groupedSearch: true, address: true, evidence: true, evidencePopover: true, evidenceSizing: listStyle, keyboard: true, dates: true, language: true, mobile: true };
  };
  const output = await browser(["run-code", verify.toString().replaceAll("ARTIFACTS", JSON.stringify(artifacts))]);
  await writeFile(join(artifacts, "report.txt"), output);
  const markdown = await readFile(join(artifacts, "dialogue.md"), "utf8");
  assert.equal((markdown.match(/^### 用户$/gm) ?? []).length, 110);
  assert.equal((markdown.match(/^### AI 回复/gm) ?? []).length, 110);
  assert.ok(markdown.includes("未确认结束") && markdown.includes("const synthetic = true;\n".repeat(1000)));
  assert.ok(!markdown.includes("合成压缩摘要") && !markdown.includes("pending-call"));
  console.log(output.split("### Ran Playwright code")[0]);
  console.log("浏览器验收通过：高级筛选及嵌套日期焦点、展开查看入口、原有画像与侧栏折叠、110 轮跨页导出、长代码、会话级搜索、状态恢复、三个证据入口、证据浮层位置与字号、滚动和关闭定位、日期、键盘、中英文及窄屏主题。");
} catch (failure) {
  try { await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]); await writeFile(join(artifacts, "failure.txt"), await browser(["snapshot"])); } catch { /* 浏览器已关闭时保留原始错误。 */ }
  throw failure;
} finally {
  try { await browser(["close"]); } catch { /* 测试失败也清理隔离后台。 */ }
  await service?.close(); await rm(directory, { recursive: true, force: true });
}
