import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { clientIds } from "../dist/clients.js";
import { startService } from "../dist/server.js";
import { resourceFixture } from "./resource-fixture.mjs";

// 显式隔离全部历史和资源目录；文件操作只针对人工合成资源。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-tags-removal-")));
const artifacts = fileURLToPath(new URL("../.local/resource-tags-removal-e2e/", import.meta.url));
const session = `tags-removal-${process.pid}`;
const checks = [];
let service;
let base;
const browser = async args => {
  const result = await run("playwright-cli", [`-s=${session}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.stdout.includes("### Error")) throw new Error(result.stdout);
  return result.stdout;
};
const api = async (path, method = "GET", body) => {
  const response = await fetch(`${base}/api/v1${path}`, { method, headers: { "x-agent-manor-instance": service.instance.id, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? String(response.status));
  return result;
};
const step = async (name, code) => {
  await browser(["run-code", `async page => { const expect=(value,message)=>{if(!value)throw new Error(message);}; ${code} return {passed:${JSON.stringify(name)}}; }`]);
  checks.push(name); console.log(`PASS ${name}`);
};
const openManage = name => `await page.getByRole("textbox",{name:"搜索资源名称或路径",exact:true}).fill(${JSON.stringify(name)}); await page.getByRole("table",{name:"Skill 总览",exact:true}).getByRole("button",{name:${JSON.stringify(`管理${name}`)},exact:true}).click(); await page.getByRole("dialog",{name:"管理具体入口",exact:true}).waitFor();`;
const finish = `await page.getByRole("button",{name:"完成",exact:true}).waitFor(); await page.getByRole("button",{name:"完成",exact:true}).click();`;
const confirm = action => `await page.getByRole("dialog",{name:${JSON.stringify(`${action}预览`)},exact:true}).getByRole("button",{name:${JSON.stringify(`确认${action}`)},exact:true}).click(); await page.getByRole("status").filter({hasText:"本地修改完成"}).waitFor(); ${finish}`;
const recover = state => `await page.goto(page.url().split("/#")[0]+${JSON.stringify(`/#resources?kind=skill&tab=${state}&q=shared`)}); await page.getByRole("button",{name:"查看shared的恢复记录",exact:true}).click(); await page.getByRole("button",{name:"预览恢复",exact:true}).click(); ${confirm("恢复")}`;

try {
  await mkdir(artifacts, { recursive: true });
  const fixture = await resourceFixture(directory, 35);
  await writeFile(join(fixture.shared, "asset.txt"), "合成共享资源附件\n");
  const extra = [
    { type: "session_meta", timestamp: "2026-01-03T12:00:00Z", payload: { id: "synthetic-home-session", cwd: fixture.userHome, title: "共享扫描和历史独有验收" } },
    { type: "response_item", timestamp: "2026-01-03T12:00:01Z", payload: { type: "function_call", name: "Skill", call_id: "retired-call", arguments: JSON.stringify({ skill: "retired-only" }) } },
    { type: "response_item", timestamp: "2026-01-03T12:00:02Z", payload: { type: "function_call_output", call_id: "retired-call", output: "合成调用完成" } },
  ];
  await writeFile(join(fixture.history, "extra.jsonl"), extra.map(row => JSON.stringify(row)).join("\n") + "\n{malformed synthetic record\n");
  const roots = Object.fromEntries(clientIds.map(client => [client, client === "codex" ? fixture.history : []]));
  service = await startService({ home: fixture.home, roots, resourceInventory: { userHome: fixture.userHome, environment: {} }, startupRefresh: true, staticRoot: fileURLToPath(new URL("../dist/web", import.meta.url)) });
  base = `http://127.0.0.1:${service.instance.port}`;
  let ready = false;
  for (let attempt = 0; attempt < 400; attempt++) {
    const status = await api("/sessions/status");
    if (status.job?.status === "failed") throw new Error(status.job.error);
    if (status.version) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(ready, "合成历史未完成索引");
  await api("/preferences", "PUT", { language: "zh-CN" });
  const overview = await api("/resources/overview?kind=skill&pageSize=200");
  const shared = overview.resources.find(row => row.identity.name === "shared");
  assert.equal(overview.resources.find(row => row.identity.name === "retired-only").partial, true, "合成解析缺口未进入统计范围");
  const detail = await api(`/resources/overview/${encodeURIComponent(shared.identity.id)}?kind=skill`);
  assert.ok(detail.local.flatMap(row => row.entries).filter(entry => entry.client === "pi").length > 1);
  await api("/resources/favorites", "POST", { id: shared.identity.id, value: true });
  const originalConfig = await readFile(fixture.configPath, "utf8");
  await browser(["open", `${base}/#resources?kind=skill&tab=usage`, "--headed", "--browser=chrome"]);
  await step("保留默认总览和三项指标，移除状态列与概括统计提示", `
    page.resourceErrors=[]; page.on("pageerror",error=>page.resourceErrors.push(error.message));
    await page.setViewportSize({width:1680,height:1000});
    const table=page.getByRole("table",{name:"Skill 总览",exact:true}); await table.waitFor();
    expect(await page.getByRole("button",{name:"Skill 总览",exact:true}).getAttribute("aria-current")==="page","默认总览变更");
    expect(await page.locator(".resource-sidebar").isVisible(),"原侧栏消失");
    expect(await page.getByRole("columnheader",{name:/调用次数/}).getAttribute("aria-sort")==="descending","调用次数默认排序变更");
    for(const name of ["使用会话数","最近使用","管理"]) expect(await page.getByRole("columnheader",{name:new RegExp(name)}).count()===1,"缺少原列："+name);
    expect(await table.getByRole("columnheader",{name:"状态",exact:true}).count()===0,"状态列仍显示");
    expect(await table.locator(".resource-tags").count()===0,"状态标签仍显示在总览行中");
    expect(!(await page.locator("body").innerText()).includes("统计不完整"),"概括统计提示仍显示");
    await page.screenshot({path:${JSON.stringify(join(artifacts, "list.png"))}});
  `);
  await step("地图、本地资源与 MCP 总览均移除概括统计提示", `
    await page.getByRole("button",{name:"地图",exact:true}).click(); await page.locator(".resource-map-view").waitFor();
    await page.locator(".resource-map-compact summary").click();
    expect(!(await page.locator("body").innerText()).includes("统计不完整"),"地图仍显示概括统计提示");
    await page.goto(${JSON.stringify(`${base}/#resources?kind=skill&tab=local`)}); await page.locator(".resource-row").first().waitFor();
    expect(!(await page.locator("body").innerText()).includes("统计不完整"),"本地资源仍显示概括统计提示");
    await page.goto(${JSON.stringify(`${base}/#resources?kind=mcp&tab=usage&view=list`)});
    const table=page.getByRole("table",{name:"MCP 总览",exact:true}); await table.waitFor();
    expect(await table.getByRole("columnheader",{name:"状态",exact:true}).count()===0,"MCP 状态列仍显示");
    expect(!(await page.locator("body").innerText()).includes("统计不完整"),"MCP 仍显示概括统计提示");
    await page.goto(${JSON.stringify(`${base}/#resources?kind=skill&tab=usage&view=list`)}); await page.getByRole("table",{name:"Skill 总览",exact:true}).waitFor();
  `);
  await step("共享文件只有一个回收按钮，管理入口保留，相关客户端去重", `
    ${openManage("shared")}
    const dialog=page.getByRole("dialog",{name:"管理具体入口",exact:true});
    const file=dialog.getByRole("button",{name:${JSON.stringify(`将${fixture.shared}移入回收区`)},exact:true}); await file.waitFor();
    expect(await file.count()===1 && await file.isEnabled(),"共享文件没有唯一可用按钮");
    const clients=await dialog.locator(".resource-management-note").filter({hasText:"发现于："}).innerText();
    expect(clients.split("Pi").length===2,"相关客户端重复展示");
    expect(!(await dialog.innerText()).includes("启用状态未知"),"无效状态仍常驻");
    await page.screenshot({path:${JSON.stringify(join(artifacts, "manage-shared.png"))}});
  `);
  await step("回收确认说明完整文件与共享影响，取消不修改文件并恢复焦点", `
    await page.getByRole("button",{name:${JSON.stringify(`将${fixture.shared}移入回收区`)},exact:true}).click();
    const preview=page.getByRole("dialog",{name:"移入回收区预览",exact:true}); await preview.getByRole("button",{name:"确认移入回收区",exact:true}).waitFor();
    const text=await preview.innerText(); expect(text.includes("客户端启停配置不会修改"),"没有说明文件操作边界");
    expect(text.includes("未扫描的位置"),"影响清单暗示完整");
    expect(text.includes("Pi") && text.includes("Codex") && text.includes(${JSON.stringify(fixture.shared)}),"影响或路径缺失");
    await preview.getByRole("button",{name:"取消",exact:true}).click(); await preview.waitFor({state:"hidden"});
    await page.waitForFunction(()=>document.activeElement?.getAttribute("aria-label")==="管理shared");
    ${openManage("shared")}
  `);
  assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
  assert.equal(await readFile(join(fixture.shared, "asset.txt"), "utf8"), "合成共享资源附件\n");
  await step("共享 Skill 完整目录回收成功，原生配置保持", `
    await page.getByRole("button",{name:${JSON.stringify(`将${fixture.shared}移入回收区`)},exact:true}).click(); ${confirm("移入回收区")}
  `);
  await assert.rejects(readFile(join(fixture.shared, "SKILL.md")));
  assert.equal(await readlink(fixture.link), fixture.shared);
  assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
  const archives = await api("/resources/archives?state=trash&kind=skill");
  assert.equal(archives.archives.length, 1); assert.equal(archives.archives[0].target, "file");
  await step("共享目录从原回收区恢复，正文和附件全部保留", recover("trash"));
  assert.equal(await readFile(join(fixture.shared, "asset.txt"), "utf8"), "合成共享资源附件\n");
  assert.match(await readFile(join(fixture.link, "SKILL.md"), "utf8"), /共享测试/);
  await step("链接移除明确保留目标文件，原流程仍可恢复", `
    await page.goto(${JSON.stringify(`${base}/#resources?kind=skill&tab=usage&q=shared`)}); ${openManage("shared")}
    const link=page.getByRole("button",{name:${JSON.stringify(`移除链接${fixture.link}，保留目标文件`)},exact:true}); await link.waitFor();
    expect(await link.count()===1,"同一链接重复操作入口"); await link.click();
    const dialog=page.getByRole("dialog",{name:"移入回收区预览",exact:true}); await dialog.getByRole("button",{name:"确认移入回收区",exact:true}).waitFor();
    expect((await dialog.innerText()).includes("只移除这个链接"),"链接操作含义不清"); ${confirm("移入回收区")}
  `);
  await assert.rejects(readlink(fixture.link));
  assert.match(await readFile(join(fixture.shared, "SKILL.md"), "utf8"), /共享测试/);
  await step("所选链接可恢复，文件不重复回收", recover("trash"));
  assert.equal(await readlink(fixture.link), fixture.shared);
  await step("原生停用入口仍可用，停用与恢复不移除文件", `
    await page.goto(${JSON.stringify(`${base}/#resources?kind=skill&tab=usage&q=shared`)}); ${openManage("shared")}
    await page.getByRole("button",{name:"预览停用shared的Codex入口",exact:true}).click(); ${confirm("停用")}
  `);
  assert.match(await readFile(join(fixture.shared, "SKILL.md"), "utf8"), /共享测试/);
  assert.notEqual(await readFile(fixture.configPath, "utf8"), originalConfig);
  await step("原生停用从原停用记录恢复", recover("disabled"));
  assert.equal(await readFile(fixture.configPath, "utf8"), originalConfig);
  await step("历史独有资源管理时说明原因，默认统计卡片保持", `
    await page.goto(${JSON.stringify(`${base}/#resources?kind=skill&tab=usage&q=retired-only`)});
    await page.getByRole("button",{name:"查看retired-only的使用详情",exact:true}).click();
    await page.getByRole("heading",{name:"retired-only",exact:true}).waitFor();
    expect(!(await page.locator("body").innerText()).includes("统计不完整"),"详情仍显示概括统计提示");
    expect((await page.locator(".resource-stats").innerText()).includes("成功读取"),"扩大范围隐藏了原有统计卡片");
    await page.locator(".resource-details").getByRole("button",{name:"管理retired-only",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"管理具体入口",exact:true}); await dialog.getByText("当前结果中没有可管理的本地文件或配置，使用记录仍保留。",{exact:true}).waitFor();
    expect((await dialog.innerText()).includes("当前结果中没有可管理的本地文件或配置"),"未找到位置的原因不清楚");
    await dialog.getByRole("button",{name:"关闭管理具体入口",exact:true}).click();
    expect(page.resourceErrors.length===0,"页面异常："+page.resourceErrors.join(";"));
  `);
  await api("/preferences", "PUT", { language: "en" });
  await step("英文与窄屏保持原管理流程和文件位置", `
    await page.setViewportSize({width:375,height:812}); await page.goto(${JSON.stringify(`${base}/#resources?kind=skill&tab=usage&q=shared`)}); await page.reload();
    const table=page.getByRole("table",{name:"Skill overview",exact:true}); await table.waitFor();
    expect(await table.getByRole("columnheader",{name:"Status",exact:true}).count()===0,"英文状态列仍显示");
    expect(!(await page.locator("body").innerText()).includes("Incomplete statistics"),"英文概括统计提示仍显示");
    await table.getByRole("button",{name:"Manage shared",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"Manage individual entries",exact:true}); await dialog.waitFor();
    expect(await dialog.getByRole("button",{name:${JSON.stringify(`Move ${fixture.shared} to recovery`)},exact:true}).isEnabled(),"英文或窄屏丢失文件操作");
    expect((await dialog.innerText()).includes("Discovered by:"),"发现来源未翻译");
    expect(!(await dialog.innerText()).includes("Enabled state unknown"),"英文无效标签常驻");
    await page.screenshot({path:${JSON.stringify(join(artifacts, "narrow-en.png"))}});
  `);
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ passed: true, checks }, null, 2));
  console.log(`PASS 标签与 Skill 移除 Chrome 验收 ${checks.length} 项`);
} catch (error) {
  await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]).catch(() => {});
  await writeFile(join(artifacts, "failure-state.txt"), await browser(["run-code", 'async page=>({url:page.url(),text:(await page.locator("body").innerText()).slice(0,16000)})']).catch(() => "无法读取页面"));
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ passed: false, checks, error: error.message }, null, 2));
  throw error;
} finally {
  await browser(["close"]).catch(() => {});
  await service?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
