import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { clientIds } from "../dist/clients.js";
import { startService } from "../dist/server.js";
import { parse as parseToml } from "smol-toml";
import Database from "better-sqlite3";
import { resourceFixture, skillRankingFixture, mcpOverviewFixture } from "./resource-fixture.mjs";

// 全部历史 roots 和资源 home 均显式隔离；真实 Chrome 只操作人工资源。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-resources-e2e-")));
const artifacts = fileURLToPath(new URL("../.local/resource-e2e/", import.meta.url));
const browserSession = `resources${process.pid}`;
const started = Date.now();
const checks = [];
let service;
let fixture;
let base;
const browser = async args => {
  const result = await run("playwright-cli", [`-s=${browserSession}`, ...args], {
    cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 5 * 1024 * 1024,
  });
  if (result.stdout.includes("### Error")) throw new Error(result.stdout);
  return result.stdout;
};
const api = async (path, method = "GET", body) => {
  const response = await fetch(`${base}/api/v1${path}`, { method, headers: {
    "x-agent-manor-instance": service.instance.id, ...(body === undefined ? {} : { "Content-Type": "application/json" }),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error?.message ?? String(response.status)), { code: result.error?.code });
  return result;
};
const step = async (name, code) => {
  const output = await browser(["run-code", `async page => {
    const expect = (value, message) => { if (!value) throw new Error(message); };
    ${code}
    return { passed: ${JSON.stringify(name)} };
  }`]);
  checks.push(name);
  console.log(`PASS ${name}`);
  return output;
};
const select = (label, option) => `await page.getByRole("combobox", {name:${JSON.stringify(label)},exact:true}).click(); await page.getByRole("option",{name:${JSON.stringify(option)},exact:true}).click();`;
const view = label => `await page.getByRole("navigation",{name:"资源视图"}).getByRole("button",{name:${JSON.stringify(label)},exact:true}).click();`;
const search = name => `await page.getByRole("textbox",{name:"搜索资源名称或路径",exact:true}).fill(${JSON.stringify(name)});`;
const local = name => `${view("本地资源")} ${search(name)} await page.getByRole("button",{name:${JSON.stringify(`查看${name}的本地详情`)},exact:true}).click(); await page.locator(".resource-detail-heading h2").filter({hasText:${JSON.stringify(name)}}).waitFor();`;
const screenshot = name => `await page.screenshot({path:${JSON.stringify(join(artifacts, name))}});`;
const actionNames = { disable: "停用", trash: "移入回收区", restore: "恢复", purge: "永久清除" };
const previewEntry = (action, name, client = "Codex") => `await page.getByRole("button",{name:${JSON.stringify(`预览${actionNames[action]}${name}的${client}入口`)},exact:true}).click(); await page.getByRole("dialog",{name:${JSON.stringify(`${actionNames[action]}预览`)},exact:true}).getByRole("button",{name:${JSON.stringify(`确认${actionNames[action]}`)},exact:true}).waitFor();`;
const confirm = action => `{
  const dialog=page.getByRole("dialog",{name:${JSON.stringify(`${actionNames[action]}预览`)},exact:true});
  ${action === "purge" ? 'expect(await dialog.getByRole("button",{name:"确认永久清除",exact:true}).isDisabled(),"永久清除未要求二次确认"); await dialog.getByRole("checkbox",{name:"我确认永久清除所列恢复材料",exact:true}).check();' : ""}
  await dialog.getByRole("button",{name:${JSON.stringify(`确认${actionNames[action]}`)},exact:true}).click();
  await dialog.getByRole("button",{name:"完成",exact:true}).waitFor();
  expect((await dialog.innerText()).includes(${JSON.stringify(action === "purge" ? "客户端生效状态未知" : "待重新加载")}),"结果未说明客户端生效边界");
  expect((await dialog.getByRole("status").innerText()).includes("本地修改完成"),"管理操作未成功");
  await dialog.getByRole("button",{name:"完成",exact:true}).click(); await dialog.waitFor({state:"hidden"});
}`;
const archive = (tab, name) => `${view(tab)} ${search(name)} await page.getByRole("button",{name:${JSON.stringify(`查看${name}的恢复记录`)},exact:true}).click(); await page.getByRole("button",{name:"预览恢复",exact:true}).waitFor();`;
const restore = `await page.getByRole("button",{name:"预览恢复",exact:true}).click(); await page.getByRole("dialog",{name:"恢复预览",exact:true}).getByRole("button",{name:"确认恢复",exact:true}).waitFor(); ${confirm("restore")}`;

try {
  await mkdir(artifacts, { recursive: true });
  fixture = await resourceFixture(directory, 105);
  await run("git", ["init", "-q", fixture.project]);
  const claudeHistory = join(directory, "history-claude");
  await mkdir(claudeHistory);
  const roots = { ...Object.fromEntries(clientIds.map(client => [client, []])), codex: fixture.history, claude: claudeHistory };
  service = await startService({ home: fixture.home, roots, resourceInventory: { userHome: fixture.userHome },
    startupRefresh: true, staticRoot: fileURLToPath(new URL("../dist/web", import.meta.url)) });
  base = `http://127.0.0.1:${service.instance.port}`;
  let ready = false;
  for (let attempt = 0; attempt < 400; attempt++) {
    const status = await api("/sessions/status");
    if (status.job?.status === "failed") throw new Error(status.job.error);
    if (status.version) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(ready, "人工历史未完成索引");
  const initialConfig = await readFile(fixture.configPath, "utf8");
  const usage = await api("/resources/usage?kind=skill");
  assert.equal(usage.resources.find(row => row.identity.name === "guide")?.stats.successfulReads, 1);
  await writeFile(join(fixture.project, "sample.ts"), "export const sample = 1;\n");
  const registered = await api("/repositories", "POST", { path: fixture.project });
  for (let attempt = 0; attempt < 400; attempt++) {
    const { job } = await api(`/jobs/${registered.job.id}`);
    if (job.status === "completed") break;
    assert.notEqual(job.status, "failed", job.error);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal((await api(`/jobs/${registered.job.id}`)).job.status, "completed");
  await api("/preferences", "PUT", { language: "zh-CN" });
  await browser(["open", `${base}/#resources`, "--headed", "--browser=chrome"]);

  await step("资源首屏不加载隐藏代码地图，切回地图按需加载", `
    await page.getByRole("table",{name:"Skill 总览",exact:true}).waitFor();
    await page.waitForFunction(()=>performance.getEntriesByType("resource").some(entry=>new URL(entry.name).pathname==="/api/v1/status"));
    const coverageCount=()=>page.evaluate(()=>performance.getEntriesByType("resource").filter(entry=>new URL(entry.name).pathname.endsWith("/coverage")).length);
    expect(await coverageCount()===0,"资源首屏触发了隐藏地图查询");
    const navigation=page.getByRole("navigation",{name:"功能导航"});
    await navigation.getByRole("button",{name:"代码地图",exact:true}).click();
    await page.locator(".map-file").first().waitFor();
    const loaded=await coverageCount();
    expect(loaded>0,"切回代码地图没有加载数据");
    await navigation.getByRole("button",{name:"资源管理",exact:true}).click();
    await page.getByRole("table",{name:"Skill 总览",exact:true}).waitFor();
    expect(await coverageCount()===loaded,"返回资源页重新查询了隐藏地图");
  `);

  await step("入口、Skill 读取与调用分列", `
    page.resourceErrors=[]; page.on("pageerror",error=>page.resourceErrors.push(error.message));
    await page.setViewportSize({width:1560,height:980});
    await page.getByRole("navigation",{name:"功能导航"}).getByRole("button",{name:"资源管理",exact:true}).click();
    await page.getByRole("button",{name:"查看guide的使用详情",exact:true}).click();
    await page.locator(".resource-detail-heading h2").filter({hasText:"guide"}).waitFor();
    const stats=await page.locator(".resource-stats").innerText();
    expect(/1\\s*成功读取/.test(stats),"Skill读取未分列");
    expect(/0\\s*显式调用/.test(stats),"读取被误计为显式调用");
    expect(await page.locator(".resource-tags").filter({hasText:"已关联本地入口"}).count()>0,"Skill路径未关联");
    ${screenshot("usage-light.png")}
  `);
  await step("收藏筛选、空结果与键盘下拉", `
    const row=page.getByRole("table",{name:"Skill 总览",exact:true}).getByRole("row").filter({has:page.getByRole("button",{name:"查看guide的使用详情",exact:true})});
    await row.getByRole("button",{name:"收藏guide",exact:true}).click();
    await row.getByRole("button",{name:"取消收藏guide",exact:true}).waitFor();
    await page.getByRole("group",{name:"Skill 快速筛选",exact:true}).getByRole("button",{name:/^已收藏/}).click();
    await page.getByRole("button",{name:"查看guide的使用详情",exact:true}).waitFor();
    await row.getByRole("button",{name:"取消收藏guide",exact:true}).click();
    await page.getByText("没有匹配的 Skill",{exact:true}).waitFor();
    await page.getByRole("group",{name:"Skill 快速筛选",exact:true}).getByRole("button",{name:/^全部/}).click();
    const picker=page.getByRole("combobox",{name:"资源Agent",exact:true});
    await picker.focus(); await page.keyboard.press("ArrowDown");
    await page.getByRole("option",{name:"Codex",exact:true}).focus(); await page.keyboard.press("Enter");
    expect((await picker.innerText()).includes("Codex"),"键盘选择未生效");
    await picker.click(); await page.keyboard.press("Escape");
    expect(await picker.evaluate(element=>element===document.activeElement),"Escape未恢复焦点");
  `);
  await step("日期选择与清空、项目搜索", `
    ${select("资源使用时间", "自定义日期")}
    await page.getByRole("button",{name:"资源开始日期",exact:true}).click();
    await page.getByRole("button",{name:"今天",exact:true}).click();
    expect(!(await page.getByRole("button",{name:"资源开始日期",exact:true}).innerText()).includes("选择日期"),"日期未选中");
    await page.getByRole("button",{name:"资源开始日期",exact:true}).click();
    await page.getByRole("button",{name:"清空",exact:true}).click();
    expect((await page.getByRole("button",{name:"资源开始日期",exact:true}).innerText()).includes("选择日期"),"日期未清空");
    ${select("资源使用时间", "全部历史")}
    expect(await page.locator(".resources-shell").getByRole("button",{name:"筛选项目",exact:true}).count()===0,"Skill排行仍展示项目筛选");
    ${view("本地资源")}
    await page.locator(".resources-shell").getByRole("button",{name:"筛选项目",exact:true}).click();
    await page.getByRole("combobox",{name:"搜索项目",exact:true}).fill("sample-project");
    await page.getByRole("option").filter({hasText:"sample-project"}).click();
    await page.getByText("没有匹配的本地资源",{exact:true}).waitFor();
  `);
  await step("MCP 工具下钻与证据跳转返回", `
    await page.getByRole("group",{name:"资源类型",exact:true}).getByRole("button",{name:"MCP",exact:true}).click();
    ${view("MCP 总览")}
    await page.getByRole("button",{name:"查看sample的使用详情",exact:true}).click();
    const tool=page.locator(".resource-tool-list").getByRole("button").filter({hasText:"lookup"});
    await tool.click();
    await page.waitForFunction(()=>document.querySelectorAll(".resource-evidence a").length===1);
    expect(await page.locator(".resource-evidence a").count()===1,"工具下钻未限制证据");
    const resourceHash=await page.evaluate(()=>location.hash);
    await page.locator(".resource-evidence a").first().click();
    await page.waitForURL(/#sessions/);
    expect(page.url().includes("mode=trace")&&page.url().includes("message="),"证据未定位轨迹");
    await page.goBack(); await page.waitForURL(/#resources/);
    expect((await page.evaluate(()=>location.hash))===resourceHash,"返回未保留筛选与资源位置");
    await page.locator(".resource-evidence a").first().waitFor();
    ${screenshot("mcp-tools.png")}
  `);
  await step("本地长列表分页与受视口约束滚动", `
    await page.getByRole("group",{name:"资源类型",exact:true}).getByRole("button",{name:"Skill",exact:true}).click();
    await page.getByRole("button",{name:"重置筛选",exact:true}).click();
    ${view("本地资源")}
    await page.getByRole("button",{name:"查看guide的本地详情",exact:true}).waitFor();
    await page.getByRole("button",{name:"本地资源下一页",exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[aria-label="本地资源"]')?.textContent.includes("第 2 /"));
    expect(await page.locator(".resource-row").count()===20,"本地资源分页错误");
    await page.locator(".resource-list-scroll").evaluate(element=>element.scrollTop=300);
    const scroll=await page.locator(".resource-list-scroll").evaluate(element=>({top:element.scrollTop,height:element.clientHeight,full:element.scrollHeight}));
    expect(scroll.top>0&&scroll.full>scroll.height,"列表没有独立滚动");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.documentElement.scrollHeight<=innerHeight+1),"资源页面溢出视口");
    ${screenshot("local-list-light.png")}
    await page.getByRole("button",{name:"切换主题",exact:true}).click();
    expect(await page.evaluate(()=>document.documentElement.dataset.theme)==="dark","深色主题未生效");
    ${screenshot("local-list-dark.png")}
    await page.getByRole("button",{name:"切换主题",exact:true}).click();
  `);

  const manualRoot = join(directory, "manual-skills");
  await mkdir(join(manualRoot, "manual-guide"), { recursive: true });
  await writeFile(join(manualRoot, "manual-guide", "SKILL.md"), "---\nname: manual-guide\n---\n人工手动来源。\n");
  await step("手动来源添加与只读状态", `
    await page.getByRole("button",{name:"添加来源",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"添加资源来源",exact:true});
    await dialog.getByRole("textbox",{name:"资源来源绝对路径",exact:true}).fill(${JSON.stringify(manualRoot)});
    await dialog.getByRole("button",{name:"添加并盘点",exact:true}).click();
    await dialog.waitFor({state:"hidden"});
    ${search("manual-guide")}
    await page.getByRole("button",{name:"查看manual-guide的本地详情",exact:true}).click();
    await page.locator(".resource-detail-heading h2").filter({hasText:"manual-guide"}).waitFor();
    expect((await page.locator(".resource-entry").innerText()).includes("只读"),"手动未知来源未保持只读");
  `);
  // 管理交互由下一组使用真实 Dialog 执行；只有 API 用于回读与制造确定性冲突。
  assert.equal(await readFile(fixture.configPath, "utf8"), initialConfig, "只读阶段修改了配置");
  await step("原生 Skill 停用与恢复，具体确认与待重新加载", `${local("guide")} ${previewEntry("disable", "guide")}
    expect((await page.getByRole("dialog",{name:"停用预览",exact:true}).innerText()).includes("恢复备份位置"),"停用备份冒充移动目标");
    ${screenshot("disable-preview.png")} ${confirm("disable")}`);
  const disabled = parseToml(await readFile(fixture.configPath, "utf8"));
  assert.equal(disabled.skills.config.at(-1).enabled, false);
  assert.equal(disabled.mcp_servers.sample.env.TOKEN, parseToml(initialConfig).mcp_servers.sample.env.TOKEN);
  await step("已停用记录可恢复", `${archive("已停用", "guide")} ${restore}`);
  assert.equal(parseToml(await readFile(fixture.configPath, "utf8")).mcp_servers.other.enabled, true);

  await step("共享链接只隔离选中入口", `${local("shared")} ${previewEntry("trash", "shared", "Claude Code")} ${confirm("trash")}`);
  await assert.rejects(access(fixture.link), { code: "ENOENT" });
  assert.ok((await readFile(join(fixture.shared, "SKILL.md"), "utf8")).includes("共享测试资源"));
  await step("回收入口恢复", `${archive("回收区", "shared")} ${restore}`);
  assert.equal(await realpath(fixture.link), await realpath(fixture.shared));

  const legacyEntry = (await api("/resources/local?kind=skill&q=sample-01")).rows.find(row => row.body.name === "sample-01").entries[0];
  const legacyPreview = await api("/resources/preview", "POST", { entryId: legacyEntry.id, action: "standby" });
  assert.equal((await api("/resources/apply", "POST", { previewId: legacyPreview.id, confirmed: true })).status, "success");
  await step("旧备用链接归回收区并保留恢复入口", `
    await page.evaluate(()=>location.hash='#resources?kind=skill&tab=standby&q=sample-01');
    const nav=page.getByRole("navigation",{name:"资源视图",exact:true});
    await nav.getByRole("button",{name:"回收区",exact:true}).waitFor();
    await page.waitForFunction(()=>new URLSearchParams(location.hash.split('?')[1]).get('tab')==='trash');
    expect(await nav.getByRole("button",{name:"备用",exact:true}).count()===0,"旧链接仍显示备用标签");
    await page.getByRole("button",{name:"查看sample-01的恢复记录",exact:true}).click();
    await page.getByRole("button",{name:"预览永久清除",exact:true}).waitFor();
    ${restore}
  `);

  await step("来源变化前生成可审阅预览", `${local("guide")} ${previewEntry("trash", "guide")}`);
  await appendFile(join(fixture.guide, "SKILL.md"), "\n预览后人工追加。\n");
  await step("旧预览失效，不继续修改来源", `
    const dialog=page.getByRole("dialog",{name:"移入回收区预览",exact:true});
    await dialog.getByRole("button",{name:"确认移入回收区",exact:true}).click();
    await dialog.getByRole("alert").waitFor();
    expect(!(await dialog.innerText()).includes("本地已修改"),"冲突被宣称成功");
    expect(await dialog.getByRole("button",{name:"确认移入回收区",exact:true}).count()===0,"旧预览确认入口仍可执行");
    await dialog.getByRole("button",{name:"重新预览",exact:true}).waitFor();
    const done=dialog.getByRole("button",{name:"完成",exact:true});
    if(await done.count()) await done.click(); else await dialog.getByRole("button",{name:"取消",exact:true}).click();
  `);
  assert.ok((await readFile(join(fixture.guide, "SKILL.md"), "utf8")).includes("预览后人工追加"));

  await step("回收保留完整目录附件", `${local("guide")} ${previewEntry("trash", "guide")} ${confirm("trash")}`);
  await assert.rejects(access(fixture.guide), { code: "ENOENT" });
  await mkdir(fixture.guide, { recursive: true });
  await writeFile(join(fixture.guide, "SKILL.md"), "新占用内容，不可覆盖。\n");
  await step("恢复位置冲突直接可见并禁止覆盖", `
    ${archive("回收区", "guide")}
    await page.getByRole("button",{name:"预览恢复",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"恢复预览",exact:true});
    await dialog.getByRole("alert").waitFor();
    expect(await dialog.getByRole("button",{name:"确认恢复",exact:true}).count()===0,"冲突仍可直接恢复");
    await dialog.getByRole("button",{name:"重新预览",exact:true}).waitFor();
    ${screenshot("restore-conflict.png")}
  `);
  assert.equal(await readFile(join(fixture.guide, "SKILL.md"), "utf8"), "新占用内容，不可覆盖。\n");
  await rm(fixture.guide, { recursive: true });
  await step("冲突处理后必须重新预览再恢复", `
    const dialog=page.getByRole("dialog",{name:"恢复预览",exact:true});
    await dialog.getByRole("button",{name:"重新预览",exact:true}).click();
    await dialog.getByRole("button",{name:"确认恢复",exact:true}).waitFor(); ${confirm("restore")}
  `);
  assert.equal(await readFile(join(fixture.guide, "asset.txt"), "utf8"), "保留资源附件\n");

  await step("删除先回收，恢复材料仍可查看", `${local("sample-00")} ${previewEntry("trash", "sample-00")} ${confirm("trash")} ${archive("回收区", "sample-00")}`);
  const recycled = (await api("/resources/archives?state=trash")).archives.find(item => item.entry.name === "sample-00");
  assert.ok(recycled.restorable); await access(recycled.storedPath);
  await step("永久清除另行确认", `
    await page.getByRole("button",{name:"预览永久清除",exact:true}).click();
    await page.getByRole("dialog",{name:"永久清除预览",exact:true}).getByRole("button",{name:"确认永久清除",exact:true}).waitFor();
    ${confirm("purge")}
  `);
  await assert.rejects(access(recycled.storedPath), { code: "ENOENT" });

  await step("MCP 原生停用保留其他注册与敏感材料", `
    await page.getByRole("group",{name:"资源类型",exact:true}).getByRole("button",{name:"MCP",exact:true}).click();
    ${local("sample")} ${previewEntry("disable", "sample")} ${confirm("disable")}
  `);
  const mcpDisabled = parseToml(await readFile(fixture.configPath, "utf8"));
  assert.equal(mcpDisabled.mcp_servers.sample.enabled, false);
  assert.deepEqual(mcpDisabled.mcp_servers.other, parseToml(initialConfig).mcp_servers.other);
  assert.equal(mcpDisabled.mcp_servers.sample.env.TOKEN, parseToml(initialConfig).mcp_servers.sample.env.TOKEN);
  await step("MCP 停用恢复与操作记录", `
    ${archive("已停用", "sample")} ${restore}
    ${view("操作记录")} ${search("")}
    await page.getByRole("button",{name:"查看sample的恢复记录",exact:true}).waitFor();
    expect((await page.locator(".resource-list-scroll").innerText()).includes("待重新加载"),"操作记录未保留客户端生效状态");
    ${screenshot("operations.png")}
  `);
  await step("窄屏筛选、详情与独立滚动", `
    await page.getByRole("group",{name:"资源类型",exact:true}).getByRole("button",{name:"Skill",exact:true}).click();
    ${view("本地资源")} ${search("guide")}
    await page.setViewportSize({width:760,height:900});
    await page.getByRole("button",{name:"打开资源筛选",exact:true}).click();
    const filterDialog=page.getByRole("dialog",{name:"资源筛选",exact:true});
    await filterDialog.getByRole("combobox",{name:"资源客户端",exact:true}).click();
    await page.getByRole("option",{name:"全部客户端",exact:true}).click();
    await filterDialog.getByRole("button",{name:"完成",exact:true}).click();
    await filterDialog.waitFor({state:"hidden"});
    await page.getByRole("button",{name:"查看guide的本地详情",exact:true}).click();
    const detailDialog=page.getByRole("dialog",{name:"资源详情",exact:true});
    await detailDialog.getByRole("heading",{name:"guide",exact:true}).waitFor();
    const box=await detailDialog.boundingBox(); expect(box.x>=0&&box.x+box.width<=760,"窄屏详情超出视口");
    ${screenshot("narrow-detail.png")}
    await page.keyboard.press("Escape"); await detailDialog.waitFor({state:"hidden"});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.documentElement.scrollHeight<=innerHeight+1),"窄屏页面溢出");
    await page.setViewportSize({width:375,height:812});
    ${search("")}
    await page.getByRole("button",{name:"打开资源筛选",exact:true}).click();
    const phoneFilter=page.getByRole("dialog",{name:"资源筛选",exact:true});
    const filterBox=await phoneFilter.boundingBox(); expect(filterBox.x>=0&&filterBox.x+filterBox.width<=375,"375px筛选超出视口");
    await phoneFilter.getByRole("button",{name:"完成",exact:true}).click(); await phoneFilter.waitFor({state:"hidden"});
    await page.getByRole("button",{name:"查看guide的本地详情",exact:true}).click();
    const phoneDetail=page.getByRole("dialog",{name:"资源详情",exact:true});
    await phoneDetail.getByRole("heading",{name:"guide",exact:true}).waitFor();
    await phoneDetail.getByRole("button",{name:"预览停用guide的Codex入口",exact:true}).click();
    const nested=page.getByRole("dialog",{name:"停用预览",exact:true});
    await nested.getByRole("button",{name:"确认停用",exact:true}).waitFor();
    await page.keyboard.press("Escape"); await nested.waitFor({state:"hidden"});
    await page.waitForFunction(()=>document.querySelector('[aria-label="预览停用guide的Codex入口"]')===document.activeElement,undefined,{timeout:2000});
    expect(await phoneDetail.getByRole("button",{name:"预览停用guide的Codex入口",exact:true}).evaluate(element=>element===document.activeElement),"嵌套预览关闭未恢复操作焦点");
    ${screenshot("phone-detail.png")}
    await page.keyboard.press("Escape"); await phoneDetail.waitFor({state:"hidden"});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.documentElement.scrollHeight<=innerHeight+1),"375px页面溢出");
    expect(page.resourceErrors.length===0,"浏览器异常："+page.resourceErrors.join(";"));
    await page.setViewportSize({width:1560,height:980});
  `);

  // 前面的管理断言完成后才增加历史，避免改变初始排行及读取次数。
  const secondProject = join(directory, "second-project");
  await mkdir(secondProject);
  await run("git", ["init", "-q", secondProject]);
  const codexShared = [
    { type: "session_meta", timestamp: "2026-01-03T12:00:00Z", payload: { id: "shared-codex-example", cwd: fixture.project, title: "共享 Skill 的 Codex 使用" } },
    { type: "response_item", timestamp: "2026-01-03T12:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "读取人工共享资源" }] } },
    { type: "response_item", timestamp: "2026-01-03T12:00:02Z", payload: { type: "function_call", name: "shell_command", call_id: "shared-codex-read", arguments: JSON.stringify({ command: `cat '${join(fixture.shared, "SKILL.md")}'`, workdir: fixture.project }) } },
    { type: "response_item", timestamp: "2026-01-03T12:00:03Z", payload: { type: "function_call_output", call_id: "shared-codex-read", output: "Exit code: 0\nOutput:\n共享测试资源。\n" } },
    { type: "response_item", timestamp: "2026-01-03T12:00:04Z", payload: { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "人工共享资源已读取" }] } },
  ];
  const claudeShared = [
    { type: "user", uuid: "shared-claude-user", timestamp: "2026-01-04T12:00:00Z", sessionId: "shared-claude-example", cwd: secondProject, message: { content: [{ type: "text", text: "读取人工共享资源" }] } },
    { type: "assistant", uuid: "shared-claude-request", timestamp: "2026-01-04T12:00:01Z", sessionId: "shared-claude-example", cwd: secondProject, message: { content: [{ type: "tool_use", id: "shared-claude-read", name: "Read", input: { file_path: join(fixture.link, "SKILL.md") } }] } },
    { type: "user", uuid: "shared-claude-result", timestamp: "2026-01-04T12:00:02Z", sourceToolAssistantUUID: "shared-claude-request", sessionId: "shared-claude-example", cwd: secondProject, message: { content: [{ type: "tool_result", tool_use_id: "shared-claude-read", content: "共享测试资源。\n", is_error: false }] }, toolUseResult: { type: "text", file: { filePath: join(fixture.link, "SKILL.md"), content: "共享测试资源。\n", numLines: 1, startLine: 1, totalLines: 1 } } },
    { type: "assistant", uuid: "shared-claude-final", timestamp: "2026-01-04T12:00:03Z", sessionId: "shared-claude-example", cwd: secondProject, message: { content: [{ type: "text", text: "人工共享资源已读取" }] } },
  ];
  await writeFile(join(fixture.history, "shared-example.jsonl"), codexShared.map(record => JSON.stringify(record)).join("\n") + "\n");
  await writeFile(join(claudeHistory, "shared-example.jsonl"), claudeShared.map(record => JSON.stringify(record)).join("\n") + "\n");
  const { job: refreshJob } = await api("/sessions/refresh", "POST");
  let finished = refreshJob;
  for (let attempt = 0; attempt < 400 && ["queued", "running"].includes(finished.status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    finished = (await api(`/jobs/${refreshJob.id}`)).job;
  }
  assert.equal(finished.status, "complete", finished.error);
  await api("/resources/refresh", "POST");
  const sharedRow = (await api("/resources/local?kind=skill&q=shared")).rows.find(row => row.body.name === "shared");
  assert.equal(sharedRow.usage.sessions, 2);
  const sharedDetail = await api(`/resources/local/${encodeURIComponent(sharedRow.body.id)}?kind=skill`);
  assert.equal(sharedDetail.clients.length, 2);
  assert.equal(sharedDetail.projects.length, 2);
  assert.equal(sharedDetail.trend.reduce((sum, row) => sum + row.stats.events, 0), 2);
  await step("共享本体合并跨客户端、项目及趋势", `
    await page.getByRole("button",{name:"重置筛选",exact:true}).click();
    await page.getByRole("button",{name:"刷新清单",exact:true}).click();
    await page.getByRole("button",{name:"刷新清单",exact:true}).waitFor();
    ${local("shared")}
    const detail=page.getByRole("complementary",{name:"资源详情",exact:true});
    expect(/2\\s*使用会话/.test(await detail.locator(".resource-stats").innerText()),"共享本体会话数未合并");
    const clients=detail.locator(".resource-detail-section").filter({has:page.getByRole("heading",{name:"客户端分布",exact:true})});
    const projects=detail.locator(".resource-detail-section").filter({has:page.getByRole("heading",{name:"项目分布",exact:true})});
    expect(await clients.locator(".resource-distribution>div").count()===2,"本体客户端分布未合并");
    expect((await clients.innerText()).includes("Codex")&&(await clients.innerText()).includes("Claude Code"),"本体客户端分布缺少真实来源");
    expect(await projects.locator(".resource-distribution>div").count()===2,"本体项目分布未合并");
    expect((await projects.innerText()).includes("sample-project")&&(await projects.innerText()).includes("second-project"),"本体项目分布缺少项目");
    const codexEntry=detail.locator(".resource-entry").filter({has:page.getByText("Codex",{exact:true})});
    expect(await codexEntry.count()===1,"共享本体的Codex物理入口缺失");
    expect(await codexEntry.getByRole("button",{name:"预览移入回收区shared的Codex入口",exact:true}).count()===0,"共享物理本体仍可隔离");
    expect(await codexEntry.getByRole("button",{name:"预览回收shared的Codex入口",exact:true}).count()===0,"共享物理本体仍可回收");
    await detail.getByRole("img",{name:"每日资源使用次数",exact:true}).waitFor();
    await detail.getByText("查看趋势数据 · 2 天",{exact:true}).click();
    const trend=detail.locator(".resource-data-details").filter({hasText:"查看趋势数据 · 2 天"});
    expect(await trend.locator("tbody tr").count()===2,"本体趋势没有保留全部日期");
    ${screenshot("shared-body-analysis.png")}
  `);

  const unusedRow = (await api("/resources/local?kind=skill&q=sample-01")).rows.find(row => row.body.name === "sample-01");
  const management = new Database(join(fixture.home, "resources.sqlite"));
  try {
    assert.equal(management.prepare("UPDATE resource_seen SET first_seen=? WHERE id=?").run("2025-01-01T00:00:00Z", unusedRow.entries[0].id).changes, 1);
  } finally { management.close(); }
  const unused = (await api("/resources/local?kind=skill&q=sample-01&candidate=unused")).rows[0];
  assert.equal(unused.observation, "recorded");
  assert.equal(unused.usage.sessions, 0);
  await step("未发现使用筛选区分确定零值与未知", `
    ${select("资源状态筛选", "未发现使用")}
    ${search("sample-01")}
    await page.getByRole("button",{name:"查看sample-01的本地详情",exact:true}).click();
    const detail=page.getByRole("complementary",{name:"资源详情",exact:true});
    await detail.getByRole("heading",{name:"sample-01",exact:true}).waitFor();
    const tags=await detail.locator(".resource-tags").first().innerText();
    expect(tags.includes("未发现使用")&&!tags.includes("已关联使用")&&!tags.includes("使用未知"),"零使用状态与未知混淆");
    const stats=await detail.locator(".resource-stats").innerText();
    expect(/0\\s*使用会话/.test(stats)&&/0\\s*显式调用/.test(stats)&&/0\\s*成功读取/.test(stats),"确定零使用没有显示0");
    expect((await detail.locator(".resource-stats strong").allTextContents()).every(value=>value.trim()!=="未知"),"零计数错误显示未知");
    expect((await page.locator(".resource-row").innerText()).includes("未发现使用"),"列表未表达未发现使用状态");
    expect(page.resourceErrors.length===0,"浏览器异常："+page.resourceErrors.join(";"));
    ${screenshot("unused-zero-state.png")}
  `);

  const localAsc = await api("/resources/local?kind=skill&sort=uses&order=asc&pageSize=200");
  const localDesc = await api("/resources/local?kind=skill&sort=uses&order=desc&pageSize=200");
  for (const sorted of [localAsc, localDesc]) {
    const firstUnknown = sorted.rows.findIndex(row => row.usage === null);
    assert.ok(firstUnknown >= 0, "夹具缺少真正未知的断链来源");
    assert.ok(sorted.rows.slice(firstUnknown).every(row => row.usage === null), "未知数值没有排在完整结果末尾");
  }
  await step("本地调用排序支持升降，完整结果中真正未知位于末尾", `
    await page.getByRole("button",{name:"重置筛选",exact:true}).click();
    ${select("资源排序方向", "降序")}
    await page.waitForFunction(()=>document.querySelector('.resource-row-heading>strong')?.textContent==='shared');
    const rows=page.locator('.resource-row');
    expect((await rows.first().locator('.resource-row-metrics').innerText()).includes("2"),"本地会话降序未优先已知最大值");
    expect((await rows.last().locator('.resource-row-metrics').innerText()).includes("0"),"新发现零记录仍被当成未知");
    ${select("资源排序方向", "升序")}
    await page.waitForFunction(name=>document.querySelector('.resource-row-heading>strong')?.textContent===name,${JSON.stringify(localAsc.rows[0].body.name)});
    expect((await rows.first().locator('.resource-row-metrics').innerText()).includes("0"),"本地会话升序未优先确定零值");
    expect((await rows.last().locator('.resource-row-metrics').innerText()).includes("0"),"新发现零记录未按已知零值排序");
    expect(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('order'))==='asc',"本地排序方向未写入路由");
    await page.getByRole("button",{name:"重置筛选",exact:true}).click();
  `);

  const rankingBodies = await skillRankingFixture(fixture, claudeHistory, secondProject);
  const { job: rankingRefresh } = await api("/sessions/refresh", "POST");
  let rankingJob = rankingRefresh;
  for (let attempt = 0; attempt < 400 && ["queued", "running"].includes(rankingJob.status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    rankingJob = (await api(`/jobs/${rankingRefresh.id}`)).job;
  }
  assert.equal(rankingJob.status, "complete", rankingJob.error);
  await api("/resources/refresh", "POST");
  const ranked = (await api("/resources/usage?kind=skill&q=guide")).resources.filter(row => row.identity.name === "guide");
  assert.equal(ranked.length, 1);
  const guideRank = ranked[0];
  assert.equal(guideRank.identity.grouping, "skill");
  assert.equal(guideRank.identity.client, undefined); assert.equal(guideRank.identity.project, undefined); assert.equal(guideRank.identity.path, undefined);
  assert.equal(guideRank.stats.sessions, 3); assert.equal(guideRank.stats.successfulReads, 5);
  assert.deepEqual(new Set(guideRank.clients), new Set(["codex", "claude"]));
  const rankedDetail = await api(`/resources/usage/${encodeURIComponent(guideRank.identity.id)}?kind=skill`);
  assert.equal(rankedDetail.origins.length, 4); assert.equal(rankedDetail.projects.length, 2); assert.equal(rankedDetail.resource.association.state, "partial");
  const oldOrigin = rankedDetail.origins.find(origin => origin.client === "codex" && origin.path === fixture.guide);
  assert.ok(oldOrigin);
  await api("/resources/favorites", "POST", { id: oldOrigin.id, value: true });
  const guideOverview = (await api("/resources/overview?q=guide")).resources.find(row => row.identity.id === guideRank.identity.id);
  assert.ok(guideOverview);
  assert.ok(guideOverview.clients.includes("codex") && guideOverview.clients.includes("claude"));
  const oldProjectHash = `#resources?kind=skill&tab=usage&project=${encodeURIComponent(fixture.project)}&q=guide&id=${encodeURIComponent(guideRank.identity.id)}`;
  await step("Skill 全名合并跨 Agent、项目与路径，会话数取并集", `
    page.resourceRequests=[];
    page.on("request",request=>{if(request.url().includes("/api/v1/resources/usage")||request.url().includes("/api/v1/resources/overview"))page.resourceRequests.push(request.url())});
    await page.evaluate(hash=>location.hash=hash,${JSON.stringify(oldProjectHash)});
    const row=page.getByRole("table",{name:"Skill 总览",exact:true}).getByRole("row").filter({has:page.getByRole("button",{name:"查看guide的使用详情",exact:true})});
    await row.getByRole("button",{name:"查看guide的使用详情",exact:true}).waitFor();
    expect(await row.count()===1,"同名Skill仍按来源拆成多行");
    expect((await row.locator(".resource-overview-agents").innerText())===${JSON.stringify(`${guideOverview.clients.length} 个 Agent`)},"总览遗漏历史或本地Agent入口");
    expect(await row.locator(".resource-row-subtitle").count()===0,"Skill排行仍展示单项目或路径");
    expect((await row.getByRole("cell").nth(2).innerText())==="3","使用会话未取并集");
    expect((await row.getByRole("cell").nth(1).innerText())===${JSON.stringify(String(guideOverview.stats.events))},"Skill调用次数没有包含成功读取");
    expect(await row.getByRole("cell").count()===6,"主列表缺少调用次数、使用会话数或管理入口");
    expect(await page.getByRole("combobox",{name:"资源Agent",exact:true}).count()===1,"Agent筛选没有复用统一组件");
    expect(await page.locator(".resources-shell").getByRole("button",{name:"筛选项目",exact:true}).count()===0,"旧项目筛选仍可见");
    const detail=page.getByRole("complementary",{name:"资源详情",exact:true});
    await detail.getByRole("heading",{name:"guide",exact:true}).waitFor();
    expect((await detail.locator(".resource-detail-heading>div>span").innerText())===${JSON.stringify(`${guideOverview.clients.length} 个 Agent`)},"总览详情的Agent范围与列表不一致");
    expect(/3\\s*使用会话/.test(await detail.locator(".resource-stats").innerText()),"详情会话并集错误");
    expect(/5\\s*成功读取/.test(await detail.locator(".resource-stats").innerText()),"详情读取证据丢失");
    expect((await detail.locator(".resource-tags").first().innerText()).includes("部分未关联"),"部分历史未关联状态被隐藏");
    const agents=detail.locator(".resource-detail-section").filter({has:page.getByRole("heading",{name:"Agent 分布",exact:true})});
    const projects=detail.locator(".resource-detail-section").filter({has:page.getByRole("heading",{name:"项目分布",exact:true})});
    expect(await agents.locator(".resource-distribution>div").count()===2,"Agent分布未合并");
    expect(await projects.locator(".resource-distribution>div").count()===2,"项目来源未保留");
    await detail.getByText("历史来源 · 4 个",{exact:true}).click();
    expect(await detail.locator(".resource-origin-list>div").count()===4,"实际历史来源被名称汇总吞掉");
    expect(page.resourceRequests.length>=3&&page.resourceRequests.every(url=>!/[?&]project=/.test(url)),"Skill排行请求仍被旧项目限制");
    await row.getByRole("button",{name:"取消收藏guide",exact:true}).waitFor();
    ${screenshot("skill-name-ranking.png")}
  `);
  await step("旧隐藏项目不限制精确用户及跨项目本体跳转", `
    const detail=page.getByRole("complementary",{name:"资源详情",exact:true});
    for(const path of ${JSON.stringify([fixture.guide, rankingBodies.claudeGuide])}) {
      const body=detail.locator('.resource-entry').filter({has:page.getByText(path,{exact:true})});
      await body.getByRole("button",{name:/^查看guide的本地本体 /}).click();
      await detail.getByRole("heading",{name:"客户端入口",exact:true}).waitFor();
      expect(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('project'))===null,"隐藏项目穿透到本地本体详情");
      await detail.locator('.resource-entry').getByText(path,{exact:true}).first().waitFor();
      expect(await detail.getByRole("alert").count()===0,"精确本体详情被旧项目限制");
      await page.goBack();
      await detail.getByRole("heading",{name:"本地本体与入口",exact:true}).waitFor();
      expect(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('project'))===${JSON.stringify(fixture.project)},"返回丢失原总览路由");
    }
  `);
  await step("旧来源收藏兼容名称汇总与管理保护", `
    const row=page.getByRole("table",{name:"Skill 总览",exact:true}).getByRole("row").filter({has:page.getByRole("button",{name:"查看guide的使用详情",exact:true})});
    await row.getByRole("button",{name:"取消收藏guide",exact:true}).click();
    await row.getByRole("button",{name:"收藏guide",exact:true}).waitFor();
    await row.getByRole("button",{name:"收藏guide",exact:true}).click();
    await row.getByRole("button",{name:"取消收藏guide",exact:true}).waitFor();
  `);
  assert.ok((await api("/resources/status")).favoriteIds.includes(guideRank.identity.id));
  assert.ok(!(await api("/resources/status")).favoriteIds.includes(oldOrigin.id));
  const nativeGuide = (await api("/resources/local?kind=skill&q=guide")).rows.flatMap(row => row.entries).find(entry => entry.client === "codex" && entry.entryPath === fixture.guide);
  assert.ok(nativeGuide);
  assert.equal((await api("/resources/preview", "POST", { entryId: nativeGuide.id, action: "disable" })).protected, true);
  await step("Agent筛选保持Skill身份与证据跳转返回", `
    ${select("资源Agent", "Codex")}
    await page.waitForFunction(()=>{const row=[...document.querySelectorAll(".resource-overview-row")].find(element=>element.querySelector('[aria-label="查看guide的使用详情"]'));return row&&row.querySelectorAll("td")[2].textContent==="2"});
    const codexRow=page.getByRole("table",{name:"Skill 总览",exact:true}).getByRole("row").filter({has:page.getByRole("button",{name:"查看guide的使用详情",exact:true})});
    expect((await codexRow.locator(".resource-overview-agents").innerText()).includes("Codex"),"单Agent筛选名称错误");
    expect(await page.evaluate(()=>new URLSearchParams(location.hash.split("?")[1]).get("id"))===${JSON.stringify(guideRank.identity.id)},"筛选改变了Skill身份");
    ${select("资源Agent", "Claude Code")}
    await page.waitForFunction(()=>{const row=[...document.querySelectorAll(".resource-overview-row")].find(element=>element.querySelector('[aria-label="查看guide的使用详情"]'));return row&&row.querySelectorAll("td")[2].textContent==="1"});
    await page.waitForFunction(()=>document.querySelectorAll(".resource-evidence a").length===1);
    const resourceHash=await page.evaluate(()=>location.hash);
    await page.locator(".resource-evidence a").first().click(); await page.waitForURL(/#sessions/);
    expect(page.url().includes("mode=trace")&&page.url().includes("message="),"Skill证据未定位轨迹");
    await page.goBack(); await page.waitForURL(/#resources/);
    expect((await page.evaluate(()=>location.hash))===resourceHash,"返回未保留Agent筛选与Skill");
    await page.locator(".resource-evidence a").first().waitFor();
    expect((await page.getByRole("combobox",{name:"资源Agent",exact:true}).innerText()).includes("Claude Code"),"返回丢失Agent筛选");
    ${select("资源Agent", "全部 Agent")}
    await page.waitForFunction(()=>{const row=[...document.querySelectorAll(".resource-overview-row")].find(element=>element.querySelector('[aria-label="查看guide的使用详情"]'));return row&&row.querySelectorAll("td")[2].textContent==="3"});
    expect(page.resourceErrors.length===0,"浏览器异常："+page.resourceErrors.join(";"));
  `);
  await api("/resources/favorites", "POST", { id: guideRank.identity.id, value: false });

  const overview = await api("/resources/overview?kind=skill&pageSize=100");
  assert.ok(overview.total > 100);
  assert.ok(overview.counts.used >= 2);
  const zeroOverview = (await api("/resources/overview?kind=skill&q=sample-01")).resources.find(row => row.identity.name === "sample-01");
  const freshOverview = (await api("/resources/overview?kind=skill&q=sample-02")).resources.find(row => row.identity.name === "sample-02");
  assert.equal(zeroOverview.observation, "unused"); assert.equal(zeroOverview.stats.sessions, 0);
  assert.equal(freshOverview.observation, "unused"); assert.equal(freshOverview.stats.sessions, 0);
  await step("总览包含新发现的零记录本地资源", `
    await page.getByRole("button",{name:"重置筛选",exact:true}).click();
    ${view("Skill 总览")}
    const table=page.getByRole("table",{name:"Skill 总览",exact:true}); await table.waitFor();
    expect(await table.getByRole("columnheader").count()===6,"总览列数错误");
    const quick=page.getByRole("group",{name:"Skill 快速筛选",exact:true});
    expect(await quick.getByRole("button").count()===6,"快捷筛选缺失");
    expect((await quick.getByRole("button",{name:/^全部/}).innerText()).includes(${JSON.stringify(String(overview.counts.all))}),"全部计数错误");
    ${screenshot("overview-synthetic-light.png")}
    await quick.getByRole("button",{name:/^已使用/}).click();
    await page.waitForFunction(expected=>document.querySelectorAll('table[aria-label="Skill 总览"] tbody tr').length===expected, ${overview.counts.used});
    expect(await table.getByRole("row").count()===${overview.counts.used + 1},"已使用筛选混入本地未知资源");
    await quick.getByRole("button",{name:/^全部/}).click();
    ${search("sample-02")}
    const row=table.getByRole("row").filter({has:page.getByRole("button",{name:"查看sample-02的使用详情",exact:true})});
    await row.waitFor(); expect((await row.getByRole("cell").allTextContents()).slice(1,2).every(value=>value==="0"),"新资源没有显示零记录");
    expect((await row.innerText()).includes("未发现使用"),"新资源没有进入未发现使用");
    await row.getByRole("button",{name:"查看sample-02的使用详情",exact:true}).click();
    const detail=page.getByRole("complementary",{name:"资源详情",exact:true});
    await detail.getByRole("heading",{name:"sample-02",exact:true}).waitFor();
    expect(/0\\s*使用会话/.test(await detail.locator(".resource-stats").innerText()),"新资源详情没有显示零记录");
    await detail.getByRole("button",{name:"查看sample-02的本地本体 1",exact:true}).click();
    await detail.getByRole("heading",{name:"sample-02",exact:true}).waitFor();
    await detail.getByRole("heading",{name:"客户端入口",exact:true}).waitFor();
    expect(await detail.locator(".resource-entry").count()===1,"跳转没有定位精确本体");
  `);
  await step("总览确定零值与快捷筛选重置页码", `
    ${view("Skill 总览")} ${search("")}
    await page.getByRole("button",{name:"Skill 总览第2页",exact:true}).click();
    const quick=page.getByRole("group",{name:"Skill 快速筛选",exact:true});
    await quick.getByRole("button",{name:/^未发现使用/}).click();
    await page.getByRole("button",{name:"查看sample-01的使用详情",exact:true}).waitFor();
    const row=page.getByRole("table",{name:"Skill 总览",exact:true}).getByRole("row").filter({has:page.getByRole("button",{name:"查看sample-01的使用详情",exact:true})});
    expect((await row.getByRole("cell").allTextContents()).slice(1,2).every(value=>value==="0"),"确定零值没有显示0");
    expect(await page.evaluate(()=>new URLSearchParams(location.hash.split("?")[1]).get("page"))===null,"快捷筛选未重置页码");
    await row.getByRole("button",{name:"查看sample-01的使用详情",exact:true}).click();
    const detail=page.getByRole("complementary",{name:"资源详情",exact:true});
    await detail.getByRole("heading",{name:"sample-01",exact:true}).waitFor();
    expect(/0\\s*使用会话/.test(await detail.locator(".resource-stats").innerText()),"无历史零使用详情错误");
    ${screenshot("overview-unused-zero.png")}
    await quick.getByRole("button",{name:/^全部/}).click();
  `);
  const skillNameAsc = (await api("/resources/overview?kind=skill&sort=name&order=asc")).resources[0].identity.name;
  const skillNameDesc = (await api("/resources/overview?kind=skill&sort=name&order=desc")).resources[0].identity.name;
  await step("总览表头升降排序、键盘操作与路由持久化", `
    const table=page.getByRole("table",{name:"Skill 总览",exact:true});
    await table.getByRole("button",{name:"按Skill排序",exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.resource-overview-table th[aria-sort="ascending"] button')?.textContent.includes("Skill"));
    await page.waitForFunction(()=>document.querySelector('.resource-overview-table tbody th button')?.textContent===${JSON.stringify(skillNameAsc)}&&!document.querySelector('.resource-list-scroll[aria-busy="true"]'));
    const firstAsc=await table.getByRole("row").nth(1).getByRole("rowheader").getByRole("button").first().innerText();
    await table.getByRole("button",{name:"按Skill排序",exact:true}).focus(); await page.keyboard.press("Enter");
    await page.waitForFunction(()=>document.querySelector('.resource-overview-table th[aria-sort="descending"] button')?.textContent.includes("Skill"));
    await page.waitForFunction(()=>document.querySelector('.resource-overview-table tbody th button')?.textContent===${JSON.stringify(skillNameDesc)}&&!document.querySelector('.resource-list-scroll[aria-busy="true"]'));
    const firstDesc=await table.getByRole("row").nth(1).getByRole("rowheader").getByRole("button").first().innerText();
    expect(firstAsc!==firstDesc,"名称排序未改变方向");
    expect(await page.evaluate(()=>new URLSearchParams(location.hash.split("?")[1]).get("order"))==="desc","排序方向没有写入路由");
    await page.reload(); await table.waitFor();
    expect(await table.getByRole("columnheader").first().getAttribute("aria-sort")==="descending","刷新丢失排序方向");
    await table.getByRole("button",{name:"按使用会话数排序",exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.resource-overview-table th[aria-sort="descending"] button')?.textContent.includes("会话"));
    await page.waitForFunction(()=>document.querySelector('.resource-overview-table tbody tr')?.querySelectorAll('td')[2]?.textContent==='3'&&!document.querySelector('.resource-list-scroll[aria-busy="true"]'));
    expect((await table.getByRole("row").nth(1).getByRole("cell").nth(2).innerText())==="3","会话降序错误");
  `);
  await step("页码、首尾、跳转、容量与范围", `
    const pager=page.getByRole("navigation",{name:"Skill 总览",exact:true});
    await pager.getByRole("button",{name:"Skill 总览末页",exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[aria-label="Skill 总览末页"]')?.disabled);
    expect((await pager.innerText()).includes(${JSON.stringify(`/ ${overview.total} 条`)}),"分页未显示当前区间及总数");
    await pager.getByRole("spinbutton",{name:"Skill 总览跳转页码",exact:true}).fill("2");
    await pager.getByRole("button",{name:"Skill 总览跳转",exact:true}).click();
    await page.waitForFunction(()=>new URLSearchParams(location.hash.split("?")[1]).get("page")==="2"&&!document.querySelector('.resource-list-scroll[aria-busy="true"]'));
    await page.waitForFunction(()=>document.querySelector('nav[aria-label="Skill 总览"]')?.textContent.includes("21–40"));
    expect((await pager.innerText()).includes("21–40"),"跳页区间错误");
    ${select("Skill 总览每页条数", "50 条／页")}
    await page.waitForFunction(()=>document.querySelectorAll('.resource-overview-table tbody tr').length===50);
    expect(await page.evaluate(()=>new URLSearchParams(location.hash.split("?")[1]).get("page"))===null,"改变容量未重置页码");
    ${select("Skill 总览每页条数", "100 条／页")}
    await page.waitForFunction(()=>document.querySelectorAll('.resource-overview-table tbody tr').length===100);
    await page.reload(); await page.getByRole("table",{name:"Skill 总览",exact:true}).waitFor();
    expect((await pager.getByRole("combobox",{name:"Skill 总览每页条数",exact:true}).innerText()).includes("100"),"刷新丢失容量");
    await pager.getByRole("button",{name:"Skill 总览下一页",exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.resource-overview-table tbody tr').length>0&&document.querySelectorAll('.resource-overview-table tbody tr').length<100);
    await page.getByRole("textbox",{name:"搜索资源名称或路径",exact:true}).fill("no-such-skill");
    await page.getByText("没有匹配的 Skill",{exact:true}).waitFor();
    expect((await pager.innerText()).includes("0–0 / 0 条"),"空结果区间错误");
    expect(await pager.getByRole("button",{name:"Skill 总览下一页",exact:true}).isDisabled(),"空结果仍可翻页");
    await page.getByRole("button",{name:"重置筛选",exact:true}).click();
  `);
  await step("总览名称收藏与独立本体收藏", `
    ${search("guide")}
    await page.getByRole("button",{name:"查看guide的使用详情",exact:true}).click();
    const detail=page.getByRole("complementary",{name:"资源详情",exact:true});
    await detail.getByRole("heading",{name:"本地本体与入口",exact:true}).waitFor();
    await detail.getByRole("button",{name:/^查看guide的本地本体 /}).nth(2).waitFor();
    expect(await detail.getByRole("button",{name:/^查看guide的本地本体 /}).count()===3,"同名本体被名称汇总合并");
    await detail.getByRole("button",{name:"收藏guide本体 1",exact:true}).click();
    await detail.getByRole("button",{name:"取消收藏guide本体 1",exact:true}).waitFor();
    const row=page.getByRole("table",{name:"Skill 总览",exact:true}).getByRole("row").filter({has:page.getByRole("button",{name:"查看guide的使用详情",exact:true})});
    await row.getByRole("button",{name:"收藏guide",exact:true}).waitFor();
    expect(await row.getByRole("button",{name:"收藏guide",exact:true}).count()===1,"本体收藏冒充名称收藏");
    await row.getByRole("button",{name:"收藏guide",exact:true}).click();
    await row.getByRole("button",{name:"取消收藏guide",exact:true}).waitFor();
    await row.getByRole("button",{name:"取消收藏guide",exact:true}).click();
    await row.getByRole("button",{name:"收藏guide",exact:true}).waitFor();
    await detail.getByRole("button",{name:"取消收藏guide本体 1",exact:true}).waitFor();
    expect((await row.innerText()).includes("受保护"),"取消名称收藏丢失独立本体保护");
    await page.getByRole("group",{name:"Skill 快速筛选",exact:true}).getByRole("button",{name:/^已收藏/}).click();
    await row.waitFor();
    await detail.getByRole("button",{name:"取消收藏guide本体 1",exact:true}).click();
    await page.getByText("没有匹配的 Skill",{exact:true}).waitFor();
    await page.getByRole("group",{name:"Skill 快速筛选",exact:true}).getByRole("button",{name:/^全部/}).click();
  `);
  await step("仅历史标签、旧来源链接与精确证据", `
    const legacyHash=${JSON.stringify(`#resources?kind=skill&tab=usage&id=${encodeURIComponent(oldOrigin.id)}`)};
    await page.evaluate(hash=>location.hash=hash,legacyHash);
    const detail=page.getByRole("complementary",{name:"资源详情",exact:true});
    await detail.getByRole("heading",{name:"guide",exact:true}).waitFor();
    await detail.locator(".resource-stats").filter({hasText:/2\\s*使用会话/}).waitFor();
    expect(/2\\s*使用会话/.test(await detail.locator(".resource-stats").innerText()),"旧来源链接错误扩大为名称汇总");
    await page.waitForFunction(()=>document.querySelectorAll('.resource-evidence a').length===2);
    expect(await detail.getByRole("button",{name:/^查看guide的本地本体 /}).count()===1,"旧来源链接没有定位精确本体");
    const retired=${JSON.stringify(rankedDetail.origins.find(origin => origin.path.includes("retired"))?.id)};
    expect(!!retired,"人工仅历史来源缺失");
    await page.evaluate(id=>location.hash='#resources?kind=skill&tab=usage&id='+encodeURIComponent(id),retired);
    await detail.getByRole("heading",{name:"guide",exact:true}).waitFor();
    await detail.getByText("仅历史",{exact:true}).waitFor();
    expect(await detail.getByRole("button",{name:/^查看guide的本地本体 /}).count()===0,"仅历史来源冒充本地入口");
  `);
  await step("总览深浅主题、375px独立横向滚动与键盘跳页", `
    await page.evaluate(()=>location.hash='#resources?kind=skill&tab=usage');
    await page.getByRole("table",{name:"Skill 总览",exact:true}).waitFor();
    await page.getByRole("button",{name:"切换主题",exact:true}).click();
    ${screenshot("overview-dark.png")}
    await page.getByRole("button",{name:"切换主题",exact:true}).click();
    await page.setViewportSize({width:375,height:812});
    const scroll=page.locator('.resource-overview-scroll');
    expect(await scroll.evaluate(element=>element.scrollWidth>element.clientWidth),"窄屏表格没有独立横向滚动");
    await scroll.evaluate(element=>element.scrollLeft=250);
    expect(await scroll.evaluate(element=>element.scrollLeft)>0,"表格不能横向滚动");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.documentElement.scrollHeight<=innerHeight+1),"窄屏总览溢出页面");
    const jump=page.getByRole("spinbutton",{name:"Skill 总览跳转页码",exact:true});
    await jump.fill('2'); await jump.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(()=>new URLSearchParams(location.hash.split('?')[1]).get('page')==='2'&&!document.querySelector('.resource-list-scroll[aria-busy="true"]'));
    ${screenshot("overview-phone.png")}
    await page.setViewportSize({width:1560,height:980});
    expect(page.resourceErrors.length===0,"浏览器异常："+page.resourceErrors.join(";"));
  `);

  const pageGuide = join(fixture.userHome, ".codex", "skills", "page-guide");
  await mkdir(pageGuide, { recursive: true });
  await writeFile(join(pageGuide, "SKILL.md"), "---\nname: page-guide\n---\n分页证据人工资源。\n");
  const paginationHistory = [
    { type: "session_meta", timestamp: "2026-01-07T12:00:00Z", payload: { id: "pagination-example", cwd: fixture.project, title: "分页合成证据" } },
    { type: "response_item", timestamp: "2026-01-07T12:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "读取合成资源并验证证据分页" }] } },
  ];
  for (let index = 0; index < 26; index++) {
    const path = index < 25 ? join(pageGuide, "SKILL.md") : join(directory, "retired-only", "SKILL.md");
    const timestamp = second => new Date(Date.UTC(2026, 0, 7, 12, 0, second)).toISOString();
    paginationHistory.push({ type: "response_item", timestamp: timestamp(index * 2 + 2), payload: { type: "function_call", name: "shell_command", call_id: `pagination-read-${index}`, arguments: JSON.stringify({ command: `cat '${path}'`, workdir: fixture.project }) } });
    paginationHistory.push({ type: "response_item", timestamp: timestamp(index * 2 + 3), payload: { type: "function_call_output", call_id: `pagination-read-${index}`, output: "Exit code: 0\nOutput:\n人工资源内容。\n" } });
  }
  paginationHistory.push({ type: "response_item", timestamp: "2026-01-07T12:01:00Z", payload: { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "分页证据已记录" }] } });
  await writeFile(join(fixture.history, "pagination-example.jsonl"), paginationHistory.map(record => JSON.stringify(record)).join("\n") + "\n");
  const { job: paginationRefresh } = await api("/sessions/refresh", "POST");
  let paginationJob = paginationRefresh;
  for (let attempt = 0; attempt < 400 && ["queued", "running"].includes(paginationJob.status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    paginationJob = (await api(`/jobs/${paginationRefresh.id}`)).job;
  }
  assert.equal(paginationJob.status, "complete", paginationJob.error);
  await api("/resources/refresh", "POST");
  await step("证据固定十条、页码首尾与跳转返回", `
    await page.getByRole("button",{name:"刷新清单",exact:true}).click();
    await page.getByRole("button",{name:"刷新清单",exact:true}).waitFor();
    ${search("page-guide")}
    await page.getByRole("button",{name:"查看page-guide的使用详情",exact:true}).click();
    const detail=page.getByRole("complementary",{name:"资源详情",exact:true});
    const pager=detail.getByRole("navigation",{name:"使用证据",exact:true}); await pager.waitFor();
    expect(await detail.locator('.resource-evidence a').count()===10,"证据第一页不是十条");
    expect(await pager.getByRole("combobox").count()===0,"证据容量不应可调");
    await pager.getByRole("button",{name:"使用证据末页",exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.resource-evidence a').length===5);
    expect((await pager.innerText()).includes("21–25 / 25 条"),"证据末页区间错误");
    await pager.getByRole("spinbutton",{name:"使用证据跳转页码",exact:true}).fill('2');
    await pager.getByRole("button",{name:"使用证据跳转",exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.resource-evidence a').length===10&&new URLSearchParams(location.hash.split('?')[1]).get('evidencePage')==='2');
    const resourceHash=await page.evaluate(()=>location.hash);
    await detail.locator('.resource-evidence a').first().click(); await page.waitForURL(/#sessions/);
    await page.goBack(); await page.waitForURL(/#resources/); await pager.waitFor();
    expect((await page.evaluate(()=>location.hash))===resourceHash,"返回丢失证据页码");
    expect((await pager.innerText()).includes("11–20 / 25 条"),"返回丢失证据区间");
    await pager.getByRole("button",{name:"使用证据首页",exact:true}).click();
    await page.waitForFunction(()=>new URLSearchParams(location.hash.split('?')[1]).get('evidencePage')===null);
  `);
  await step("总览列表直接管理保留筛选与选择，Esc恢复焦点", `
    ${search("guide")}
    const row=page.getByRole("table",{name:"Skill 总览",exact:true}).getByRole("row").filter({has:page.getByRole("button",{name:"查看guide的使用详情",exact:true})});
    await row.getByRole("button",{name:"查看guide的使用详情",exact:true}).click();
    const detail=page.getByRole("complementary",{name:"资源详情",exact:true});
    await detail.getByRole("button",{name:"管理guide",exact:true}).waitFor();
    const hash=await page.evaluate(()=>location.hash);
    const trigger=row.getByRole("button",{name:"管理guide",exact:true}); await trigger.click();
    const manage=page.getByRole("dialog",{name:"管理具体入口",exact:true}); await manage.waitFor();
    expect(await manage.locator('.resource-management-body').count()>1,"总览管理未列具体本体");
    expect((await manage.innerText()).includes('Codex')&&(await manage.innerText()).includes(${JSON.stringify(fixture.guide)}),"总览未显示实际路径与Agent");
    expect(await manage.getByRole("button",{name:"预览停用guide的Codex入口",exact:true}).count()>0,"总览管理缺少具体入口动作");
    expect(await manage.getByRole("button",{name:/备用/}).count()===0,"仍提供备用操作");
    await page.keyboard.press('Escape'); await manage.waitFor({state:'hidden'});
    expect(await trigger.evaluate(element=>element===document.activeElement),"列表管理Esc未恢复焦点");
    expect(await page.evaluate(()=>location.hash)===hash,"管理改变总览筛选或选中项");
    await detail.getByRole("button",{name:"管理guide",exact:true}).click(); await manage.waitFor();
    await manage.getByRole("button",{name:"预览停用guide的Codex入口",exact:true}).first().click();
    const preview=page.getByRole("dialog",{name:"停用预览",exact:true}); await preview.getByRole("button",{name:"确认停用",exact:true}).waitFor();
    expect(await manage.count()===0,"总览入口与预览重叠");
    await page.keyboard.press('Escape'); await preview.waitFor({state:'hidden'});
    expect(await detail.getByRole("button",{name:"管理guide",exact:true}).evaluate(element=>element===document.activeElement),"预览关闭未恢复顶栏管理焦点");
    expect(await page.evaluate(()=>location.hash)===hash,"预览改变总览视图");
  `);
  await step("仅历史资源在总览中保留状态", `
    ${search("retired-only")}
    const row=page.getByRole("table",{name:"Skill 总览",exact:true}).getByRole("row").filter({has:page.getByRole("button",{name:"查看retired-only的使用详情",exact:true})});
    await row.waitFor(); expect((await row.innerText()).includes("仅历史"),"总览未显示仅历史标签");
    await row.getByRole("button",{name:"查看retired-only的使用详情",exact:true}).click();
    const detail=page.getByRole("complementary",{name:"资源详情",exact:true});
    await detail.getByText("仅历史",{exact:true}).waitFor();
    expect(await detail.getByRole("button",{name:/^查看retired-only的本地本体 /}).count()===0,"仅历史资源生成了管理对象");
    await detail.getByRole("button",{name:"管理retired-only",exact:true}).click();
    const manage=page.getByRole("dialog",{name:"管理具体入口",exact:true}); await manage.waitFor();
    expect((await manage.innerText()).includes("当前没有可管理的本地入口"),"仅历史不可管理原因未展示");
    expect(await manage.getByRole("button",{name:/^预览/}).count()===0,"仅历史生成写操作");
    await page.keyboard.press('Escape'); await manage.waitFor({state:'hidden'});
    expect(page.resourceErrors.length===0,"浏览器异常："+page.resourceErrors.join(";"));
  `);

  const mcpFixture = await mcpOverviewFixture(fixture, claudeHistory, secondProject);
  const { job: mcpRefresh } = await api("/sessions/refresh", "POST");
  let mcpJob = mcpRefresh;
  for (let attempt = 0; attempt < 400 && ["queued", "running"].includes(mcpJob.status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    mcpJob = (await api(`/jobs/${mcpRefresh.id}`)).job;
  }
  assert.equal(mcpJob.status, "complete", mcpJob.error);
  await api("/resources/refresh", "POST");
  const mcpUnused = (await api("/resources/local?kind=mcp&q=mcp-unused")).rows.find(row => row.body.name === "mcp-unused");
  assert.ok(mcpUnused);
  const mcpManagement = new Database(join(fixture.home, "resources.sqlite"));
  try {
    for (const entry of mcpUnused.entries) assert.equal(mcpManagement.prepare("UPDATE resource_seen SET first_seen=? WHERE id=?").run("2025-01-01T00:00:00Z", entry.id).changes, 1);
  } finally { mcpManagement.close(); }
  await api("/resources/refresh", "POST");
  const mcpOverview = await api("/resources/overview?kind=mcp&pageSize=200");
  const mcpSample = mcpOverview.resources.find(row => row.identity.name === "sample");
  assert.ok(mcpOverview.total > 100); assert.ok(mcpSample);
  assert.equal(mcpSample.stats.sessions, 3); assert.equal(mcpSample.stats.mcpCalls, 29);
  assert.equal(mcpSample.stats.results.failure, 3); assert.equal(mcpSample.stats.results.success, 26);
  const mcpDetail = await api(`/resources/overview/${encodeURIComponent(mcpSample.identity.id)}?kind=mcp`);
  assert.equal(mcpDetail.history.clients.length, 2); assert.equal(mcpDetail.history.projects.length, 2);
  assert.equal(mcpDetail.history.tools.reduce((count, tool) => count + tool.stats.mcpCalls, 0), 29);
  assert.ok(mcpDetail.local.length > 1);
  const legacyMcp = (await api("/resources/usage?kind=mcp&q=sample&pageSize=200")).resources.find(row => row.identity.name === "sample" && row.identity.client === "codex");
  assert.ok(legacyMcp); assert.equal(legacyMcp.stats.mcpCalls, 27);
  const mcpConfigs = [fixture.configPath, mcpFixture.claudeConfig, join(fixture.project, ".mcp.json"), join(secondProject, ".mcp.json")];
  const mcpConfigSnapshots = await Promise.all(mcpConfigs.map(path => readFile(path, "utf8")));
  const mcpHash = `#resources?kind=mcp&tab=usage&project=${encodeURIComponent(fixture.project)}`;
  await step("MCP 总览合并服务名称、注册和会话并集", `
    await page.evaluate(hash=>location.hash=hash,${JSON.stringify(mcpHash)});
    const table=page.getByRole("table",{name:"MCP 总览",exact:true}); await table.waitFor();
    expect(await table.getByRole("columnheader").count()===6,"MCP总览列数错误");
    expect(await table.getByRole("button",{name:"按读取排序",exact:true}).count()===0,"MCP错误展示Skill读取列");
    expect(await table.getByRole("button",{name:"按调用次数排序",exact:true}).count()===1,"MCP缺少调用次数列");
    expect(await table.getByRole("columnheader").filter({hasText:"调用次数"}).getAttribute("aria-sort")==="descending","MCP默认没有按调用次数降序");
    const quick=page.getByRole("group",{name:"MCP 快速筛选",exact:true});
    expect(await quick.getByRole("button").count()===6,"MCP快捷筛选缺失");
    expect((await quick.getByRole("button",{name:/^全部/}).innerText()).includes(${JSON.stringify(String(mcpOverview.counts.all))}),"MCP快捷计数错误");
    const row=table.getByRole("row").filter({has:page.getByRole("button",{name:"查看sample的使用详情",exact:true})});
    expect(await row.count()===1,"同名服务仍按Agent或项目拆行");
    expect((await row.getByRole("cell").nth(2).innerText())==="3","服务使用会话被重复累计");
    expect((await row.locator('.resource-overview-agents').innerText())===${JSON.stringify(`${mcpSample.clients.length} 个 Agent`)},"服务遗漏本地或历史Agent");
    expect(await page.locator('.resources-shell').getByRole("button",{name:"筛选项目",exact:true}).count()===0,"MCP总览仍受项目筛选");
    ${screenshot("mcp-overview-light.png")}
    await row.getByRole("button",{name:"查看sample的使用详情",exact:true}).click();
    const detail=page.getByRole("complementary",{name:"资源详情",exact:true});
    await detail.getByRole("heading",{name:"sample",exact:true}).waitFor();
    expect(/29\\s*调用次数/.test(await detail.locator('.resource-stats').innerText()),"服务详情统计丢失");
    expect(await detail.getByRole("button",{name:/^查看sample的本地本体 /}).count()===${mcpDetail.local.length},"同名注册被错误合并为管理对象");
    expect(!(await detail.innerText()).includes('synthetic-mcp-secret'),"页面泄露注册配置值");
  `);
  await step("MCP Agent 筛选保持服务身份、调用与会话范围", `
    ${select("资源Agent", "Codex")}
    await page.waitForFunction(()=>{const row=document.querySelector('[aria-label="查看sample的使用详情"]')?.closest('tr');return row&&row.querySelectorAll('td')[2].textContent==='2'});
    const table=page.getByRole("table",{name:"MCP 总览",exact:true});
    let row=table.getByRole("row").filter({has:page.getByRole("button",{name:"查看sample的使用详情",exact:true})});
    expect((await row.getByRole("cell").nth(2).innerText())==="2","Codex会话范围错误");
    await row.getByRole("button",{name:"查看sample的使用详情",exact:true}).click();
    expect(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('id'))===${JSON.stringify(mcpSample.identity.id)},"Agent筛选改变服务名称身份");
    ${select("资源Agent", "Claude Code")}
    await page.waitForFunction(()=>{const row=document.querySelector('[aria-label="查看sample的使用详情"]')?.closest('tr');return row&&row.querySelectorAll('td')[2].textContent==='1'});
    row=table.getByRole("row").filter({has:page.getByRole("button",{name:"查看sample的使用详情",exact:true})});
    expect((await row.getByRole("cell").nth(2).innerText())==="1","Claude会话范围错误");
    ${select("资源Agent", "全部 Agent")}
    await page.waitForFunction(()=>{const row=document.querySelector('[aria-label="查看sample的使用详情"]')?.closest('tr');return row&&row.querySelectorAll('td')[2].textContent==='3'});
  `);
  await step("MCP 工具下钻覆盖全名历史及证据分页返回", `
    const detail=page.getByRole("complementary",{name:"资源详情",exact:true});
    await detail.getByRole("heading",{name:"工具调用",exact:true}).waitFor();
    const tool=detail.locator('.resource-tool-list').getByRole('button').filter({hasText:'lookup'});
    expect((await tool.innerText()).includes('22 次'),"工具没有汇总跨Agent调用");
    await tool.click();
    const pager=detail.getByRole("navigation",{name:"使用证据",exact:true});
    await pager.getByRole("button",{name:"使用证据末页",exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.resource-evidence a').length===2);
    expect((await pager.innerText()).includes('21–22 / 22 条'),"工具证据被截断或串服务");
    const hash=await page.evaluate(()=>location.hash);
    await detail.locator('.resource-evidence a').first().click(); await page.waitForURL(/#sessions/);
    expect(page.url().includes('mode=trace')&&page.url().includes('message='),"MCP证据未定位轨迹");
    await page.goBack(); await pager.waitFor();
    expect(await page.evaluate(()=>location.hash)===hash,"返回丢失服务与工具分页");
    await detail.getByRole("button",{name:"全部工具",exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.resource-pagination')?.textContent.includes('29 条')||document.querySelector('[aria-label="使用证据"]')?.textContent.includes('29 条'));
  `);
  await step("MCP 新注册立即归未发现使用、本地注册精确跳转", `
    ${search("mcp-new")}
    await page.getByRole("button",{name:"查看mcp-new的使用详情",exact:true}).click();
    const detail=page.getByRole("complementary",{name:"资源详情",exact:true});
    await detail.getByRole("heading",{name:"mcp-new",exact:true}).waitFor();
    expect(/0\\s*调用次数/.test(await detail.locator('.resource-stats').innerText()),"新注册MCP没有显示真实零记录");
    await detail.getByRole("button",{name:"查看mcp-new的本地本体 1",exact:true}).click();
    await detail.getByRole("heading",{name:"客户端入口",exact:true}).waitFor();
    expect(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('project'))===null,"隐藏项目阻止用户级注册跳转");
    expect(await detail.getByRole('alert').count()===0,"精确注册详情失败");
    ${view("MCP 总览")} ${search("")}
    await page.getByRole("group",{name:"MCP 快速筛选",exact:true}).getByRole('button',{name:/^未发现使用/}).click();
    ${search("mcp-unused")}
    await page.getByRole("button",{name:"查看mcp-unused的使用详情",exact:true}).click();
    await detail.getByRole("heading",{name:"mcp-unused",exact:true}).waitFor();
    expect(/0\\s*调用次数/.test(await detail.locator('.resource-stats').innerText()),"确定零调用没有显示零");
    expect(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('page'))===null,"状态筛选没有重置页码");
    await page.getByRole("group",{name:"MCP 快速筛选",exact:true}).getByRole('button',{name:/^全部/}).click();
    ${search("")}
  `);
  const mcpNameAsc = (await api("/resources/overview?kind=mcp&sort=name&order=asc")).resources[0].identity.name;
  const mcpNameDesc = (await api("/resources/overview?kind=mcp&sort=name&order=desc")).resources[0].identity.name;
  await step("MCP 排序、跳页、容量、刷新与空结果", `
    const table=page.getByRole("table",{name:"MCP 总览",exact:true});
    await table.getByRole('button',{name:'按服务器排序',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.resource-overview-table th[aria-sort="ascending"] button')?.textContent.includes('服务器'));
    await page.waitForFunction(()=>document.querySelector('.resource-overview-table tbody th button')?.textContent===${JSON.stringify(mcpNameAsc)}&&!document.querySelector('.resource-list-scroll[aria-busy="true"]'));
    const firstAsc=await table.getByRole('row').nth(1).getByRole('rowheader').getByRole('button').first().innerText();
    await table.getByRole('button',{name:'按服务器排序',exact:true}).focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('.resource-overview-table th[aria-sort="descending"] button')?.textContent.includes('服务器'));
    await page.waitForFunction(()=>document.querySelector('.resource-overview-table tbody th button')?.textContent===${JSON.stringify(mcpNameDesc)}&&!document.querySelector('.resource-list-scroll[aria-busy="true"]'));
    expect((await table.getByRole('row').nth(1).getByRole('rowheader').getByRole('button').first().innerText())!==firstAsc,"MCP名称排序方向未改变");
    const pager=page.getByRole('navigation',{name:'MCP 总览',exact:true});
    await pager.getByRole('button',{name:'MCP 总览末页',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[aria-label="MCP 总览末页"]')?.disabled);
    await pager.getByRole('spinbutton',{name:'MCP 总览跳转页码',exact:true}).fill('2');
    await pager.getByRole('button',{name:'MCP 总览跳转',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('nav[aria-label="MCP 总览"]')?.textContent.includes('21–40'));
    ${select("MCP 总览每页条数", "50 条／页")}
    await page.waitForFunction(()=>document.querySelectorAll('.resource-overview-table tbody tr').length===50);
    ${select("MCP 总览每页条数", "100 条／页")}
    await page.waitForFunction(()=>document.querySelectorAll('.resource-overview-table tbody tr').length===100);
    await page.reload(); await table.waitFor();
    expect((await pager.getByRole('combobox',{name:'MCP 总览每页条数',exact:true}).innerText()).includes('100'),"刷新丢失MCP容量");
    expect(await table.getByRole('columnheader').first().getAttribute('aria-sort')==='descending',"刷新丢失MCP排序");
    ${search("no-such-mcp")}
    await page.getByText('没有匹配的 MCP',{exact:true}).waitFor();
    expect((await pager.innerText()).includes('0–0 / 0 条'),"MCP空结果分页错误");
    await page.getByRole('button',{name:'重置筛选',exact:true}).click();
  `);
  await step("MCP 名称收藏与独立注册收藏互不覆盖", `
    ${search("sample")}
    await page.getByRole('button',{name:'查看sample的使用详情',exact:true}).click();
    const detail=page.getByRole('complementary',{name:'资源详情',exact:true});
    await detail.getByRole('button',{name:'收藏sample本体 1',exact:true}).click();
    await detail.getByRole('button',{name:'取消收藏sample本体 1',exact:true}).waitFor();
    const row=page.getByRole('table',{name:'MCP 总览',exact:true}).getByRole('row').filter({has:page.getByRole('button',{name:'查看sample的使用详情',exact:true})});
    await row.getByRole('button',{name:'收藏sample',exact:true}).click();
    await row.getByRole('button',{name:'取消收藏sample',exact:true}).click();
    await row.getByRole('button',{name:'收藏sample',exact:true}).waitFor();
    await detail.getByRole('button',{name:'取消收藏sample本体 1',exact:true}).waitFor();
    expect((await row.innerText()).includes('受保护'),"名称取消收藏清除了注册保护");
    await page.getByRole('group',{name:'MCP 快速筛选',exact:true}).getByRole('button',{name:/^已收藏/}).click(); await row.waitFor();
    await detail.getByRole('button',{name:'取消收藏sample本体 1',exact:true}).click();
    await page.getByText('没有匹配的 MCP',{exact:true}).waitFor();
    await page.getByRole('group',{name:'MCP 快速筛选',exact:true}).getByRole('button',{name:/^全部/}).click();
  `);
  await step("MCP 旧来源精确链接与仅历史服务", `
    await page.evaluate(id=>location.hash='#resources?kind=mcp&tab=usage&id='+encodeURIComponent(id),${JSON.stringify(legacyMcp.identity.id)});
    const detail=page.getByRole('complementary',{name:'资源详情',exact:true});
    await detail.getByRole('heading',{name:'sample',exact:true}).waitFor();
    await detail.locator('.resource-stats').filter({hasText:/27\\s*调用次数/}).waitFor();
    expect(/27\\s*调用次数/.test(await detail.locator('.resource-stats').innerText()),"旧来源链接被扩大成全名汇总");
    expect(/2\\s*使用会话/.test(await detail.locator('.resource-stats').innerText()),"旧来源会话范围错误");
    ${search("retired-service")}
    const row=page.getByRole('table',{name:'MCP 总览',exact:true}).getByRole('row').filter({has:page.getByRole('button',{name:'查看retired-service的使用详情',exact:true})});
    await row.waitFor(); expect((await row.innerText()).includes('仅历史'),"仅历史MCP标签缺失");
    await row.getByRole('button',{name:'查看retired-service的使用详情',exact:true}).click();
    await detail.getByText('仅历史',{exact:true}).waitFor();
    expect(await detail.getByRole('button',{name:/^查看retired-service的本地本体 /}).count()===0,"历史服务冒充注册对象");
  `);
  await step("MCP 深浅主题、375px独立滚动与键盘分页", `
    await page.evaluate(()=>location.hash='#resources?kind=mcp&tab=usage');
    await page.getByRole('table',{name:'MCP 总览',exact:true}).waitFor();
    await page.getByRole('button',{name:'切换主题',exact:true}).click();
    ${screenshot("mcp-overview-dark.png")}
    await page.getByRole('button',{name:'切换主题',exact:true}).click();
    await page.setViewportSize({width:375,height:812});
    const scroll=page.locator('.resource-overview-scroll');
    expect(await scroll.evaluate(element=>element.scrollWidth>element.clientWidth),"MCP窄屏表格没有独立滚动");
    await scroll.evaluate(element=>element.scrollLeft=180);
    expect(await scroll.evaluate(element=>element.scrollLeft)>0,"MCP表格不可横向滚动");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.documentElement.scrollHeight<=innerHeight+1),"MCP窄屏页面溢出");
    const jump=page.getByRole('spinbutton',{name:'MCP 总览跳转页码',exact:true});
    await jump.fill('2'); await jump.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(()=>new URLSearchParams(location.hash.split('?')[1]).get('page')==='2'&&!document.querySelector('.resource-list-scroll[aria-busy="true"]'));
    ${screenshot("mcp-overview-phone.png")}
    await page.setViewportSize({width:1560,height:980});
    expect(page.resourceErrors.length===0,"浏览器异常："+page.resourceErrors.join(';'));
  `);
  assert.deepEqual(await Promise.all(mcpConfigs.map(path => readFile(path, "utf8"))), mcpConfigSnapshots, "MCP总览浏览修改了注册配置");
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ passed: true, checks, elapsedMs: Date.now() - started }, null, 2));
  console.log(`PASS 资源 Chrome 端到端 ${checks.length} 项`);
} catch (error) {
  await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]).catch(() => {});
  const state = await browser(["run-code", `async page => ({url:page.url(),text:(await page.locator("body").innerText()).slice(0,18000),focus:await page.evaluate(()=>({active:document.activeElement?.outerHTML,target:[...document.querySelectorAll('[aria-label="预览停用guide的Codex入口"]')].map(button=>({connected:button.isConnected,rects:button.getClientRects().length,html:button.outerHTML,focused:button===document.activeElement}))}))})`]).catch(() => "页面状态无法读取");
  await writeFile(join(artifacts, "failure-state.txt"), state);
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ passed: false, checks, error: error.message, elapsedMs: Date.now() - started }, null, 2));
  throw error;
} finally {
  await browser(["close"]).catch(() => {});
  await service?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
