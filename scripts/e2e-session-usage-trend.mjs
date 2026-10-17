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
import { encodeSession, longSessionFixture } from "./session-fixture.mjs";

// 隔离人工历史，验证画像 API 与界面的完整趋势、分页及父子范围一致；底层统计正确性由独立测试覆盖。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-usage-trend-")));
const artifacts = fileURLToPath(new URL("../.local/session-usage-trend-e2e/", import.meta.url));
const browserName = `usage-trend-${process.pid}`;
let service, opened = false;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${browserName}`, ...args], {
    cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
try {
  await mkdir(artifacts, { recursive: true });
  const history = join(directory, "codex"), home = join(directory, "data");
  await mkdir(history); await mkdir(home); await writePreferences(home, "zh-CN");
  const parent = longSessionFixture("/synthetic/workspace").filter(record => record.payload?.channel !== "final");
  const child = parent.slice(0, 21).map((record, ordinal) => ({ ...record, ordinal }));
  child[0].payload = { id: "demo-child", cwd: "/synthetic/workspace", forked_from_id: "demo-long", subagent_history_start_ordinal: 1,
    source: { subagent: { thread_spawn: { parent_thread_id: "demo-long", agent_path: "/root/usage_check", agent_nickname: "Fixture Agent" } } } };
  await writeFile(join(history, "parent.jsonl"), encodeSession(parent));
  await writeFile(join(history, "child.jsonl"), encodeSession(child));
  service = await startService({ home, startupRefresh: false, roots: Object.fromEntries(clientIds.map(client => [client, client === "codex" ? [history] : []])),
    resourceInventory: { userHome: join(directory, "isolated-user"), environment: {} },
    usagePricing: { fetch: async () => { throw new Error("synthetic offline"); } } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const api = async (path, options) => { const response = await fetch(`${base}/api/v1${path}`, options); assert.equal(response.status, 200); return response.json(); };
  await api("/usage/pricing", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    overrides: [{ model: "fixture-model", input: 2, output: 10, cacheRead: 0.2 }], mappings: [],
  }) });
  const { job } = await api("/sessions/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await api(`/jobs/${job.id}`); assert.notEqual(result.job.status, "failed");
    if (result.job.status === "complete") break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const list = await api("/sessions");
  const selected = list.sessions.find(item => item.clientSessionId === "demo-long");
  assert.ok(selected);
  const own = await api(`/sessions/${selected.id}/profile`), tree = await api(`/sessions/${selected.id}/profile?includeChildren=true`);
  const scopes = [own.usage.requests, tree.usage.requests];
  assert.ok(scopes[0] > 0); assert.ok(scopes[1] > scopes[0]);
  assert.equal(own.steps.length, scopes[0]); assert.equal(tree.steps.length, scopes[1]);
  await browser(["open", base, "--headed", "--browser=chrome"]); opened = true;
  const verify = async (page, fixture) => {
    page.setDefaultTimeout(15_000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const ensure = (condition, message) => { if (!condition) throw new Error(message); };
    const zh = fixture.language === "zh-CN";
    await page.setViewportSize({ width: 1560, height: 1080 }); await page.reload();
    await page.getByRole("button", { name: zh ? "会话库" : "Sessions", exact: true }).click();
    await page.locator(".session-list-item").filter({ hasText: "长会话工作区验收" }).click();
    const summary = page.getByRole("region", { name: zh ? "Token 用量" : "Token usage", exact: true });
    await summary.waitFor();
    ensure(await summary.locator(":scope > .session-usage-grid").count() === 1, "请求摘要未复用统一 Token 指标区域");
    const cost = summary.getByRole("group", { name: zh ? /^估算费用(?:小计)?$/ : /^Estimated cost(?: subtotal)?$/ });
    const help = async text => {
      await summary.getByRole("button", { name: zh ? "统计口径" : "Statistics methodology", exact: true }).click();
      await page.getByText(text, { exact: true }).waitFor();
      await page.keyboard.press("Escape");
    };
    const treeTotal = new Intl.NumberFormat(fixture.language).format(fixture.scopes[1]);
    await cost.getByText("$0.39", { exact: true }).waitFor();
    ensure((await cost.innerText()).includes("$"), "会话概览费用缺少美元符号");
    await page.getByRole("tab", { name: zh ? "用量" : "Usage", exact: true }).click();
    for (const [scopeIndex, total] of fixture.scopes.entries()) {
      if (scopeIndex === 1) {
        await page.getByRole("button", { name: zh ? "包含子会话" : "Include child sessions", exact: true }).click();
        await page.waitForFunction(total => document.querySelector(".session-chart-hit")?.getAttribute("aria-valuemax") === String(total), total);
      }
      await page.locator(".session-step-table tbody tr").first().waitFor(); await page.waitForLoadState("networkidle");
      await cost.getByText("$0.39", { exact: true }).waitFor();
      const hit = page.getByRole("slider", { name: zh ? "选择用量请求" : "Select usage request", exact: true });
      ensure(await hit.getAttribute("aria-valuemax") === String(total), `趋势末请求应为 ${total}，实际为 ${await hit.getAttribute("aria-valuemax")}`);
      const table = page.locator(".session-step-table tbody tr");
      const pager = page.getByRole("navigation", { name: zh ? "请求明细分页" : "Request details pagination", exact: true });
      const chart = () => page.locator(".session-usage-chart svg").evaluate(svg => [...svg.querySelectorAll("polyline")].map(line => line.getAttribute("points")));
      const before = await chart();
      ensure(before[0].split(" ").length === total, "趋势没有包含全部请求");
      ensure(await table.count() === 12 && (await table.first().innerText()).startsWith("#1\t"), "范围切换后请求表应从首页开始");
      const profileRequests = []; const record = request => { if (/\/(profile|cost)(\?|$)/.test(request.url())) profileRequests.push(request.url()); };
      page.on("request", record);
      await pager.getByRole("button", { name: zh ? "请求明细分页下一页" : "Request details pagination next page", exact: true }).click();
      ensure((await table.first().innerText()).startsWith("#13\t"), "请求表没有翻到第二页");
      ensure(JSON.stringify(await chart()) === JSON.stringify(before), "表格翻页改变了完整趋势");
      await pager.getByRole("button", { name: zh ? "请求明细分页末页" : "Request details pagination last page", exact: true }).click();
      ensure((await table.last().innerText()).startsWith(`#${total}\t`), "表格末页请求编号错误");
      ensure(JSON.stringify(await chart()) === JSON.stringify(before), "表格末页改变了完整趋势");
      page.off("request", record); ensure(profileRequests.length === 0, "表格翻页重复获取画像或费用");
      await hit.focus(); await page.keyboard.press("End");
      ensure(await hit.getAttribute("aria-valuenow") === String(total), "图表键盘未覆盖末请求");
      const tooltip = page.getByRole("tooltip"); await tooltip.waitFor();
      ensure((await tooltip.innerText()).includes(String(total)), "末请求提示编号错误");
      await page.keyboard.press("Enter");
      await page.locator(".session-message.is-focused, .trace-detail-body").waitFor();
      ensure((await page.locator(".session-message.is-focused, .trace-detail-body").innerText()).includes(zh ? "请求用量（记录值）" : "Request usage (recorded values)"), "图表末请求未定位用量记录");
      await page.screenshot({ path: `${fixture.artifacts}/${fixture.language}-${total}.png` });
    }
    await page.locator(".session-list-item").filter({ hasText: "长会话工作区验收" }).click();
    await cost.getByText("$0.39", { exact: true }).waitFor();
    await page.getByRole("tab", { name: zh ? "概览" : "Overview", exact: true }).click();
    const cache = page.locator(".session-cache-ratio");
    ensure(await cache.count() === 1, "完整缓存占比没有显示");
    const styles = await page.evaluate(() => {
      const ratio = document.querySelector(".session-cache-ratio"), amount = document.querySelector(".session-cost");
      return { ratioBackground: getComputedStyle(ratio).backgroundColor, amountBackground: getComputedStyle(amount).backgroundColor,
        ratioColor: getComputedStyle(ratio.querySelector("strong")).color, amountColor: getComputedStyle(amount.querySelector("strong")).color };
    });
    ensure(styles.ratioBackground === styles.amountBackground && styles.ratioColor === styles.amountColor, "缓存占比未采用普通费用行样式");

    const costRoute = /\/api\/v1\/sessions\/[^/]+\/cost(?:\?|$)/;
    await page.route(costRoute, async route => { await page.waitForTimeout(500); await route.continue(); });
    await page.getByRole("button", { name: zh ? "自身" : "Self", exact: true }).click();
    ensure(await cost.getByText("$0.39", { exact: true }).count() === 0, "范围已切换但仍显示旧费用");
    await page.getByRole("button", { name: zh ? "包含子会话" : "Include child sessions", exact: true }).click();
    await cost.getByText("$0.39", { exact: true }).waitFor();
    await page.unroute(costRoute);
    await page.screenshot({ path: `${fixture.artifacts}/${fixture.language}-cost-overview.png` });
    const price = async overrides => {
      const response = await page.request.put(`${fixture.base}/api/v1/usage/pricing`, { data: { overrides, mappings: [] } });
      ensure(response.ok(), "合成价格未保存");
      await page.getByRole("button", { name: zh ? "用量统计" : "Usage", exact: true }).click();
      await page.getByRole("button", { name: zh ? "会话库" : "Sessions", exact: true }).click();
    };
    await price([{ model: "fixture-model", input: 4, output: 20, cacheRead: 0.4 }]);
    await cost.getByText("$0.78", { exact: true }).waitFor();
    await price([{ model: "fixture-model", input: 0, output: 0, cacheRead: 0 }]);
    await cost.getByText("$0.00", { exact: true }).waitFor();
    ensure(!(await cost.innerText()).includes(zh ? "未定价" : "unpriced"), "明确零价被当作未定价");
    await price([]);
    await cost.getByText("—", { exact: true }).waitFor();
    await help(zh ? `完整估价 0 · 部分 0 · 未定价 ${treeTotal}` : `Fully priced 0 · partial 0 · unpriced ${treeTotal}`);
    await page.screenshot({ path: `${fixture.artifacts}/${fixture.language}-cost-unpriced.png` });
    await price([{ model: "fixture-model", input: 2, output: 10 }]);
    await cost.getByText("$0.34", { exact: true }).waitFor();
    await cost.getByText(zh ? "估算费用小计" : "Estimated cost subtotal", { exact: true }).waitFor();
    await help(zh ? `完整估价 0 · 部分 ${treeTotal} · 未定价 0` : `Fully priced 0 · partial ${treeTotal} · unpriced 0`);
    await page.screenshot({ path: `${fixture.artifacts}/${fixture.language}-cost-partial.png` });
    await price([{ model: "fixture-model", input: 2, output: 10, cacheRead: 0.2 }]);
    await cost.getByText("$0.39", { exact: true }).waitFor();
    await help(zh ? `可估价请求依据：历史单价 0 · 当前快照 0 · 用户单价 ${treeTotal}` : `Priced requests: historical 0 · current snapshot 0 · manual ${treeTotal}`);
    await page.route(costRoute, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "synthetic pricing failure", messageDescriptor: { key: "common.error.query" } } }) }));
    await page.getByRole("button", { name: zh ? "收起会话画像" : "Collapse session profile", exact: true }).click();
    await page.getByRole("button", { name: zh ? "展开会话画像" : "Expand session profile", exact: true }).click();
    await cost.getByRole("button", { name: zh ? "重试" : "Retry", exact: true }).waitFor();
    ensure(await page.locator(".session-usage-grid").first().isVisible(), "费用错误阻断会话画像");
    await page.unroute(costRoute);
    await cost.getByRole("button", { name: zh ? "重试" : "Retry", exact: true }).click();
    await cost.getByText("$0.39", { exact: true }).waitFor();
    await page.getByRole("button", { name: zh ? "外观" : "Appearance", exact: true }).click();
    await page.getByRole("combobox", { name: zh ? "显示模式" : "Display mode", exact: true }).click();
    await page.getByRole("option", { name: zh ? "深色" : "Dark", exact: true }).click();
    await page.getByRole("dialog", { name: zh ? "外观" : "Appearance", exact: true }).press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: zh ? "会话统计" : "Session statistics", exact: true }).click();
    await cost.getByText("$0.39", { exact: true }).waitFor();
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "费用导致窄屏横向溢出");
    await page.screenshot({ path: `${fixture.artifacts}/${fixture.language}-cost-mobile-dark.png` });
    await page.setViewportSize({ width: 1560, height: 1080 });
    await page.getByRole("button", { name: zh ? "外观" : "Appearance", exact: true }).click();
    await page.getByRole("combobox", { name: zh ? "显示模式" : "Display mode", exact: true }).click();
    await page.getByRole("option", { name: zh ? "明亮" : "Light", exact: true }).click();
    await page.getByRole("dialog", { name: zh ? "外观" : "Appearance", exact: true }).press("Escape");
    ensure(errors.length === 0, errors.join(";"));
    return { passed: true, language: fixture.language, scopes: fixture.scopes, comparison: "profile-api-to-ui", cost: ["overview", "scope", "pagination", "manual-update", "zero", "unpriced", "partial", "help", "retry", "mobile-dark"], errors };
  };
  const reports = [];
  for (const language of ["zh-CN", "en"]) {
    await api("/preferences", { method: "PUT", headers: { "Content-Type": "application/json", "x-agent-manor-instance": service.instance.id }, body: JSON.stringify({ language }) });
    const result = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify({ language, artifacts, base, scopes })})`]);
    reports.push(result); console.log(result.split("### Ran Playwright code")[0]);
  }
  await writeFile(join(artifacts, "report.txt"), reports.join("\n"));
} catch (error) {
  if (opened) await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]).catch(() => {});
  throw error;
} finally {
  if (opened) await browser(["close"]).catch(() => {});
  await service?.close(); await rm(directory, { recursive: true, force: true });
}
