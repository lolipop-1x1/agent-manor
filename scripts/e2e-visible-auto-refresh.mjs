import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";
import { writePreferences } from "../dist/service/preferences.js";
import { sessionSpeedFixture } from "./session-speed-fixture.mjs";

// 人工长会话、隔离后台与独立 Chrome；不会检查或更新日常历史。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-visible-refresh-")));
const artifacts = fileURLToPath(new URL("../.local/visible-auto-refresh-e2e/", import.meta.url));
const browserName = `visible-refresh-${process.pid}`;
const roots = Object.fromEntries(clientIds.map(client => [client, []]));
roots.codex = join(directory, "codex");
roots.pi = join(directory, "pi");
const source = join(roots.codex, "bulk.jsonl");
const repository = join(directory, "repo");
const fixture = sessionSpeedFixture().files.find(item => item.id === "speed-bulk");
const rows = fixture.records;
const at = seconds => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const text = "长正文起点\n" + "完整内容需要保留。".repeat(1500) + "\n长正文末尾完整标记";
const finalIndex = rows.findIndex(row => row.payload?.id === "bulk-comment-bulk-1-6");
rows[finalIndex].payload.content[0].text = text;
rows.splice(finalIndex, 0, ...Array.from({ length: 700 }, (_, index) => ({ type: "response_item", timestamp: at(2020), payload: {
  type: index % 2 ? "function_call_output" : "function_call", call_id: `large-${Math.floor(index / 2)}`,
  ...(index % 2 ? { output: `合成结果 ${index}` } : { name: "fixture_tool", arguments: JSON.stringify({ index }) }),
} })));
let service;
const checks = [];
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${browserName}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
const step = async (name, code) => {
  const action = `async page => { const expect=(value,message)=>{if(!value)throw new Error(message);}; ${code} return {passed:${JSON.stringify(name)}}; }`;
  await writeFile(join(artifacts, "current-check.mjs"), `export default ${action};`);
  await browser(["run-code", action]);
  checks.push(name); console.log(`PASS ${name}`);
};
try {
  await mkdir(artifacts, { recursive: true }); await mkdir(roots.codex); await mkdir(roots.pi);
  const piRows = [{ type: "session", version: 3, id: "offset-branches", timestamp: at(0), cwd: "/synthetic/repo" },
    { type: "message", id: "branch-user", parentId: null, timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "分支分页回归" }] } }];
  for (let index = 1; index <= 350; index++) piRows.push({ type: "message", id: `old-${index}`, parentId: index === 1 ? "branch-user" : `old-${index - 1}`, timestamp: at(index + 1),
    message: { role: "assistant", model: "fixture-model", timestamp: Date.UTC(2026, 0, 1) + index * 1000, stopReason: "stop", content: [{ type: "text", text: `旧分支消息 ${index}` }], usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 } } });
  piRows.push({ type: "message", id: "branch-new", parentId: "branch-user", timestamp: at(400), message: { role: "assistant", model: "fixture-model", stopReason: "stop", content: [{ type: "text", text: "短分支当前回答" }] } });
  await writeFile(join(roots.pi, "branches.jsonl"), piRows.map(row => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(source, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  await mkdir(join(repository, "src"), { recursive: true }); await run("git", ["init", "-q", repository]);
  await writeFile(join(repository, "src/a.ts"), "export const alpha = 1;\n".repeat(100));
  await writeFile(join(repository, "src/b.ts"), "export const beta = 2;\n".repeat(80));
  await run("git", ["-C", repository, "add", "src/a.ts", "src/b.ts"]);
  const home = join(directory, "data"); await mkdir(home); await writePreferences(home, "zh-CN");
  service = await startService({ home, roots, staticRoot: fileURLToPath(new URL("../dist/web", import.meta.url)), resourceInventory: { userHome: join(directory, "isolated-user"), environment: {} } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const api = async (path, body) => {
    const response = await fetch(`${base}/api/v1${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, path); return response.json();
  };
  const wait = async () => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const status = await api("/sessions/status?summary=true");
      if (status.job?.status === "failed") throw new Error(status.job.error);
      if (status.version && !["queued", "running"].includes(status.job?.status)) return status;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("合成索引未完成");
  };
  const registration = await api("/repositories", { path: repository });
  const waitMap = async jobId => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const { job } = await api(`/jobs/${jobId}`);
      if (job.status === "failed") throw new Error(job.error);
      if (job.status === "completed") return job;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("合成地图未完成");
  };
  await waitMap(registration.job.id);
  const initial = await wait();
  const allSessions = (await api("/sessions")).sessions;
  const summary = allSessions.find(item => item.clientSessionId === "speed-bulk");
  const branchSession = allSessions.find(item => item.clientSessionId === "offset-branches");
  assert.ok(summary); assert.ok(branchSession);
  const sid = encodeURIComponent(summary.id);
  const fullProfile = await api(`/sessions/${sid}/profile`);
  assert.equal(fullProfile.usage.requests, 1010);
  await browser(["open", `${base}/#sessions?id=${sid}`, "--headed", "--browser=chrome"]);
  await step("默认关闭、开启并保存间隔，可见调度与隐藏恢复", `
    page.setDefaultTimeout(15000); await page.setViewportSize({width:1440,height:1000});
    await page.locator('.session-message-scroll[data-version=${JSON.stringify(initial.version)}]').waitFor();
    const paths=await page.evaluate(()=>performance.getEntriesByType('resource').map(item=>item.name));
    expect(paths.some(path=>path.includes('/profile?')&&path.includes('summary=true')),'画像没有采用摘要 '+JSON.stringify(paths));
    expect(!paths.some(path=>path.includes('/profile?')&&!path.includes('summary=true')),'首屏提前读取完整用量');
    await page.clock.install();
    await page.reload();await page.locator('.session-message-scroll[data-version=${JSON.stringify(initial.version)}]').waitFor();
    await page.evaluate(()=>{globalThis.__refreshRequests=[]; globalThis.__readingErrors=[];});
    page.on('request',request=>{if(request.url().includes('/api/v1/')) page.evaluate(value=>globalThis.__refreshRequests.push(value),{url:request.url(),body:request.postData()}).catch(()=>{});});
    page.on('pageerror',error=>page.evaluate(value=>globalThis.__readingErrors.push(value),String(error)).catch(()=>{}));
    expect((await page.getByRole('combobox',{name:'会话库自动刷新',exact:true}).innerText()).includes('关闭'),'未默认关闭');
    await page.clock.runFor(120010);await page.waitForTimeout(200);
    expect(!(await page.evaluate(()=>globalThis.__refreshRequests)).some(item=>item.url.includes('/auto-refresh')||item.url.includes('/status')),'关闭时仍周期检查');
    await page.getByRole('combobox',{name:'会话库自动刷新',exact:true}).click();
    await page.screenshot({path:${JSON.stringify(join(artifacts, "auto-refresh-menu-zh.png"))},clip:{x:0,y:0,width:1440,height:380}});
    const saved=page.waitForResponse(response=>response.url().endsWith('/preferences')&&response.request().method()==='PUT');
    await page.getByRole('option',{name:'1 分钟',exact:true}).click();await saved;
    await page.clock.runFor(60010); await page.waitForTimeout(300);
    let requests=await page.evaluate(()=>globalThis.__refreshRequests);
    expect(requests.some(item=>item.url.includes('/sessions/auto-refresh')&&!String(item.body).includes('client')),'自动刷新未覆盖全部客户端');
    expect(!requests.some(item=>['/profile?','/messages?','/timeline?'].some(path=>item.url.includes(path))),'无变化检查重新读取大接口');
    await page.evaluate(()=>{globalThis.__refreshRequests=[];Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>globalThis.__testHidden?'hidden':'visible'});globalThis.__testHidden=true;document.dispatchEvent(new Event('visibilitychange'));});
    await page.clock.runFor(120010); await page.waitForTimeout(200);
    expect(!(await page.evaluate(()=>globalThis.__refreshRequests)).some(item=>item.url.includes('/sessions/auto-refresh')),'隐藏页仍触发新刷新');
    await page.evaluate(()=>{globalThis.__testHidden=false;document.dispatchEvent(new Event('visibilitychange'));});
    await page.clock.runFor(20); await page.waitForTimeout(300);
    expect((await page.evaluate(()=>globalThis.__refreshRequests)).some(item=>item.url.includes('/sessions/auto-refresh')),'恢复可见没有补查');
    await page.evaluate(()=>{const pane=document.querySelector('.session-message-scroll');pane.scrollTop=700;const bounds=pane.getBoundingClientRect();const node=[...pane.querySelectorAll('.session-message')].find(node=>node.getBoundingClientRect().bottom>bounds.top+8);globalThis.__readingAnchor={id:node.id,offset:node.getBoundingClientRect().top-bounds.top};});
  `);
  await step("间隔重载保留，短长间隔替换旧计时器，键盘选择与 Escape 恢复焦点", `
    await page.reload();await page.locator('.session-message-scroll').waitFor();
    let control=page.getByRole('combobox',{name:'会话库自动刷新',exact:true});
    expect((await control.innerText()).includes('1 分钟'),'重载未保留间隔');
    await control.focus();await page.keyboard.press('Enter');await page.keyboard.press('Escape');
    expect(await control.evaluate(node=>node===document.activeElement),'Escape 没有恢复焦点');
    await control.click();const shortSaved=page.waitForResponse(response=>response.url().endsWith('/preferences')&&response.request().method()==='PUT');
    await page.getByRole('option',{name:'5 秒',exact:true}).click();await shortSaved;
    await page.clock.runFor(20);await page.waitForTimeout(100);await page.evaluate(()=>globalThis.__refreshRequests=[]);
    await page.clock.runFor(10010);await page.waitForTimeout(200);
    expect((await page.evaluate(()=>globalThis.__refreshRequests)).filter(item=>item.url.includes('/sessions/auto-refresh')).length>=2,'5 秒间隔未生效');
    await control.focus();await page.keyboard.press('Enter');await page.clock.runFor(20);await page.keyboard.press('End');await page.clock.runFor(20);
    const longSaved=page.waitForResponse(response=>response.url().endsWith('/preferences')&&response.request().method()==='PUT');
    await page.keyboard.press('Enter');await longSaved;
    expect((await control.innerText()).includes('10 分钟'),'键盘未选择长间隔');
    await page.clock.runFor(20);await page.waitForTimeout(100);await page.evaluate(()=>globalThis.__refreshRequests=[]);
    await page.clock.runFor(590000);await page.waitForTimeout(100);
    expect(!(await page.evaluate(()=>globalThis.__refreshRequests)).some(item=>item.url.includes('/sessions/auto-refresh')),'改成长间隔后旧计时器仍触发');
    await page.clock.runFor(10020);await page.waitForTimeout(100);
    expect((await page.evaluate(()=>globalThis.__refreshRequests)).some(item=>item.url.includes('/sessions/auto-refresh')),'10 分钟计时器未触发');
    await control.click();const saved=page.waitForResponse(response=>response.url().endsWith('/preferences')&&response.request().method()==='PUT');
    await page.getByRole('option',{name:'1 分钟',exact:true}).click();await saved;await page.clock.runFor(20);
    await page.evaluate(()=>{const pane=document.querySelector('.session-message-scroll');pane.scrollTop=700;const bounds=pane.getBoundingClientRect();const node=[...pane.querySelectorAll('.session-message')].find(node=>node.getBoundingClientRect().bottom>bounds.top+8);globalThis.__readingAnchor={id:node.id,offset:node.getBoundingClientRect().top-bounds.top};});
  `);
  const appendTurn = async turn => {
    const timestamp = at(2000 + turn * 30);
    await appendFile(source, [
      { type: "response_item", timestamp, payload: { type: "message", id: `new-user-${turn}`, role: "user", content: [{ type: "input_text", text: `新问题 ${turn}` }] } },
      { type: "response_item", timestamp: at(2001 + turn * 30), payload: { type: "message", id: `new-answer-${turn}`, role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `新版回答 ${turn}` }] } },
      { type: "token_usage_record", timestamp: at(2001 + turn * 30), payload: { response_id: `new-request-${turn}`, usage: { input_tokens: 100, output_tokens: 200 }, thread_token_usage: { input_tokens: 100, output_tokens: 132000 + (turn - 110) * 200 } } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    await api("/sessions/refresh", { mode: "quick" }); return wait();
  };
  const appended = await appendTurn(111);
  await step("新版自动应用保持旧消息锚点，正文与画像同版", `
    await page.clock.runFor(5010); await page.locator('.session-message-scroll[data-version=${JSON.stringify(appended.version)}]').waitFor();
    const anchor=await page.evaluate(()=>{const pane=document.querySelector('.session-message-scroll'),node=document.getElementById(globalThis.__readingAnchor.id);return {exists:!!node,offset:node?.getBoundingClientRect().top-pane.getBoundingClientRect().top,before:globalThis.__readingAnchor.offset};});
    expect(anchor.exists&&Math.abs(anchor.offset-anchor.before)<4,'刷新丢失旧阅读位置');
    expect(await page.locator('#session-profile-content').getAttribute('data-version')===${JSON.stringify(appended.version)},'画像与正文版本不一致');
    await page.route('**/profile?*summary=true*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SYNTHETIC_FAILURE',message:'synthetic-profile-failure'}})}));
  `);
  const failed = await appendTurn(112);
  await step("新版准备失败保留整套旧结果，重试成功后一起切换", `
    await page.clock.runFor(5010); await page.locator('.session-message-scroll').getByRole('button',{name:'重试',exact:true}).waitFor();
    expect(await page.locator('.session-message-scroll').getAttribute('data-version')===${JSON.stringify(appended.version)},'失败替换了正文');
    expect(await page.locator('#session-profile-content').getAttribute('data-version')===${JSON.stringify(appended.version)},'失败混入新版画像');
    await page.unroute('**/profile?*summary=true*');
    await page.locator('.session-message-scroll').getByRole('button',{name:'重试',exact:true}).click();
    await page.locator('.session-message-scroll[data-version=${JSON.stringify(failed.version)}]').waitFor();
    await page.locator(".session-turn-position").click();
    await page.getByRole('button',{name:'末轮',exact:true}).click();
    await page.getByText('新版回答 112',{exact:true}).waitFor();
    await page.locator('.session-message-scroll').evaluate(pane=>pane.scrollTop=pane.scrollHeight);
  `);
  const tail = await appendTurn(113);
  const updatedProfile = await api(`/sessions/${sid}/profile?version=${tail.version}`);
  await step("在末尾阅读自动接续新内容", `
    await page.clock.runFor(5010); await page.locator('.session-message-scroll[data-version=${JSON.stringify(tail.version)}]').waitFor();
    await page.getByText('新版回答 113',{exact:true}).waitFor();
    expect(await page.locator('.session-message-scroll').evaluate(pane=>pane.scrollHeight-pane.scrollTop-pane.clientHeight<32),'末尾阅读未接续新内容');
    await page.goto(${JSON.stringify(`${base}/#sessions?id=${sid}&mode=full&turn=1`)});
    await page.getByRole('button',{name:'加载后续内容',exact:true}).waitFor();
    expect(await page.locator('.session-message').count()<=300,'长轮首段正文未有界');
    await page.getByRole('button',{name:'加载后续内容',exact:true}).evaluate(node=>node.click());
    await page.locator('.session-message').nth(300).waitFor();
    await page.getByRole('button',{name:'加载后续内容',exact:true}).evaluate(node=>node.click());
    await page.locator('.session-message').nth(600).waitFor();
    expect(await page.locator('.session-message').count()<=1200,'连续阅读驻留窗口未有界');
    const expand=page.locator('.session-text-expand').filter({hasText:'展开全部内容'}).first();
    await expand.waitFor();await expand.click();await page.getByText('长正文末尾完整标记',{exact:false}).waitFor();
    await page.context().grantPermissions(['clipboard-read','clipboard-write']);
    const article=page.locator('.session-message').filter({hasText:'长正文末尾完整标记'});
    await article.getByRole('button',{name:'复制回复',exact:true}).click();
    await article.getByRole('status').filter({hasText:'已复制'}).waitFor();
    expect((await page.evaluate(()=>navigator.clipboard.readText())).endsWith('长正文末尾完整标记'),'复制丢失原始末尾');
    await page.getByRole('tab',{name:'用量',exact:true}).click();
    await page.locator('.session-step-table tbody tr').first().waitFor();
    expect(await page.locator('.session-step-table tbody tr').count()===12,'请求明细未分页');
    await page.getByRole('button',{name:'请求明细分页下一页',exact:true}).click();
    await page.getByRole('button',{name:'请求 13',exact:true}).waitFor();
    expect((await page.locator('.session-request-range').innerText()).includes('13'),'分页趋势没有标明实际范围');
    expect((await page.locator('.session-usage-grid').innerText()).includes(${JSON.stringify(Math.round(updatedProfile.outputSpeed.tokensPerSecond) + ' tok/s')}),'摘要速度与完整请求不一致');
    await page.getByRole('button',{name:'执行轨迹',exact:true}).click();
    await page.locator('.trace-timeline-viewport svg').waitFor();
    await page.locator('.trace-timeline-actions').filter({hasText:'聚合显示'}).waitFor();
    await page.getByRole('button',{name:'放大轨迹图',exact:true}).click();
    await page.getByRole('button',{name:'放大轨迹图',exact:true}).click();
    expect(await page.locator('.trace-timeline-viewport svg .trace-mark').count()<3000,'聚合图构建过多节点');
  `);
  await step("分支切换清除长轮偏移，短分支仍显示完整当前回答", `
    await page.goto(${JSON.stringify(`${base}/#sessions?id=${encodeURIComponent(branchSession.id)}&mode=full&branch=old-350`)});
    await page.getByRole('button',{name:'加载后续内容',exact:true}).waitFor();
    await page.getByRole('button',{name:'加载后续内容',exact:true}).evaluate(node=>node.click());
    await page.locator('.session-message').nth(300).waitFor();
    await page.getByRole('combobox',{name:'阅读分支',exact:true}).click();
    await page.getByRole('option',{name:'当前分支',exact:true}).click();
    await page.locator('.session-turn summary').filter({hasText:'2 条记录'}).waitFor();
    const closed=page.locator('.session-turn:not([open]) summary').first();if(await closed.count())await closed.click();
    await page.getByText('短分支当前回答',{exact:true}).waitFor();
    expect(await page.locator('.session-reading-boundary').count()===0,'短分支保留旧窗口边界');
    expect(await page.locator('.session-message').count()===2,'短分支混入旧分支消息');
  `);
  const endpoint = (await api(`/sessions/${sid}/timeline?maxEvents=1800`)).events.at(-1);
  await step("跨页聚合图选中后新页到达仍定位虚拟列表目标", `
    await page.goto(${JSON.stringify(`${base}/#sessions?id=${sid}&mode=trace&turn=1`)});
    const svg=page.locator('.trace-timeline-viewport svg');await svg.waitFor();await page.locator('.trace-mark').first().waitFor();
    await svg.focus();await svg.press('End');
    await page.locator('.trace-inspector [data-message-id=${JSON.stringify(endpoint.id)}]').waitFor();
    const selected=page.locator('.trace-row.is-selected');await selected.waitFor();
    expect(await selected.evaluate(node=>{const pane=node.closest('.trace-ledger-scroll');const box=node.getBoundingClientRect(),bounds=pane.getBoundingClientRect();return box.bottom>bounds.top&&box.top<bounds.bottom;}),'目标未滚入轨迹列表窗口');
  `);
  const completeEvents = (await api(`/sessions/${sid}/timeline`)).events;
  const late = completeEvents.at(-2);
  await step("聚合总览仍可定位真实记录，英文与窄屏保持状态", `
    await page.goto(${JSON.stringify(`${base}/#sessions?id=${sid}&mode=trace&message=${encodeURIComponent(late.id)}`)});
    await page.locator('.trace-inspector [data-message-id=${JSON.stringify(late.id)}]').waitFor();
    await page.locator('.trace-mark-selection').waitFor();
    expect(await page.locator('.trace-timeline').getAttribute('data-version')===await page.locator('.session-message-scroll').getAttribute('data-version'),'轨迹和正文混版');
    await page.getByRole('button',{name:'显示语言',exact:true}).click();await page.getByRole('menuitemradio',{name:'English',exact:true}).click();
    await page.getByRole('button',{name:'Zoom in trace timeline',exact:true}).waitFor();
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),'窄屏水平溢出');
    await page.getByRole('button',{name:'Zoom in trace timeline',exact:true}).click();
    await page.getByRole('button',{name:'Locate selected trace node',exact:true}).click();
    await page.screenshot({path:${JSON.stringify(join(artifacts, "narrow-en.png"))}});
    expect((await page.evaluate(()=>globalThis.__readingErrors??[])).length===0,'浏览器出现脚本错误');
  `);
  await step("会话库与地图开关独立，地图首屏摘要和自动检查保留筛选", `
    await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>globalThis.__refreshRequests=[]);await page.getByRole('button',{name:'Code map',exact:true}).click();
    await page.locator('.code-map').waitFor();
    const refresh=page.getByRole('combobox',{name:'Code map auto refresh',exact:true});
    expect((await refresh.innerText()).includes('Off'),'会话库开启后意外开启地图刷新');
    await page.evaluate(()=>globalThis.__refreshRequests=[]);await page.clock.runFor(60010);await page.waitForTimeout(200);
    expect(!(await page.evaluate(()=>globalThis.__refreshRequests??[])).some(item=>item.url.includes('/auto-refresh')),'地图关闭时仍自动检查，或隐藏的会话库仍自动检查');
    await refresh.click();const saved=page.waitForResponse(response=>response.url().endsWith('/preferences')&&response.request().method()==='PUT');
    await page.getByRole('option',{name:'1 minute',exact:true}).click();await saved;
    await page.getByRole('combobox',{name:'Map client',exact:true}).click();await page.getByRole('option',{name:'Codex',exact:true}).click();
    await page.waitForLoadState('networkidle');
    await page.evaluate(()=>{globalThis.__mapNode=document.querySelector('.code-map');globalThis.__mapFit=Number(globalThis.__mapNode.dataset.scale);});
    await page.getByRole('button',{name:'Zoom in',exact:true}).click();await page.getByRole('button',{name:'Zoom in',exact:true}).click();
    await page.clock.runFor(60010);await page.waitForTimeout(300);
    expect((await page.evaluate(()=>globalThis.__refreshRequests.map(item=>item.url))).some(path=>path.includes('/coverage?')&&path.includes('summary=true')),'地图首屏没有使用摘要');
    expect((await page.evaluate(()=>globalThis.__refreshRequests??[])).some(item=>item.url.includes('/repositories/')&&item.url.includes('/auto-refresh')),'可见地图未自动检查当前仓库');
  `);
  await appendFile(join(repository, "src/a.ts"), "export const appended = 3;\n".repeat(3));
  const changedMap = await api(`/repositories/${registration.repository.id}/refresh`, {});await waitMap(changedMap.job.id);
  await step("地图新版自动应用保持缩放、筛选与当前视野", `
    const fresh=page.waitForResponse(response=>response.url().includes('/coverage?')&&response.url().includes('summary=true'));
    await page.clock.runFor(5010);await fresh;await page.waitForLoadState('networkidle');
    expect(await page.evaluate(()=>document.querySelector('.code-map')===globalThis.__mapNode),'自动更新重建了地图实例');
    expect(await page.evaluate(()=>Number(document.querySelector('.code-map').dataset.scale)>globalThis.__mapFit*1.5),'自动更新重置了缩放');
    expect((await page.getByRole('combobox',{name:'Map client',exact:true}).innerText()).includes('Codex'),'自动更新清除了客户端筛选');
  `);
  await step("英文窄屏菜单、保存失败保持原设置，两份开关独立关闭后停止周期检查", `
    const control=page.getByRole('combobox',{name:'Code map auto refresh',exact:true});
    expect((await control.innerText()).includes('1 minute'),'切换语言丢失刷新设置');
    await page.route('**/api/v1/preferences',route=>route.request().method()==='PUT'?route.fulfill({status:503,contentType:'application/json',body:'{}'}):route.continue());
    await control.click();await page.getByRole('option',{name:'Off',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Preferences were not saved'}).waitFor();
    expect((await control.innerText()).includes('1 minute'),'保存失败误显示已关闭');
    await page.unroute('**/api/v1/preferences');
    await page.setViewportSize({width:390,height:844});await control.click();
    expect(await page.getByRole('option',{name:'10 minutes',exact:true}).isVisible(),'窄屏菜单选项不可见');
    await page.screenshot({path:${JSON.stringify(join(artifacts, "auto-refresh-menu-en.png"))}});
    const saved=page.waitForResponse(response=>response.url().endsWith('/preferences')&&response.request().method()==='PUT');
    await page.getByRole('option',{name:'Off',exact:true}).click();await saved;await page.clock.runFor(20);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),'新增控件导致窄屏溢出');
    await page.evaluate(()=>globalThis.__refreshRequests=[]);await page.clock.runFor(1200010);await page.waitForTimeout(200);
    expect(!(await page.evaluate(()=>globalThis.__refreshRequests)).some(item=>item.url.includes('/auto-refresh')||item.url.includes('/status')),'关闭后仍进行周期检查');
    await page.reload();await page.locator('.code-map').waitFor();
    expect((await page.getByRole('combobox',{name:'Code map auto refresh',exact:true}).innerText()).includes('Off'),'关闭未持久化');
    await page.getByRole('button',{name:'Sessions',exact:true}).click();await page.locator('.session-message-scroll').waitFor();
    const sessionRefresh=page.getByRole('combobox',{name:'Session auto refresh',exact:true});
    expect((await sessionRefresh.innerText()).includes('1 minute'),'关闭地图意外关闭会话库刷新');
    await page.evaluate(()=>globalThis.__refreshRequests=[]);await page.clock.runFor(60010);await page.waitForTimeout(100);
    expect((await page.evaluate(()=>globalThis.__refreshRequests)).some(item=>item.url.includes('/sessions/auto-refresh')),'地图关闭后会话库间隔失效');
    expect(!(await page.evaluate(()=>globalThis.__refreshRequests)).some(item=>item.url.includes('/repositories/')&&item.url.includes('/auto-refresh')),'隐藏地图仍自动刷新');
    await sessionRefresh.click();const sessionSaved=page.waitForResponse(response=>response.url().endsWith('/preferences')&&response.request().method()==='PUT');
    await page.getByRole('option',{name:'Off',exact:true}).click();await sessionSaved;await page.clock.runFor(20);
    await page.evaluate(()=>globalThis.__refreshRequests=[]);await page.clock.runFor(600010);await page.waitForTimeout(100);
    expect(!(await page.evaluate(()=>globalThis.__refreshRequests)).some(item=>item.url.includes('/auto-refresh')||item.url.includes('/sessions/status')),'关闭后会话仍进行周期检查');
  `);
  await step("关闭状态下手动刷新会话与地图仍能看到进度并完成", `
    await page.setViewportSize({width:1440,height:1000});
    let response=page.waitForResponse(response=>response.url().endsWith('/sessions/refresh')&&response.request().method()==='POST');
    await page.getByRole('button',{name:'Refresh session index',exact:true}).click();
    const sessionJob=(await (await response).json()).job;
    for(let attempt=0;attempt<60;attempt++){await page.clock.runFor(2010);await page.waitForTimeout(50);if(await page.getByRole('button',{name:'Refresh session index',exact:true}).isEnabled())break;}
    expect(await page.getByRole('button',{name:'Refresh session index',exact:true}).isEnabled(),'关闭后会话进度未完成');
    expect((await page.evaluate(()=>globalThis.__refreshRequests??[])).some(item=>item.url.includes('/jobs/'+sessionJob.id)),'关闭后不再查询手动任务进度');
    await page.getByRole('button',{name:'Code map',exact:true}).click();await page.locator('.code-map').waitFor();
    response=page.waitForResponse(response=>response.url().includes('/repositories/')&&response.url().endsWith('/refresh')&&response.request().method()==='POST');
    await page.getByRole('button',{name:'Refresh analysis',exact:true}).click();await response;
    for(let attempt=0;attempt<60;attempt++){await page.clock.runFor(2010);await page.waitForTimeout(50);if(await page.getByRole('button',{name:'Refresh analysis',exact:true}).isEnabled())break;}
    expect(await page.getByRole('button',{name:'Refresh analysis',exact:true}).isEnabled(),'关闭后地图进度未完成');
    expect(!(await page.evaluate(()=>globalThis.__refreshRequests??[])).some(item=>item.url.includes('/auto-refresh')),'手动刷新意外开启自动刷新');
  `);
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ checks, completeMessages: completeEvents.length, requests: fullProfile.usage.requests, initialVersion: initial.version, finalVersion: tail.version }, null, 2));
} catch (failure) {
  try { await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]); await writeFile(join(artifacts, "failure.txt"), await browser(["snapshot"])); } catch { /* 保留原失败。 */ }
  throw failure;
} finally {
  try { await browser(["close"]); } catch { /* 关闭已退出会话。 */ }
  await service?.close(); await rm(directory, { recursive: true, force: true });
}
