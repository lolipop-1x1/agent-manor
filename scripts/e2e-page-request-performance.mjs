import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { clientIds } from "../dist/clients.js";
import { startService } from "../dist/server.js";
import { resourceFixture } from "./resource-fixture.mjs";

// 全部历史和资源目录隔离，诊断输入仅使用人工合成内容。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-page-performance-")));
const artifacts = fileURLToPath(new URL("../.local/page-request-performance-e2e/", import.meta.url));
const session = `page-performance-${process.pid}`;
const checks = [];
let service;
const browser = async args => {
  const result = await run("playwright-cli", [`-s=${session}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.stdout.includes("### Error")) throw new Error(result.stdout);
  return result.stdout;
};
const step = async (name, code) => {
  await browser(["run-code", `async page => { const expect=(value,message)=>{if(!value)throw new Error(message);}; ${code} return {passed:${JSON.stringify(name)}}; }`]);
  checks.push(name); console.log(`PASS ${name}`);
};

try {
  await mkdir(artifacts, { recursive: true });
  const fixture = await resourceFixture(directory, 35);
  await appendFile(fixture.source, "{malformed synthetic diagnostic\n".repeat(40));
  const roots = Object.fromEntries(clientIds.map(client => [client, client === "codex" ? fixture.history : []]));
  service = await startService({ home: fixture.home, roots, resourceInventory: { userHome: fixture.userHome, environment: {} }, staticRoot: fileURLToPath(new URL("../dist/web", import.meta.url)) });
  const base = `http://127.0.0.1:${service.instance.port}`;
  let state;
  for (let attempt = 0; attempt < 400; attempt++) {
    state = await (await fetch(`${base}/api/v1/sessions/status?summary=true`)).json();
    if (state.job?.status === "failed") throw new Error(state.job.error);
    if (state.version) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(state.version);
  assert.ok(state.gapCount > 0);
  await fetch(`${base}/api/v1/preferences`, { method: "PUT", headers: { "Content-Type": "application/json", "x-agent-manor-instance": service.instance.id }, body: JSON.stringify({ language: "zh-CN" }) });
  await browser(["open", `${base}/#resources?kind=skill&tab=usage`, "--headed", "--browser=chrome"]);
  await step("资源首屏只取摘要，完整来源和诊断不提前下载", `
    await page.getByRole("table",{name:"Skill 总览",exact:true}).waitFor();
    await page.waitForLoadState("networkidle");
    const paths=await page.evaluate(()=>performance.getEntriesByType("resource").filter(item=>item.name.includes("/api/v1/")).map(item=>new URL(item.name).pathname+new URL(item.name).search));
    expect(paths.includes("/api/v1/resources/status?summary=true"),"资源状态必须使用摘要");
    expect(!paths.includes("/api/v1/resources/status"),"完整来源不能提前下载");
    expect(paths.some(path=>path.startsWith("/api/v1/resources/overview?")&&path.includes("summary=true")),"总览必须使用摘要");
    expect(paths.includes("/api/v1/status?summary=true"),"首页状态必须使用摘要");
  `);
  await step("来源读取失败可重试，关闭诊断明细不生成列表节点", `
    await page.route("**/api/v1/resources/status",route=>route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:{code:"SYNTHETIC_FAILURE",message:"synthetic-source-failure"}})}));
    await page.getByRole("button",{name:"来源与能力",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"来源与能力",exact:true});
    await dialog.getByRole("button",{name:"重试",exact:true}).waitFor();
    await page.unroute("**/api/v1/resources/status");
    await dialog.getByRole("button",{name:"重试",exact:true}).click();
    await dialog.locator(".resource-source-list > div").first().waitFor();
    expect(await dialog.locator(".resource-diagnostics").count()>0,"合成来源必须包含诊断");
    expect(await dialog.locator(".resource-diagnostics > div").count()===0,"关闭的诊断列表不应构建节点");
    const diagnosticSummary=dialog.locator("details").filter({has:page.locator(".resource-diagnostics")}).locator("summary");
    await diagnosticSummary.click();
    await dialog.locator(".resource-diagnostics > div").first().waitFor();
    await diagnosticSummary.click();
    await dialog.locator(".resource-diagnostics > div").first().waitFor({state:"detached"});
    await page.keyboard.press("Escape");
    await dialog.waitFor({state:"hidden"});
  `);
  await step("会话首屏只取摘要，展开后才读取对应版本的缺口", `
    await page.getByRole("button",{name:"会话库",exact:true}).click();
    await page.locator(".session-list-item").first().waitFor();
    let paths=await page.evaluate(()=>performance.getEntriesByType("resource").map(item=>new URL(item.name).pathname+new URL(item.name).search));
    expect(paths.includes("/api/v1/sessions/status?summary=true"),"会话状态必须使用摘要");
    expect(!paths.some(path=>path.startsWith("/api/v1/sessions/gaps")),"缺口正文不能提前下载");
    await page.route("**/api/v1/sessions/gaps?*",route=>route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:{code:"SYNTHETIC_FAILURE",message:"synthetic-gap-failure"}})}));
    await page.locator(".session-index-gaps > summary").click();
    await page.locator(".session-index-gaps").getByRole("button",{name:"重试",exact:true}).waitFor();
    await page.unroute("**/api/v1/sessions/gaps?*");
    const diagnosticResponse=page.waitForResponse(response=>response.url().includes("/api/v1/sessions/gaps?version="));
    await page.locator(".session-index-gaps").getByRole("button",{name:"重试",exact:true}).click();
    await diagnosticResponse;
    await page.locator(".session-index-gaps > div").first().waitFor();
    await page.waitForLoadState("networkidle");
    paths=await page.evaluate(()=>performance.getEntriesByType("resource").map(item=>new URL(item.name).pathname+new URL(item.name).search));
    expect(paths.some(path=>path.startsWith("/api/v1/sessions/gaps?version=")),"缺口请求必须绑定版本");
    expect(await page.locator(".session-index-gaps > div").count()>0,"诊断正文未显示");
    await page.locator(".session-index-gaps > summary").click();
    await page.locator(".session-index-gaps > div").first().waitFor({state:"detached"});
    expect(await page.locator(".session-index-gaps > div").count()===0,"关闭时不保留诊断节点");
  `);
  await fetch(`${base}/api/v1/preferences`, { method: "PUT", headers: { "Content-Type": "application/json", "x-agent-manor-instance": service.instance.id }, body: JSON.stringify({ language: "en" }) });
  await step("英文与窄屏仍可按需查看同一版本的诊断", `
    await page.setViewportSize({width:375,height:812});
    await page.reload();
    await page.locator(".session-compact-actions").getByRole("button",{name:"Session list",exact:true}).click();
    await page.locator(".session-list-item").first().waitFor();
    expect((await page.locator(".session-index-gaps > summary").innerText()).includes("Index gap"),"缺口数量未使用英文目录");
    await page.locator(".session-index-gaps > summary").click();
    await page.locator(".session-index-gaps > div").first().waitFor();
    const paths=await page.evaluate(()=>performance.getEntriesByType("resource").map(item=>new URL(item.name).pathname+new URL(item.name).search));
    expect(paths.some(path=>path===${JSON.stringify(`/api/v1/sessions/gaps?version=${state.version}`)}),"语言与视口不能改变诊断版本");
    await page.screenshot({path:${JSON.stringify(join(artifacts, "narrow-en.png"))}});
  `);
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ checks }, null, 2));
  console.log(`PASS 页面请求与按需诊断 Chrome 验收 ${checks.length} 项`);
} finally {
  await browser(["close"]).catch(() => undefined);
  if (service) await service.close();
  await rm(directory, { recursive: true, force: true });
}
