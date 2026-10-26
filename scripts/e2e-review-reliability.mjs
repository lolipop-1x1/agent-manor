import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { knowledgeFixture } from "./knowledge-fixture.mjs";
import { KnowledgeStore } from "../dist/knowledge/store.js";
import { SessionStore } from "../dist/sessions/store.js";

// 正式页面使用隔离合成数据；只有模型搜索响应以受控延迟构造竞态。
const fixture = await knowledgeFixture(), run = promisify(execFile), session = `review-reliability-${process.pid}`;
const artifacts = fileURLToPath(new URL("../.local/review-reliability-e2e/", import.meta.url));
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${session}`, ...args], { cwd: fixture.directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
const checks = [];
const step = async (name, callback, extra = {}) => {
  const output = await browser(["run-code", `async page => {
    const config = ${JSON.stringify({ base: fixture.base, artifacts, ...extra })};
    const ensure = (value, message) => { if (!value) throw new Error(message); };
    page.setDefaultTimeout(15_000);
    ${callback}
    return { passed: ${JSON.stringify(name)} };
  }`]);
  await writeFile(join(artifacts, `${String(checks.length + 1).padStart(2, "0")}.log`), output);
  checks.push(name); console.log(`PASS ${name}`);
};
const sessions = new SessionStore(join(fixture.home, "index.sqlite"));
const sessionId = "synthetic-review-session", sourcePath = "/synthetic/history/review-session.jsonl";
const occurredAt = new Date(Date.now() - 3_600_000).toISOString();
const publish = label => {
  const pending = sessions.createRevision(sourcePath, label);
  pending.sink.message({ id: "synthetic-review-input", sessionId, ordinal: 0, recordLine: 1, turnId: "synthetic-turn", kind: "user", text: "调用人工合成 Skill", occurredAt, resource: { kind: "skill_call", name: "synthetic-review-skill" } });
  pending.sink.message({ id: "synthetic-review-answer", sessionId, ordinal: 1, recordLine: 2, turnId: "synthetic-turn", kind: "assistant", text: `Synthetic response ${label}`, occurredAt, final: "explicit" });
  pending.sink.usage({ id: "synthetic-review-request", messageId: "synthetic-review-answer", turnId: "synthetic-turn", model: "synthetic-model", occurredAt, inputTokens: 100, outputTokens: 20 });
  pending.flush();
  sessions.finishRevision(pending.revision, { id: sessionId, client: "codex", clientSessionId: sessionId, path: sourcePath, sourceId: sessionId, title: "Synthetic versioned evidence", titleOrigin: "recorded", messageCount: 2, turnCount: 1, models: ["synthetic-model"], gaps: [], startedAt: occurredAt, updatedAt: occurredAt });
  const revisions = sessions.cachedRevisions().filter(item => item.path !== sourcePath);
  return sessions.publish(sessions.createJob().id, [...revisions, { path: sourcePath, revision: pending.revision, fingerprint: label }], []);
};
try {
  await mkdir(artifacts, { recursive: true });
  const store = new KnowledgeStore(join(fixture.home, "knowledge", "knowledge.sqlite"));
  try {
    for (let index = 0; index < 20; index++) store.create({ title: `合成末页条目 ${index}`, body: "仅用于隔离验证知识审批分页。", scope: { kind: "global" }, sources: [{ kind: "manual" }] });
    const ids = Array.from({ length: 25 }, (_, index) => `synthetic-review-task-${index}`);
    for (const [index, id] of ids.entries()) store.setState(`extraction.job:${id}`, {
      job: { id, previewId: "synthetic-preview", status: index === 0 ? "failed" : "complete", phase: "complete", createdAt: occurredAt, updatedAt: occurredAt,
        totalSessions: 1, completedSessions: 1, totalChunks: 1, completedChunks: 1, createdEntries: 1, updatedEntries: 0, duplicates: 0, noValue: 0, needsContext: 0,
        results: Array.from({ length: 500 }, (_, item) => ({ knowledgeId: `synthetic-result-${item}`, revisionId: `synthetic-revision-${item}` })), failedSessions: [], events: [], outputLanguage: "zh-CN", fingerprint: "synthetic" },
      preview: { targets: [{ title: `合成任务 ${index}` }] },
    });
    store.setState("extraction.manager", { previews: [], jobs: ids, idempotency: {}, automatic: { enabled: false } });
  } finally { store.close(); }
  const versionOne = publish("one");
  await browser(["open", `${fixture.base}/#sessions`, "--headed", "--browser=chrome"]);
  await step("语义搜索切页和连续请求恢复", `
    await page.route('**/api/v1/semantic/settings', async route => { const response = await route.fetch(), value = await response.json(); value.config.enabled = true; value.config.connection.model = 'synthetic-ready'; await route.fulfill({ response, json: value }); });
    await page.route('**/api/v1/semantic/status', async route => { const response = await route.fetch(), value = await response.json(); value.enabled = true; value.ready = true; await route.fulfill({ response, json: value }); });
    await page.route('**/api/v1/semantic/search', async route => { const input = route.request().postDataJSON(); await page.waitForTimeout(input.q === 'older-query' ? 1600 : 120); await route.fulfill({ json: { groups: [], total: 0, page: 1, pageSize: 12, mode: 'semantic', limited: false, coveredSessions: 4, version: config.version } }).catch(() => {}); });
    await page.reload();
    const button = name => page.getByRole('button', { name, exact: true });
    await button('语义').click();
    const input = page.getByRole('textbox', { name: '语义搜索内容', exact: true });
    await input.fill('older-query'); await button('搜索').click();
    await button('知识库').click(); await button('会话库').click();
    await page.waitForFunction(() => document.querySelector('.semantic-submit')?.getAttribute('aria-busy') === 'false');
    ensure(!(await button('搜索').isDisabled()), '返回后搜索按钮可用 ' + JSON.stringify({ input: await input.inputValue(), status: await page.locator('.semantic-status-button').innerText(), busy: await button('搜索').getAttribute('aria-busy'), html: await button('搜索').evaluate(el => el.outerHTML) }));
    ensure(await page.locator('.semantic-results').getAttribute('inert') === null, '返回后结果不遗留inert');
    await input.fill('older-query'); await button('搜索').click();
    await input.fill('newer-query'); await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('.semantic-submit')?.getAttribute('aria-busy') === 'false');
    await page.waitForTimeout(1800);
    ensure((await page.locator('.semantic-result-query').innerText()).includes('newer-query'), '旧请求不能覆盖较新查询');
  `, { version: versionOne });
  await step("审批末页最后一项自动回到有效页", `
    await page.goto(config.base + '/#knowledge?page=review&pageNumber=2&pageSize=20');
    await page.waitForFunction(() => document.querySelectorAll('.knowledge-entry').length === 1 && document.querySelector('.knowledge-reader')?.getAttribute('aria-busy') === 'false');
    await page.getByRole('button', { name: '确认并发布', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认并发布', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.knowledge-entry').length === 20 && document.querySelector('.knowledge-entry-list')?.getAttribute('aria-busy') === 'false');
    ensure(await page.evaluate(() => new URLSearchParams(location.hash.split('?')[1]).get('pageNumber') === '1'), '地址回到第一页');
    ensure((await page.locator('.knowledge-list-pane .resource-pager').innerText()).includes('1–20 / 20'), '分页与剩余结果一致');
  `);
  await step("任务列表使用摘要分页和服务端筛选", `
    const queries = []; const listener = request => { if (request.url().includes('/api/v1/knowledge/extractions')) queries.push(request.url()); };
    page.on('request', listener);
    await page.goto(config.base + '/#knowledge?page=tasks');
    await page.waitForFunction(() => document.querySelectorAll('.knowledge-task-list li').length === 20 && document.querySelector('.knowledge-task-list')?.getAttribute('aria-busy') === 'false');
    await page.getByRole('combobox', { name: '任务状态', exact: true }).click();
    await page.getByRole('option', { name: '失败', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.knowledge-task-list li').length === 1 && document.querySelector('.knowledge-task-list')?.getAttribute('aria-busy') === 'false');
    ensure(queries.some(url => url.includes('status=failed') && url.includes('response=summary')), '状态过滤先于后台分页');
    ensure(queries.every(url => url.includes('response=summary')), '列表没有完整任务轮询');
    await page.locator('.knowledge-task-list li button').click();
    await page.getByRole('heading', { name: '沉淀任务详情', exact: true }).waitFor();
    await page.getByRole('tab', { name: '结果', exact: true }).click();
    await page.getByRole('button', { name: '查看待审结果', exact: true }).waitFor();
    ensure(!(await page.getByRole('button', { name: '查看待审结果', exact: true }).isDisabled()), '摘要之外的任务详情仍可读取');
    page.off('request', listener);
  `);
  await step("保留旧版用量报告", `
    await page.goto(config.base + '/#usage');
    await page.getByRole('link', { name: '进入会话', exact: true }).first().waitFor();
    await page.waitForFunction(() => !document.querySelector('.usage-workspace')?.hasAttribute('inert'));
  `);
  const versionTwo = publish("two");
  await step("用量原文跳转保留报告版本", `
    const link = page.getByRole('link', { name: '进入会话', exact: true }).first();
    const address = await link.getAttribute('href');
    const copied = await page.context().newPage();
    try {
      await copied.goto(config.base + '/' + address);
      await copied.getByText('Synthetic response one', { exact: true }).first().waitFor();
      ensure(await copied.evaluate(version => new URLSearchParams(location.hash.split('?')[1]).get('version') === version, config.version), '新窗口复制链接保留旧版原文');
    } finally { await copied.close(); await page.bringToFront(); }
    await link.click();
    await page.waitForFunction(() => location.hash.startsWith('#sessions'));
    ensure(await page.evaluate(version => new URLSearchParams(location.hash.split('?')[1]).get('version') === version, config.version), '用量报告版本进入阅读地址');
    await page.getByText('Synthetic response one', { exact: true }).first().waitFor();
  `, { version: versionOne });
  const response = await fetch(`${fixture.base}/api/v1/resources/overview?kind=skill`), overview = await response.json();
  const identity = overview.resources.find(item => item.identity.name === "synthetic-review-skill").identity.id;
  await step("加载当前版资源证据", `
    await page.goto(config.base + '/#resources?kind=skill&id=' + encodeURIComponent(config.identity) + '&detail=history');
    await page.locator('.resource-evidence a').first().waitFor();
    await page.waitForFunction(() => document.querySelector('.resource-detail-body')?.getAttribute('aria-busy') === 'false');
    const address = await page.locator('.resource-evidence a').first().getAttribute('href');
    ensure(await page.evaluate(({ address, version }) => new URLSearchParams(address.split('?')[1]).get('version') === version, { address, version: config.version }), '可复制资源证据链接携带版本');
  `, { identity, version: versionTwo });
  publish("three");
  await step("资源证据点击保持旧版与消息位置", `
    await page.locator('.resource-evidence a').first().click();
    await page.waitForFunction(() => location.hash.startsWith('#sessions'));
    const params = await page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1])));
    ensure(params.version === config.version && params.message === 'synthetic-review-input', '资源回调与可复制链接定位一致');
  `, { version: versionTwo });
  assert.equal(fixture.calls.length, 0);
  await writeFile(join(artifacts, "summary.json"), JSON.stringify({ checks, modelCalls: fixture.calls.length }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, modelCalls: fixture.calls.length }));
} finally {
  sessions.close();
  await browser(["close"]).catch(() => {});
  await fixture.close();
}
