import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { clientIds } from "../dist/clients.js";
import { startService } from "../dist/server.js";
import { writePreferences } from "../dist/service/preferences.js";
import { SessionStore } from "../dist/sessions/store.js";

// 只使用人工记录和隔离后台，不连接日常会话及偏好。
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "manor-round-metrics-"));
const home = join(directory, "data");
const artifacts = fileURLToPath(new URL("../.local/session-round-metrics-e2e/", import.meta.url));
const browserName = `round-metrics-${process.pid}`;
const browser = async args => {
  const result = await run("playwright-cli", [`-s=${browserName}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.stdout.includes("### Error")) throw new Error(result.stdout);
  return result.stdout;
};
const record = (ordinal, turnId, kind, text, extra = {}) => ({ id: `message-${ordinal}`, ordinal, recordLine: ordinal + 1, turnId, kind, text, ...extra });
const recordedAt = (seconds = 0, daysAgo = 10) => { const value = new Date(); value.setDate(value.getDate() - daysAgo); value.setHours(9, 0, seconds, 0); return value.toISOString(); };
let service;
try {
  await mkdir(artifacts, { recursive: true });
  await mkdir(home);
  await writePreferences(home, "zh-CN");
  const store = new SessionStore(join(home, "index.sqlite"));
  const source = (id, title, messages, usages, extra = {}) => {
    const path = `/workspace/history/${id}.jsonl`;
    const pending = store.createRevision(path, "synthetic");
    for (const message of messages) pending.sink.message({ sessionId: id, ...message });
    for (const usage of usages) pending.sink.usage(usage);
    pending.flush();
    store.finishRevision(pending.revision, { id, client: "codex", clientSessionId: id, sourceId: `codex:${id}`, path,
      title, titleOrigin: "recorded", models: [], messageCount: messages.length, turnCount: 0, gaps: [], ...extra });
    return { path, revision: pending.revision, fingerprint: "synthetic" };
  };
  const sources = [
    source("parent", "合成平均指标", [
      record(0, "first", "user", "修复 ", { occurredAt: recordedAt(0) }),
      record(1, "first", "user", "问题", { recordLine: 1 }),
      record(2, "first", "assistant", "完成", { final: "explicit", occurredAt: recordedAt(60) }),
      record(3, "second", "user", "检查", { occurredAt: recordedAt(120) }),
      record(4, "second", "assistant", "完成", { final: "explicit", occurredAt: recordedAt(240) }),
      record(5, "context", "user", "自动注入文字", { contextSource: "client" }),
      record(6, "copied", "user", "继承文字", { copied: true }),
    ], [{ id: "a", turnId: "first", model: "synthetic-model", inputTokens: 100, cachedInputTokens: 80, cacheWriteTokens: 0, outputTokens: 10 },
      { id: "b", turnId: "first", model: "synthetic-model", inputTokens: 200, cachedInputTokens: 160, cacheWriteTokens: 0, outputTokens: 20 },
      { id: "c", turnId: "second" }]),
    source("child", "合成子会话", [
      record(0, "first", "user", "子需求", { occurredAt: recordedAt(0) }),
      record(1, "first", "assistant", "完成", { final: "explicit", occurredAt: recordedAt(600) }),
    ], [{ id: "child-a", turnId: "first" }], { parentSessionId: "parent", relationship: "child" }),
    source("pending", "合成未结束", [record(0, "first", "user", "继续"), record(1, "first", "assistant", "处理中", { final: "inferred" })], []),
    source("trace", "合成轨迹估算", [
      record(0, "first", "user", "检查轨迹", { occurredAt: recordedAt(0, 1) }),
      record(1, "first", "reasoning", "先分析"),
      record(2, "first", "assistant", "开始处理"),
      record(3, "first", "context", "普通上下文"),
      record(4, "first", "assistant", "继续同一输出段"),
      record(5, "first", "context", "原生查看卡片", { operation: { type: "view", presentationComplete: true } }),
      record(6, "first", "context", "并行查看卡片", { operation: { type: "view", presentationComplete: true } }),
      record(7, "first", "reasoning", "读完再分析"),
      record(8, "first", "assistant", "准备验证"),
      record(9, "first", "tool_call", "验证", { callId: "synthetic-check", tool: "check" }),
      record(10, "first", "tool_result", "验证结果", { callId: "synthetic-check", tool: "check" }),
      record(11, "first", "assistant", "验证完成", { final: "explicit", occurredAt: recordedAt(60, 1) }),
      record(12, "second", "user", "再确认", { occurredAt: recordedAt(120, 1) }),
      record(13, "second", "reasoning", "复制的分析", { copied: true }),
      record(14, "second", "assistant", "已确认", { final: "explicit", occurredAt: recordedAt(240, 1) }),
    ], [], { client: "pi", sourceId: "doubao-work:trace" }),
    source("zero", "合成零值", [
      record(0, "first", "user", " \n", { occurredAt: recordedAt(0) }),
      record(1, "first", "assistant", "完成", { final: "explicit", occurredAt: recordedAt(0) }),
    ], [{ id: "zero-a", turnId: "first" }]),
  ];
  store.publish(store.createJob().id, sources, []);
  store.close();
  service = await startService({ home, port: 0, startupRefresh: false,
    roots: Object.fromEntries(clientIds.map(client => [client, join(directory, `empty-${client}`)])), resourceInventory: { environment: {} } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const own = await (await fetch(`${base}/api/v1/sessions/parent/profile?summary=true`)).json();
  const tree = await (await fetch(`${base}/api/v1/sessions/parent/profile?summary=true&includeChildren=true`)).json();
  assert.deepEqual(own.roundMetrics, { userTurns: 2, completedTurns: 2, stepTurns: 2, timedTurns: 2, promptInputs: 2,
    averageSteps: 1.5, averageDurationMs: 90_000, averagePromptCharacters: 3 });
  assert.deepEqual(tree.roundMetrics, own.roundMetrics);
  const trace = await (await fetch(`${base}/api/v1/sessions/trace/profile?summary=true`)).json();
  assert.equal(trace.roundMetrics.averageSteps, 2);
  assert.equal(trace.roundMetrics.estimatedStepTurns, 2);
  assert.equal(trace.usage.requests, 0);
  assert.equal(trace.usage.inputTokens, null);
  assert.equal(trace.usage.outputTokens, null);
  const review = await (await fetch(`${base}/api/v1/overview/review`)).json();
  assert.equal(review.rounds.steps.average, 2);
  assert.equal(review.rounds.steps.estimatedSamples, 2);

  await browser(["open", `${base}/#sessions`, "--headed", "--browser=chrome"]);
  const verify = async page => {
    const checks = [];
    const ensure = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
    const button = name => page.getByRole("button", { name, exact: true });
    const row = label => page.locator(".session-profile .session-usage-grid.compact > div").filter({ has: page.getByText(label, { exact: true }) }).locator("strong");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: /^合成平均指标 Codex/ }).click();
    await row("平均模型步骤").waitFor();
    ensure(await row("平均模型步骤").innerText() === "1.5", "平均步骤为 1.5");
    ensure(await row("平均轮次耗时").innerText() === "1.5分钟", "平均轮次耗时为 1.5 分钟");
    ensure(await row("平均提示词字数").innerText() === "3", "分块与注入排除后平均字数为 3");
    await page.getByText("缓存读取占比（已记录）", { exact: true }).waitFor();
    ensure((await page.locator(".session-cache-ratio").innerText()).includes("80.0%"), "部分覆盖仍显示合格记录缓存比例");
    ensure(await page.locator(".session-usage-coverage, .session-cost-coverage").count() === 0, "概览不显示覆盖计数和费用小字");
    ensure(await page.getByText("总输入 Token 小计", { exact: true }).isVisible(), "部分输入通过字段名保留小计含义");
    await page.getByRole("tab", { name: "用量", exact: true }).click();
    await page.locator(".session-step-table tbody tr").first().waitFor();
    ensure(await page.locator(".session-request-range, .session-usage-coverage, .session-cost-coverage").count() === 0, "用量页不显示重复请求范围和覆盖小字");
    await page.getByRole("tab", { name: "概览", exact: true }).click();
    await button("统计口径").click();
    const usageHelp = page.getByRole("dialog", { name: "统计口径", exact: true });
    await usageHelp.waitFor();
    ensure((await usageHelp.innerText()).includes("已记录 2 / 3 条") && (await usageHelp.innerText()).includes("未定价 3"), "覆盖与费用计数移入统计帮助");
    await usageHelp.press("Escape");
    await button("轮次与提示词统计口径").click();
    const help = page.getByRole("dialog", { name: "轮次与提示词统计口径", exact: true });
    await help.waitFor();
    ensure((await help.innerText()).includes("用户轮次 2，有回复 2") && (await help.innerText()).includes("2 次真实用户输入"), "帮助提供同一统计范围的样本数");
    await help.press("Escape");
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "轮次与提示词统计口径");
    ensure(await button("轮次与提示词统计口径").evaluate(element => element === document.activeElement), "关闭帮助恢复焦点");
    await button("包含子会话").click();
    await page.waitForFunction(() => document.querySelector('.session-profile-scope button[aria-pressed="true"]')?.textContent === "包含子会话");
    await page.waitForLoadState("networkidle");
    ensure(await row("平均模型步骤").innerText() === "1.5" && await row("平均轮次耗时").innerText() === "1.5分钟", "包含子会话不改变自身轮次平均值");
    await page.screenshot({ path: ARTIFACTS + "/desktop-zh.png" });
    await page.locator(".session-profile .session-child").filter({ hasText: "合成子会话" }).click();
    await page.getByRole("heading", { name: "合成子会话", exact: true }).waitFor();
    await page.waitForLoadState("networkidle");
    ensure(await row("平均模型步骤").innerText() === "1" && await row("平均轮次耗时").innerText() === "10分钟", "子会话显示自身平均值");
    await page.getByRole("button", { name: /^合成未结束 Codex/ }).click();
    await page.getByRole("heading", { name: "合成未结束", exact: true }).waitFor();
    await page.waitForLoadState("networkidle");
    ensure(await row("平均模型步骤").innerText() === "≈ 1" && await row("平均轮次耗时").innerText() === "—" && await row("平均提示词字数").innerText() === "2", "无请求的已保存回复估算一步且未知耗时保留空值");
    await page.getByRole("button", { name: /^合成轨迹估算 Pi/ }).click();
    await page.getByRole("heading", { name: "合成轨迹估算", exact: true }).waitFor();
    await page.waitForLoadState("networkidle");
    ensure(await row("平均模型步骤").innerText() === "≈ 2", "连续输出合并且原生操作和工具分隔后按两轮均值估算");
    ensure(await row("平均轮次耗时").innerText() === "1.5分钟", "轨迹估算不改变明确消息的轮次耗时");
    ensure(await page.getByRole("tab", { name: "用量", exact: true }).count() === 0, "轨迹估算不制造请求用量页签");
    await button("轮次与提示词统计口径").click(); await help.waitFor();
    ensure((await help.innerText()).includes("2 轮按执行轨迹估算") && (await help.innerText()).includes("不等于完整 API 请求数"), "中文帮助披露轨迹样本与 API 边界");
    await help.press("Escape");
    await page.getByRole("button", { name: /^合成零值 Codex/ }).click();
    await page.getByRole("heading", { name: "合成零值", exact: true }).waitFor();
    await page.waitForLoadState("networkidle");
    ensure(await row("平均轮次耗时").innerText() === "0秒" && await row("平均提示词字数").innerText() === "0", "真实零时长与字数保留");
    await page.getByRole("button", { name: /^合成平均指标 Codex/ }).click();
    await page.getByRole("heading", { name: "合成平均指标", exact: true }).waitFor();
    await page.waitForLoadState("networkidle");
    await button("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
    await row("Avg. model steps").waitFor();
    ensure(await row("Avg. model steps").innerText() === "1.5" && await row("Avg. turn duration").innerText() === "1.5 min" && await row("Avg. prompt characters").innerText() === "3", "英文标签和单位正确且数值保持");
    await button("Turn and prompt statistics").click();
    const englishHelp = page.getByRole("dialog", { name: "Turn and prompt statistics", exact: true });
    await englishHelp.waitFor();
    ensure((await englishHelp.innerText()).includes("User turns: 2"), "英文帮助提供样本");
    await englishHelp.press("Escape");
    await page.getByRole("button", { name: /^合成轨迹估算 Pi/ }).click();
    await page.getByRole("heading", { name: "合成轨迹估算", exact: true }).waitFor();
    await page.waitForLoadState("networkidle");
    ensure(await row("Avg. model steps").innerText() === "≈ 2", "英文轨迹估算保持相同数值与估算标识");
    await button("Turn and prompt statistics").click(); await englishHelp.waitFor();
    ensure((await englishHelp.innerText()).includes("2 turns use execution-trace estimates") && (await englishHelp.innerText()).includes("not the full API request count"), "英文帮助披露轨迹估算来源");
    await englishHelp.press("Escape");
    await button("Appearance").click(); await page.getByRole("combobox", { name: "Display mode", exact: true }).click();
    await page.getByRole("option", { name: "Dark", exact: true }).click(); await page.getByRole("dialog", { name: "Appearance", exact: true }).press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await button("Session statistics").click();
    await row("Avg. model steps").waitFor();
    ensure(await row("Avg. prompt characters").isVisible() && await row("Avg. model steps").innerText() === "≈ 2", "窄屏画像显示轨迹估算和其他指标");
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "窄屏没有页面横向溢出");
    await button("Turn and prompt statistics").click(); await englishHelp.waitFor();
    ensure(await englishHelp.evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight; }), "窄屏帮助位于视口内");
    await page.screenshot({ path: ARTIFACTS + "/mobile-dark-en.png" });
    await englishHelp.press("Escape");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(page.url().split("#")[0] + "#overview");
    await page.locator(".weekly-review[aria-busy='false'] .weekly-review-groups").waitFor();
    const weeklySteps = page.locator(".weekly-review-metric").filter({ has: page.getByText("Average model steps", { exact: true }) });
    ensure(await weeklySteps.locator("strong").innerText() === "≈ 2", "七天复盘步骤均值独立按轨迹估算样本标约数");
    await weeklySteps.click();
    await page.locator(".weekly-review-dialog .overview-investigation-body[aria-busy='false']").waitFor();
    const stepCells = await page.locator(".weekly-review-records tbody tr td:nth-child(3)").allTextContents();
    ensure(stepCells.length === 2 && stepCells.every(value => /^≈ [13]$/.test(value)), "七天逐轮步骤保留轨迹估算标识");
    ensure((await page.locator(".weekly-review-summary").innerText()).includes("≈ 2"), "七天步骤明细摘要保留估算标识");
    await button("Statistics").click();
    const distribution = page.locator(".weekly-review-distribution tbody tr").filter({ has: page.getByText("Model steps", { exact: true }) });
    const distributionCells = await distribution.locator("td").allTextContents();
    ensure(distributionCells.slice(1, 5).every(value => value.startsWith("≈ ")) && distributionCells[5] === "2", "七天步骤均值中位P90最大值标估算，样本数保持精确");
    await page.locator(".weekly-review-dialog").getByRole("button", { name: "Insight definitions", exact: true }).click();
    const weeklyHelp = page.getByRole("dialog", { name: "Insight definitions", exact: true }); await weeklyHelp.waitFor();
    ensure((await weeklyHelp.innerText()).includes("2 step samples use execution-trace estimates"), "七天复盘帮助显示独立估算样本");
    await weeklyHelp.press("Escape"); await page.keyboard.press("Escape");
    await button("Display language").click(); await page.getByRole("menuitemradio", { name: "Simplified Chinese", exact: true }).click();
    const chineseWeeklySteps = page.locator(".weekly-review-metric").filter({ has: page.getByText("平均模型步骤", { exact: true }) });
    await chineseWeeklySteps.waitFor();
    ensure(await chineseWeeklySteps.locator("strong").innerText() === "≈ 2", "七天复盘中文保持估算标识与同一数值");
    await chineseWeeklySteps.click(); await page.locator(".weekly-review-dialog .overview-investigation-body[aria-busy='false']").waitFor();
    await page.locator(".weekly-review-dialog").getByRole("button", { name: "洞察口径", exact: true }).click();
    const chineseWeeklyHelp = page.getByRole("dialog", { name: "洞察口径", exact: true }); await chineseWeeklyHelp.waitFor();
    ensure((await chineseWeeklyHelp.innerText()).includes("2 个步骤样本按执行轨迹估算"), "七天复盘中文帮助解释轨迹来源");
    await page.screenshot({ path: ARTIFACTS + "/weekly-trace-zh.png" });
    await chineseWeeklyHelp.press("Escape"); await page.keyboard.press("Escape");
    return { checks, count: checks.length };
  };
  const output = await browser(["run-code", verify.toString().replaceAll("ARTIFACTS", JSON.stringify(artifacts))]);
  await writeFile(join(artifacts, "report.txt"), output);
  console.log(output.split("### Ran Playwright code")[0]);
  console.log("单会话平均指标浏览器验收通过。");
} catch (failure) {
  try { await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]); await writeFile(join(artifacts, "failure.txt"), await browser(["snapshot"])); } catch { /* 保留原始测试错误。 */ }
  throw failure;
} finally {
  try { await browser(["close"]); } catch { /* 失败也清理独立浏览器。 */ }
  await service?.close();
  await rm(directory, { recursive: true, force: true });
}
