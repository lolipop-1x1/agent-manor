import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CLIENTS, clientIds } from "../dist/clients.js";
import { translate } from "../dist/i18n/index.js";
import { startService } from "../dist/server.js";
import { geminiQwenFixture } from "./native-gemini-qwen-fixture.mjs";
import { kimiOmpFixture } from "./native-kimi-omp-fixture.mjs";
import { grokReasonixCodewhaleFixture } from "./native-grok-reasonix-codewhale-fixture.mjs";

// 所有历史、配置、仓库及管理写操作都限制在隔离合成目录。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-native-e2e-")));
const artifacts = fileURLToPath(new URL("../.local/native-client-expansion/e2e/", import.meta.url));
const clients = ["gemini", "qwen", "kimi", "omp", "grok", "reasonix", "codewhale"];
const browserSession = `native${process.pid}`;
const checks = [];
const localSkills = new Map();
let service;
let base;
const browser = async args => {
  const result = await run("playwright-cli", [`-s=${browserSession}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 5 * 1024 * 1024 });
  if (result.stdout.includes("### Error")) throw new Error(result.stdout);
  return result.stdout;
};
const api = async (path, method = "GET", body) => {
  const response = await fetch(`${base}/api/v1${path}`, { method, headers: { "x-agent-manor-instance": service.instance.id,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); assert.ok(response.ok, JSON.stringify(data.error)); return data;
};
const waitFor = async check => {
  for (let attempt = 0; attempt < 1200; attempt++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("合成验收等待超时");
};
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
const ui = async (name, code) => {
  await browser(["run-code", `async page => { page.setDefaultTimeout(15000); const ensure=(value,message)=>{if(!value)throw new Error(message)}; ${code} return {passed:${JSON.stringify(name)}}; }`]);
  pass(name);
};

try {
  await mkdir(artifacts, { recursive: true });
  const project = join(directory, "project"); await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "example.ts"), "export const alpha = 1;\nexport const beta = 2;\n");
  await run("git", ["init", "-q", project]); await run("git", ["-C", project, "add", "src"]);
  const groups = [];
  for (const fixture of [geminiQwenFixture, kimiOmpFixture, grokReasonixCodewhaleFixture]) groups.push(await fixture(directory, project));
  const roots = { ...Object.fromEntries(clientIds.map(client => [client, []])), ...Object.assign({}, ...groups.map(group => group.roots)) };
  const home = join(directory, "data");
  service = await startService({ home, roots, startupRefresh: true, resourceInventory: { userHome: join(directory, "user"), environment: {} },
    staticRoot: fileURLToPath(new URL("../dist/web/", import.meta.url)) });
  base = `http://127.0.0.1:${service.instance.port}`;
  await waitFor(async () => { const status = await api("/sessions/status"); assert.notEqual(status.job?.status, "failed", status.job?.error); return !!status.version; });
  const registration = await api("/repositories", "POST", { path: project });
  await waitFor(async () => { const { job } = await api(`/jobs/${registration.job.id}`); assert.notEqual(job.status, "failed", job.error); return job.status === "completed"; });
  await api("/resources/refresh", "POST", {});
  for (const client of clients) {
    const list = await api(`/sessions?client=${client}`); assert.equal(list.total, 1, `${client} 会话发现数量`);
    const session = list.sessions[0]; assert.equal(session.client, client); assert.equal(session.project, project);
    const messages = await api(`/sessions/${encodeURIComponent(session.id)}/messages?mode=trace`);
    assert.ok(messages.messages.some(message => message.kind === "user"), `${client} 用户轮次`);
    assert.ok(messages.messages.some(message => message.kind === "tool_call" && message.status === "success"), `${client} 成功工具轨迹`);
    const profile = await api(`/sessions/${encodeURIComponent(session.id)}/profile`);
    assert.ok(profile.turnCount > 0); assert.ok(profile.tools.some(tool => tool.success > 0));
    if (["reasonix", "codewhale"].includes(client)) assert.ok(profile.usageReports?.length, `${client} 原生累计报告`);
    const usage = await api(`/usage?clients=${encodeURIComponent(JSON.stringify([client]))}`); assert.equal(usage.totals.requests, profile.usage.requests, `${client} 跨入口请求口径`);
    const coverage = await api(`/repositories/${registration.repository.id}/coverage?client=${client}`);
    assert.ok(coverage.files.some(file => file.path === "src/example.ts" && file.readCount > 0), `${client} 代码地图读取活动`);
    const env = { ...process.env, AGENT_MANOR_HOME: home };
    const cli = await run(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "--home", home, "sessions", "list", "--client", client, "--json"], { env, timeout: 30_000 });
    assert.equal(JSON.parse(cli.stdout).sessions[0].client, client, `${client} CLI 校验`);
    for (const kind of ["skill", "mcp"]) {
      const local = await api(`/resources/local?kind=${kind}&client=${client}&pageSize=200`);
      assert.ok(local.total > 0, `${client}/${kind} 原生资源清单`);
      if (kind === "skill") localSkills.set(client, local.rows.find(row => row.entries.some(entry => entry.client === client && !entry.protected && (entry.capabilities.disable || entry.capabilities.trash))));
      assert.ok(!JSON.stringify(local).includes("fixture-secret"), `${client} MCP 敏感投影`);
    }
    pass(`${client} API／CLI／代码地图／统计／资源`);
  }
  await api("/overview/snapshot?window=all"); pass("总览发布结果读取");
  await api("/preferences", "PUT", { language: "zh-CN" });
  await browser(["open", `${base}/#sessions`, "--headed", "--browser=chrome"]);
  for (const language of ["zh-CN", "en"]) {
    await api("/preferences", "PUT", { language });
    for (const client of clients) {
      const label = CLIENTS.find(value => value.id === client).name;
      const filter = language === "en" ? "Filter clients" : "筛选客户端";
      const trace = language === "en" ? "Execution trace" : "执行轨迹";
      await ui(`${language}/${client} 筛选与执行轨迹`, `
        await page.goto(${JSON.stringify(`${base}/#sessions?client=${client}`)});
        await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
        await page.locator(${JSON.stringify(`html[lang="${language}"]`)}).waitFor();
        const filter=page.getByRole('combobox',{name:${JSON.stringify(filter)},exact:true});
        await filter.click(); await page.getByRole('option',{name:${JSON.stringify(label)},exact:true}).click();
        await page.locator('.session-list-item').first().waitFor();
        ensure(await page.locator('.session-list-item').count()===1,'客户端过滤不一致');
        await page.locator('.session-list-item').first().click();
        await page.getByRole('button',{name:${JSON.stringify(trace)},exact:true}).click();
        await page.locator('.session-trace').waitFor();
        ensure((await page.locator('.sessions-main').innerText()).length>40,'执行轨迹为空');
      `);
      for (const kind of ["skill", "mcp"]) await ui(`${language}/${client}/${kind} 本地资源`, `
        await page.goto(${JSON.stringify(`${base}/#resources?client=${client}&kind=${kind}&tab=local`)});
        await page.getByRole('table',{name:${JSON.stringify(translate(language, "resources.tab.local"))},exact:true}).waitFor();
        await page.getByRole('combobox',{name:${JSON.stringify(language === "en" ? "Resource client" : "资源客户端")},exact:true}).waitFor();
        ensure((await page.locator('.resources-shell').innerText()).includes(${JSON.stringify(label)}),'资源客户端名称错误');
      `);
    }
    if (language === "zh-CN") for (const client of clients) {
      const row = localSkills.get(client); assert.ok(row, `${client} 普通 Skill 管理入口`);
      const entry = row.entries.find(value => value.client === client && !value.protected && (value.capabilities.disable || value.capabilities.trash));
      const action = entry.capabilities.disable ? "disable" : "trash";
      const actionName = translate(language, `resources.action.${action}`);
      const label = CLIENTS.find(value => value.id === client).name;
      const previewLabel = action === "disable" ? translate(language, "resources.management.previewEntry", { action: actionName, name: entry.name, client: label })
        : translate(language, "resources.management.trashFile", { path: entry.entryPath });
      await ui(`${client} 原生管理预览与本地执行`, `
        await page.goto(${JSON.stringify(`${base}/#resources?client=${client}&kind=skill&tab=local`)});
        await page.getByRole('button',{name:${JSON.stringify(translate(language, "resources.viewLocal", { name: row.body.name }))},exact:true}).click();
        await page.getByRole('button',{name:${JSON.stringify(translate(language, "resources.management.resource", { name: row.body.name }))},exact:true}).click();
        await page.getByRole('dialog',{name:${JSON.stringify(translate(language, "resources.detail.manageEntries"))},exact:true}).getByRole('button',{name:${JSON.stringify(previewLabel)},exact:true}).click();
        const dialog=page.getByRole('dialog',{name:${JSON.stringify(translate(language, "resources.management.actionPreview", { action: actionName }))},exact:true});
        await dialog.getByRole('button',{name:${JSON.stringify(translate(language, "resources.management.confirm", { action: actionName }))},exact:true}).click();
        await dialog.getByRole('button',{name:${JSON.stringify(translate(language, "resources.done"))},exact:true}).waitFor();
        ensure((await dialog.innerText()).includes('本地修改完成'),'管理写入没有成功反馈');
        await dialog.getByRole('button',{name:${JSON.stringify(translate(language, "resources.done"))},exact:true}).click();
      `);
      const archives = await api(`/resources/archives?client=${client}`);
      const archive = archives.archives.find(value => value.entry.id === entry.id && value.state !== "restored"); assert.ok(archive, `${client} 恢复材料`);
      const restore = await api("/resources/preview", "POST", { operationId: archive.operationId, action: "restore" });
      const restored = await api("/resources/apply", "POST", { previewId: restore.id, confirmed: true }); assert.equal(restored.status, "success");
      await api("/resources/refresh", "POST", {});
      const current = await api(`/resources/local?kind=skill&client=${client}&pageSize=200`);
      assert.ok(current.rows.some(value => value.entries.some(item => item.id === entry.id && item.nativeState === "enabled")), `${client} 恢复后原生状态`);
      pass(`${client} 原生状态与恢复回读`);
    }
  }
  await ui("窄屏与英文累计报告", `
    await page.setViewportSize({width:1440,height:1000});
    await page.goto(${JSON.stringify(`${base}/#sessions?client=codewhale`)});
    await page.locator('.session-list-item').first().click();
    await page.setViewportSize({width:760,height:900});
    await page.getByRole('button',{name:'Session statistics',exact:true}).click();
    const report=page.getByText('Native cumulative reports',{exact:true});
    await report.waitFor(); await report.click();
    ensure(await page.locator('.session-stat-details table').count()>0,'累计报告未展示');
    await page.getByRole('button',{name:'Appearance',exact:true}).click();
    await page.getByRole('combobox',{name:'Display mode',exact:true}).click();
    await page.getByRole('option',{name:'Dark',exact:true}).click();
    await page.keyboard.press('Escape');
    await page.locator('html[data-theme="dark"]').waitFor();
    await page.screenshot({path:${JSON.stringify(join(artifacts, "native-clients-en-narrow.png"))}});
  `);
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ passed: true, checks, nativeRuntimeVerified: false }, null, 2));
  console.log(JSON.stringify({ passed: true, count: checks.length }));
} catch (error) {
  try { await browser(["run-code", `async page => { await page.screenshot({path:${JSON.stringify(join(artifacts, "failure.png"))}}); return (await page.locator('body').innerText()).slice(0,12000); }`]); } catch { /* 不覆盖原始验收错误。 */ }
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ passed: false, checks, error: String(error) }, null, 2)); throw error;
} finally {
  try { await browser(["close"]); } catch { /* 保留原始验收错误。 */ }
  await service?.close(); await rm(directory, { recursive: true, force: true });
}
