import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { clientIds } from "../dist/clients.js";
import { startService } from "../dist/server.js";
import { resourceFixture, skillRankingFixture, mcpOverviewFixture } from "./resource-fixture.mjs";

// 正式静态产物与真实服务、Chrome 联测；全部写操作仅作用于隔离人工资源。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-resources-e2e-")));
const artifacts = fileURLToPath(new URL("../.local/resource-e2e/", import.meta.url));
const session = `resources${process.pid}`;
const checks = [], measurements = [];
const started = Date.now();
let service, fixture, base;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${session}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 5 * 1024 * 1024 });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
const api = async (path, method = "GET", body) => {
  const response = await fetch(`${base}/api/v1${path}`, { method, headers: { "x-agent-manor-instance": service.instance.id, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error?.message ?? String(response.status)), { code: result.error?.code });
  return result;
};
const step = async (name, code) => {
  await browser(["run-code", `async page => { const expect=(value,message)=>{if(!value)throw new Error(message)}; ${code} return {passed:${JSON.stringify(name)}}; }`]);
  checks.push(name); console.log(`PASS ${name}`);
};
const ready = `await page.waitForLoadState('networkidle'); await page.waitForFunction(()=>!document.querySelector('.resource-list-scroll[aria-busy="true"]')&&!document.querySelector('.resource-detail-body[aria-busy="true"]'));`;
const route = (kind = "skill", q = "", id = "", detail = "overview") => `await page.goto(${JSON.stringify(base)}+'/#resources?'+${JSON.stringify(new URLSearchParams({kind,tab:"usage",view:"list",q,id,detail}).toString())}); await page.getByRole('table',{name:${JSON.stringify(kind === "skill" ? "Skill 总览" : "MCP 总览")},exact:true}).waitFor(); ${ready}`;
const open = name => `await page.getByRole('button',{name:${JSON.stringify(`查看${name}的使用详情`)},exact:true}).click(); await page.locator('.resource-detail-heading h2').filter({hasText:${JSON.stringify(name)}}).waitFor(); ${ready}`;
const tab = name => `await page.locator('.resource-detail-tabs').getByRole('button',{name:${JSON.stringify(name)},exact:true}).click();`;
const select = (label, option) => `await page.getByRole('combobox',{name:${JSON.stringify(label)},exact:true}).click(); await page.getByRole('option',{name:${JSON.stringify(option)},exact:true}).click(); ${ready}`;
const tools = name => `await page.getByRole('button',{name:'更多资源工具',exact:true}).click(); await page.getByRole('menuitem',{name:${JSON.stringify(name)},exact:true}).click(); ${ready}`;
const location = path => `page.locator('.resource-management-body').filter({has:page.getByText(${JSON.stringify(path)},{exact:true})})`;
const preview = `page.locator('.resource-preview-panel')`;
const apply = label => `await ${preview}.getByRole('button',{name:${JSON.stringify(label)},exact:true}).click(); await ${preview}.getByRole('button',{name:'完成',exact:true}).waitFor(); expect((await ${preview}.getByRole('status').innerText()).includes('本地修改完成'),'操作没有成功');`;
const finish = `await ${preview}.getByRole('button',{name:'完成',exact:true}).click(); await ${preview}.waitFor({state:'hidden'}); ${ready}`;
const snap = name => `await page.screenshot({path:${JSON.stringify(join(artifacts,name))}});`;

try {
  await mkdir(artifacts, {recursive:true});
  fixture = await resourceFixture(directory, 105);
  const claudeHistory = join(directory,"claude-history"), secondProject = join(directory,"other-project");
  await mkdir(claudeHistory); await mkdir(secondProject);
  await skillRankingFixture(fixture,claudeHistory,secondProject);
  await mcpOverviewFixture(fixture,claudeHistory,secondProject,105);
  await appendFile(fixture.source, JSON.stringify({type:"response_item",timestamp:"2026-01-02T12:02:00Z",payload:{type:"function_call",name:"Skill",call_id:"retired-only",arguments:JSON.stringify({skill:"retired-only"})}})+'\n');
  service = await startService({home:fixture.home,roots:{...Object.fromEntries(clientIds.map(client=>[client,[]])),codex:fixture.history,claude:claudeHistory},resourceInventory:{userHome:fixture.userHome},startupRefresh:true,staticRoot:fileURLToPath(new URL("../dist/web",import.meta.url))});
  base = `http://127.0.0.1:${service.instance.port}`;
  for(let attempt=0;attempt<400;attempt++) { const state=await api('/sessions/status'); if(state.job?.status==='failed')throw new Error(state.job.error); if(state.version)break; await new Promise(resolve=>setTimeout(resolve,25)); }
  assert.ok((await api('/sessions/status')).version);
  await api('/preferences','PUT',{language:'zh-CN'});
  const initialConfig = await readFile(fixture.configPath,'utf8');
  const sample = (await api('/resources/overview?kind=mcp')).resources.find(row=>row.identity.name==='sample');
  const guide = (await api('/resources/overview?kind=skill')).resources.find(row=>row.identity.name==='guide');
  assert.equal(guide.stats.events,5); assert.equal(guide.stats.sessions,3); assert.equal(sample.stats.events,29);
  for(const query of ['kind=skill','kind=skill&presence=present','kind=skill&scope=project', 'kind=mcp']) {
    for(let index=0;index<3;index++) {const begin=performance.now();const result=await api('/resources/overview?summary=true&'+query); measurements.push({query,ms:performance.now()-begin,bytes:Buffer.byteLength(JSON.stringify(result))});}
  }
  await browser(['open',`${base}/#resources`,'--headed','--browser=chrome']);
  await step('正式统一清单、三栏布局及按需加载',`
    page.setDefaultTimeout(15000); await page.setViewportSize({width:1920,height:1000}); ${route()}
    page.resourceErrors=[]; page.on('pageerror',error=>page.resourceErrors.push(error.message));
    const table=page.getByRole('table',{name:'Skill 总览',exact:true});
    expect(await table.getByRole('columnheader',{name:'本地位置',exact:true}).count()===1,'没有本地位置列');
    expect(await table.getByRole('columnheader',{name:/涉及|管理/}).count()===0,'旧 Agent 或管理列残留');
    expect(await page.getByRole('navigation',{name:'资源视图',exact:true}).count()===0,'双清单入口残留');
    expect(await page.getByRole('button',{name:'来源与能力',exact:true}).count()===0,'来源入口仍常驻');
    expect(await page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>['/api/v1/resources/map','/api/v1/resources/status'].includes(new URL(e.name).pathname)&&!e.name.includes('summary=true')).length)===0,'首屏请求地图或完整诊断');
    ${open('guide')}
    const left=await page.getByRole('complementary',{name:'资源筛选',exact:true}).boundingBox();
    const right=await page.getByRole('complementary',{name:'资源详情',exact:true}).boundingBox();
    expect(left.width>=200&&right.width>=380,'三栏默认宽度不足');
    expect((await table.boundingBox()).width<=1121,'宽屏表格无限拉伸');
    ${snap('workspace-wide.png')}
  `);
  await step('名称汇总、三分区和原始描述',`
    expect(await page.locator('.resource-detail-tabs button').count()===3,'详情分区缺失');
    expect((await page.locator('.resource-overview-stats').innerText()).includes('5'),'名称调用数错误');
    ${tab('使用记录')}
    expect(/5\\s*成功读取/.test(await page.locator('.resource-stats').innerText()),'读取统计丢失');
    ${tab('文件位置')}
    expect(await page.locator('.resource-management-body').count()>=3,'不同文件被合并为一个写入对象');
    ${tab('概览')}
  `);
  await step('整行、键盘、文本选择与详情关闭焦点',`
    const table=page.getByRole('table',{name:'Skill 总览',exact:true}); const other=table.locator('tbody tr').nth(1);
    const name=await other.locator('th button').innerText(); await other.locator('td').first().click();
    await page.locator('.resource-detail-heading h2').filter({hasText:name}).waitFor(); ${ready}
    const row=table.getByRole('row',{name:'查看guide的使用详情',exact:true});
    const hash=page.url(); await row.locator('th button').evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);const selection=getSelection();selection.removeAllRanges();selection.addRange(range)});
    await row.locator('td').first().dispatchEvent('click'); expect(page.url()===hash,'选文字触发行导航'); await page.evaluate(()=>getSelection().removeAllRanges());
    await row.focus(); await page.keyboard.press('Enter'); ${ready}
    await page.keyboard.press('Escape'); expect(await row.evaluate(node=>document.activeElement===node),'关闭详情未回到资源行');
    await row.press('Enter'); await page.locator('.resource-detail-heading h2').filter({hasText:'guide'}).waitFor(); ${ready}
  `);
  await step('收藏即时响应、单次写入、稳定 DOM 与焦点',`
    const row=page.getByRole('row',{name:'查看guide的使用详情',exact:true}),star=row.locator('.resource-favorite');
    const table=await page.getByRole('table',{name:'Skill 总览',exact:true}).elementHandle(), detail=await page.locator('.resource-detail-heading').elementHandle(), evidence=await page.locator('.resource-evidence').elementHandle();
    const requests=[]; const listener=request=>{if(request.url().includes('/api/v1/resources/'))requests.push({url:request.url(),method:request.method()})}; page.on('request',listener);
    let release;const gate=new Promise(resolve=>release=resolve);await page.route('**/api/v1/resources/favorites',async route=>{await gate;await route.continue()});
    const saved=page.waitForResponse(response=>response.url().endsWith('/resources/favorites')); await star.click(); expect(await star.getAttribute('aria-pressed')==='true','收藏未即时反馈');
    await star.click({force:true});release();await(await saved).finished();await page.waitForFunction(()=>!document.querySelector('.resource-favorite[aria-busy="true"]'));await page.unroute('**/api/v1/resources/favorites');
    expect(requests.length===1&&requests[0].method==='POST','收藏触发额外查询');
    expect(await table.evaluate(node=>node.isConnected)&&await detail.evaluate(node=>node.isConnected)&&await evidence.evaluate(node=>node.isConnected),'收藏卸载页面');
    expect(await star.evaluate(node=>node===document.activeElement),'收藏丢失焦点'); page.off('request',listener);
    const cleared=page.waitForResponse(response=>response.url().endsWith('/resources/favorites'));await star.click();await(await cleared).finished();await page.waitForFunction(()=>!document.querySelector('.resource-favorite[aria-busy="true"]'));
  `);
  await step('收藏失败回滚且不同资源保存顺序稳定',`
    const star=page.getByRole('row',{name:'查看guide的使用详情',exact:true}).locator('.resource-favorite');
    await page.route('**/api/v1/resources/favorites',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_FAILURE',message:'人工收藏失败'}})}));
    await star.click();await page.getByRole('alert').filter({hasText:'人工收藏失败'}).waitFor();await page.unroute('**/api/v1/resources/favorites');
    expect(await star.getAttribute('aria-pressed')==='false','失败未回滚');
    await page.getByRole('button',{name:'重试',exact:true}).click();${ready}
    const rows=page.getByRole('table',{name:'Skill 总览',exact:true}).locator('tbody tr'); await rows.nth(2).locator('.resource-favorite').click();await rows.nth(3).locator('.resource-favorite').click();
    await page.waitForFunction(()=>!document.querySelector('.resource-favorite[aria-busy="true"]'));
    expect(await rows.nth(2).locator('.resource-favorite').getAttribute('aria-pressed')==='true'&&await rows.nth(3).locator('.resource-favorite').getAttribute('aria-pressed')==='true','不同资源收藏互相覆盖');
    await rows.nth(2).locator('.resource-favorite').click();await rows.nth(3).locator('.resource-favorite').click();await page.waitForFunction(()=>!document.querySelector('.resource-favorite[aria-busy="true"]'));
  `);
  await step('本地范围筛选不改变历史调用，项目选择可搜索',`
    ${select('位置范围','项目级')}
    await page.getByRole('button',{name:'位置项目',exact:true}).click();await page.getByRole('combobox',{name:'位置项目搜索',exact:true}).fill('other-project');await page.getByRole('option').filter({hasText:'other-project'}).click();${ready}
    const row=page.getByRole('row',{name:'查看guide的使用详情',exact:true});expect((await row.innerText()).includes('5'),'位置项目裁剪了历史次数');
    expect((await row.innerText()).includes('项目级'),'位置范围未投影');
    ${select('位置范围','全部范围')}
    expect(await page.getByRole('button',{name:'位置项目',exact:true}).count()===0,'项目条件未渐进隐藏');
  `);
  await step('使用客户端与使用项目独立作用于历史',`
    await page.locator('.resource-more-filters > summary').click();${select('使用客户端','Codex')}
    expect((await page.getByRole('row',{name:'查看guide的使用详情',exact:true}).innerText()).includes('4'),'客户端未筛选历史');
    ${select('使用客户端','全部客户端')}
    await page.getByRole('button',{name:'使用项目',exact:true}).click();await page.getByRole('combobox',{name:'使用项目搜索',exact:true}).fill('other-project');await page.getByRole('option').filter({hasText:'other-project'}).click();${ready}
    expect((await page.getByRole('row',{name:'查看guide的使用详情',exact:true}).innerText()).includes('1'),'使用项目未筛选历史');
    await page.getByRole('button',{name:'重置筛选',exact:true}).click();${ready}
  `);
  await step('未发现、未知和零值保持区别，空结果可恢复',`
    ${select('本地状态','本地未发现')}
    expect(await page.getByRole('row',{name:'查看retired-only的使用详情',exact:true}).isVisible(),'历史独有资源丢失');
    ${select('本地状态','全部')}
    const response=page.waitForResponse(response=>response.url().includes('/resources/overview?')&&response.url().includes('q=no-such-resource')); await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('no-such-resource');await(await response).finished();${ready}
    expect(await page.locator('.resource-empty').count()>0,'没有空结果状态');await page.getByRole('button',{name:'清空资源搜索',exact:true}).click();${ready}
  `);
  await step('排序、首尾页、跳转和容量',`
    await page.getByRole('button',{name:'Skill 总览末页',exact:true}).click();${ready}
    const jump=page.getByRole('spinbutton',{name:'Skill 总览跳转页码',exact:true});await jump.fill('1');await jump.press('Enter');${ready}
    await page.waitForFunction(()=>document.querySelector('[aria-label="Skill 总览首页"]')?.disabled);expect(await page.getByRole('button',{name:'Skill 总览首页',exact:true}).isDisabled(),'跳转没有回到首页');
    await page.getByRole('button',{name:'按调用次数排序',exact:true}).click();${ready}
    expect(await page.getByRole('columnheader').filter({hasText:'调用次数'}).getAttribute('aria-sort')==='ascending','表头排序没有反转');
    ${select('Skill 总览每页条数','50 条／页')}
    await page.waitForFunction(()=>document.querySelectorAll('.resource-overview-table tbody tr').length===50);expect(await page.getByRole('table',{name:'Skill 总览',exact:true}).locator('tbody tr').count()===50,'分页容量未生效');
    await page.getByRole('button',{name:'重置筛选',exact:true}).click();${ready}
  `);
  await step('筛选更新保留旧表格、布局并暂停旧结果下钻',`
    const table=await page.getByRole('table',{name:'Skill 总览',exact:true}).elementHandle(),top=(await page.locator('.resource-list-scroll').boundingBox()).y;
    let release;const gate=new Promise(resolve=>release=resolve);await page.route('**/api/v1/resources/overview?**',async route=>{await gate;await route.continue()});
    await page.getByRole('button',{name:'按调用次数排序',exact:true}).click();await page.locator('.resource-list-scroll[aria-busy="true"]').waitFor();
    expect(await table.evaluate(node=>node.isConnected),'更新卸载旧表格');expect(await page.locator('.resource-list-scroll').getAttribute('inert')!==null,'旧结果可继续下钻');expect((await page.locator('.resource-list-scroll').boundingBox()).y===top,'更新造成布局跳动');
    release();${ready}await page.unroute('**/api/v1/resources/overview?**');
  `);
  await step('刷新失败保留清单并能重试',`
    const count=await page.locator('.resource-overview-table tbody tr').count();
    await page.route('**/api/v1/resources/refresh?**',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_FAILURE',message:'人工盘点失败'}})}));
    await page.getByRole('button',{name:'刷新清单',exact:true}).click();await page.getByRole('alert').filter({hasText:'人工盘点失败'}).waitFor();
    expect(await page.locator('.resource-overview-table tbody tr').count()===count,'失败清空了旧清单');await page.unroute('**/api/v1/resources/refresh?**');
    await page.getByRole('alert').filter({hasText:'人工盘点失败'}).getByRole('button',{name:'重试',exact:true}).click();${ready}
  `);
  await step('旧本地链接进入统一位置详情',`
    await page.goto(${JSON.stringify(base)}+'/#resources?kind=skill&tab=local&bodyId='+${JSON.stringify(guide.localBodyIds[0])});
    await page.locator('.resource-detail-heading h2').filter({hasText:'guide'}).waitFor();${ready}
    expect(await page.locator('.resource-detail-tabs button[aria-current="page"]').innerText()==='文件位置','旧链接丢失位置分区');
    expect(await page.getByRole('navigation',{name:'资源视图',exact:true}).count()===0,'旧链接恢复了已删除视图');
  `);
  await step('Skill 原生路径规则预览、取消及焦点返回',`
    ${route('skill','guide',guide.identity.id,'locations')}
    const control=${location(fixture.guide)}.getByRole('button',{name:'预览停用guide的Codex入口',exact:true});await control.click();
    await ${preview}.getByRole('button',{name:'停用此配置',exact:true}).waitFor();
    expect((await page.locator('.resource-change').innerText()).includes('skills.config[].enabled')&&(await page.locator('.resource-change').innerText()).includes('SKILL.md'),'没有真实路径规则');
    ${snap('skill-preview.png')}
    await ${preview}.getByRole('button',{name:'取消',exact:true}).click();await ${preview}.waitFor({state:'hidden'});${ready}
    await page.waitForFunction(label=>document.activeElement?.getAttribute('aria-label')===label,'预览停用guide的Codex入口');expect(await control.evaluate(node=>document.activeElement===node),'取消预览未恢复焦点');
  `);
  assert.equal(await readFile(fixture.configPath,'utf8'),initialConfig,'取消预览改写了配置');
  await step('Skill 停用并直接预览恢复',`
    await ${location(fixture.guide)}.getByRole('button',{name:'预览停用guide的Codex入口',exact:true}).click();${apply('停用此配置')}
  `);
  assert.equal(parseToml(await readFile(fixture.configPath,'utf8')).skills.config.at(-1).enabled,false);
  await step('Skill 恢复撤销原路径规则',`await ${preview}.getByRole('button',{name:'预览恢复',exact:true}).click();${apply('恢复到原位置')}${finish}`);
  assert.equal(await readFile(fixture.configPath,'utf8'),initialConfig);
  await step('过期源内容使执行失效并允许重新预览',`await ${location(fixture.guide)}.getByRole('button',{name:'预览停用guide的Codex入口',exact:true}).click();await ${preview}.getByRole('button',{name:'停用此配置',exact:true}).waitFor();`);
  await appendFile(fixture.configPath,'\n# external-fixture-change\n');
  await step('冲突保留外部改动',`await ${preview}.getByRole('button',{name:'停用此配置',exact:true}).click();await ${preview}.getByRole('alert').waitFor();expect(await ${preview}.getByRole('button',{name:'停用此配置',exact:true}).count()===0,'冲突仍可执行旧预览');${finish}`);
  assert.match(await readFile(fixture.configPath,'utf8'),/external-fixture-change/);await writeFile(fixture.configPath,initialConfig);
  await step('Skill 回收展示真实路径变化并执行',`await ${location(fixture.guide)}.getByRole('button',{name:${JSON.stringify(`将${fixture.guide}移入回收区`)},exact:true}).click();await ${preview}.getByRole('button',{name:'移入回收区',exact:true}).waitFor();expect((await page.locator('.resource-change-diff').innerText()).includes('resource-vault'),'没有回收路径');${apply('移入回收区')}`);
  await assert.rejects(access(fixture.guide),{code:'ENOENT'});
  await mkdir(fixture.guide);await writeFile(join(fixture.guide,'occupied.txt'),'keep');
  await step('恢复遇到原位置占用时不覆盖',`await ${preview}.getByRole('button',{name:'预览恢复',exact:true}).click();await ${preview}.getByRole('alert').waitFor();`);
  assert.equal(await readFile(join(fixture.guide,'occupied.txt'),'utf8'),'keep');await rm(fixture.guide,{recursive:true});
  await step('解决占用后重新预览并完整恢复附件',`await ${preview}.getByRole('button',{name:'重新预览',exact:true}).click();${apply('恢复到原位置')}${finish}`);
  assert.equal(await readFile(join(fixture.guide,'asset.txt'),'utf8'),'保留资源附件\n');
  await step('共享符号链接单独移除，目标文件保留',`
    ${route('skill','shared')}${open('shared')}${tab('文件位置')}
    await page.locator('.resource-linked-locations > summary').click();await page.getByRole('button',{name:${JSON.stringify(`移除链接${fixture.link}，保留目标文件`)},exact:true}).click();
    await ${preview}.getByRole('button',{name:'移入回收区',exact:true}).waitFor();expect((await ${preview}.innerText()).includes('只移除这个链接'),'未解释链接边界');${apply('移入回收区')}
  `);
  await assert.rejects(access(fixture.link),{code:'ENOENT'});await access(join(fixture.shared,'SKILL.md'));
  await step('链接恢复仍指向原目标',`await ${preview}.getByRole('button',{name:'预览恢复',exact:true}).click();${apply('恢复到原位置')}${finish}`);
  assert.equal(await realpath(fixture.link),await realpath(fixture.shared));
  await step('MCP 独立注册和字段前后值，不展示敏感内容',`
    ${route('mcp','sample',sample.identity.id,'locations')}
    expect(await page.locator('.resource-management-body').count()===4,'同名注册被合并');
    await ${location(fixture.configPath)}.getByRole('button',{name:'预览停用sample的Codex入口',exact:true}).click();await ${preview}.getByRole('button',{name:'停用此配置',exact:true}).waitFor();
    const text=await ${preview}.innerText();expect(text.includes('mcp_servers.sample.enabled')&&text.includes('false'),'MCP字段差异缺失');expect(!/synthetic-secret|example-command|example.invalid/.test(text),'预览泄露注册值');
    ${snap('mcp-preview.png')}${apply('停用此配置')}
  `);
  assert.equal(parseToml(await readFile(fixture.configPath,'utf8')).mcp_servers.sample.enabled,false);
  await step('MCP 原生配置恢复',`await ${preview}.getByRole('button',{name:'预览恢复',exact:true}).click();${apply('恢复到原位置')}${finish}`);
  assert.equal(await readFile(fixture.configPath,'utf8'),initialConfig);
  const projectConfig=join(fixture.project,'.mcp.json'),projectBefore=await readFile(projectConfig,'utf8');
  await step('MCP 移除只改一条注册',`await ${location(projectConfig)}.getByRole('button',{name:/^预览移入回收区/}).click();await ${preview}.getByRole('button',{name:'移除这条注册',exact:true}).waitFor();${apply('移除这条注册')}`);
  assert.equal(JSON.parse(await readFile(projectConfig,'utf8')).mcpServers?.sample,undefined);
  await step('MCP 恢复预览指向配置项，恢复原注册',`await ${preview}.getByRole('button',{name:'预览恢复',exact:true}).click();await ${preview}.getByRole('button',{name:'恢复这条注册',exact:true}).waitFor();const text=await page.locator('.resource-change').innerText();expect(text.includes('mcpServers.sample')&&!text.includes('resource-vault'),'注册恢复伪造了目录搬移');${apply('恢复这条注册')}${finish}`);
  assert.equal(await readFile(projectConfig,'utf8'),projectBefore);
  await step('MCP 工具证据分页与会话返回保留上下文',`
    ${tab('使用记录')}${ready}
    const tool=page.locator('.resource-tool-list').getByRole('button').filter({hasText:'lookup'});expect((await tool.innerText()).includes('22 次'),'工具未汇总跨客户端历史');await tool.click();${ready}
    const pager=page.getByRole('navigation',{name:'使用证据',exact:true});await pager.getByRole('button',{name:'使用证据末页',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.resource-evidence a').length===2);expect((await pager.innerText()).includes('21–22 / 22 条'),'证据分页被截断');
    const hash=page.url().split('#')[1];await page.locator('.resource-evidence a').first().click();await page.waitForURL(/#sessions/);expect(page.url().includes('mode=trace')&&page.url().includes('message='),'没有定位到会话轨迹');await page.goBack();await pager.waitFor();${ready}expect(page.url().split('#')[1]===hash,'返回丢失工具或页码');
    await page.getByRole('button',{name:'全部工具',exact:true}).click();${ready}
  `);
  await step('管理记录和回收工具从更多可达',`${tools('操作记录')}expect(await page.locator('.resource-row').count()>0,'操作记录丢失');${tools('回收区')}expect(await page.getByRole('heading',{name:'资源管理',exact:true}).count()===1,'回收区不可达');${tools('资源清单')}`);
  await step('地图保留并共用筛选与详情',`
    ${route('skill','guide')}${open('guide')}
    await page.getByRole('group',{name:'资源展示方式',exact:true}).getByRole('button',{name:'地图',exact:true}).click();await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    await page.getByRole('button',{name:'查看guide的使用详情',exact:true}).waitFor();expect(await page.locator('.resource-detail-heading h2').innerText()==='guide','视图切换丢失选择');
    ${snap('workspace-map.png')}
    await page.getByRole('group',{name:'资源展示方式',exact:true}).getByRole('button',{name:'列表',exact:true}).click();${ready}expect(await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).inputValue()==='guide','地图丢失搜索');
  `);
  await step('扫描设置按需加载，普通缺失不作为主界面错误',`${tools('扫描详情与设置')}await page.getByRole('dialog',{name:'扫描详情与设置',exact:true}).waitFor();expect(await page.getByText('来源缺口',{exact:true}).count()===0,'诊断数直接报错');await page.keyboard.press('Escape');`);
  await api('/preferences','PUT',{appearance:{mode:'dark',preset:'blue'}});
  await step('深色主题使用真实共享偏好',`await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');${snap('workspace-dark.png')}`);
  await api('/preferences','PUT',{language:'en',appearance:{mode:'light',preset:'blue'}});
  await step('英文、窄屏筛选和全屏详情',`
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByRole('combobox',{name:'Local presence',exact:true}).waitFor();await page.setViewportSize({width:390,height:844});
    const dialog=page.getByRole('dialog',{name:'Resource details',exact:true});await dialog.waitFor();expect((await dialog.boundingBox()).width<=391,'详情宽度溢出');await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Open resource filters',exact:true}).click();const filters=page.getByRole('dialog',{name:'Resource filters',exact:true});await filters.waitFor();await filters.getByRole('combobox',{name:'Local presence',exact:true}).click();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await page.keyboard.press('Escape');await filters.waitFor({state:'hidden'});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'手机页面横向溢出');expect(page.resourceErrors.length===0,'浏览器异常：'+page.resourceErrors.join(';'));${snap('workspace-phone.png')}
  `);
  const report={passed:true,checks,measurements,elapsedMs:Date.now()-started};await writeFile(join(artifacts,'report.json'),JSON.stringify(report,null,2));
  console.log(`PASS 正式资源工作区 Chrome ${checks.length} 项`);
} catch(error) {
  await browser(['screenshot',`--filename=${join(artifacts,'failure.png')}`]).catch(()=>{});
  const state=await browser(['run-code',`async page=>({url:page.url(),text:(await page.locator('body').innerText()).slice(0,18000)})`]).catch(()=>null);
  await writeFile(join(artifacts,'failure-state.txt'),state??'');await writeFile(join(artifacts,'report.json'),JSON.stringify({passed:false,checks,error:error.message,elapsedMs:Date.now()-started},null,2));throw error;
} finally {await browser(['close']).catch(()=>{});await service?.close().catch(()=>{});await rm(directory,{recursive:true,force:true});}
