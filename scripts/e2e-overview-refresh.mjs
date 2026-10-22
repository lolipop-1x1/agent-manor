import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SessionStore } from "../dist/sessions/store.js";
import { weeklyReviewFixture } from "./weekly-review-fixture.mjs";

// 新历史、失败注入、显示偏好及截图均来自隔离合成后台。
const run = promisify(execFile), fixture = await weeklyReviewFixture({ dimensionIdentities: true });
const artifacts = fileURLToPath(new URL("../.local/overview-refresh-e2e/", import.meta.url));
const session = `overview-refresh-${process.pid}`;
let opened = false, publication = 0;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${session}`, ...args], {
    cwd: fixture.directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
const publish = () => {
  const store = new SessionStore(join(fixture.home, "index.sqlite"));
  try {
    const sources = store.cachedRevisions(), id = `synthetic-publication-${++publication}`, path = `/synthetic/history/${id}.jsonl`;
    const pending = store.createRevision(path, id), date = new Date(); date.setDate(date.getDate() - 1); date.setHours(10, 0, 0, 0);
    pending.sink.message({ id: `${id}:user`, sessionId: id, ordinal: 0, recordLine: 1, turnId: "turn", kind: "user", text: "检查合成更新", occurredAt: date.toISOString() });
    date.setMinutes(1);
    pending.sink.message({ id: `${id}:reply`, sessionId: id, ordinal: 1, recordLine: 2, turnId: "turn", kind: "assistant", text: "合成检查完成", final: "explicit", occurredAt: date.toISOString() });
    pending.sink.usage({ id: `${id}:request`, messageId: `${id}:reply`, turnId: "turn", occurredAt: date.toISOString(), model: "review-fast", inputTokens: 100, outputTokens: 20 });
    pending.flush();
    store.finishRevision(pending.revision, { id, client: "codex", clientSessionId: id, sourceId: id, path,
      title: "合成新历史", titleOrigin: "recorded", models: ["review-fast"], messageCount: 2, turnCount: 1, gaps: [] });
    return store.publish(store.createJob().id, [...sources, { path, revision: pending.revision, fingerprint: id }], []);
  } finally { store.close(); }
};
const code = async (fn, options = {}) => {
  const output = await browser(["run-code", `async page => (${fn.toString()})(page, ${JSON.stringify({ artifacts, ...options })})`]);
  console.log(output.split("### Ran Playwright code")[0]);
  return output;
};
try {
  await mkdir(artifacts, { recursive: true });
  await browser(["open", `${fixture.base}/#overview`, "--headed", "--browser=chrome"]); opened = true;
  await code(async page => {
    page.__overviewErrors = []; page.on("pageerror", error => page.__overviewErrors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator(".overview-results[aria-busy='false']").waitFor();
    await page.locator(".weekly-review[aria-busy='false'] .weekly-review-groups").waitFor();
    await page.locator(".weekly-review-metric").filter({ has: page.getByText("平均模型步骤", { exact: true }) }).click();
    await page.locator(".weekly-review-dialog .overview-investigation-body[aria-busy='false']").waitFor();
    await page.locator(".weekly-review-dialog .resource-pager").getByRole("button", { name: /下一页/ }).click();
    await page.locator(".weekly-review-dialog .overview-investigation-body[aria-busy='false']").waitFor();
    const body = page.locator(".weekly-review-dialog .overview-investigation-body"), row = page.locator(".weekly-review-record-title").nth(5);
    await row.focus(); await body.evaluate(element => { element.scrollTop = 350; });
    page.__overviewHeld = { title: await page.locator(".weekly-review-dialog h2").innerText(), summary: await page.locator(".weekly-review-summary").innerHTML(),
      rows: await page.locator(".weekly-review-records tbody").innerHTML(), scroll: await body.evaluate(element => element.scrollTop), focus: await row.getAttribute("data-overview-focus") };
    await page.route("**/api/v1/overview/review?**", async route => { await new Promise(resolve => { page.__releaseReview = resolve; }); await route.continue(); });
    return { prepared: true, page: 2 };
  });
  const firstVersion = publish();
  await code(async (page, options) => {
    const ensure = (value, message) => { if (!value) throw new Error(message); };
    await page.locator(".weekly-review[aria-busy='true']").waitFor();
    const body = page.locator(".weekly-review-dialog .overview-investigation-body");
    await body.locator("[inert] .weekly-review-record-title").first().waitFor();
    ensure(await page.locator(".weekly-review-dialog").isVisible(), "新历史通知关闭详情");
    ensure(await page.locator(".weekly-review-records tbody").innerHTML() === page.__overviewHeld.rows, "报告等待期间记录改变");
    ensure(await page.locator(".weekly-review-summary").innerHTML() === page.__overviewHeld.summary, "报告等待期间摘要改变");
    await page.screenshot({ path: `${options.artifacts}/refresh-pending.png` });
    await page.route("**/api/v1/overview/review/detail?**", async route => {
      page.__overviewDetailUrl = route.request().url();
      await new Promise(resolve => { page.__releaseDetail = resolve; }); await route.continue();
    });
    const request = page.waitForRequest(value => value.url().includes("/overview/review/detail?"));
    page.__releaseReview(); await request;
    ensure(await page.locator(".weekly-review-summary").innerHTML() === page.__overviewHeld.summary, "新报告混入旧详情摘要");
    ensure(await page.locator(".weekly-review-records tbody").innerHTML() === page.__overviewHeld.rows, "新详情等待期间旧记录被清空");
    const query = await page.evaluate(url => { const parameters = new URL(url).searchParams; return { version: parameters.get("version"), detail: JSON.parse(parameters.get("detail")) }; }, page.__overviewDetailUrl);
    ensure(query.version === options.version, "详情未采用新历史版本");
    ensure(query.detail.page === 2, "新版本重置了详情页码");
    await page.screenshot({ path: `${options.artifacts}/detail-pending.png` });
    page.__releaseDetail();
    await body.locator("[inert]").first().waitFor({ state: "hidden" });
    await body.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector(".weekly-review-dialog .overview-investigation-body")?.getAttribute("aria-busy") === "false");
    ensure(Math.abs(await body.evaluate(element => element.scrollTop) - page.__overviewHeld.scroll) < 2, "更新丢失滚动位置");
    ensure(await page.evaluate(() => document.activeElement?.getAttribute("data-overview-focus")) === page.__overviewHeld.focus, "更新丢失原记录焦点");
    ensure(await page.locator(".weekly-review-dialog h2").innerText() === page.__overviewHeld.title, "更新丢失调查对象");
    ensure(await page.locator(".weekly-review-summary").innerHTML() !== page.__overviewHeld.summary, "详情没有整体替换到新报告");
    await page.screenshot({ path: `${options.artifacts}/refresh-success.png` });
    await page.unroute("**/api/v1/overview/review?**"); await page.unroute("**/api/v1/overview/review/detail?**");
    await page.route("**/api/v1/overview/review?**", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Synthetic refresh failure" } }) }));
    page.__overviewHeld.rows = await page.locator(".weekly-review-records tbody").innerHTML();
    return { updatePreservesDialog: true, atomicSummary: true, page: 2, scroll: true, focus: true };
  }, { version: firstVersion });
  publish();
  await code(async (page, options) => {
    const ensure = (value, message) => { if (!value) throw new Error(message); };
    const dialog = page.locator(".weekly-review-dialog"), body = dialog.locator(".overview-investigation-body");
    await dialog.getByRole("alert").waitFor();
    ensure(await dialog.isVisible(), "刷新失败关闭详情");
    ensure(await dialog.getByRole("alert").evaluate(element => { const rect = element.getBoundingClientRect(), parent = element.closest(".weekly-review-dialog").getBoundingClientRect(); return rect.top >= parent.top && rect.bottom <= parent.bottom; }), "滚动后刷新错误不在可视区域");
    ensure(await page.locator(".weekly-review-records tbody").innerHTML() === page.__overviewHeld.rows, "刷新失败清空旧记录");
    ensure(await dialog.locator("[inert] .weekly-review-record-title").count() > 0, "刷新失败仍可下钻旧记录");
    await page.screenshot({ path: `${options.artifacts}/refresh-failure.png` });
    await page.unroute("**/api/v1/overview/review?**");
    await dialog.getByRole("button", { name: "重试", exact: true }).click();
    await body.locator("[inert]").first().waitFor({ state: "hidden" });
    await dialog.getByRole("alert").waitFor({ state: "hidden" });
    ensure(await dialog.isVisible(), "重试关闭详情");
    await page.screenshot({ path: `${options.artifacts}/refresh-retry.png` });
    await page.keyboard.press("Escape");
    for (const [metric, field] of [["常用模型", "model"], ["常用思考程度", "reasoning"]]) {
      await page.locator(".weekly-review-metric").filter({ has: page.getByText(metric, { exact: true }) }).click();
      await dialog.locator(".overview-investigation-body[aria-busy='false']").waitFor();
      await dialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined))));
      await page.screenshot({ path: `${options.artifacts}/${field}-identities.png` });
      for (const name of ["未知", "unknown", "literal:unknown"]) {
        const rank = page.locator(".weekly-review-ranks tbody tr").filter({ has: page.getByRole("button", { name, exact: true }) });
        ensure(await rank.count() === 1, `${field} 的 ${name} 身份不独立`);
        const expected = Number((await rank.locator("td").nth(1).innerText()).replaceAll(",", ""));
        await rank.getByRole("button", { name, exact: true }).click();
        await dialog.locator(".overview-investigation-body[aria-busy='false']").waitFor();
        ensure(await page.locator(".weekly-review-records tbody tr").count() === expected, `${field} 的 ${name} 明细漏项或重复`);
        ensure(await dialog.locator("h2").innerText() === name, `${field} 的 ${name} 标题未保留原文或未翻译`);
        await dialog.getByRole("button", { name: "返回", exact: true }).click();
        await dialog.locator(".overview-investigation-body[aria-busy='false']").waitFor();
      }
      await page.keyboard.press("Escape");
    }
    await page.getByRole("button", { name: "显示语言", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByRole("combobox", { name: "Display mode", exact: true }).click();
    await page.getByRole("option", { name: "Dark", exact: true }).click(); await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".weekly-review-metric").filter({ has: page.getByText("Most-used models", { exact: true }) }).click();
    await dialog.locator(".overview-investigation-body[aria-busy='false']").waitFor();
    await page.locator(".weekly-review-ranks").getByRole("button", { name: "Unknown", exact: true }).click();
    await dialog.locator(".overview-investigation-body[aria-busy='false']").waitFor();
    ensure(await dialog.locator("h2").innerText() === "Unknown", "英文缺失身份标题未翻译");
    ensure(await dialog.evaluate(element => element.getBoundingClientRect().right <= innerWidth), "英文窄屏详情越界");
    await dialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined))));
    await page.screenshot({ path: `${options.artifacts}/english-dark-mobile.png` });
    ensure(page.__overviewErrors.length === 0, `浏览器运行错误：${page.__overviewErrors.join(";")}`);
    return { passed: true, failurePreservesDialog: true, retry: true, modelIdentities: true, reasoningIdentities: true, englishDarkMobile: true };
  });
  await writeFile(`${artifacts}/result.json`, JSON.stringify({ passed: true, historyPublications: publication, screenshots: 8 }, null, 2));
  assert.equal(publication, 2);
} finally { if (opened) await browser(["close"]).catch(() => undefined); await fixture.close(); }
