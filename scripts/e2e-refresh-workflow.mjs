import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { clientIds } from "../dist/clients.js";
import { startService } from "../dist/server.js";
import { writePreferences } from "../dist/service/preferences.js";
import { resourceFixture } from "./resource-fixture.mjs";

// 全部来源、资源、数据目录和浏览器均隔离，只更新人工历史。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-refresh-workflow-")));
const artifacts = fileURLToPath(new URL("../.local/refresh-workflow-e2e/", import.meta.url));
const session = `refresh-workflow-${process.pid}`;
const checks = [];
let service;
let base;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${session}`, ...args], {
    cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
const step = async (name, code) => {
  const action = `async page => { const expect=(value,message)=>{if(!value)throw new Error(message);}; ${code} return {passed:${JSON.stringify(name)}}; }`;
  await writeFile(join(artifacts, "current-check.mjs"), `export default ${action};`);
  await browser(["run-code", action]); checks.push(name); console.log(`PASS ${name}`);
};
const api = async (path, body) => {
  const response = await fetch(`${base}/api/v1${path}`, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, path); return response.json();
};
const waitJob = async (id, complete) => {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { job } = await api(`/jobs/${id}`);
    if (job.status === "failed") throw new Error(job.error);
    if (job.status === complete) return job;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("合成任务未完成");
};

try {
  await mkdir(artifacts, { recursive: true });
  const fixture = await resourceFixture(directory, 8);
  const claude = join(directory, "claude"); await mkdir(claude);
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const records = (await readFile(fixture.source, "utf8")).trim().split("\n").map((line, index) => ({
    ...JSON.parse(line), timestamp: new Date(today.getTime() + index * 1000).toISOString(),
  }));
  await writeFile(fixture.source, records.map(row => JSON.stringify(row)).join("\n") + "\n");
  await run("git", ["init", "-q", fixture.project]);
  await writeFile(join(fixture.project, "sample.ts"), "export const sample = 1;\n".repeat(80));
  await run("git", ["-C", fixture.project, "add", "sample.ts"]);
  await mkdir(fixture.home, { recursive: true }); await writePreferences(fixture.home, "zh-CN");
  const roots = { ...Object.fromEntries(clientIds.map(client => [client, []])), codex: fixture.history, claude };
  service = await startService({ home: fixture.home, roots, resourceInventory: { userHome: fixture.userHome, environment: {} },
    usagePricing: { fetch: async () => new Response("{}", { headers: { "Content-Type": "application/json" } }) },
    staticRoot: fileURLToPath(new URL("../dist/web", import.meta.url)) });
  base = `http://127.0.0.1:${service.instance.port}`;
  let initial;
  for (let attempt = 0; attempt < 400; attempt++) {
    initial = await api("/sessions/status?summary=true");
    if (initial.version && initial.job?.status === "complete") break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(initial.version);
  const registration = await api("/repositories", { path: fixture.project });
  await waitJob(registration.job.id, "completed");
  await browser(["open", `${base}/#overview`, "--headed", "--browser=chrome"]);
  await step("五页全局入口与页头图标位置一致，地图操作属于页面", `
    page.setDefaultTimeout(15000); await page.setViewportSize({width:1440,height:1000});
    for(const name of ['总览','会话库','代码地图','用量统计','资源管理']){
      await page.getByRole('button',{name,exact:true}).click();
      await page.locator('.app-header').getByRole('button',{name:'同步历史',exact:true}).waitFor();
      const names=await page.locator('.header-display-actions > button, .header-display-actions > a').evaluateAll(items=>items.map(item=>item.getAttribute('aria-label')));
      expect(names.at(-3)==='显示语言'&&names.at(-2)==='外观'&&names.at(-1)==='项目 GitHub','页头图标顺序不一致');
      expect(await page.locator('.header-actions .refresh-state').count()===0,'页头仍有独立状态图标');
      expect(await page.locator('.app-header').getByRole('combobox',{name:'会话库自动同步',exact:true}).count()===(name==='会话库'?1:0),'会话库自动同步没有按当前页面在顶栏显示');
    }
    await page.getByRole('button',{name:'外观',exact:true}).click();
    await page.screenshot({path:${JSON.stringify(join(artifacts, "compact-appearance-zh.png"))}});await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'代码地图',exact:true}).click();
    expect(await page.locator('.map-page-actions').getByRole('button',{name:'刷新分析',exact:true}).count()===1,'地图分析入口不在页面操作区');
    expect(await page.locator('.map-page-actions').getByRole('combobox',{name:'代码地图自动刷新',exact:true}).count()===1,'地图自动刷新入口缺失');
    await page.locator('.code-map').waitFor();
    await page.screenshot({path:${JSON.stringify(join(artifacts, "desktop-light.png"))}});
  `);
  await step("更新中可打开菜单查看状态，手动检查禁用且不重复发起", `
    let release;const held=new Promise(resolve=>release=resolve);
    await page.route('**/api/v1/sessions/refresh',async route=>{await held;await route.continue();},{times:1});
    const response=page.waitForResponse(response=>response.url().endsWith('/sessions/refresh')&&response.request().method()==='POST');
    await page.getByRole('button',{name:'同步历史',exact:true}).click();
    const menu=page.getByRole('button',{name:'历史同步状态',exact:true});expect(await menu.isEnabled(),'运行中菜单不可打开');await menu.click();
    expect((await page.locator('.history-refresh-panel').innerText()).includes('开始同步'),'菜单没有请求开始状态');
    expect(await page.getByRole('button',{name:'同步历史',exact:true}).isDisabled(),'运行中仍可重复发起更新');
    const progress=page.getByRole('progressbar',{name:'历史同步进度',exact:true});
    expect(await progress.isVisible()&&await progress.getAttribute('value')===null,'请求开始阶段没有不确定进度条');
    await page.keyboard.press('Escape');release();await response;
    await page.waitForFunction(()=>!document.querySelector('.header-actions .refresh-button')?.disabled);
  `);
  await step("状态弹层移除范围与重复动作，页面筛选不限制更新，键盘恢复焦点", `
    await page.getByRole('button',{name:'会话库',exact:true}).click();
    expect(await page.locator('.session-page-actions').count()===0,'会话库仍保留独立空白动作行');
    const workspace=await page.locator('.sessions-shell .workspace').boundingBox();
    const header=await page.locator('.app-header').boundingBox();expect(Math.abs(workspace.y-header.y-header.height)<2,'会话工作区没有接在全局页头下');
    const clients=page.getByRole('combobox',{name:'筛选客户端',exact:true});await clients.click();
    await page.getByRole('option',{name:'Codex',exact:true}).click();
    const menu=page.getByRole('button',{name:'历史同步状态',exact:true});await menu.click();
    expect(await page.locator('.app-header').getByRole('combobox',{name:'会话库自动同步',exact:true}).count()===1,'自动刷新没有在顶栏直接显示');
    expect((await page.locator('.header-actions .auto-refresh-label').innerText())==='自动同步','桌面标签仍重复显示会话库范围');
    expect((await page.locator('.history-refresh-panel').innerText()).includes('最近同步'),'状态缺少最近同步时间');
    expect(await page.locator('.history-refresh-panel').getByRole('combobox').count()===0,'状态仍提供范围选择');
    expect(await page.locator('.history-refresh-panel').getByRole('button').count()===0,'状态仍提供重复更新动作');
    expect(!(await page.locator('.history-refresh-panel').innerText()).includes('校验'),'状态仍暴露技术选项');
    await page.screenshot({path:${JSON.stringify(join(artifacts, "history-status-zh.png"))}});
    await page.keyboard.press('Escape');await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='历史同步状态');
    expect(await menu.evaluate(node=>node===document.activeElement),'关闭状态未恢复焦点');
    expect(await page.getByRole('button',{name:'刷新会话索引',exact:true}).count()===0,'会话库仍有重复入口');
    const response=page.waitForResponse(response=>response.url().endsWith('/sessions/refresh')&&response.request().method()==='POST');
    await page.getByRole('button',{name:'同步历史',exact:true}).click();
    const body=(await response).request().postDataJSON();expect(!body.client&&body.mode==='quick','客户端筛选限制了全局更新');
    await page.waitForFunction(()=>!document.querySelector('.header-actions .refresh-button')?.disabled);
  `);
  await step("各阶段真实进度语义、处理数量、已用时间与桌面窄屏状态", `
    const now=new Date().toISOString();
    const job={id:'synthetic-progress',status:'queued',phase:'queued',progress:0,createdAt:new Date(Date.now()-65000).toISOString(),
      counts:{discovered:10,quickReused:0,verifiedReused:0,parsed:0,missing:0,fallbacks:[]},version:${JSON.stringify(initial.version)}};
    await page.route('**/api/v1/sessions/refresh',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({job})}),{times:1});
    await page.route('**/api/v1/jobs/synthetic-progress',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({job})}));
    const update=page.getByRole('button',{name:'同步历史',exact:true});const idle=await update.boundingBox();expect(idle.width<110,'中文按钮仍为过宽的固定尺寸');
    await update.click();await page.waitForFunction(()=>document.querySelector('.header-actions .refresh-label')?.textContent==='等待同步');
    const progress=page.getByRole('progressbar',{name:'历史同步进度',exact:true});expect(await progress.getAttribute('value')===null,'排队显示了虚假百分比');
    job.status='running';job.phase='建立搜索索引';job.phaseDescriptor={key:'diagnostics.sessions.refresh.m005'};
    await page.waitForFunction(()=>document.querySelector('.header-actions .refresh-label')?.textContent==='准备同步');
    expect(await progress.getAttribute('value')===null,'准备阶段显示了虚假百分比');
    job.phase='discover';delete job.phaseDescriptor;
    await page.waitForFunction(()=>document.querySelector('.header-actions .refresh-label')?.textContent==='查找历史');
    expect(await progress.getAttribute('value')===null,'发现阶段显示了虚假百分比');
    job.phase='index';job.progress=0.5;job.counts.quickReused=5;
    await page.waitForFunction(()=>document.querySelector('.header-actions progress')?.value===0.5);
    expect((await update.innerText()).includes('50%'),'按钮没有可见百分比');const running=await update.boundingBox();expect(Math.abs(running.x+running.width-idle.x-idle.width)<2,'运行状态改变了按钮右侧状态入口的位置');
    await page.getByRole('button',{name:'历史同步状态',exact:true}).click();
    let panel=page.getByRole('dialog',{name:'历史同步状态',exact:true});
    expect((await panel.innerText()).includes('5 / 10'),'处理数量缺失');expect((await panel.innerText()).includes('1 分'),'已用时间缺失');
    expect(!(await panel.innerText()).includes('剩余'),'凭数量估计了剩余时间');
    await page.screenshot({path:${JSON.stringify(join(artifacts, "history-progress-zh.png"))},clip:{x:0,y:0,width:1440,height:420}});
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'显示语言',exact:true}).click();await page.getByRole('menuitemradio',{name:'English',exact:true}).click();
    await page.getByRole('button',{name:'Appearance',exact:true}).click();await page.getByRole('combobox',{name:'Display mode',exact:true}).click();await page.getByRole('option',{name:'Dark',exact:true}).click();await page.keyboard.press('Escape');
    await page.setViewportSize({width:390,height:844});
    const english=page.getByRole('button',{name:'Sync history',exact:true});expect((await english.innerText()).includes('50%'),'窄屏隐藏了百分比');
    expect(await english.locator('.refresh-label').isVisible(),'窄屏隐藏了更新文案');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),'进度导致窄屏溢出');
    const icons=await Promise.all(['Display language','Appearance'].map(name=>page.getByRole('button',{name,exact:true}).boundingBox()));
    const github=await page.getByRole('link',{name:'Project GitHub',exact:true}).boundingBox();
    expect(icons.every(rect=>rect.y===github.y)&&github.x>icons[1].x,'运行中右侧图标被换行拆开');
    await page.getByRole('button',{name:'History sync status',exact:true}).click();
    panel=page.getByRole('dialog',{name:'History sync status',exact:true});const rect=await panel.boundingBox();
    expect(rect.x>=0&&rect.x+rect.width<=390&&rect.y+rect.height<=844,'窄屏进度详情超出视口');
    expect((await panel.innerText()).includes('Elapsed time'),'英文缺少已用时间');
    await page.screenshot({path:${JSON.stringify(join(artifacts, "history-progress-mobile-en.png"))}});
    await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:1000});
    await page.getByRole('button',{name:'Appearance',exact:true}).click();await page.getByRole('combobox',{name:'Display mode',exact:true}).click();await page.getByRole('option',{name:'Light',exact:true}).click();await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Display language',exact:true}).click();await page.getByRole('menuitemradio',{name:'Simplified Chinese',exact:true}).click();
    job.progress=1;await page.waitForFunction(()=>document.querySelector('.header-actions progress')?.value===0.99);
    expect(!(await update.innerText()).includes('100%'),'任务完成前显示100%');
    job.phase='publish';await page.waitForFunction(()=>document.querySelector('.header-actions .refresh-label')?.textContent==='整理结果');
    expect(await progress.getAttribute('value')===null,'发布阶段沿用了处理数量百分比');
    job.status='complete';job.phase='complete';job.finishedAt=now;
    await page.waitForFunction(()=>!document.querySelector('.header-actions .refresh-button')?.disabled);
    expect(await progress.count()===0,'任务完成后进度没有收起');expect((await update.innerText()).includes('同步历史'),'完成后没有恢复主操作');
    await page.unroute('**/api/v1/jobs/synthetic-progress');
  `);
  const newTitle = "历史更新新增合成会话";
  const claudeRows = [
    { type: "user", uuid: "new-user", sessionId: "new-claude", cwd: fixture.project, timestamp: today.toISOString(), message: { role: "user", content: [{ type: "text", text: newTitle }] } },
    { type: "assistant", uuid: "new-reply", sessionId: "new-claude", cwd: fixture.project, timestamp: new Date(today.getTime() + 2000).toISOString(),
      message: { id: "request-new", role: "assistant", model: "sample-model", content: [{ type: "text", text: "合成完成" }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 250 } } },
  ];
  await writeFile(join(claude, "new.jsonl"), claudeRows.map(row => JSON.stringify(row)).join("\n") + "\n");
  await step("全局主按钮忽略客户端筛选，完成后用量页自动读取新增历史", `
    await page.getByRole('button',{name:'用量统计',exact:true}).click();await page.locator('.usage-results').waitFor();
    const oldBody=await page.locator('.usage-report-body').elementHandle();
    const started=page.waitForResponse(response=>response.url().endsWith('/sessions/refresh')&&response.request().method()==='POST');
    await page.getByRole('button',{name:'同步历史',exact:true}).click();
    const response=await started;expect(!response.request().postDataJSON().client,'主按钮被客户端筛选限制');
    await page.locator('.usage-session-name').filter({hasText:${JSON.stringify(newTitle)}}).waitFor();
    expect(await oldBody.evaluate(node=>node===document.querySelector('.usage-report-body')),'历史更新重建了报告容器');
    expect(await page.getByRole('button',{name:'同步历史',exact:true}).isEnabled(),'任务完成后全局入口仍不可用');
  `);
  const latest = await api("/sessions/status?summary=true"); assert.notEqual(latest.version, initial.version);
  await step("隐藏总览切回读取新版本，会话客户端筛选继续保留", `
    const next=page.waitForResponse(response=>response.url().includes('/overview/snapshot?'));
    await page.getByRole('button',{name:'总览',exact:true}).click();
    expect((await (await next).json()).version===${JSON.stringify(latest.version)},'隐藏总览返回后仍读取旧版本');
    await page.getByRole('button',{name:'会话库',exact:true}).click();
    expect((await page.getByRole('combobox',{name:'筛选客户端',exact:true}).innerText()).includes('Codex'),'历史更新重置了客户端筛选');
  `);
  await step("历史检查失败保留报告，重试重新发起检查", `
    await page.getByRole('button',{name:'用量统计',exact:true}).click();await page.locator('.usage-session-name').filter({hasText:${JSON.stringify(newTitle)}}).waitFor();
    let attempts=0;await page.route('**/api/v1/sessions/refresh',route=>{attempts++;return attempts===1?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'INTERNAL_ERROR',message:'合成历史检查失败'}})}):route.continue();});
    await page.getByRole('button',{name:'同步历史',exact:true}).click();await page.getByRole('alert').filter({hasText:'合成历史检查失败'}).waitFor();
    expect(await page.locator('.usage-session-name').filter({hasText:${JSON.stringify(newTitle)}}).count()===1,'检查失败清除了旧报告');
    await page.getByRole('button',{name:'历史同步状态',exact:true}).click();
    const status=page.getByRole('dialog',{name:'历史同步状态',exact:true});
    expect((await status.innerText()).includes('合成历史检查失败'),'状态弹层没有错误详情');
    await status.getByRole('button',{name:'重试',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'合成历史检查失败'}).waitFor({state:'hidden'});
    await page.waitForFunction(()=>!document.querySelector('.header-actions .refresh-button')?.disabled);
    expect(attempts===2,'历史检查失败重试没有重新发起同一操作');await page.unroute('**/api/v1/sessions/refresh');await page.keyboard.press('Escape');
  `);
  await step("任务状态查询失败只重试查询，不重复发起历史检查", `
    let posts=0;let reads=0;page.on('request',request=>{if(request.url().endsWith('/sessions/refresh')&&request.method()==='POST')posts++;});
    await page.route('**/api/v1/jobs/*',route=>{reads++;return reads===1?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'INTERNAL_ERROR',message:'合成任务状态查询失败'}})}):route.continue();});
    await page.getByRole('button',{name:'同步历史',exact:true}).click();const error=page.locator('.history-error').filter({hasText:'合成任务状态查询失败'});await error.waitFor();
    expect((await page.getByRole('button',{name:'同步历史',exact:true}).innerText()).includes('进度获取失败'),'进度查询失败仍显示正常进度');
    expect(await page.getByRole('progressbar',{name:'历史同步进度',exact:true}).getAttribute('value')===null,'进度查询失败继续显示旧百分比');
    await error.getByRole('button',{name:'重试',exact:true}).click();await error.waitFor({state:'hidden'});
    await page.waitForFunction(()=>!document.querySelector('.header-actions .refresh-button')?.disabled);
    expect(posts===1&&reads>=2,'状态重试重复触发了历史检查');await page.unroute('**/api/v1/jobs/*');
  `);
  await step("资源盘点失败重试再次执行POST，查询失败仍重试GET", `
    await page.getByRole('button',{name:'资源管理',exact:true}).click();await page.getByRole('button',{name:'刷新清单',exact:true}).waitFor();
    let attempts=0;await page.route('**/api/v1/resources/refresh?*',route=>{attempts++;return attempts===1?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'INTERNAL_ERROR',message:'合成盘点失败'}})}):route.continue();});
    await page.getByRole('button',{name:'刷新清单',exact:true}).click();const error=page.getByRole('alert').filter({hasText:'合成盘点失败'});await error.waitFor();
    await error.getByRole('button',{name:'重试',exact:true}).click();await error.waitFor({state:'hidden'});
    await page.getByText('本地资源清单已更新',{exact:true}).waitFor();expect(attempts===2,'盘点重试只读取了旧清单');await page.unroute('**/api/v1/resources/refresh?*');
    let gets=0;await page.route('**/api/v1/resources/overview?*',route=>{gets++;return gets===1?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'INTERNAL_ERROR',message:'合成清单查询失败'}})}):route.continue();});
    await page.reload();const queryError=page.getByRole('alert').filter({hasText:'合成清单查询失败'});await queryError.waitFor();
    await queryError.getByRole('button',{name:'重试',exact:true}).click();await queryError.waitFor({state:'hidden'});expect(gets>=2,'查询重试没有重新读取列表');await page.unroute('**/api/v1/resources/overview?*');
  `);
  const resourceBefore = (await api("/resources/overview?kind=skill")).resources.find(row => row.identity.name === "guide").stats.sessions;
  const resourceRows = [
    { type: "session_meta", timestamp: today.toISOString(), payload: { id: "extra-resource-history", cwd: fixture.project, title: "资源使用更新合成会话" } },
    { type: "response_item", timestamp: today.toISOString(), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "再次使用人工指南" }] } },
    { type: "response_item", timestamp: new Date(today.getTime() + 1000).toISOString(), payload: { type: "function_call", name: "shell_command", call_id: "extra-guide-read",
      arguments: JSON.stringify({ command: `cat '${join(fixture.guide, "SKILL.md")}'`, workdir: fixture.project }) } },
    { type: "response_item", timestamp: new Date(today.getTime() + 2000).toISOString(), payload: { type: "function_call_output", call_id: "extra-guide-read", output: "Exit code: 0\nOutput:\n# 指南\n人工合成资源\n" } },
  ];
  await writeFile(join(fixture.history, "extra-resource.jsonl"), resourceRows.map(row => JSON.stringify(row)).join("\n") + "\n");
  await step("资源页历史更新联动使用统计，清单盘点保持独立", `
    await page.waitForLoadState('networkidle');
    let scans=0;page.on('request',request=>{if(request.url().includes('/resources/refresh')&&request.method()==='POST')scans++;});
    const next=page.waitForResponse(response=>response.url().includes('/resources/overview?'));
    await page.getByRole('button',{name:'同步历史',exact:true}).click();const result=await (await next).json();
    expect(result.resources.find(row=>row.identity.name==='guide').stats.sessions===${resourceBefore + 1},'资源使用统计没有跟进新增历史');
    expect(scans===0,'历史更新额外触发了资源盘点');await page.getByRole('row').filter({hasText:'guide'}).waitFor();
  `);
  await step("英文深色窄屏五页入口和菜单位于视口内，显示切换保留筛选", `
    await page.getByRole('button',{name:'会话库',exact:true}).click();
    await page.getByRole('button',{name:'显示语言',exact:true}).click();await page.getByRole('menuitemradio',{name:'English',exact:true}).click();
    await page.getByRole('button',{name:'Appearance',exact:true}).click();await page.getByRole('combobox',{name:'Display mode',exact:true}).click();await page.getByRole('option',{name:'Dark',exact:true}).click();await page.keyboard.press('Escape');
    await page.setViewportSize({width:390,height:844});
    for(const name of ['Overview','Sessions','Code map','Usage','Resources']){
      await page.getByRole('button',{name,exact:true}).click();
      const button=page.getByRole('button',{name:'Sync history',exact:true});await button.waitFor();
      const rect=await button.boundingBox();expect(rect.x>=0&&rect.x+rect.width<=391,'全局入口超出窄屏');
      const github=await page.getByRole('link',{name:'Project GitHub',exact:true}).boundingBox();
      const appearance=await page.getByRole('button',{name:'Appearance',exact:true}).boundingBox();
      expect(github.x>=appearance.x+appearance.width&&github.x+github.width<=391&&github.y===appearance.y,'GitHub 图标未保持在主题右侧或超出窄屏');
      await page.getByRole('button',{name:'History sync status',exact:true}).click();
      const menu=await page.getByRole('dialog',{name:'History sync status',exact:true}).boundingBox();expect(menu.x>=0&&menu.x+menu.width<=391,'历史更新菜单超出窄屏');await page.keyboard.press('Escape');
    }
    await page.getByRole('button',{name:'Sessions',exact:true}).click();
    const scope=page.getByRole('combobox',{name:'Filter clients',exact:true});if(await scope.isVisible())expect((await scope.innerText()).includes('Codex'),'显示切换重置了筛选');
    await page.screenshot({path:${JSON.stringify(join(artifacts, "mobile-dark-en.png"))}});
    await page.getByRole('button',{name:'History sync status',exact:true}).click();
    expect(await page.locator('.app-header').getByRole('combobox',{name:'Session auto sync',exact:true}).count()===1,'窄屏自动刷新没有在顶栏显示');
    const autoMenu=await page.locator('.history-refresh-panel').boundingBox();expect(autoMenu.x>=0&&autoMenu.x+autoMenu.width<=390&&autoMenu.y+autoMenu.height<=844,'自动刷新菜单超出窄屏');
    await page.screenshot({path:${JSON.stringify(join(artifacts, "history-status-mobile-en.png"))}});await page.keyboard.press('Escape');
  `);
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ checks, initialVersion: initial.version, latestVersion: latest.version }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, artifacts }));
} finally {
  await browser(["close"]).catch(() => {});
  if (service) await service.close();
  await rm(directory, { recursive: true, force: true });
}
