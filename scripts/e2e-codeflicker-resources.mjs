import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { clientIds } from "../dist/clients.js";
import { startService } from "../dist/server.js";
import { codeflickerResourceFixture } from "./codeflicker-resource-fixture.mjs";

// 所有历史、配置、回收材料及浏览器写操作均限定在隔离夹具。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-codeflicker-e2e-")));
const artifacts = fileURLToPath(new URL("../.local/codeflicker-resource-e2e/", import.meta.url));
const session = `cfresources${process.pid}`;
const checks = [];
let service;
let base;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${session}`, ...args], {
    cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 5 * 1024 * 1024,
  });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
const api = async (path, method = "GET", body) => {
  const response = await fetch(`${base}/api/v1${path}`, { method, headers: {
    "x-agent-manor-instance": service.instance.id, ...(body === undefined ? {} : { "Content-Type": "application/json" }),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  assert.ok(response.ok, data.error?.message);
  return data;
};
const step = async (name, code) => {
  await browser(["run-code", `async page => {
    const expect = (value, message) => { if (!value) throw new Error(message); };
    ${code}
    return { passed: ${JSON.stringify(name)} };
  }`]);
  checks.push(name);
  console.log(`PASS ${name}`);
};
const goto = (client, kind = "skill", tab = "local", extra = "") => `await page.goto(${JSON.stringify(`${base}/#resources?kind=${kind}&tab=${tab}&client=${client}&window=all&${extra}`)});`;
const local = name => `await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill(${JSON.stringify(name)}); await page.getByRole('button',{name:${JSON.stringify(`查看${name}的本地详情`)},exact:true}).click(); await page.locator('.resource-detail-heading h2').filter({hasText:${JSON.stringify(name)}}).waitFor();`;
const confirm = action => `{
  const dialog=page.getByRole('dialog',{name:${JSON.stringify(`${action}预览`)},exact:true});
  await dialog.getByRole('button',{name:${JSON.stringify(`确认${action}`)},exact:true}).click();
  await dialog.getByRole('button',{name:'完成',exact:true}).waitFor();
  expect((await dialog.getByRole('status').innerText()).includes('本地修改完成'),'隔离管理写操作失败');
  await dialog.getByRole('button',{name:'完成',exact:true}).click(); await dialog.waitFor({state:'hidden'});
}`;
const preview = (name, client, action) => `await page.getByRole('button',{name:${JSON.stringify(`预览${action}${name}的${client}入口`)},exact:true}).click(); await page.getByRole('dialog',{name:${JSON.stringify(`${action}预览`)},exact:true}).getByRole('button',{name:${JSON.stringify(`确认${action}`)},exact:true}).waitFor();`;
const restore = name => `await page.getByRole('button',{name:${JSON.stringify(`查看${name}的恢复记录`)},exact:true}).click(); await page.getByRole('button',{name:'预览恢复',exact:true}).click(); ${confirm("恢复")}`;

try {
  await mkdir(artifacts, { recursive: true });
  const fixture = await codeflickerResourceFixture(directory);
  await run("git", ["init", "-q", fixture.project]);
  service = await startService({ home: fixture.home, startupRefresh: true,
    roots: { ...Object.fromEntries(clientIds.map(id => [id, []])), codeflicker: fixture.cliHistory, "codeflicker-desktop": fixture.desktopHistory },
    resourceInventory: { userHome: fixture.userHome }, staticRoot: fileURLToPath(new URL("../dist/web", import.meta.url)),
  });
  base = `http://127.0.0.1:${service.instance.port}`;
  let ready = false;
  for (let attempt = 0; attempt < 500; attempt++) {
    const status = await api("/sessions/status");
    assert.notEqual(status.job?.status, "failed", status.job?.error);
    if (status.version) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(ready, "合成历史索引未完成");
  await api("/preferences", "PUT", { language: "zh-CN" });
  const before = { cli: await readFile(fixture.cliConfig, "utf8"), desktop: await readFile(fixture.desktopConfig, "utf8") };
  const results = [];
  for (const client of ["codeflicker", "codeflicker-desktop"]) for (const kind of ["skill", "mcp"]) {
    const result = await api(`/resources/local?client=${client}&kind=${kind}&pageSize=200`);
    assert.ok(result.total > 0, `${client}/${kind}清单为空`);
    results.push(result);
  }
  assert.ok(!JSON.stringify(results).includes("synthetic-private-token"));
  assert.ok(!JSON.stringify(results).includes("synthetic-desktop-private"));
  const cliMap = await api("/resources/map?client=codeflicker&kind=skill&metric=uses");
  const desktopMap = await api("/resources/map?client=codeflicker-desktop&kind=skill&metric=uses");
  assert.ok(cliMap.positive.some(row => row.name === "cli-guide" && row.localBodyIds.length > 0));
  assert.ok(desktopMap.positive.some(row => row.name === "desktop-guide" && row.localBodyIds.length > 0));
  for (const client of ["codeflicker", "codeflicker-desktop"]) {
    const map = await api(`/resources/map?client=${client}&kind=mcp&metric=uses`);
    assert.ok(map.positive.length > 0, `${client}/mcp地图为空`);
  }
  await browser(["open", `${base}/#resources?kind=skill&tab=local&client=codeflicker`, "--headed", "--browser=chrome"]);
  await step("CodeFlicker本地分页直接跳转", `
    await page.getByRole('button',{name:'查看cli-guide的本地详情',exact:true}).waitFor();
    await page.getByRole('spinbutton',{name:'本地资源跳转页码',exact:true}).fill('2');
    await page.getByRole('button',{name:'本地资源跳转',exact:true}).click();
    await page.waitForURL(/page=2/);
    await page.getByRole('button',{name:'本地资源首页',exact:true}).click();
    await page.getByRole('button',{name:'查看cli-guide的本地详情',exact:true}).waitFor();
  `);
  await step("CLI列表、仅用户触发和管理能力", `
    await page.getByRole('button',{name:'查看user-guide的本地详情',exact:true}).waitFor();
    ${local("user-guide")}
    expect((await page.locator('.resource-entry').innerText()).includes('仅用户触发'),'userOnly未显示');
    ${goto("codeflicker")}
    ${local("cli-guide")}
    ${preview("cli-guide", "CodeFlicker CLI", "停用")}
    ${confirm("停用")}
  `);
  assert.ok(JSON.parse(await readFile(fixture.cliConfig, "utf8")).skills.disabled.includes("cli-guide"));
  await step("CLI原生停用恢复并保留原规则", `${goto("codeflicker", "skill", "disabled")} ${restore("cli-guide")}`);
  assert.equal(await readFile(fixture.cliConfig, "utf8"), before.cli);
  await step("桌面Skill标记停用与恢复", `
    ${goto("codeflicker-desktop")}
    ${local("desktop-guide")}
    ${preview("desktop-guide", "CodeFlicker 桌面版", "停用")}
    ${confirm("停用")}
    ${goto("codeflicker-desktop", "skill", "disabled")}
    ${restore("desktop-guide")}
  `);
  await assert.rejects(readFile(join(fixture.desktopSkill, ".disable")), error => error.code === "ENOENT");
  await step("CLI Skill回收与恢复入口", `
    ${goto("codeflicker")}
    ${local("cli-guide")}
    ${preview("cli-guide", "CodeFlicker CLI", "移入回收区")}
    ${confirm("移入回收区")}
    ${goto("codeflicker", "skill", "trash")}
    ${restore("cli-guide")}
  `);
  assert.ok((await readFile(join(fixture.cliSkill, "SKILL.md"), "utf8")).includes("Synthetic content"));
  await step("CLI MCP停用和恢复", `
    ${goto("codeflicker", "mcp")}
    ${local("cli-service")}
    ${preview("cli-service", "CodeFlicker CLI", "停用")}
    ${confirm("停用")}
    ${goto("codeflicker", "mcp", "disabled")}
    ${restore("cli-service")}
  `);
  assert.equal(await readFile(fixture.cliConfig, "utf8"), before.cli);
  await step("桌面MCP只读和状态边界", `
    ${goto("codeflicker-desktop", "mcp")}
    ${local("desktop-service")}
    expect(await page.getByRole('button',{name:/^预览停用desktop-service/}).count()===0,'桌面MCP开放了未核验写操作');
    expect((await page.locator('.resource-entry').innerText()).includes('状态未知'),'disabled未确认字段未保留未知');
    expect((await page.locator('.resource-entry').innerText()).includes('客户端'),'桌面MCP缺少客户端管理引导');
    await page.getByRole('button',{name:'客户端管理',exact:true}).click();
    await page.keyboard.press('Escape');
    expect(await page.getByRole('button',{name:'客户端管理',exact:true}).evaluate(node=>node===document.activeElement),'帮助关闭未恢复焦点');
  `);
  assert.equal(await readFile(fixture.desktopConfig, "utf8"), before.desktop);
  await step("静态托管与系统Skill保护", `
    ${goto("codeflicker-desktop")}
    ${local("builtin-guide")}
    expect(await page.locator('.resource-entry-actions button[data-resource-action]').count()===0,'内置资源错误开放操作');
    ${goto("codeflicker-desktop")}
    ${local("market-guide")}
    expect(await page.locator('.resource-entry-actions button[data-resource-action]').count()===0,'托管资源错误开放操作');
  `);
  await step("来源覆盖和残留诊断", `
    ${goto("codeflicker")}
    await page.getByRole('button',{name:'来源与能力',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'来源与能力',exact:true});
    await dialog.waitFor();
    await dialog.locator('summary').filter({hasText:'来源诊断'}).click();
    expect((await dialog.innerText()).includes('shadow-guide'),'未显示范围覆盖诊断');
    expect((await dialog.innerText()).includes('0.9.0'),'未登记旧缓存未进入诊断');
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
  `);
  await step("Skill地图详情可打开管理", `
    ${goto("codeflicker", "skill", "usage", "view=map&metric=uses")}
    await page.getByRole('button',{name:'查看cli-guide的使用详情',exact:true}).first().click();
    await page.getByRole('button',{name:'管理cli-guide',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'管理具体入口',exact:true});
    await dialog.getByRole('button',{name:'预览停用cli-guide的CodeFlicker CLI入口',exact:true}).waitFor();
    await page.keyboard.press('Escape');
  `);
  await step("Agent筛选、搜索空结果和刷新", `
    ${goto("codeflicker")}
    const picker=page.getByRole('combobox',{name:'资源客户端',exact:true});
    await picker.click(); await page.getByRole('option',{name:'CodeFlicker 桌面版',exact:true}).click();
    await page.getByRole('button',{name:'查看desktop-guide的本地详情',exact:true}).waitFor();
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('does-not-exist');
    await page.getByText('没有匹配的本地资源',{exact:true}).waitFor();
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('');
    await page.getByRole('button',{name:'刷新清单',exact:true}).click();
    await page.getByRole('button',{name:'查看desktop-guide的本地详情',exact:true}).waitFor();
  `);
  await step("MCP地图与详情管理只读边界", `
    ${goto("codeflicker-desktop", "mcp", "usage", "view=map&metric=uses")}
    await page.getByRole('button',{name:'查看desktop-service的使用详情',exact:true}).first().click();
    await page.getByRole('button',{name:'管理desktop-service',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'管理具体入口',exact:true});
    await dialog.getByRole('button',{name:'客户端管理',exact:true}).waitFor();
    expect(await dialog.locator('button[data-resource-action]').count()===0,'桌面MCP地图开放未核验写操作');
    await page.keyboard.press('Escape');
  `);
  await api("/preferences", "PUT", { language: "en" });
  await step("英文四种组合和可访问标签", `
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.locator('html[lang="en"]').waitFor();
    for(const client of ['codeflicker','codeflicker-desktop']) for(const kind of ['skill','mcp']) {
      await page.goto(${JSON.stringify(base)}+'/#resources?kind='+kind+'&tab=local&client='+client);
      await page.getByRole('combobox',{name:'Resource client',exact:true}).waitFor();
      await page.locator('.resource-row').first().waitFor();
      expect(!(await page.locator('.resources-shell').innerText()).includes('未适配'),'兼容页面回退未适配');
    }
    await page.screenshot({path:${JSON.stringify(join(artifacts, "desktop-mcp-en.png"))}});
  `);
  await api("/preferences", "PUT", { language: "zh-CN" });
  await step("窄屏、主题和键盘焦点", `
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.locator('html[lang="zh-CN"]').waitFor();
    ${goto("codeflicker")}
    await page.setViewportSize({width:760,height:900});
    await page.getByRole('button',{name:/切换.*主题/}).click();
    await page.getByRole('button',{name:'查看cli-guide的本地详情',exact:true}).click();
    await page.locator('.resource-detail-heading h2').filter({hasText:'cli-guide'}).waitFor();
    expect(await page.getByRole('button',{name:'预览停用cli-guide的CodeFlicker CLI入口',exact:true}).isVisible(),'窄屏管理不可达');
    await page.getByRole('button',{name:'预览停用cli-guide的CodeFlicker CLI入口',exact:true}).click();
    await page.getByRole('dialog',{name:'停用预览',exact:true}).waitFor();
    await page.keyboard.press('Escape');
    expect(await page.getByRole('button',{name:'预览停用cli-guide的CodeFlicker CLI入口',exact:true}).evaluate(node=>node===document.activeElement),'预览关闭未恢复焦点');
    await page.screenshot({path:${JSON.stringify(join(artifacts, "cli-skill-dark-narrow.png"))}});
  `);
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ passed: true, checks }, null, 2));
  console.log(JSON.stringify({ passed: true, count: checks.length }));
} catch (error) {
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ passed: false, checks, error: String(error) }, null, 2));
  throw error;
} finally {
  try { await browser(["close"]); } catch { /* 保留原始验收错误。 */ }
  await service?.close();
  await rm(directory, { recursive: true, force: true });
}
