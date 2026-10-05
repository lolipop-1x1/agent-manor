import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { desktopFixture, desktopNativeFixture, encodeDesktop } from "./desktop-fixture.mjs";
import { ideFixture } from "./ide-fixture.mjs";

// 真实 CLI、后台、Worker、HTTP 与 Chrome；全部输入为人工样本。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-desktop-e2e-")));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const repository = join(directory, "sample-workspace");
const desktopRoot = join(directory, "desktop/sessions");
const source = join(desktopRoot, "desktop-session/message/cache.jsonl");
const env = { ...process.env, AGENT_MANOR_HOME: join(directory, "data"), AGENT_MANOR_PORT: "0",
  AGENT_MANOR_CODEX_DIR: join(directory, "missing-codex"), AGENT_MANOR_CLAUDE_DIR: join(directory, "missing-claude"),
  AGENT_MANOR_CODEFLICKER_DIR: join(directory, "cli-history"), AGENT_MANOR_CODEFLICKER_DESKTOP_DIR: desktopRoot,
  AGENT_MANOR_CODEFLICKER_DESKTOP_DB: join(directory, "missing-app.db") };
const command = async args => JSON.parse((await run(process.execPath, [cli, ...args, "--json"], { cwd: directory, env, timeout: 60_000 })).stdout);
const browserSession = `fd${process.pid}`;
const browser = async args => {
  const result = await run("playwright-cli", [`-s=${browserSession}`, ...args], { cwd: directory,
    env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.stdout.includes("### Error")) throw new Error(result.stdout);
  return result.stdout;
};
try {
  for (const path of [join(repository, "src"), dirname(source), join(desktopRoot, "desktop-session/checkpoints"),
    join(desktopRoot, "desktop-session/claude-session"), env.AGENT_MANOR_CODEFLICKER_DIR]) await mkdir(path, { recursive: true });
  await run("git", ["init", "-q", repository]);
  await writeFile(join(repository, "src/entry.ts"), "export const healthy = true;\nexport const updated = true;\n");
  await writeFile(source, encodeDesktop(desktopFixture(repository)));
  await writeFile(join(desktopRoot, "desktop-session/checkpoints/registry.json"), JSON.stringify({ sessionId: "desktop-session", cwd: repository }));
  await writeFile(join(desktopRoot, "desktop-session/claude-session/native.jsonl"), encodeDesktop(desktopNativeFixture));
  await writeFile(join(env.AGENT_MANOR_CODEFLICKER_DIR, "cli.jsonl"), encodeDesktop([
    { type: "message", role: "user", sessionId: "desktop-session", uuid: "cli-user", cwd: repository, content: "CLI 历史保持独立" },
    { type: "message", role: "assistant", sessionId: "desktop-session", uuid: "cli-final", content: "CLI 回答" },
  ]));
  const ide = ideFixture(desktopRoot, repository);
  ide.db.close();
  const sqlitePath = join(desktopRoot, "composer_data.sqlite");
  const sqliteOriginal = await readFile(sqlitePath);
  const original = await readFile(source);
  const registered = await command(["register", repository, "--wait"]);
  assert.equal(registered.job.status, "completed");
  const repositoryId = registered.repository.id;
  assert.equal((await command(["sessions", "refresh", "--wait"])).job.status, "complete");
  const coverage = await command(["coverage", repositoryId, "--client", "codeflicker-desktop"]);
  assert.deepEqual(coverage.summary.readExact, { files: 1, lines: 2 });
  assert.deepEqual(coverage.summary.editExact, { files: 1, lines: 1 });
  assert.equal((await command(["coverage", repositoryId, "--client", "codeflicker"])).summary.readExact.lines, 0);
  const events = await command(["events", repositoryId, "--client", "codeflicker-desktop"]);
  const evidence = await command(["evidence", repositoryId, events.events.find(event => event.tool === "read_file").id, "--client", "codeflicker-desktop"]);
  assert.equal(evidence.records.length, 2);
  assert.equal(evidence.unavailable.length, 0);
  const desktop = (await command(["sessions", "list", "--client", "codeflicker-desktop"])).sessions;
  const cliSessions = (await command(["sessions", "list", "--client", "codeflicker"])).sessions;
  assert.equal(desktop.length, 3); assert.equal(cliSessions.length, 1);
  assert.notEqual(desktop[0].id, cliSessions[0].id);
  const native = desktop.find(session => session.clientSessionId === "desktop-session");
  const ideSession = desktop.find(session => session.clientSessionId === "ide-main");
  assert.equal(ideSession.title, "SQLite 入口核对");
  assert.equal(ideSession.project, repository);
  const ideEvidence = await command(["evidence", repositoryId, events.events.find(event => event.tool === "readFile").id]);
  assert.equal(ideEvidence.unavailable.length, 0);
  assert.ok(ideEvidence.records.every(record => record.source.path === sqlitePath && record.source.selector === "composerData:ide-main"));
  assert.equal((await command(["sessions", "messages", ideSession.id, "--mode", "brief"])).total, 2);
  const profile = await command(["sessions", "profile", native.id]);
  assert.equal(profile.usage.inputTokens, 200); assert.equal(profile.usage.cacheReadRatio, 0.6);
  const brief = await command(["sessions", "messages", native.id, "--mode", "brief"]);
  assert.equal(brief.messages.length, 2);
  const hits = await command(["sessions", "search", "桌面历史核对", "--client", "codeflicker-desktop"]);
  assert.equal(hits.total, 1);
  const status = await command(["status"]);
  const url = `http://127.0.0.1:${status.instance.port}`;
  const response = await fetch(`${url}/api/v1/repositories/${repositoryId}/coverage?client=codeflicker-desktop&version=${coverage.version}`);
  assert.deepEqual(await response.json(), coverage);
  await browser(["open", url, "--headed", "--browser=chrome"]);
  const code = async page => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const ensure = (condition, message) => { if (!condition) throw new Error(message); };
    await page.setViewportSize({ width: 1560, height: 1080 });
    const clients = page.locator(".filters select").first();
    ensure((await clients.locator("option").allTextContents()).includes("CodeFlicker CLI"), "地图缺少 CLI 名称");
    ensure((await clients.locator("option").allTextContents()).includes("CodeFlicker 桌面版"), "地图缺少桌面版选项");
    await clients.selectOption("codeflicker-desktop");
    await page.waitForFunction(() => document.querySelector(".metric-primary strong")?.textContent === "100.0%");
    await page.getByRole("button", { name: "历史修改", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".metric-primary strong")?.textContent === "50.0%");
    await page.getByRole("button", { name: "会话库", exact: true }).click();
    await page.getByLabel("筛选客户端").selectOption("codeflicker-desktop");
    await page.waitForFunction(() => document.querySelectorAll(".session-list-item").length === 3);
    await page.locator(".session-list-item").filter({ hasText: "验证桌面历史检索" }).click();
    await page.locator(".session-message").first().waitFor();
    ensure((await page.locator(".sessions-main-heading h1").innerText()) === "验证桌面历史检索", "桌面标题不正确");
    ensure(await page.locator(".session-message").count() === 2, "简易模式应只保留用户和最终回答");
    await page.getByRole("tab", { name: "完整", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".session-message").length === 9);
    ensure((await page.locator(".session-profile-content").innerText()).includes("fixture-desktop-model"), "模型未关联原生记录");
    await page.getByRole("tab", { name: "调用", exact: true }).click();
    ensure((await page.locator(".session-profile-content").innerText()).includes("check-example"), "Skill 统计未展示");
    await page.getByRole("tab", { name: "用量", exact: true }).click();
    ensure((await page.locator(".session-profile-content").innerText()).includes("60.0%"), "缓存比例不正确");
    await page.getByLabel("搜索会话标题和消息").fill("桌面历史核对");
    await page.getByRole("region", { name: "全局搜索命中", exact: true }).locator(".session-hit").first().click();
    await page.locator(".session-message.is-focused").waitFor();
    ensure((await page.locator(".session-message.is-focused").innerText()).includes("桌面历史核对完成"), "搜索没有定位到正文");
    await page.getByLabel("搜索会话标题和消息").fill("");
    await page.locator(".session-list-item").filter({ hasText: "SQLite 入口核对" }).click();
    await page.waitForFunction(() => document.querySelector(".sessions-main-heading h1")?.textContent === "SQLite 入口核对");
    await page.getByRole("tab", { name: "完整", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".session-message").length === 10);
    await page.getByRole("tab", { name: "调用", exact: true }).click();
    ensure((await page.locator(".session-profile-content").innerText()).includes("lookup"), "SQLite MCP 调用未展示");
    await page.getByRole("tab", { name: "简易", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".session-message").length === 2);
    await page.getByLabel("筛选客户端").selectOption("codeflicker");
    await page.waitForFunction(() => document.querySelectorAll(".session-list-item").length === 1);
    await page.locator(".session-list-item").click();
    await page.waitForFunction(() => document.querySelector(".sessions-main-heading h1")?.textContent === "CLI 历史保持独立");
    ensure(errors.length === 0, `浏览器错误: ${errors.join(",")}`);
    return { codeMapRead: "100%", codeMapEdit: "50%", clientsIsolated: true, fullMessages: 9, briefMessages: 2, search: true, model: true, profile: true, errors };
  };
  const output = await browser(["run-code", `(${code.toString()})`]);
  assert.equal(await readFile(source, "utf8"), original.toString());
  assert.deepEqual(await readFile(sqlitePath), sqliteOriginal);
  await mkdir(fileURLToPath(new URL("../.local/", import.meta.url)), { recursive: true });
  await writeFile(fileURLToPath(new URL("../.local/desktop-e2e-result.json", import.meta.url)), JSON.stringify({ passed: true, output }, null, 2));
  console.log("桌面版端到端通过：CLI/Worker/HTTP/真实 Chrome，读取2行、修改1行、简易2条/完整9条、模型/缓存/Skill/搜索、CLI身份隔离、SQLite 标题/项目/MCP/简易2条/完整10条、双格式来源只读。");
} finally {
  await browser(["close"]).catch(() => undefined);
  await command(["stop"]).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
