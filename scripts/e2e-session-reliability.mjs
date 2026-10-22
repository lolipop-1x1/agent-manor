import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalysisStore } from '../dist/index/store.js';
import { SessionStore } from '../dist/sessions/store.js';
import { startService } from '../dist/server.js';
import { clientIds } from '../dist/clients.js';
import { writePreferences } from '../dist/service/preferences.js';

// 所有历史及失败响应均为隔离合成数据。
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'manor-review-'));
const artifacts = new URL('../.local/session-reliability-e2e/', import.meta.url).pathname;
await mkdir(artifacts, { recursive: true });
const home = join(directory, 'data');
await mkdir(home);
await writePreferences(home, 'zh-CN');
const db = join(home, 'index.sqlite');
new AnalysisStore(db).close();
const store = new SessionStore(db);
const revisions = [];
for (let index = 0; index < 85; index++) {
  const id = `review-${String(index).padStart(2, '0')}`;
  const path = `/workspace/review/${id}.jsonl`;
  const pending = store.createRevision(path, 'synthetic');
  const messages = index === 0 ? [
    { kind: 'user', text: '共同标记 合成问题' },
    ...Array.from({ length: 30 }, (_, i) => ({ kind: 'tool_result', text: `共同标记 工具结果 ${i}` })),
    { kind: 'assistant', text: '共同标记 合成回复', final: 'recorded' },
  ] : [{ kind: 'user', text: `会话问题 ${index}` }, { kind: 'assistant', text: `会话回复 ${index}`, final: 'recorded' }];
  messages.forEach((message, ordinal) => pending.sink.message({ ...message, id: `${id}-${ordinal}`, sessionId: id, ordinal, recordLine: ordinal + 1, turnId: 'turn-one', occurredAt: '2026-10-20T09:00:00Z' }));
  pending.flush();
  store.finishRevision(pending.revision, { id, client: 'codex', clientSessionId: id, sourceId: id, path, title: `审查会话 ${index}`, titleOrigin: 'recorded', messageCount: messages.length, turnCount: 1, updatedAt: new Date(Date.parse('2026-10-20T09:00:00Z') - index * 1000).toISOString(), project: '/workspace/review', models: [], gaps: [] });
  revisions.push({ path, revision: pending.revision, fingerprint: 'synthetic' });
}
store.publish(store.createJob().id, revisions, []);
let service;
const session = `review-${process.pid}`;
const browser = async args => {
  const result = await run('playwright-cli', [`-s=${session}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: '/tmp' }, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  if (result.stdout.includes('### Error')) throw new Error(result.stdout);
  return result.stdout;
};
const evaluate = async (name, action) => {
  const output = await browser(['run-code', action.toString().replaceAll('ARTIFACTS', JSON.stringify(artifacts))]);
  await writeFile(join(artifacts, `${name}.log`), output);
  console.log(name, output.split('### Ran Playwright code')[0].trim());
};
try {
  service = await startService({ home, port: 0, startupRefresh: false, roots: Object.fromEntries(clientIds.map(client => [client, join(directory, `empty-${client}`)])), resourceInventory: { environment: {}, userHome: join(directory, 'isolated-user') } });
  await browser(['open', `http://127.0.0.1:${service.instance.port}/#sessions`, '--headed', '--browser=chrome']);
  await evaluate('faults', async page => {
    const b = name => page.getByRole('button', { name, exact: true });
    await page.setViewportSize({ width: 1500, height: 950 });
    await page.getByRole('heading', { name: '审查会话 0', exact: true }).waitFor();
    await page.getByText('共同标记 合成回复', { exact: true }).waitFor();
    await page.route('**/api/v1/sessions/*/profile?*', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '合成画像失败' } }) }));
    await page.getByRole('button', { name: /^审查会话 1 Codex/ }).first().click();
    await page.getByText('合成画像失败', { exact: false }).waitFor();
    await page.getByText('会话回复 1', { exact: true }).waitFor();
    if (await page.getByText('会话回复 1', { exact: true }).count() !== 1) throw new Error('画像失败不应阻断正常正文');
    if (!(await page.locator('.session-profile-content').innerText()).includes('合成画像失败')) throw new Error('画像应在自己的面板显示错误');
    const profileFailure = { bodyPresent: await page.getByText('会话回复 1', { exact: true }).count(), profileText: await page.locator('.session-profile-content').innerText(), messageError: await page.locator('.session-message-scroll').innerText() };
    await page.screenshot({ path: ARTIFACTS + '/profile-failure.png' });
    await page.unroute('**/api/v1/sessions/*/profile?*');
    await b('重试').click();
    await page.getByText('会话回复 1', { exact: true }).waitFor();
    await page.getByRole('button', { name: /^审查会话 0 Codex/ }).click();
    await page.getByText('共同标记 合成回复', { exact: true }).waitFor();
    await page.route('**/api/v1/sessions/*/timeline?*', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '合成轨迹失败' } }) }));
    await b('执行轨迹').click();
    await page.getByText('合成轨迹失败', { exact: false }).waitFor();
    if ((await page.locator('.trace-timeline').innerText()).includes('0 个节点')) throw new Error('时间线失败不能显示零节点');
    if (!(await page.locator('.trace-timeline').innerText()).includes('合成轨迹失败')) throw new Error('时间线应在自己的面板显示错误');
    if (!(await page.locator('.trace-ledger').innerText()).includes('工具结果')) throw new Error('时间线失败不应丢弃过程正文');
    const timelineFailure = { traceText: await page.locator('.session-message-scroll').innerText(), visibleRows: await page.locator('.trace-row').count() };
    await page.screenshot({ path: ARTIFACTS + '/timeline-failure.png' });
    await page.unroute('**/api/v1/sessions/*/timeline?*');
    await b('重试总览').click();
    await page.getByText('合成轨迹失败', { exact: false }).waitFor({ state: 'hidden' });
    await page.getByText('共同标记 工具结果 0', { exact: false }).first().waitFor();
    return { profileFailure, timelineFailure, recovered: true };
  });
  await evaluate('request-isolation', async page => {
    const b = name => page.getByRole('button', { name, exact: true });
    const counters = { messages: 0, profile: 0, timeline: 0 };
    page.on('request', request => {
      for (const kind of Object.keys(counters)) if (request.url().includes('/' + kind + '?')) counters[kind]++;
    });
    await page.route('**/api/v1/sessions/*/messages?*', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '合成正文失败' } }) }));
    await b('对话').click();
    await page.locator('.session-message-scroll').getByText('合成正文失败', { exact: false }).waitFor();
    if (await page.locator('.trace-ledger, .session-turns').count()) throw new Error('正文失败不能把旧模式正文渲染为新模式');
    if (!(await page.locator('.session-profile-content').innerText()).includes('会话内容')) throw new Error('正文失败不能丢弃可用画像');
    await page.unroute('**/api/v1/sessions/*/messages?*');
    const before = { ...counters };
    await page.locator('.session-message-scroll').getByRole('button', { name: '重试', exact: true }).click();
    await page.getByText('共同标记 合成回复', { exact: true }).waitFor();
    if (counters.messages !== before.messages + 1 || counters.profile !== before.profile || counters.timeline !== before.timeline) throw new Error('重试正文不应重读画像或时间线');
    const sameMode = { ...counters };
    await b('对话').click();
    await page.getByText('共同标记 合成回复', { exact: true }).waitFor();
    if (counters.messages !== sameMode.messages) throw new Error('重复点击当前模式不应重新请求或折叠正文');
    await page.route('**/api/v1/sessions/*/profile?*', async route => {
      const response = await route.fetch(), body = await response.json(); body.version = 'invalid-version';
      await route.fulfill({ response, json: body });
    });
    await b('包含子会话').click();
    await page.locator('.session-profile-content [role="alert"]').waitFor();
    if (await page.locator('.session-profile-content').getAttribute('data-version') === 'invalid-version') throw new Error('不能采用不同版本的画像');
    await page.getByText('共同标记 合成回复', { exact: true }).waitFor();
    await page.unroute('**/api/v1/sessions/*/profile?*');
    const retry = { ...counters };
    await page.locator('.session-profile-content').getByRole('button', { name: '重试', exact: true }).click();
    await page.locator('.session-profile-content [role="alert"]').waitFor({ state: 'hidden' });
    if (counters.messages !== retry.messages || counters.profile !== retry.profile + 1) throw new Error('画像重试不应重新读取正文');
    let delayed = false;
    await page.route('**/api/v1/sessions/review-02/messages?*', async route => { delayed = true; await page.waitForTimeout(500); await route.continue().catch(() => {}); });
    await page.getByRole('button', { name: /^审查会话 2 Codex/ }).first().click();
    for (let i = 0; i < 30 && !delayed; i++) await page.waitForTimeout(20);
    if (!delayed) throw new Error('旧会话延迟请求未触发');
    await page.getByRole('button', { name: /^审查会话 3 Codex/ }).first().click();
    await page.getByText('会话回复 3', { exact: true }).waitFor(); await page.waitForTimeout(550);
    if (await page.getByText('会话回复 2', { exact: true }).count()) throw new Error('旧会话响应覆盖当前会话');
    await page.unroute('**/api/v1/sessions/review-02/messages?*');
    return { independentRetries: true, versionGuard: true, modeIsolation: true, staleCancelled: true };
  });
  await evaluate('group-page', async page => {
    const input = page.getByRole('textbox', { name: '搜索会话标题和消息', exact: true });
    const requests = [];
    page.on('request', request => { if (request.url().includes('/sessions/search?')) requests.push(request.url()); });
    await input.fill('共同标记');
    await page.locator('.session-search-group').waitFor();
    await page.getByRole('button', { name: /^更多筛选/ }).click();
    const processCheckbox = page.getByRole('checkbox', { name: '搜索过程记录', exact: true });
    await processCheckbox.check();
    await page.getByRole('dialog', { name: '搜索范围', exact: true }).press('Escape');
    await page.waitForFunction(() => document.querySelector('.session-search-group small')?.textContent.includes('32'));
    await page.getByRole('button', { name: '展开全部命中', exact: true }).click();
    const next = page.getByRole('button', { name: '当前会话命中下一页', exact: true });
    await next.click();
    await page.waitForFunction(() => document.querySelector('.session-search-group .session-pager')?.textContent.includes('2 / 3'));
    await page.getByRole('button', { name: /^更多筛选/ }).click();
    await processCheckbox.uncheck();
    await page.getByRole('dialog', { name: '搜索范围', exact: true }).press('Escape');
    await page.waitForFunction(() => document.querySelector('.session-search-group small')?.textContent.includes('2 条'));
    await page.waitForFunction(() => document.querySelectorAll('.session-search-group .session-hit').length === 2);
    if (await page.locator('.session-search-group .session-hit').count() !== 2) throw new Error('收窄过程搜索后应回到第一页并显示两条正文命中');
    const result = { groupText: await page.locator('.session-search-group').innerText(), visibleHits: await page.locator('.session-search-group .session-hit').count(), requests };
    await page.screenshot({ path: ARTIFACTS + '/group-page.png' });
    await page.getByRole('button', { name: '清除搜索', exact: true }).click();
    await page.locator('.session-list-item').first().waitFor();
    return result;
  });
  await evaluate('list-page-before', async page => {
    await page.getByRole('button', { name: '会话列表分页下一页', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.resource-pager-compact input')?.value === '2');
    await page.getByRole('button', { name: '会话列表分页下一页', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.resource-pager-compact input')?.value === '3');
    return { count: await page.locator('.session-list-item').count(), page: await page.locator('.resource-pager-compact input').inputValue() };
  });
  const extraPath = '/workspace/review/added.jsonl', extra = store.createRevision(extraPath, 'added');
  extra.sink.message({ id: 'added-user', sessionId: 'added', ordinal: 0, recordLine: 1, turnId: 'turn-one', kind: 'user', text: '新增合成问题' });
  extra.flush();
  store.finishRevision(extra.revision, { id: 'added', client: 'codex', clientSessionId: 'added', title: '审查会话新增', titleOrigin: 'recorded', path: extraPath, sourceId: 'added', messageCount: 1, turnCount: 1, models: [], gaps: [] });
  revisions.push({ path: extraPath, revision: extra.revision, fingerprint: 'added' });
  store.publish(store.createJob().id, revisions, []);
  await evaluate('list-valid-page', async page => {
    await page.waitForResponse(response => response.url().includes('/api/v1/sessions?') && response.status() === 200);
    if (await page.locator('.resource-pager-compact input').inputValue() !== '3') throw new Error('结果仍覆盖当前页时不应回到首页');
    return { retained: true };
  });
  store.publish(store.createJob().id, revisions.slice(0, 2), []);
  await evaluate('list-page-after', async page => {
    await page.waitForFunction(() => document.querySelector('.session-list-meta')?.textContent.includes('2 个'), undefined, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('.session-list-item').length === 2);
    if (await page.locator('.session-list-item').count() !== 2) throw new Error('刷新减少结果后应校正越界页');
    const result = { meta: await page.locator('.session-list-meta').innerText(), count: await page.locator('.session-list-item').count(), empty: await page.locator('.session-empty-list').count(), pager: await page.getByRole('navigation', { name: '会话列表分页', exact: true }).count() };
    await page.screenshot({ path: ARTIFACTS + '/list-page-after.png' });
    return result;
  });

  store.publish(store.createJob().id, revisions.slice(0, 85), []);
  await evaluate('search-page-before', async page => {
    await page.waitForFunction(() => document.querySelector('.session-list-meta')?.textContent.includes('85 个'), undefined, { timeout: 15000 });
    await page.getByRole('textbox', { name: '搜索会话标题和消息', exact: true }).fill('审查会话');
    await page.locator('.session-search-group').first().waitFor();
    const input = page.getByRole('spinbutton', { name: '会话列表分页跳转页码', exact: true });
    await input.fill('8'); await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('.resource-pager-compact input')?.value === '8' && document.querySelectorAll('.session-search-group').length === 1);
    return { page: 8 };
  });
  store.publish(store.createJob().id, revisions.slice(0, 2), []);
  await evaluate('search-page-after', async page => {
    await page.waitForFunction(() => document.querySelector('.session-list-meta')?.textContent.includes('2 个') && document.querySelectorAll('.session-search-group').length === 2, undefined, { timeout: 15000 });
    if (await page.locator('.session-search-empty').count()) throw new Error('分组搜索越界后不能显示假空态');
    await page.screenshot({ path: ARTIFACTS + '/search-page-after.png' });
    return { groups: 2, corrected: true };
  });

} catch (error) {
  console.log('FAILURE', String(error));
  await writeFile(join(artifacts, 'reproduce-failure-state.log'), await browser(['snapshot']).catch(() => 'unavailable'));
  await browser(['screenshot', `--filename=${join(artifacts, 'reproduce-failure.png')}`]).catch(() => {});
  throw error;
} finally {
  await browser(['close']).catch(() => {});
  if (service) await service.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
}
