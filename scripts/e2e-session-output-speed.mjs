import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";
import { summarizeRequestSpeed } from "../dist/session-speed.js";
import { SessionStore } from "../dist/sessions/store.js";
import { writePreferences } from "../dist/service/preferences.js";
import { sessionSpeedFixture, indexSpeedBranchFixture, indexLegacySpeedFixture } from "./session-speed-fixture.mjs";
import { encodeSession } from "./session-fixture.mjs";

// 仅合成来源、独立服务与独立浏览器；--api-only 供界面集成前核验验收数据。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-speed-e2e-")));
const artifacts = fileURLToPath(new URL("../.local/session-output-speed-e2e/", import.meta.url));
const browserName = `speed-${process.pid}`;
async function activateDisclosure(page, locator, name, action = "click") {
  // Chrome 原生折叠控件使用 DisclosureTriangle；绑定实际操作节点核对角色与名称。
  const client = await page.context().newCDPSession(page);
  let objectId;
  try {
    await locator.evaluate(element => { globalThis.__speedDisclosureTarget = element; });
    const target = await client.send("Runtime.evaluate", { expression: "globalThis.__speedDisclosureTarget" });
    objectId = target.result.objectId;
    const tree = await client.send("Accessibility.getPartialAXTree", { objectId, fetchRelatives: false });
    const node = tree.nodes[0];
    if (node?.ignored || node?.role?.value !== "DisclosureTriangle" || node?.name?.value !== name) {
      throw new Error(`原生折叠控件的角色或可访问名称不符：${node?.role?.value} / ${node?.name?.value}`);
    }
  } finally {
    await client.send("Runtime.evaluate", { expression: "delete globalThis.__speedDisclosureTarget" });
    if (objectId) await client.send("Runtime.releaseObject", { objectId });
    await client.detach();
  }
  await locator[action]();
}
const browser = async args => {
  if (args[0] === "run-code") args[1] = args[1].replaceAll("DISCLOSURE_CONTROL", activateDisclosure.toString());
  const { stdout } = await run("playwright-cli", [`-s=${browserName}`, ...args], {
    cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
const roots = Object.fromEntries(clientIds.map(client => [client, []]));
const fixture = sessionSpeedFixture();
let service;
let opened = false;
try {
  await mkdir(artifacts, { recursive: true });
  for (const source of fixture.files) {
    roots[source.client] = join(directory, source.client);
    await mkdir(roots[source.client], { recursive: true });
    await writeFile(join(roots[source.client], source.name), encodeSession(source.records));
  }
  const home = join(directory, "data");
  await mkdir(home); await writePreferences(home, "zh-CN");
  service = await startService({ home, port: 0, roots, resourceInventory: { environment: {}, userHome: join(directory, "isolated-user") } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const api = async path => {
    const response = await fetch(`${base}/api/v1${path}`);
    assert.ok(response.ok, `HTTP ${response.status}: ${path}`);
    return response.json();
  };
  let status;
  for (let attempt = 0; attempt < 400; attempt++) {
    status = await api("/sessions/status");
    if (status.job?.status === "failed") throw new Error(status.job.error);
    if (status.version) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(status.version, "合成历史未能发布索引");
  const list = await api("/sessions?includeSubagents=true");
  const profiles = [];
  let codexEnd;
  for (const source of fixture.files) {
    const session = list.sessions.find(item => item.clientSessionId === source.id);
    assert.ok(session, `未发现 ${source.id}`);
    const profile = await api(`/sessions/${encodeURIComponent(session.id)}/profile`);
    const speed = summarizeRequestSpeed(profile.steps);
    assert.deepEqual(speed, source.expected, `${source.client} 请求速度与覆盖`);
    assert.deepEqual(profile.outputSpeed, source.expected, `${source.client} Profile 汇总与全部请求一致`);
    if (source.client === "codex" && source.name === "speed.jsonl") {
      const records = await api(`/sessions/${encodeURIComponent(session.id)}/messages?mode=trace&pageSize=200`);
      for (const step of profile.steps.slice(0, 2)) {
        assert.equal(step.timing.end.messageId, step.messageId, "用量结束边界保留真实用量记录身份");
        const end = records.messages.find(message => message.id === step.timing.end.messageId);
        assert.equal(end?.kind, "system");
        assert.equal(end?.recordLine, step.timing.end.recordLine);
      }
      codexEnd = profile.steps[0].timing.end;
    }
    profiles.push({ client: source.client, source: source.id, speed });
  }
  const parent = list.sessions.find(item => item.clientSessionId === "speed-codex");
  const tree = await api(`/sessions/${encodeURIComponent(parent.id)}/profile?includeChildren=true`);
  assert.deepEqual(summarizeRequestSpeed(tree.steps), fixture.treeExpected, "父子范围平均");

  // 已发布的原生历史保持原样；额外索引仅用于可控的分支速度界面验证。
  const store = new SessionStore(join(home, "index.sqlite"));
  let branch;
  try {
    const existing = store.cachedRevisions();
    branch = indexSpeedBranchFixture(store, join(directory, "synthetic-branch-ui.jsonl"));
    const legacy = indexLegacySpeedFixture(store, join(directory, "synthetic-legacy-ui.jsonl"));
    store.publish(store.createJob().id, [...existing, branch, legacy], []);
  } finally { store.close(); }
  await writeFile(join(artifacts, "api-report.json"), JSON.stringify({ profiles, tree: summarizeRequestSpeed(tree.steps), codexEndRecord: codexEnd,
    directIndexBranchFixture: { purpose: "只验证 UI 分支范围", session: branch.id } }, null, 2) + "\n");
  if (!process.argv.includes("--api-only")) {
    await browser(["open", `${base}/#sessions?id=${encodeURIComponent(parent.id)}&mode=brief`, "--headed", "--browser=chrome"]);
    opened = true;
    const verifyNative = async page => {
      page.setDefaultTimeout(15_000);
      const button = name => page.getByRole("button", { name, exact: true });
      const checks = [];
      const ensure = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
      const disclosure = DISCLOSURE_CONTROL;
      const details = page.getByRole("dialog", { name: /^(请求速度详情|Request speed details)$/ });
      const openDetails = async target => { await target.locator(".session-speed-badge").click(); await details.waitFor(); };
      page.speedErrors = [];
      page.on("pageerror", error => page.speedErrors.push(error.message));
      await page.setViewportSize({ width: 1440, height: 900 });
      for (const [title, selector, file] of [["吐字速度验收", /^吐字速度验收 Codex/, "codex"], ["Claude 速度验收", /^Claude 速度验收 Claude Code/, "claude"], ["CLI 速度验收", /^CLI 速度验收 CodeFlicker CLI/, "cli"]]) {
        await page.getByRole("button", { name: selector }).click();
        await page.getByRole("heading", { name: title, exact: true }).waitFor();
        await page.waitForLoadState("networkidle");
        if (await button("对话").getAttribute("aria-pressed") !== "true") await button("对话").click();
        await page.waitForLoadState("networkidle");
        const turn = page.locator(".session-turn").first();
        await turn.locator(".session-speed-badge").filter({ hasText: "平均 ≈ 26 tok/s" }).waitFor();
        await page.getByRole("spinbutton", { name: "跳转轮次", exact: true }).fill("1"); await button("跳转").click();
        await page.waitForLoadState("networkidle");
        await turn.locator(".kind-assistant .session-speed-badge").filter({ hasText: "请求 ≈ 20 tok/s" }).waitFor();
        await disclosure(page, turn.getByText("第 1 轮", { exact: true }).locator(".."), "第 1 轮 查看速度说明：平均 ≈ 26 tok/s 复制本轮问答");
        checks.push(`${file} 轮次折叠具有原生角色与可访问名称`);
        await page.waitForFunction(() => document.querySelector(".session-turn")?.open === false);
        ensure(await turn.getAttribute("open") === null && await turn.locator("summary .session-speed-badge").innerText() === "平均 ≈ 26 tok/s", `${file} 折叠保留轮平均`);
        await turn.locator("summary .session-speed-badge").click();
        const help = page.getByRole("dialog", { name: "速度说明", exact: true });
        await help.waitFor();
        ensure((await help.innerText()).includes("200") && (await help.innerText()).includes("1 秒") && (await help.innerText()).includes("同一批请求"), `${file} 区域帮助说明门槛和加权平均`);
        await page.keyboard.press("Escape"); await help.waitFor({ state: "hidden" }); await page.waitForFunction(() => document.activeElement?.getAttribute("data-state") === "closed");
        await help.waitFor({ state: "hidden" });
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "查看速度说明：平均 ≈ 26 tok/s");
        ensure(await turn.getAttribute("open") === null && await turn.locator("summary .session-speed-badge").evaluate(element => element === document.activeElement), `${file} 帮助关闭焦点恢复`);
        await button("全部记录").click();
        await page.waitForLoadState("networkidle");
        await page.getByRole("spinbutton", { name: "跳转轮次", exact: true }).fill("1"); await button("跳转").click();
        await page.waitForLoadState("networkidle");
        await turn.locator(".kind-thinking .session-speed-badge").filter({ hasText: "请求 ≈ 40 tok/s" }).waitFor();
        ensure(await turn.locator(".kind-assistant .session-speed-badge").filter({ hasText: "请求 ≈ 40 tok/s" }).count() === 1, `${file} 思考与正文共享请求速度`);
        ensure(await turn.locator(".kind-tool_call .session-speed-badge, .kind-tool_result .session-speed-badge, .help-trigger").count() === 0, `${file} 工具与消息卡片不制造速度或帮助入口`);
        await button("执行轨迹").click();
        await page.waitForLoadState("networkidle");
        await page.locator(".trace-columns").getByRole("columnheader", { name: "速度", exact: true }).waitFor();
        const headers = await page.locator(".trace-columns").getByRole("columnheader").allTextContents();
        ensure(headers[3] === "输出 / 结果" && headers[4] === "速度" && headers[5] === "时间 / 耗时", `${file} 速度列位置正确`);
        ensure(await page.evaluate(() => new URLSearchParams(location.hash.split("?")[1]).get("mode")) === "trace", `${file} trace稳定参数保留`);
        await page.getByRole("button", { name: /^查看记录 \d+：思考$/ }).first().click();
        const inspector = page.locator(".trace-inspector");
        ensure(await inspector.locator("header .session-speed-badge").innerText() === "请求 ≈ 40 tok/s", `${file} 轨迹详情显示所属请求速度`);
        await openDetails(inspector.locator("header"));
        checks.push(`${file} 速度徽标可打开请求详情`);
        ensure(await details.locator(".session-speed-formula").innerText() === "480 Token ÷ 12.0 秒 ≈ 40 tok/s", `${file} 详情代入原始输出与耗时`);
        ensure((await details.locator(".session-speed-details").innerText()).includes("估算") && (await details.locator(".session-speed-details").innerText()).includes("起始记录"), `${file} 计时依据可核对`);
        await page.keyboard.press("Escape"); await details.waitFor({ state: "hidden" }); await page.waitForFunction(() => document.activeElement?.getAttribute("data-state") === "closed");
        await page.locator(".trace-columns").getByRole("button", { name: "速度说明", exact: true }).click();
        await help.waitFor(); ensure((await help.innerText()).includes("200 Token"), `${file} 轨迹速度表头提供算法帮助`); await page.keyboard.press("Escape"); await help.waitFor({ state: "hidden" }); await page.waitForFunction(() => document.activeElement?.getAttribute("data-state") === "closed");
        await button("执行轨迹说明").focus(); await page.keyboard.press("Enter");
        const traceHelp = page.getByRole("dialog", { name: "执行轨迹说明", exact: true });
        await traceHelp.waitFor(); ensure((await traceHelp.innerText()).includes("轨迹总览") && !(await traceHelp.innerText()).includes("吐字速度怎么算"), `${file} 轨迹说明和速度说明各自在所属区域`);
        await page.keyboard.press("Escape");
        await traceHelp.waitFor({ state: "hidden" });
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "执行轨迹说明");
        ensure(await button("执行轨迹说明").evaluate(element => element === document.activeElement), `${file} 轨迹帮助键盘与焦点恢复`);
        const profile = page.locator(".session-profile");
        if (file === "codex") {
          await page.getByRole("tab", { name: "概览", exact: true }).click();
          const resizer = page.getByRole("separator", { name: "调整会话画像宽度", exact: true });
          const grid = profile.locator(".session-usage-grid").first();
          await resizer.press("Home");
          ensure(await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length) === 2, "同一窗口窄侧栏采用两列指标");
          await resizer.press("End");
          ensure(await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length) === 4, "同一窗口宽侧栏采用四列指标");
          ensure((await grid.innerText()).includes("平均响应速度") && (await grid.innerText()).includes("2/5 次可计算") && (await grid.innerText()).includes("最大单次输入"), "宽侧栏速度覆盖与最大输入各归对应指标");
          await page.screenshot({ path: ARTIFACTS + "/profile-wide-metrics.png" });
          await resizer.press("Home"); for (let step = 0; step < 14; step++) await resizer.press("ArrowLeft");
        }
        await page.getByRole("tab", { name: "用量", exact: true }).click();
        await profile.locator(".session-speed-metric").getByText("2/5 次可计算", { exact: true }).waitFor();
        ensure(await profile.locator(".session-speed-metric strong").innerText() === "≈ 26 tok/s", `${file} 右侧平均与覆盖一致`);
        const rows = profile.locator(".session-step-table tbody tr");
        ensure(await rows.count() === 5, `${file} 请求表保留过滤与缺失记录`);
        for (const [index, reason] of [[2, "输出少于 200 Token，未计算速度"], [3, "响应结束未确认，未计算速度"], [4, "响应未完整结束，未计算速度"]]) {
          await openDetails(rows.nth(index));
          ensure((await details.innerText()).includes(reason) && await details.locator(".session-speed-formula").count() === 0, `${file} 请求${index + 1}显示实际原因而不制造算式`); await page.keyboard.press("Escape"); await details.waitFor({ state: "hidden" }); await page.waitForFunction(() => document.activeElement?.getAttribute("data-state") === "closed");
        }
        ensure(await rows.getByText("请求速度依据", { exact: true }).count() === 0, `${file} 请求表不再重复依据入口`);
        await profile.locator(".session-step-table thead").getByRole("button", { name: "速度说明", exact: true }).click(); await help.waitFor();
        ensure((await help.innerText()).includes("同一批请求"), `${file} 用量表头说明平均口径`); await page.keyboard.press("Escape"); await help.waitFor({ state: "hidden" }); await page.waitForFunction(() => document.activeElement?.getAttribute("data-state") === "closed");
        await openDetails(rows.first());
        ensure(await details.locator(".session-speed-formula").innerText() === "480 Token ÷ 12.0 秒 ≈ 40 tok/s", `${file} 右侧单请求公式一致`); await page.keyboard.press("Escape"); await details.waitFor({ state: "hidden" }); await page.waitForFunction(() => document.activeElement?.getAttribute("data-state") === "closed");
        const slider = page.getByRole("slider", { name: "选择用量请求", exact: true });
        await slider.focus(); await page.keyboard.press("Home");
        await page.getByRole("tooltip").getByText("请求 ≈ 40 tok/s", { exact: true }).waitFor();
        ensure(await profile.locator(".session-chart-unit").innerText() === "Token", `${file} Token曲线仅在提示补速度`);
        await page.keyboard.press("ArrowRight"); await page.getByRole("tooltip").getByText("请求 ≈ 20 tok/s", { exact: true }).waitFor();
        await button("统计口径").click();
        const stats = page.getByRole("dialog", { name: "统计口径", exact: true });
        ensure((await stats.innerText()).includes("阅读分支不改变统计范围") && (await stats.innerText()).includes("吐字速度怎么算"), `${file} 统计帮助合并原有范围与速度`);
        await stats.press("Escape");
        await page.screenshot({ path: ARTIFACTS + "/" + file + "-desktop-speed.png" });
        await profile.getByRole("button", { name: "请求 1", exact: true }).click();
        await inspector.locator("header .session-speed-badge").filter({ hasText: "请求 ≈ 40 tok/s" }).waitFor();
        ensure(await button("执行轨迹").getAttribute("aria-pressed") === "true", `${file} 请求定位到正确轨迹记录`);
        if (file === "codex") {
          await openDetails(rows.first());
          await details.getByRole("button", { name: `第 ${CODEX_END_RECORD_LINE} 条记录`, exact: true }).click();
          await page.waitForLoadState("networkidle");
          await page.waitForFunction(id => document.querySelector(".trace-inspector article[data-message-id]")?.getAttribute("data-message-id") === id, CODEX_END_MESSAGE_ID);
          ensure(await inspector.locator("article[data-message-id]").getAttribute("data-message-id") === CODEX_END_MESSAGE_ID
            && (await inspector.innerText()).includes("请求用量（记录值）"), "Codex 请求结束入口定位到保存用量的真实轨迹记录");
        }
      }
      ensure(page.speedErrors.length === 0, "原生三来源Chrome无运行时异常");
      return { nativeApiVerified: true, fourViews: ["codex", "claude", "cli"], checks, errors: page.speedErrors };
    };
    const output = await browser(["run-code", verifyNative.toString().replaceAll("ARTIFACTS", JSON.stringify(artifacts))
      .replaceAll("CODEX_END_RECORD_LINE", JSON.stringify(codexEnd.recordLine)).replaceAll("CODEX_END_MESSAGE_ID", JSON.stringify(codexEnd.messageId))]);
    await writeFile(join(artifacts, "native-browser-report.txt"), output);
    console.log(output.split("### Ran Playwright code")[0]);
    const verifyScopes = async page => {
      const checks = [];
      const ensure = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
      const details = page.getByRole("dialog", { name: /^(请求速度详情|Request speed details)$/ });
      const openDetails = async target => { await target.locator(".session-speed-badge").click(); await details.waitFor(); };
      const button = name => page.getByRole("button", { name, exact: true });
      const select = async (title, name) => {
        await page.getByRole("button", { name }).click(); await page.getByRole("heading", { name: title, exact: true }).waitFor();
        await page.waitForLoadState("networkidle");
      };
      const profile = page.locator(".session-profile");
      await select("吐字速度验收", /^吐字速度验收 Codex/);
      await button("对话").click(); await page.waitForLoadState("networkidle");
      await button("自身").click(); await profile.getByText("2/5 次可计算", { exact: true }).waitFor();
      await button("包含子会话").click(); await profile.getByText("3/6 次可计算", { exact: true }).waitFor();
      ensure(await profile.locator(".session-speed-metric strong").innerText() === "≈ 28 tok/s", "原生父子平均采用1480Token与52秒");
      ensure(await page.locator(".session-turn").first().locator("summary .session-speed-badge").innerText() === "平均 ≈ 26 tok/s", "包含子会话不改变父轮范围");
      await button("自身").click(); await profile.getByText("2/5 次可计算", { exact: true }).waitFor();
      ensure(await profile.locator(".session-speed-metric strong").innerText() === "≈ 26 tok/s", "self/tree切回保持原范围");
      await select("门槛与缺失验收", /^门槛与缺失验收 Codex/);
      await page.getByRole("tab", { name: "用量", exact: true }).click();
      await profile.getByText("1/4 次可计算", { exact: true }).waitFor();
      ensure(await profile.locator(".session-speed-metric strong").innerText() === "≈ 200 tok/s", "200Token和1秒的等号请求参与统计");
      const thresholdRows = profile.locator(".session-step-table tbody tr");
      const thresholdTexts = [];
      for (let index = 0; index < await thresholdRows.count(); index++) {
        await openDetails(thresholdRows.nth(index)); thresholdTexts.push(await details.innerText()); await page.keyboard.press("Escape"); await details.waitFor({ state: "hidden" }); await page.waitForFunction(() => document.activeElement?.getAttribute("data-state") === "closed");
      }
      const thresholdText = thresholdTexts.join("\n");
      ensure(thresholdText.includes("200 Token ÷ 1.0 秒 ≈ 200 tok/s") && thresholdText.includes("响应耗时少于 1 秒，未计算速度")
        && thresholdText.includes("缺少有效计时依据") && thresholdText.includes("未记录输出 Token"), "等号算式、999ms、缺时间及缺输出分别呈现");
      await page.screenshot({ path: ARTIFACTS + "/thresholds-and-missing.png" });
      for (const [title, name, reason] of [["速度数据不足验收", /^速度数据不足验收 Codex/, "响应结束未确认，未计算速度"], ["旧索引速度验收", /^旧索引速度验收 Codex/, "缺少有效计时依据"]]) {
        await select(title, name); await button("执行轨迹").click(); await page.waitForLoadState("networkidle");
        await profile.getByText("速度数据不足", { exact: true }).waitFor();
        ensure(await page.locator(".trace-columns").getByRole("columnheader", { name: "速度", exact: true }).count() === 1, `${title}无合格请求仍保留速度表头帮助`);
        await page.getByRole("tab", { name: "用量", exact: true }).click();
        await profile.getByText("0/1 次可计算", { exact: true }).waitFor();
        ensure(await profile.locator(".session-step-table").getByRole("columnheader", { name: "速度", exact: true }).count() === 1, `${title}右侧缺失值保留详情入口`);
        await openDetails(profile.locator(".session-step-table tbody tr").first());
        ensure((await details.innerText()).includes(reason) && await details.locator(".session-speed-formula").count() === 0, `${title}无数值时保留具体原因`); await page.keyboard.press("Escape"); await details.waitFor({ state: "hidden" }); await page.waitForFunction(() => document.activeElement?.getAttribute("data-state") === "closed");
      }
      await select("原生分支速度缺失验收", /^原生分支速度缺失验收 Pi/);
      await button("对话").click(); await page.waitForLoadState("networkidle");
      await page.getByText("当前分支合成回答", { exact: true }).waitFor();
      await page.getByRole("combobox", { name: "阅读分支", exact: true }).click();
      await page.getByRole("option", { name: "分支 1", exact: true }).click(); await page.waitForLoadState("networkidle");
      await page.getByText("旧分支合成回答", { exact: true }).waitFor();
      ensure(await page.locator(".session-turn").first().locator("summary .session-speed-badge").innerText() === "速度数据不足", "未支持计时的原生分支保留缺失");
      ensure(await profile.locator(".session-speed-coverage").last().innerText() === "0/2 次可计算", "原生分支阅读不缩小右侧全部请求范围");
      ensure(page.speedErrors.length === 0, "缺失与范围Chrome无运行时异常");
      return { checks, nativeChildScope: true, nativePiBranches: true, legacyIndex: true };
    };
    const scopeOutput = await browser(["run-code", verifyScopes.toString().replaceAll("ARTIFACTS", JSON.stringify(artifacts))]);
    await writeFile(join(artifacts, "scope-browser-report.txt"), scopeOutput);
    console.log(scopeOutput.split("### Ran Playwright code")[0]);
    const verifyBranchLanguage = async page => {
      const checks = [];
      const ensure = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
      const details = page.getByRole("dialog", { name: /^(请求速度详情|Request speed details)$/ });
      const openDetails = async target => { await target.locator(".session-speed-badge").click(); await details.waitFor(); };
      const button = name => page.getByRole("button", { name, exact: true });
      const profile = page.locator(".session-profile");
      const choose = async (label, name) => {
        await page.getByRole("combobox", { name: label, exact: true }).click();
        await page.getByRole("option", { name, exact: true }).click(); await page.waitForLoadState("networkidle");
      };
      const language = async (label, name) => {
        const saved = page.waitForResponse(response => response.url().endsWith("/api/v1/preferences") && response.request().method() === "PUT");
        await button(label).click(); await page.getByRole("menuitemradio", { name, exact: true }).click(); await saved; await page.waitForLoadState("networkidle");
      };
      await page.getByRole("button", { name: /^分支速度验收 Codex/ }).click();
      await page.getByRole("heading", { name: "分支速度验收", exact: true }).waitFor(); await page.waitForLoadState("networkidle");
      await button("对话").click(); await page.waitForLoadState("networkidle");
      await page.locator(".session-turn").first().locator("summary .session-speed-badge").filter({ hasText: "平均 ≈ 40 tok/s" }).waitFor();
      await choose("阅读分支", "合成旧分支");
      await page.locator(".session-turn").first().locator("summary .session-speed-badge").filter({ hasText: "平均 ≈ 20 tok/s" }).waitFor();
      ensure(await profile.locator(".session-speed-metric strong").innerText() === "≈ 27 tok/s", "直接索引分支fixture只改变轮平均而不修改右侧范围");
      await button("全部记录").click(); await page.waitForLoadState("networkidle");
      await page.locator(".session-turn").first().locator("summary .session-speed-badge").filter({ hasText: "平均 ≈ 27 tok/s" }).waitFor();
      await choose("阅读分支", "合成旧分支");
      await page.getByRole("spinbutton", { name: "跳转轮次", exact: true }).fill("12"); await button("跳转").click(); await page.waitForLoadState("networkidle");
      ensure(await page.getByRole("spinbutton", { name: "跳转轮次", exact: true }).inputValue() === "12", "分支第12轮分页定位");
      await page.getByRole("tab", { name: "用量", exact: true }).click();
      await button("包含子会话").click(); await page.waitForLoadState("networkidle");
      await button("请求明细分页下一页").click();
      const firstRequest = profile.locator(".session-step-table tbody tr").first();
      await firstRequest.getByRole("button", { name: "请求 13", exact: true }).waitFor();
      const slider = page.getByRole("slider", { name: "选择用量请求", exact: true });
      await slider.focus(); await page.keyboard.press("End");
      await page.getByRole("tooltip").getByText("请求 ≈ 40 tok/s", { exact: true }).waitFor();
      page.speedQueries = [];
      page.on("request", request => { if (request.method() === "GET" && /\/api\/v1\/sessions(?:\/|\?)/.test(request.url())) page.speedQueries.push(request.url()); });
      const before = { hash: await page.evaluate(() => location.hash), turn: await page.getByRole("spinbutton", { name: "跳转轮次", exact: true }).inputValue(),
        expanded: await page.locator(".session-turn[open]").count(), selected: await slider.getAttribute("aria-valuenow"), queries: page.speedQueries.length };
      await language("显示语言", "English");
      ensure(await button("All records").getAttribute("aria-pressed") === "true" && await button("Execution trace").count() === 1, "英文完整与执行轨迹名称正确");
      ensure(await page.evaluate(() => location.hash) === before.hash && await page.getByRole("spinbutton", { name: "Turn to jump to", exact: true }).inputValue() === before.turn, "英文切换保留会话模式分支与轮次地址");
      ensure(await page.getByRole("combobox", { name: "Reading branch", exact: true }).innerText() === "合成旧分支" && await page.locator(".session-turn[open]").count() === before.expanded, "英文切换保留分支与展开状态");
      ensure(await button("Include child sessions").getAttribute("aria-pressed") === "true" && await page.getByRole("tab", { name: "Usage", exact: true }).getAttribute("aria-selected") === "true", "英文切换保留统计范围与用量页");
      ensure(await page.getByRole("slider", { name: "Select usage request", exact: true }).getAttribute("aria-valuenow") === before.selected && await firstRequest.getByRole("button", { name: "Request 13", exact: true }).isVisible(), "英文切换保留曲线请求与请求明细分页");
      await openDetails(firstRequest);
      ensure(await details.locator(".session-speed-formula").innerText() === "400 tokens ÷ 20.0 seconds ≈ 20 tok/s", "请求详情算式随语言呈现"); await page.keyboard.press("Escape"); await details.waitFor({ state: "hidden" }); await page.waitForFunction(() => document.activeElement?.getAttribute("data-state") === "closed");
      ensure(await page.locator(".session-turn").filter({ hasText: "分支速度问题 12" }).locator("summary .session-speed-badge").innerText() === "Average ≈ 20 tok/s", "英文轮平均仍按旧分支计算");
      ensure(page.speedQueries.length === before.queries, "语言切换不重读会话索引或改变请求范围");
      await button("Statistics methodology").focus(); await page.keyboard.press("Enter");
      const stats = page.getByRole("dialog", { name: "Statistics methodology", exact: true });
      await stats.waitFor(); ensure((await stats.innerText()).includes("at least 200 output tokens") && (await stats.innerText()).includes("1 second"), "英文帮助算法与门槛完整");
      await stats.press("Escape"); await stats.waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Statistics methodology");
      await page.screenshot({ path: ARTIFACTS + "/branch-english-preserved.png" });
      await button("Execution trace").click(); await page.waitForLoadState("networkidle");
      await choose("Reading branch", "合成旧分支");
      await page.locator(".trace-row.kind-assistant").first().getByRole("button", { name: /^View record \d+: AI$/ }).click();
      const inspector = page.locator(".trace-inspector");
      await openDetails(inspector.locator("header")); await page.keyboard.press("Escape"); await details.waitFor({ state: "hidden" }); await page.waitForFunction(() => document.activeElement?.getAttribute("data-state") === "closed");
      const traceBefore = { hash: await page.evaluate(() => location.hash), rows: await page.locator(".trace-ledger").getAttribute("aria-rowcount"),
        selected: await inspector.locator("article[data-message-id]").getAttribute("data-message-id") };
      await language("Display language", "Simplified Chinese");
      ensure(await button("执行轨迹").getAttribute("aria-pressed") === "true" && await page.evaluate(() => location.hash) === traceBefore.hash, "轨迹切回中文保持trace与记录定位");
      ensure(await page.locator(".trace-ledger").getAttribute("aria-rowcount") === traceBefore.rows
        && await inspector.locator("article[data-message-id]").getAttribute("data-message-id") === traceBefore.selected, "轨迹切换保留选中节点和总行数");
      await openDetails(inspector.locator("header"));
      ensure(await details.locator(".session-speed-formula").innerText() === "400 Token ÷ 20.0 秒 ≈ 20 tok/s", "轨迹请求详情算式中文呈现"); await page.keyboard.press("Escape"); await details.waitFor({ state: "hidden" }); await page.waitForFunction(() => document.activeElement?.getAttribute("data-state") === "closed");
      await button("自身").click(); await page.waitForLoadState("networkidle");
      ensure(page.speedErrors.length === 0, "语言与分支Chrome无运行时异常");
      return { checks, directIndexBranchFixture: true, originalTitlePreserved: true };
    };
    const languageOutput = await browser(["run-code", verifyBranchLanguage.toString().replaceAll("ARTIFACTS", JSON.stringify(artifacts))]);
    await writeFile(join(artifacts, "branch-language-browser-report.txt"), languageOutput);
    console.log(languageOutput.split("### Ran Playwright code")[0]);
    const verifyLongHistory = async page => {
      const checks = [];
      const ensure = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
      const details = page.getByRole("dialog", { name: /^(请求速度详情|Request speed details)$/ });
      const openDetails = async target => { await target.locator(".session-speed-badge").click(); await details.waitFor(); };
      const button = name => page.getByRole("button", { name, exact: true });
      await page.getByRole("button", { name: /^长列表速度验收 Codex/ }).click();
      await page.getByRole("heading", { name: "长列表速度验收", exact: true }).waitFor(); await page.waitForLoadState("networkidle");
      await button("对话").click(); await page.waitForLoadState("networkidle");
      await page.locator(".session-turn").first().locator("summary .session-speed-badge").filter({ hasText: "平均 ≈ 200 tok/s" }).waitFor();
      ensure(await page.locator(".session-turn").count() === 10, "110轮历史按完整轮次分页");
      await button("末轮").click(); await page.waitForLoadState("networkidle");
      await page.locator(".kind-user .session-message-text").getByText("合成速度问题 110", { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('input[aria-label="跳转轮次"]')?.value === "110");
      ensure(await page.getByRole("spinbutton", { name: "跳转轮次", exact: true }).inputValue() === "110", "末轮跳转到第11页");
      ensure(await page.locator(".session-turn").last().locator("summary .session-speed-badge").innerText() === "平均 ≈ 200 tok/s", "跨页末轮保持六请求平均");
      await button("首轮").click(); await page.waitForLoadState("networkidle");
      await button("执行轨迹").click(); await page.waitForLoadState("networkidle");
      await page.locator(".trace-toolbar").getByText("180 个执行节点", { exact: true }).waitFor();
      const ledger = page.locator(".trace-ledger");
      const scroller = page.locator(".trace-ledger-scroll");
      const rowCount = Number(await ledger.getAttribute("aria-rowcount"));
      ensure(rowCount > 150 && await page.locator(".trace-row").count() < 40, "轨迹只渲染长列表的可见窗口");
      const first = await page.locator(".trace-row").first().getAttribute("aria-rowindex");
      await scroller.evaluate(element => { element.scrollTop = element.scrollHeight - element.clientHeight; });
      await page.waitForFunction(initial => document.querySelector(".trace-row")?.getAttribute("aria-rowindex") !== initial, first);
      ensure(await page.locator(".trace-row .session-speed-badge").filter({ hasText: "≈ 200 tok/s" }).count() > 0, "虚拟滚动末端仍显示对应请求速度");
      ensure(await page.locator(".trace-row").count() < 40, "虚拟滚动没有挂载全部记录");
      await button("折叠全部").click();
      await page.waitForFunction(() => document.querySelectorAll(".trace-row").length === 0);
      await page.waitForFunction(() => document.querySelectorAll(".trace-group").length === 10);
      ensure(await page.locator(".trace-group .session-speed-badge").filter({ hasText: "平均 ≈ 200 tok/s" }).count() === 10, "轨迹轮次折叠保留十个平均标记");
      await button("展开全部").click();
      await page.locator(".trace-row").first().waitFor();
      await page.getByRole("tab", { name: "用量", exact: true }).click();
      const profile = page.locator(".session-profile");
      ensure((await profile.locator(".session-speed-metric strong").innerText()) === "≈ 200 tok/s" && await profile.locator(".session-speed-coverage").count() === 0, "660请求全部合格时无需部分覆盖标记");
      await button("请求明细分页末页").click();
      await profile.getByRole("button", { name: "请求 660", exact: true }).waitFor();
      ensure(await profile.locator(".session-step-table tbody tr").count() === 12, "右侧660请求可定位第55页且保留12条明细");
      const last = profile.locator(".session-step-table tbody tr").last();
      ensure(await last.locator(".session-speed-badge").innerText() === "≈ 200 tok/s", "第660次请求速度来自完整明细");
      await openDetails(last);
      ensure(await details.locator(".session-speed-formula").innerText() === "200 Token ÷ 1.0 秒 ≈ 200 tok/s", "最后请求代入算式可核对"); await page.keyboard.press("Escape"); await details.waitFor({ state: "hidden" }); await page.waitForFunction(() => document.activeElement?.getAttribute("data-state") === "closed");
      const slider = page.getByRole("slider", { name: "选择用量请求", exact: true });
      await slider.focus(); await page.keyboard.press("End");
      await page.getByRole("tooltip").getByText("请求 660", { exact: true }).waitFor();
      ensure(await slider.getAttribute("aria-valuenow") === "660", "Token曲线覆盖全部660请求");
      await page.screenshot({ path: ARTIFACTS + "/long-history-request-660.png" });
      await profile.getByRole("button", { name: "请求 660", exact: true }).click(); await page.waitForLoadState("networkidle");
      await page.locator(".trace-inspector header .session-speed-badge").filter({ hasText: "请求 ≈ 200 tok/s" }).waitFor();
      await page.waitForFunction(() => document.querySelector('input[aria-label="跳转轮次"]')?.value === "110");
      ensure(await page.getByRole("spinbutton", { name: "跳转轮次", exact: true }).inputValue() === "110", "跨页请求定位到实际第110轮轨迹");
      ensure(page.speedErrors.length === 0, "长历史Chrome无运行时异常");
      return { checks, requests: 660, turns: 110, virtualRows: true };
    };
    const longOutput = await browser(["run-code", verifyLongHistory.toString().replaceAll("ARTIFACTS", JSON.stringify(artifacts))]);
    await writeFile(join(artifacts, "long-history-browser-report.txt"), longOutput);
    console.log(longOutput.split("### Ran Playwright code")[0]);
    const verifyThemesTouch = async page => {
      const context = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const mobile = await context.newPage();
      const checks = [], errors = [], tableSizes = [];
      const ensure = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
      const details = mobile.getByRole("dialog", { name: /^(请求速度详情|Request speed details)$/ });
      const openDetails = async target => { await target.locator(".session-speed-badge").tap(); await details.waitFor(); };
      const button = name => mobile.getByRole("button", { name, exact: true });
      const inViewport = async dialog => {
        const value = await dialog.boundingBox();
        return value && value.x >= 11 && value.y >= 11 && value.x + value.width <= 379 && value.y + value.height <= 833;
      };
      try {
        mobile.setDefaultTimeout(15_000);
        mobile.on("pageerror", error => errors.push(error.message));
        await mobile.goto(PARENT_URL); await mobile.getByRole("heading", { name: "吐字速度验收", exact: true }).waitFor(); await mobile.waitForLoadState("networkidle");
        ensure(await mobile.evaluate(() => matchMedia("(pointer: coarse)").matches && navigator.maxTouchPoints > 0), "真实触摸上下文使用390px窄屏");
        ensure(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "浅色中文窄屏页面无横向溢出");
        await mobile.locator(".session-turn summary .session-speed-badge").first().tap();
        const help = mobile.getByRole("dialog", { name: "速度说明", exact: true });
        await help.waitFor(); ensure(await inViewport(help) && (await help.innerText()).includes("200 Token"), "触摸可打开中文算法帮助且完整位于视口内");
        await mobile.screenshot({ path: ARTIFACTS + "/mobile-light-speed-help.png" });
        await button("关闭速度说明").tap(); await help.waitFor({ state: "hidden" });
        await button("执行轨迹").tap(); await mobile.waitForLoadState("networkidle");
        await mobile.locator(".trace-columns").getByRole("columnheader", { name: "速度", exact: true }).waitFor();
        await button("执行轨迹说明").tap();
        const traceHelp = mobile.getByRole("dialog", { name: "执行轨迹说明", exact: true });
        await traceHelp.waitFor(); ensure(await inViewport(traceHelp), "触摸轨迹说明未超出窄屏");
        await button("关闭执行轨迹说明").tap(); await traceHelp.waitFor({ state: "hidden" });
        await button("会话统计").tap(); await mobile.getByRole("tab", { name: "用量", exact: true }).tap();
        const profile = mobile.locator(".session-profile");
        await profile.getByText("2/5 次可计算", { exact: true }).waitFor();
        await button("统计口径").tap();
        const stats = mobile.getByRole("dialog", { name: "统计口径", exact: true });
        await stats.waitFor(); ensure(await inViewport(stats), "触摸统计帮助在侧栏内仍位于视口");
        await button("关闭统计口径").tap(); await stats.waitFor({ state: "hidden" });
        ensure(await mobile.locator(".sessions-shell").getAttribute("data-compact-panel") === "profile", "关闭帮助保留统计侧栏");
        const table = profile.locator(".session-step-table");
        const firstRow = table.locator("tbody tr").first();
        await openDetails(firstRow);
        ensure(await details.locator(".session-speed-formula").innerText() === "480 Token ÷ 12.0 秒 ≈ 40 tok/s", "触摸徽标打开窄屏请求算式");
        ensure(await inViewport(details), "中文请求详情弹层完整位于窄屏内");
        await mobile.screenshot({ path: ARTIFACTS + "/mobile-light-speed-usage.png" }); await button("关闭请求速度详情").tap();
        await table.evaluate(element => { element.scrollLeft = element.scrollWidth - element.clientWidth; });
        tableSizes.push(await table.evaluate(element => ({ language: "zh-CN", width: element.clientWidth, contentWidth: element.scrollWidth, scroll: element.scrollLeft })));
        ensure(await table.evaluate(element => getComputedStyle(element).overflowX === "auto" && (element.scrollWidth <= element.clientWidth || element.scrollLeft > 0)), "窄屏用量表允许内部横向滚动且保留页面宽度");
        await button("返回对话").tap({ position: { x: 5, y: 5 } });
        await mobile.waitForFunction(() => document.querySelector(".sessions-shell")?.getAttribute("data-compact-panel") !== "profile");
        await button("切换主题").tap();
        ensure(await mobile.locator("html").getAttribute("data-theme") === "dark", "深色窄屏主题切换");
        const saved = mobile.waitForResponse(response => response.url().endsWith("/api/v1/preferences") && response.request().method() === "PUT");
        await button("显示语言").tap(); await mobile.getByRole("menuitemradio", { name: "English", exact: true }).tap(); await saved; await mobile.waitForLoadState("networkidle");
        ensure(await button("Execution trace").getAttribute("aria-pressed") === "true", "窄屏英文保留执行轨迹模式");
        await mobile.locator(".trace-columns").getByRole("button", { name: "Speed help", exact: true }).tap();
        const english = mobile.getByRole("dialog", { name: "Speed help", exact: true });
        await english.waitFor(); ensure(await inViewport(english) && (await english.innerText()).includes("at least 200 output tokens"), "深色英文触摸速度表头帮助可读且不越界");
        await mobile.screenshot({ path: ARTIFACTS + "/mobile-dark-english-speed-help.png" });
        await button("Close Speed help").tap(); await english.waitFor({ state: "hidden" });
        await button("Session statistics").tap();
        await mobile.getByRole("tab", { name: "Usage", exact: true }).tap();
        ensure(await profile.locator(".session-speed-metric strong").innerText() === "≈ 26 tok/s"
          && await profile.locator(".session-speed-coverage").innerText() === "2/5 calculable requests", "深色英文窄屏保留平均与部分覆盖");
        await openDetails(firstRow);
        ensure(await details.locator(".session-speed-formula").innerText() === "480 tokens ÷ 12.0 seconds ≈ 40 tok/s", "英文触屏请求公式正确");
        ensure(await inViewport(details), "英文请求详情弹层完整位于窄屏内");
        ensure(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "深色英文窄屏页面无横向溢出");
        await mobile.screenshot({ path: ARTIFACTS + "/mobile-dark-english-speed-usage.png" }); await button("Close Request speed details").tap();
        await button("Return to conversation").tap({ position: { x: 5, y: 5 } });
        await mobile.setViewportSize({ width: 1440, height: 900 });
        await button("Dialogue").click(); await mobile.waitForLoadState("networkidle");
        await mobile.locator(".session-turn").first().locator("summary .session-speed-badge").filter({ hasText: "Average ≈ 26 tok/s" }).waitFor();
        ensure(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "深色英文桌面页面无横向溢出");
        await mobile.screenshot({ path: ARTIFACTS + "/desktop-dark-english-speed.png" });
        ensure(errors.length === 0 && page.speedErrors.length === 0, "主题与真实触摸Chrome无运行时异常");
        return { checks, actualTouch: true, themes: ["light", "dark"], languages: ["zh-CN", "en"], widths: [390, 1440], tableSizes, errors };
      } finally { await context.close(); }
    };
    const touchOutput = await browser(["run-code", verifyThemesTouch.toString().replaceAll("ARTIFACTS", JSON.stringify(artifacts))
      .replaceAll("PARENT_URL", JSON.stringify(`${base}/#sessions?id=${encodeURIComponent(parent.id)}&mode=brief`))]);
    await writeFile(join(artifacts, "theme-touch-browser-report.txt"), touchOutput);
    console.log(touchOutput.split("### Ran Playwright code")[0]);
  }
  assert.ok(JSON.parse(await readFile(join(artifacts, "api-report.json"), "utf8")).profiles.length === 8);
  console.log(process.argv.includes("--api-only") ? "合成原生数据 API 验收通过；浏览器未执行。" : "合成历史与四处速度界面验收通过。");
} catch (failure) {
  if (opened) {
    try {
      await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]);
      await writeFile(join(artifacts, "failure-state.txt"), await browser(["snapshot"]));
    } catch { /* 浏览器关闭时保留最初的失败。 */ }
  }
  throw failure;
} finally {
  if (opened) try { await browser(["close"]); } catch { /* 失败路径也清理隔离服务。 */ }
  await service?.close();
  await rm(directory, { recursive: true, force: true });
}
