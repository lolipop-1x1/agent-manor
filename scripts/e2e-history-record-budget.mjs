import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { zstdCompressSync } from "node:zlib";
import { AnalysisStore } from "../dist/index/store.js";
import { refreshRepository } from "../dist/index/refresh.js";
import { SessionStore } from "../dist/sessions/store.js";
import { refreshSessions } from "../dist/sessions/refresh.js";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";
import { translate } from "../dist/i18n/index.js";

const run = promisify(execFile), directory = await mkdtemp(join(tmpdir(), "manor-record-budget-"));
const artifacts = resolve(".local/history-record-budget-e2e"), session = `record-budget-${process.pid}`;
let service, opened = false;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${session}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
try {
  const home = join(directory, "data"), history = join(directory, "history"), repo = join(directory, "repo");
  await Promise.all([mkdir(home), mkdir(history), mkdir(join(repo, "src"), { recursive: true }), mkdir(artifacts, { recursive: true })]);
  await run("git", ["init", "-q", repo]);
  await writeFile(join(repo, "src/demo.ts"), "export const demo = 1;\n");
  const call = id => ({ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: id, arguments: JSON.stringify({ cmd: "cat src/demo.ts" }) } });
  const result = id => ({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: JSON.stringify({ exit_code: 0, output: "export const demo = 1;\n" }) } });
  const records = [{ type: "session_meta", payload: { id: "synthetic-large-context", cwd: repo } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "压缩前的合成问题" }] } }, call("before"), result("before"),
    { type: "compacted", replacement_history: [{ role: "user", content: "x".repeat(16 * 1024 * 1024) }] }, call("after"), result("after"),
    ...Array.from({ length: 22 }, (_, index) => ({ type: `synthetic_unknown_${index}` }))];
  await writeFile(join(history, "demo.jsonl.zst"), zstdCompressSync(records.map(record => JSON.stringify(record) + "\n").join("")));
  const roots = Object.fromEntries(clientIds.map(client => [client, client === "codex" ? [history] : []]));
  const store = new AnalysisStore(join(home, "index.sqlite"));
  const sessions = new SessionStore(store.dbPath);
  let repository;
  try {
    repository = await store.registerRepository(repo);
    const job = store.createJob(repository.id); await refreshRepository(store, job.id, roots);
    assert.equal(store.getJob(job.id).status, "completed");
    const historyJob = sessions.createJob(); await refreshSessions(sessions, historyJob.id, roots, false, { concurrency: 1 });
    assert.equal(sessions.getJob(historyJob.id).status, "complete");
  } finally { sessions.close(); store.close(); }
  service = await startService({ home, startupRefresh: false, roots, resourceInventory: { userHome: join(directory, "isolated-user"), environment: {} }, usagePricing: { fetch: async () => Response.json({}) } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const coverage = await (await fetch(`${base}/api/v1/repositories/${repository.id}/coverage?summary=true`)).json();
  assert.equal(coverage.gapCount, 23);
  await browser(["open", base, "--headed", "--browser=chrome"]); opened = true;
  const verify = async (page, options) => {
    page.setDefaultTimeout(15_000);
    const checks = [], errors = [];
    const ensure = (value, description) => { if (!value) throw new Error(description); checks.push(description); };
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width: options.width, height: 950 });
    let gapRequests = 0;
    page.on("request", request => { if (request.url().includes("/coverage/gaps")) gapRequests++; });
    await page.goto(`${options.base}/?record-budget=${options.language}-${options.width}#map?repository=${options.repository}`);
    await page.locator(".metrics").waitFor();
    await page.locator(".map-query-loading").waitFor({ state: "hidden" });
    ensure(gapRequests === 0, "分析信息折叠时不读取缺口明细");
    ensure(await page.locator(".code-map-page .notice.danger").count() === 0, "超限记录不会显示地图刷新失败");
    const fail = route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic gap failure" }) });
    await page.route("**/coverage/gaps?**", fail);
    await page.locator(".baseline-note summary").click();
    await page.locator(".map-analysis-gaps [role='alert']").waitFor();
    ensure(await page.locator(".metrics").isVisible(), "缺口明细失败保留地图统计");
    await page.unroute("**/coverage/gaps?**", fail);
    const mismatch = route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: "synthetic-wrong-version", gaps: [] }) });
    await page.route("**/coverage/gaps?**", mismatch);
    await page.locator(".map-analysis-gaps").getByRole("button", { name: options.retry, exact: true }).click();
    await page.getByRole("alert").getByText(options.versionError).waitFor();
    ensure(true, "缺口明细拒绝混用其他分析版本");
    await page.unroute("**/coverage/gaps?**", mismatch);
    await page.locator(".map-analysis-gaps").getByRole("button", { name: options.retry, exact: true }).click();
    await page.locator(".map-analysis-gaps li").first().waitFor();
    ensure((await page.locator(".map-analysis-gaps li").allTextContents()).some(text => text.includes(options.budget)), "缺口显示当前语言的行号及超限原因");
    ensure(await page.locator(".map-analysis-gaps li").count() === 20, "缺口按需分页，首屏不渲染全部记录");
    const next = page.locator(".map-analysis-gaps .resource-pager .resource-page-controls button").last();
    await next.click();
    ensure(await page.locator(".map-analysis-gaps li").count() === 3, "缺口分页可查看剩余记录");
    await page.locator(".map-analysis-gaps .resource-page-controls button").first().click();
    await page.locator(".baseline-note").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${options.artifacts}/${options.language}-${options.width}-map-gaps-pagination.png` });
    await page.locator(".baseline-note summary").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${options.artifacts}/${options.language}-${options.width}-map-gaps.png` });
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "缺口详情无横向溢出");
    const requests = gapRequests;
    await page.locator(".baseline-note summary").click(); await page.locator(".baseline-note summary").click();
    ensure(gapRequests === requests, "重复展开复用同版缺口结果");
    ensure(errors.length === 0, errors.join("; ") || "页面无运行错误");
    return { language: options.language, width: options.width, checks };
  };
  const reports = [];
  for (const [language, mode, width] of [["zh-CN", "light", 1440], ["en", "dark", 1440], ["zh-CN", "dark", 390], ["en", "light", 390]]) {
    const response = await fetch(`${base}/api/v1/preferences`, { method: "PUT", headers: { "Content-Type": "application/json", "x-agent-manor-instance": service.instance.id }, body: JSON.stringify({ language, appearance: { mode } }) });
    assert.ok(response.ok);
    reports.push(JSON.parse((await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify({ base, repository: repository.id, artifacts, language, width, retry: translate(language, "common.retry"), versionError: translate(language, "codeMap.error.versionCoverage"), budget: translate(language, "diagnostics.history.index.recordBudget", { line: 5 }) })})`, "--raw"])).trim()));
  }
  await writeFile(join(artifacts, "report.json"), JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports));
} catch (error) {
  if (opened) {
    console.error(await browser(["run-code", "async page => ({info: await page.locator('.baseline-note').allTextContents(), gaps: await page.locator('.map-analysis-gaps').allTextContents(), errors: await page.getByRole('alert').allTextContents()})", "--raw"]).catch(() => "无法读取失败页面"));
    await browser(["screenshot", `--filename=${artifacts}/failure.png`]).catch(() => {});
  }
  throw error;
} finally {
  if (opened) await browser(["close"]).catch(() => {});
  await service?.close(); await rm(directory, { recursive: true, force: true });
}
