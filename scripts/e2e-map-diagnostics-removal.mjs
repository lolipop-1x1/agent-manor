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

// 使用隔离仓库与人工历史，真实诊断和截图不写入公开样本。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-map-diagnostics-")));
const artifacts = fileURLToPath(new URL("../.local/map-diagnostics-e2e/", import.meta.url));
const session = `map-diagnostics-${process.pid}`;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${session}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
let service;
try {
  await mkdir(artifacts, { recursive: true });
  const repository = join(directory, "repo"), history = join(directory, "history"), home = join(directory, "data");
  await mkdir(join(repository, "src"), { recursive: true }); await mkdir(history); await mkdir(home);
  await run("git", ["init", "-q", repository]);
  await writeFile(join(repository, "src/a.ts"), "alpha\nbeta\n");
  const records = [
    { type: "session_meta", payload: { id: "synthetic-map", cwd: repository } },
    { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "read", arguments: JSON.stringify({ cmd: "cat src/a.ts", workdir: repository }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "read", output: "Exit code: 0\nOutput:\nalpha\nbeta\n" } },
    { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "unknown", arguments: JSON.stringify({ cmd: "cat $FILE", workdir: repository }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "unknown", output: "Exit code: 0\nOutput:\n" } },
  ];
  await writeFile(join(history, "source.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
  await writePreferences(home, "zh-CN");
  service = await startService({ home, port: 0, roots: Object.fromEntries(clientIds.map(client => [client, client === "codex" ? history : []])), resourceInventory: { environment: {} } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const api = async (path, body) => {
    const response = await fetch(`${base}/api/v1${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    assert.equal(response.status, 200); return response.json();
  };
  const registration = await api("/repositories", { path: repository });
  for (let attempt = 0; attempt < 200; attempt++) {
    const { job } = await api(`/jobs/${registration.job.id}`);
    assert.notEqual(job.status, "failed");
    if (job.status === "completed") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const coverage = await api(`/repositories/${registration.repository.id}/coverage`);
  assert.equal(coverage.summary.readExact.lines, 2);
  assert.ok(coverage.gaps.some(gap => gap.kind === "unsupported_tool"));
  await browser(["open", `${base}/#map`, "--headed", "--browser=chrome"]);
  const verify = async (page, output) => {
    const ensure = (value, message) => { if (!value) throw new Error(message); };
    const button = name => page.getByRole("button", { name, exact: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator(".code-map").waitFor();
    ensure(await button("来源与缺口").count() === 0 && await page.locator(".coverage-gaps").count() === 0, "诊断入口未移除");
    await page.locator('.map-file[data-path="src/a.ts"]').click();
    await page.getByRole("heading", { name: "a.ts", exact: true }).waitFor();
    ensure(await page.locator(".event-list").getByRole("button").count() === 1, "文件活动回查失效");
    await page.screenshot({ path: output + "/desktop-zh.png" });
    await button("外观").click(); await page.getByRole("combobox", { name: "显示模式", exact: true }).click(); await page.getByRole("option", { name: "深色", exact: true }).click();
    await page.getByRole("dialog", { name: "外观", exact: true }).press("Escape");
    await button("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
    ensure(await button("Sources and gaps").count() === 0, "英文仍有诊断入口");
    await page.setViewportSize({ width: 390, height: 844 });
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "窄屏横向溢出");
    ensure(await page.locator(".code-map").isVisible(), "窄屏地图不可见");
    await page.screenshot({ path: output + "/mobile-dark-en.png" });
    return { removedDiagnosticsEntry: true, retainedApiDiagnostics: true, map: true, fileEvents: true, languages: ["zh-CN", "en"], themes: ["light", "dark"], narrow: true };
  };
  const result = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify(artifacts)})`]);
  await writeFile(join(artifacts, "report.txt"), result);
  console.log(result.split("### Ran Playwright code")[0]);
} catch (error) {
  await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]).catch(() => {});
  throw error;
} finally {
  await browser(["close"]).catch(() => {});
  await service?.close(); await rm(directory, { recursive: true, force: true });
}
