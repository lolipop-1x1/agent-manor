import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { clientIds } from "../dist/clients.js";
import { SessionStore } from "../dist/sessions/store.js";
import { startService } from "../dist/server.js";

// 共享画像使用隔离索引，原生格式解析另由针对性回归覆盖。
const run = promisify(execFile), directory = await mkdtemp(join(tmpdir(), "manor-import-details-"));
const home = join(directory, "data"), session = `import-details-${process.pid}`;
const artifacts = fileURLToPath(new URL("../.local/session-import-diagnostics/e2e/", import.meta.url));
const checks = [];
let service;
const browser = async args => {
  const result = await run("playwright-cli", [`-s=${session}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 3 * 1024 * 1024 });
  if (result.stdout.includes("### Error")) throw new Error(result.stdout);
};
const step = async (name, code) => {
  await browser(["run-code", `async page=>{const ensure=(value,message)=>{if(!value)throw Error(message)};${code};return{passed:${JSON.stringify(name)}}}`]);
  checks.push(name); console.log(`PASS ${name}`);
};
try {
  await mkdir(home); await mkdir(artifacts, { recursive: true });
  const store = new SessionStore(join(home, "index.sqlite"));
  const sources = clientIds.map(client => {
    const id = `synthetic-${client}`, path = `/synthetic/history/${client}.jsonl`, turnId = `${id}:turn`;
    const pending = store.createRevision(path, "synthetic");
    const messages = [{ kind: "user", text: "合成需求" }, { kind: "tool_call", text: "", tool: "synthetic_read", callId: "call", status: "success" },
      { kind: "tool_result", text: "合成结果", tool: "synthetic_read", callId: "call", status: "success" }, { kind: "assistant", text: "合成回答", final: "explicit" }];
    for (const [ordinal, message] of messages.entries()) pending.sink.message({ id: `${id}:${ordinal}`, sessionId: id, turnId, ordinal, recordLine: ordinal + 1,
      occurredAt: `2026-01-01T00:00:0${ordinal}Z`, ...message });
    pending.sink.usage({ id: `${id}:request`, messageId: `${id}:3`, turnId, model: id, inputTokens: 100, cachedInputTokens: 80, outputTokens: 10 });
    pending.flush(); store.finishRevision(pending.revision, { id, client, clientSessionId: id, sourceId: `${client}:${id}`, path,
      title: id, titleOrigin: "recorded", models: [id], messageCount: messages.length, turnCount: 1,
      gaps: [{ kind: "parse_error", message: "人工合成导入诊断", messageDescriptor: { key: "diagnostics.sessions.parser.m002" } }] });
    return { path, revision: pending.revision, fingerprint: "synthetic" };
  });
  store.publish(store.createJob().id, sources, []); store.close();
  service = await startService({ home, startupRefresh: false, roots: Object.fromEntries(clientIds.map(client => [client, []])),
    resourceInventory: { userHome: join(directory, "user"), environment: {} }, staticRoot: fileURLToPath(new URL("../dist/web", import.meta.url)) });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const api = async path => { const response = await fetch(`${base}/api/v1${path}`); assert.equal(response.status, 200); return response.json(); };
  for (const client of clientIds) {
    const profile = await api(`/sessions/synthetic-${client}/profile?summary=true`);
    assert.equal(profile.gaps.length, 1); assert.equal(profile.usage.requests, 1); assert.equal(profile.tools[0].calls, 1);
    assert.equal(profile.turnCount, 1);
  }
  checks.push("全部客户端 API 保留诊断与已记录统计");
  await browser(["open", base, "--headed", "--browser=chrome"]);
  for (const language of ["zh-CN", "en"]) {
    const response = await fetch(`${base}/api/v1/preferences`, { method: "PUT", headers: { "content-type": "application/json", "x-agent-manor-instance": service.instance.id }, body: JSON.stringify({ language }) });
    assert.equal(response.status, 200);
    await step(`${language} 全部客户端画像移除导入详情，正文与三个分区可读`, `
      await page.setViewportSize({width:1920,height:1000});await page.reload();
      await page.locator(${JSON.stringify(`html[lang="${language}"]`)}).waitFor();
      for(const client of ${JSON.stringify(clientIds)}){
        const id='synthetic-'+client;
        await page.goto(${JSON.stringify(base)}+'/#sessions?client='+client+'&id='+id);
        await page.getByRole('heading',{name:id,exact:true}).waitFor();
        const pane=page.locator('.session-profile');
        await pane.getByRole('tab',{name:${JSON.stringify(language === "en" ? "Overview" : "概览")},exact:true}).click();
        await pane.getByText(id,{exact:true}).first().waitFor();
        ensure(await page.getByText('合成回答',{exact:true}).count()>0,'正文未显示');
        ensure(await pane.getByRole('tab').count()===3,'画像分区缺失');
        ensure(await page.getByText(/^(导入详情|Import details)$/).count()===0,'导入详情仍在界面');
        ensure(await pane.getByText(/人工合成导入诊断|无效 JSON/).count()===0,'技术诊断仍渲染在画像');
      }
      await page.screenshot({path:${JSON.stringify(join(artifacts, `${language}-desktop.png`))}});
    `);
  }
  await step("真实读取错误仍可见并支持重试", `
    await page.route('**/api/v1/sessions/**/profile?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SYNTHETIC_FAILURE',message:'synthetic-profile-failure'}})}));
    await page.goto(${JSON.stringify(`${base}/#sessions?client=codex&id=synthetic-codex`)});
    await page.getByRole('alert').filter({hasText:'synthetic-profile-failure'}).waitFor();
    await page.unroute('**/api/v1/sessions/**/profile?*');
    await page.getByRole('alert').filter({hasText:'synthetic-profile-failure'}).getByRole('button',{name:'Retry',exact:true}).click();
    await page.locator('.session-profile').getByText('synthetic-codex',{exact:true}).first().waitFor();
    ensure(await page.getByRole('alert').filter({hasText:'synthetic-profile-failure'}).count()===0,'重试后未清除旧错误');
  `);
  await step("英文深色窄屏画像没有导入详情", `
    await page.getByRole('button',{name:'Appearance',exact:true}).click();
    await page.getByRole('combobox',{name:'Display mode',exact:true}).click();
    await page.getByRole('option',{name:'Dark',exact:true}).click();await page.keyboard.press('Escape');
    await page.setViewportSize({width:760,height:900});
    await page.getByRole('button',{name:'Session statistics',exact:true}).click();
    await page.locator('.session-profile').getByRole('tab',{name:'Overview',exact:true}).click();
    ensure(await page.getByText(/^(导入详情|Import details)$/).count()===0,'窄屏导入详情仍可见');
    await page.screenshot({path:${JSON.stringify(join(artifacts, "en-dark-narrow.png"))}});
  `);
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ passed: true, clientCount: clientIds.length, checks }, null, 2));
} finally {
  await browser(["close"]).catch(() => {}); await service?.close(); await rm(directory, { recursive: true, force: true });
}
