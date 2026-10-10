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

// 隔离人工历史，验证完整趋势、表格分页和父子会话范围。
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
    resourceInventory: { userHome: join(directory, "isolated-user"), environment: {} } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const api = async (path, options) => { const response = await fetch(`${base}/api/v1${path}`, options); assert.equal(response.status, 200); return response.json(); };
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
  assert.equal(own.steps.length, 210); assert.equal(tree.steps.length, 216);
  await browser(["open", base, "--headed", "--browser=chrome"]); opened = true;
  const verify = async (page, fixture) => {
    page.setDefaultTimeout(15_000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const ensure = (condition, message) => { if (!condition) throw new Error(message); };
    const zh = fixture.language === "zh-CN";
    await page.setViewportSize({ width: 1560, height: 1080 }); await page.reload();
    await page.getByRole("button", { name: zh ? "会话库" : "Sessions", exact: true }).click();
    await page.locator(".session-list-item").filter({ hasText: "长会话工作区验收" }).click();
    await page.getByRole("tab", { name: zh ? "用量" : "Usage", exact: true }).click();
    for (const total of [210, 216]) {
      if (total === 216) {
        await page.getByRole("button", { name: zh ? "包含子会话" : "Include child sessions", exact: true }).click();
        await page.waitForFunction(total => document.querySelector(".session-chart-hit")?.getAttribute("aria-valuemax") === String(total), total);
      }
      await page.locator(".session-step-table tbody tr").first().waitFor(); await page.waitForLoadState("networkidle");
      const hit = page.getByRole("slider", { name: zh ? "选择用量请求" : "Select usage request", exact: true });
      ensure(await hit.getAttribute("aria-valuemax") === String(total), `趋势末请求应为 ${total}，实际为 ${await hit.getAttribute("aria-valuemax")}`);
      const table = page.locator(".session-step-table tbody tr");
      const pager = page.getByRole("navigation", { name: zh ? "请求明细分页" : "Request details pagination", exact: true });
      const chart = () => page.locator(".session-usage-chart svg").evaluate(svg => [...svg.querySelectorAll("polyline")].map(line => line.getAttribute("points")));
      const before = await chart();
      ensure(before[0].split(" ").length === total, "趋势没有包含全部请求");
      ensure(await table.count() === 12 && (await table.first().innerText()).startsWith("#1\t"), "范围切换后请求表应从首页开始");
      const profileRequests = []; const record = request => { if (request.url().includes("/profile")) profileRequests.push(request.url()); };
      page.on("request", record);
      await pager.getByRole("button", { name: zh ? "请求明细分页下一页" : "Request details pagination next page", exact: true }).click();
      ensure((await table.first().innerText()).startsWith("#13\t"), "请求表没有翻到第二页");
      ensure(JSON.stringify(await chart()) === JSON.stringify(before), "表格翻页改变了完整趋势");
      await pager.getByRole("button", { name: zh ? "请求明细分页末页" : "Request details pagination last page", exact: true }).click();
      ensure((await table.last().innerText()).startsWith(`#${total}\t`), "表格末页请求编号错误");
      ensure(JSON.stringify(await chart()) === JSON.stringify(before), "表格末页改变了完整趋势");
      page.off("request", record); ensure(profileRequests.length === 0, "表格翻页重复获取画像");
      await hit.focus(); await page.keyboard.press("End");
      ensure(await hit.getAttribute("aria-valuenow") === String(total), "图表键盘未覆盖末请求");
      const tooltip = page.getByRole("tooltip"); await tooltip.waitFor();
      ensure((await tooltip.innerText()).includes(String(total)), "末请求提示编号错误");
      await page.keyboard.press("Enter");
      await page.locator(".session-message.is-focused, .trace-detail-body").waitFor();
      ensure((await page.locator(".session-message.is-focused, .trace-detail-body").innerText()).includes(zh ? "请求用量（记录值）" : "Request usage (recorded values)"), "图表末请求未定位用量记录");
      await page.screenshot({ path: `${fixture.artifacts}/${fixture.language}-${total}.png` });
    }
    ensure(errors.length === 0, errors.join(";"));
    return { passed: true, language: fixture.language, scopes: [210, 216], errors };
  };
  const reports = [];
  for (const language of ["zh-CN", "en"]) {
    await api("/preferences", { method: "PUT", headers: { "Content-Type": "application/json", "x-agent-manor-instance": service.instance.id }, body: JSON.stringify({ language }) });
    const result = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify({ language, artifacts })})`]);
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
