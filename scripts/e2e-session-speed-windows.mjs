import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { zstdCompressSync } from "node:zlib";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";
import { summarizeRequestSpeed } from "../dist/session-speed.js";
import { SessionStore } from "../dist/sessions/store.js";
import { writePreferences } from "../dist/service/preferences.js";

// 全部来源和身份均为合成数据；服务、根目录与 Chrome session 独立于用户正在使用的实例。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-speed-windows-e2e-")));
const artifacts = fileURLToPath(new URL("../.local/session-output-speed-windows-e2e/", import.meta.url));
const browserName = `speed-windows-${process.pid}`;
const epoch = Date.UTC(2026, 0, 1);
const at = seconds => new Date(epoch + seconds * 1000).toISOString();
const encode = records => records.map(record => JSON.stringify(record)).join("\n") + "\n";
const roots = Object.fromEntries(clientIds.map(client => [client, []]));
const nativeFixtures = [
  { client: "dsh", id: "synthetic-speed-dsh-window", title: "DSH 输出阶段验收", name: "session.v4.jsonl.zstd", records: [
    { type: "session", version: 4, id: "synthetic-speed-dsh-window", cwd: "/synthetic/repo" },
    { type: "user/message", seq: 1, time: epoch, data: { turn: 1, message: { source: { kind: "user" }, content: [{ type: "text", text: "DSH 输出阶段验收" }] } } },
    { type: "assistant/message", seq: 2, time: epoch + 15_100, data: { turn: 1, step: 1,
      message: { source: { kind: "model", model: "synthetic-model" }, content: [{ type: "reasoning", text: "合成流式思考" }, { type: "text", text: "合成输出阶段回答" }] },
      usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 600 }, stream: [
        { type: "reasoning-chunks", index: 0, time0: epoch + 5000, dt: [0], texts: ["合成流式思考"] },
        { type: "text-chunks", index: 1, time0: epoch + 8000, dt: [0], texts: ["合成输出阶段回答"] },
        { type: "chunk", time: epoch + 15_000, chunk: { type: "finish", reason: { kind: "stop" }, replayState: { response: { responseId: "synthetic-dsh-response" } } } },
      ] } },
    { type: "turn/end", seq: 3, time: epoch + 15_200, data: { turn: 1, reason: { kind: "completed" } } },
  ], output: 600, duration: 10_000, speed: 60, window: "generation", basis: "recorded" },
  { client: "pi", id: "synthetic-speed-pi-window", title: "Pi 响应区间验收", name: "pi-speed-window.jsonl", records: [
    { type: "session", version: 3, id: "synthetic-speed-pi-window", cwd: "/synthetic/repo", timestamp: at(100) },
    { type: "message", id: "pi-user", parentId: null, timestamp: at(100), message: { role: "user", content: "Pi 响应区间验收", timestamp: epoch + 100_000 } },
    { type: "message", id: "pi-answer", parentId: "pi-user", timestamp: at(115), message: { role: "assistant", model: "synthetic-model",
      responseId: "synthetic-pi-response", timestamp: epoch + 105_000, stopReason: "stop", usage: { input: 100, output: 400, cacheRead: 0, cacheWrite: 0 },
      content: [{ type: "thinking", thinking: "合成历史思考" }, { type: "text", text: "合成响应区间回答" }] } },
  ], output: 400, duration: 10_000, speed: 40, window: "response", basis: "estimated" },
];

function indexMixedFixture(store, path) {
  const id = "codex:synthetic-speed-mixed-windows";
  const pending = store.createRevision(path, "synthetic-mixed-windows");
  const turnId = `${id}:turn:1`;
  const messages = [
    { kind: "user", text: "混合区间速度验收", seconds: 200 },
    { kind: "thinking", text: "合成响应区间思考", seconds: 209 },
    { kind: "assistant", text: "合成响应区间回答", seconds: 210 },
    { kind: "thinking", text: "合成输出阶段思考", seconds: 229 },
    { kind: "assistant", text: "合成输出阶段回答", seconds: 230 },
  ].map((item, index) => ({ id: `${id}:message:${index + 1}`, sessionId: id, turnId, ordinal: index + 1, recordLine: index + 1,
    kind: item.kind, text: item.text, occurredAt: at(item.seconds), model: item.kind === "user" ? undefined : "synthetic-model",
    final: item.kind === "assistant" ? "explicit" : undefined }));
  for (const message of messages) pending.sink.message(message);
  for (const [index, window, output, basis, start] of [[2, "response", 400, "estimated", 200], [4, "generation", 600, "recorded", 220]]) {
    const answer = messages[index];
    pending.sink.usage({ id: `${id}:request:${window}`, messageId: answer.id, requestMessageIds: [messages[index - 1].id, answer.id], turnId,
      model: "synthetic-model", inputTokens: 100, outputTokens: output, occurredAt: answer.occurredAt,
      timing: { basis, window, method: window === "response" ? "codex_event_boundary" : "dsh_stream_window", completion: "explicit",
        completionEvidence: window === "response" ? "final_response_snapshot" : "stream_finish", durationMs: 10_000,
        start: { occurredAt: at(start), recordLine: window === "response" ? 1 : 4 }, end: { occurredAt: answer.occurredAt, recordLine: answer.recordLine, messageId: answer.id } } });
  }
  pending.flush();
  store.finishRevision(pending.revision, { id, client: "codex", clientSessionId: "synthetic-speed-mixed-windows", title: "混合区间速度验收", titleOrigin: "recorded",
    path, sourceId: "synthetic-mixed-windows", messageCount: messages.length, turnCount: 1, models: ["synthetic-model"], gaps: [] });
  return { id, path, revision: pending.revision, fingerprint: "synthetic-mixed-windows" };
}

const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${browserName}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
let service;
let opened = false;
try {
  await mkdir(artifacts, { recursive: true });
  for (const fixture of nativeFixtures) {
    roots[fixture.client] = join(directory, fixture.client);
    await mkdir(roots[fixture.client]);
    const content = Buffer.from(encode(fixture.records));
    await writeFile(join(roots[fixture.client], fixture.name), fixture.client === "dsh" ? zstdCompressSync(content) : content);
  }
  const home = join(directory, "data");
  await mkdir(home); await writePreferences(home, "zh-CN");
  service = await startService({ home, port: 0, roots, resourceInventory: { environment: {}, userHome: join(directory, "isolated-user") } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const api = async path => { const response = await fetch(`${base}/api/v1${path}`); assert.ok(response.ok, `HTTP ${response.status}: ${path}`); return response.json(); };
  let status;
  for (let attempt = 0; attempt < 400; attempt++) {
    status = await api("/sessions/status");
    if (status.job?.status === "failed") throw new Error(status.job.error);
    if (status.version) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(status.version, "合成历史未发布索引");
  const list = await api("/sessions?includeSubagents=true");
  const targets = [];
  const apiChecks = [];
  for (const fixture of nativeFixtures) {
    const session = list.sessions.find(item => item.clientSessionId === fixture.id);
    assert.ok(session, `未导入合成 ${fixture.client} 来源`);
    const profile = await api(`/sessions/${encodeURIComponent(session.id)}/profile`);
    assert.equal(profile.steps.length, 1);
    const request = profile.steps[0];
    assert.equal(request.outputTokens, fixture.output); assert.equal(request.timing.durationMs, fixture.duration);
    assert.equal(request.timing.window, fixture.window); assert.equal(request.timing.basis, fixture.basis);
    assert.equal(profile.outputSpeed.tokensPerSecond, fixture.speed);
    assert.deepEqual(profile.outputSpeed, summarizeRequestSpeed(profile.steps));
    targets.push({ id: session.id, title: fixture.title, client: fixture.client });
    apiChecks.push({ client: fixture.client, output: fixture.output, durationMs: fixture.duration, speed: fixture.speed, window: fixture.window, basis: fixture.basis });
  }
  const store = new SessionStore(join(home, "index.sqlite"));
  let mixed;
  try { const existing = store.cachedRevisions(); mixed = indexMixedFixture(store, join(directory, "mixed-ui.jsonl")); store.publish(store.createJob().id, [...existing, mixed], []); }
  finally { store.close(); }
  const mixedProfile = await api(`/sessions/${encodeURIComponent(mixed.id)}/profile`);
  assert.equal(mixedProfile.outputSpeed.tokensPerSecond, null, "混合区间不形成单一平均");
  assert.equal(mixedProfile.outputSpeed.byWindow.response.tokensPerSecond, 40);
  assert.equal(mixedProfile.outputSpeed.byWindow.generation.tokensPerSecond, 60);
  await writeFile(join(artifacts, "api-report.json"), JSON.stringify({ native: apiChecks, mixed: mixedProfile.outputSpeed }, null, 2) + "\n");
  if (!process.argv.includes("--api-only")) {
    await browser(["open", `${base}/#sessions?id=${encodeURIComponent(targets[0].id)}&mode=brief`, "--headed", "--browser=chrome"]); opened = true;
    const verifyWindows = async page => {
      page.setDefaultTimeout(15_000);
      const checks = [], errors = [];
      const ensure = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
      const button = name => page.getByRole("button", { name, exact: true });
      const details = page.getByRole("dialog", { name: /^(请求速度详情|Request speed details)$/ });
      const openDetails = async target => { await target.locator(".session-speed-badge").click(); await details.waitFor(); };
      page.on("pageerror", error => errors.push(error.message));
      await page.setViewportSize({ width: 1440, height: 900 });
      const profile = page.locator(".session-profile");
      const fixtures = [...TARGETS, { id: MIXED_ID, title: "混合区间速度验收", client: "mixed" }];
      for (const fixture of fixtures) {
        await page.goto(BASE + "/#sessions?id=" + encodeURIComponent(fixture.id) + "&mode=brief");
        await page.getByRole("heading", { name: fixture.title, exact: true }).waitFor(); await page.waitForLoadState("networkidle");
        const recorded = fixture.client === "dsh", mixed = fixture.client === "mixed";
        const average = recorded ? "输出阶段平均 60 tok/s" : "平均 ≈ 40 tok/s";
        const request = recorded ? "输出阶段 60 tok/s" : "请求 ≈ 40 tok/s";
        const formula = recorded ? "600 Token ÷ 10.0 秒 = 60 tok/s" : "400 Token ÷ 10.0 秒 ≈ 40 tok/s";
        const turn = page.locator(".session-turn").first();
        await turn.locator("summary .session-speed-badge").filter({ hasText: average }).waitFor();
        ensure(await turn.locator("summary .session-speed-badge").count() === (mixed ? 2 : 1), `${fixture.client} 对话平均按计时区间分组`);
        if (mixed) ensure((await turn.locator("summary").innerText()).includes("输出阶段平均 60 tok/s") && !(await turn.locator("summary").innerText()).includes("50 tok/s"), "混合对话保留两个平均且没有50tok/s混合值");
        await turn.locator(".kind-assistant .session-speed-badge").filter({ hasText: request }).waitFor();
        const averageText = await turn.locator("summary .session-speed-badge").filter({ hasText: average }).innerText();
        ensure(recorded ? !averageText.includes("≈") : averageText.includes("≈"), `${fixture.client} 对话记录与估算标记正确`);
        await button("全部记录").click(); await page.waitForLoadState("networkidle");
        await turn.locator(".kind-thinking .session-speed-badge").filter({ hasText: request }).waitFor();
        ensure(await turn.locator("summary .session-speed-badge").count() === (mixed ? 2 : 1), `${fixture.client} 全部记录保留同请求思考和分组平均`);
        await button("执行轨迹").click(); await page.waitForLoadState("networkidle");
        ensure(await page.locator(".trace-columns").getByRole("columnheader", { name: "速度", exact: true }).count() === 1, `${fixture.client} 执行轨迹速度列可见`);
        await button("折叠全部").click(); await page.waitForFunction(() => document.querySelectorAll(".trace-row").length === 0);
        ensure(await page.locator(".trace-group .session-speed-badge").count() === (mixed ? 2 : 1), `${fixture.client} 折叠轨迹保留计时区间平均`);
        await button("展开全部").click(); await page.locator(".trace-row.kind-assistant").first().getByRole("button", { name: /^查看记录 \d+：AI$/ }).click();
        const inspector = page.locator(".trace-inspector");
        ensure(await inspector.locator("header .session-speed-badge").innerText() === request, `${fixture.client} 轨迹详情显示请求所属区间`);
        await openDetails(inspector.locator("header"));
        ensure(await details.locator(".session-speed-formula").innerText() === formula, `${fixture.client} 单请求算式使用正确等号或近似号`);
        const detailsText = await details.locator(".session-speed-details").innerText();
        ensure(detailsText.includes(recorded ? "首个流输出片段至结束，不包含首字等待" : "请求或历史起始边界至结束，包含首字等待"), `${fixture.client} 详情解释统计区间`);
        if (recorded) ensure(detailsText.includes("客户端记录计时，不代表服务端逐 Token 计时"), "DSH 说明客户端记录计时的边界");
        await details.press("Escape");
        await page.getByRole("tab", { name: "用量", exact: true }).click();
        await profile.locator(".session-speed-metric strong").filter({ hasText: recorded ? "60 tok/s" : "≈ 40 tok/s" }).waitFor();
        ensure(await profile.locator(".session-speed-metric strong").count() === (mixed ? 2 : 1), `${fixture.client} 右侧用量平均不混合区间`);
        const rows = profile.locator(".session-step-table tbody tr");
        ensure(await rows.count() === (mixed ? 2 : 1), `${fixture.client} 请求明细保持原生请求数量`);
        await openDetails(rows.first());
        ensure(await details.locator(".session-speed-formula").innerText() === formula, `${fixture.client} 右侧公式与轨迹详情一致`); await details.press("Escape");
        if (mixed) {
          await openDetails(rows.nth(1));
          ensure(await details.locator(".session-speed-formula").innerText() === "600 Token ÷ 10.0 秒 = 60 tok/s", "混合用量独立保留记录计时算式"); await details.press("Escape");
          ensure(!(await profile.locator(".session-speed-metric").first().innerText()).includes("50 tok/s"), "右侧没有混合单一平均");
        }
        await button("统计口径").click(); const help = page.getByRole("dialog", { name: "统计口径", exact: true }); await help.waitFor();
        const text = await help.innerText(); ensure(text.includes("响应区间和输出阶段分别汇总") && text.includes("客户端记录计时与历史估算分别标注"), `${fixture.client} 统一帮助解释区间和计时来源`);
        await help.press("Escape");
        ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${fixture.client} 中文桌面页面没有横向溢出`);
        await page.screenshot({ path: ARTIFACTS + "/" + fixture.client + "-windows-desktop.png" });
      }
      const saved = page.waitForResponse(response => response.url().endsWith("/api/v1/preferences") && response.request().method() === "PUT");
      await button("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click(); await saved;
      await page.waitForLoadState("networkidle");
      ensure((await profile.locator(".session-speed-metric").allTextContents()).join(" ").includes("≈ 40 tok/sAverage response speed") && (await profile.locator(".session-speed-metric").allTextContents()).join(" ").includes("60 tok/sAverage generation speed"), "英文保留两个分组平均");
      for (const [index, formula] of [[0, "400 tokens ÷ 10.0 seconds ≈ 40 tok/s"], [1, "600 tokens ÷ 10.0 seconds = 60 tok/s"]]) {
        await openDetails(profile.locator(".session-step-table tbody tr").nth(index));
        ensure(await details.locator(".session-speed-formula").innerText() === formula, "英文请求算式分别使用近似号与等号"); await details.press("Escape");
      }
      await button("Statistics methodology").click(); const englishHelp = page.getByRole("dialog", { name: "Statistics methodology", exact: true }); await englishHelp.waitFor();
      ensure((await englishHelp.innerText()).includes("Response and output-phase intervals are averaged separately"), "英文算法帮助明确分组汇总"); await englishHelp.press("Escape");
      await page.screenshot({ path: ARTIFACTS + "/mixed-windows-english-desktop.png" });
      const context = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      try {
        const mobile = await context.newPage(); mobile.setDefaultTimeout(15_000); mobile.on("pageerror", error => errors.push(error.message));
        await mobile.goto(BASE + "/#sessions?id=" + encodeURIComponent(MIXED_ID) + "&mode=brief");
        await mobile.getByRole("heading", { name: "混合区间速度验收", exact: true }).waitFor(); await mobile.waitForLoadState("networkidle");
        ensure((await mobile.locator(".session-turn summary").first().innerText()).includes("Output phase average 60 tok/s"), "英文触摸窄屏保留混合轮次区间标记");
        ensure(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "英文390px对话页面没有横向溢出");
        await mobile.getByRole("button", { name: "Execution trace", exact: true }).tap(); await mobile.waitForLoadState("networkidle");
        ensure(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "英文390px执行轨迹页面没有横向溢出");
        await mobile.getByRole("button", { name: "Session statistics", exact: true }).tap(); await mobile.getByRole("tab", { name: "Usage", exact: true }).tap();
        const mobileProfile = mobile.locator(".session-profile");
        ensure((await mobileProfile.locator(".session-speed-metric").allTextContents()).join(" ").includes("≈ 40 tok/sAverage response speed") && (await mobileProfile.locator(".session-speed-metric").allTextContents()).join(" ").includes("60 tok/sAverage generation speed"), "英文窄屏用量保持两个平均");
        await mobileProfile.locator("tbody tr").nth(1).locator(".session-speed-badge").tap();
        const mobileDetails = mobile.getByRole("dialog", { name: "Request speed details", exact: true }); await mobileDetails.waitFor();
        ensure((await mobileDetails.locator(".session-speed-details").innerText()).includes("Measured by the client; does not represent server-side per-token timing"), "英文窄屏详情显示客户端计时说明");
        ensure(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "英文390px用量详情页面没有横向溢出");

        await mobile.screenshot({ path: ARTIFACTS + "/mixed-windows-english-mobile.png" });
      } finally { await context.close(); }
      ensure(errors.length === 0, "原生区间和混合区间 Chrome 无运行时异常");
      return { checks, checkCount: checks.length, nativeImported: ["dsh", "pi"], directIndexMixedFixture: true, widths: [1440, 390], languages: ["zh-CN", "en"], errors };
    };
    const output = await browser(["run-code", verifyWindows.toString().replaceAll("TARGETS", JSON.stringify(targets)).replaceAll("MIXED_ID", JSON.stringify(mixed.id)).replaceAll("BASE", JSON.stringify(base)).replaceAll("ARTIFACTS", JSON.stringify(artifacts))]);
    await writeFile(join(artifacts, "browser-report.txt"), output);
    console.log(output.split("### Ran Playwright code")[0]);
  }
  assert.equal(JSON.parse(await readFile(join(artifacts, "api-report.json"), "utf8")).native.length, 2);
  console.log(process.argv.includes("--api-only") ? "原生 DSH/Pi 与混合区间 API 验收通过；浏览器未执行。" : "原生 DSH/Pi、混合区间四视图与英文窄屏 Chrome 验收通过。");
} catch (failure) {
  if (opened) try { await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]); await writeFile(join(artifacts, "failure-state.txt"), await browser(["snapshot"])); } catch { /* 保留原始失败。 */ }
  throw failure;
} finally {
  if (opened) try { await browser(["close"]); } catch { /* 清理隔离浏览器失败不阻断服务关闭。 */ }
  await service?.close(); await rm(directory, { recursive: true, force: true });
}
