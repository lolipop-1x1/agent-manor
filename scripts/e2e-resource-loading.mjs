import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";
import { resourceFixture } from "./resource-fixture.mjs";

const run = promisify(execFile), directory = await mkdtemp(join(tmpdir(), "resource-loading-"));
const artifacts = fileURLToPath(new URL("../.local/resource-loading-e2e/", import.meta.url));
const session = `resource-loading-${process.pid}`, checks = [];
let service;
const browser = async args => {
  const result = await run("playwright-cli", [`-s=${session}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 3 * 1024 * 1024 });
  if (result.stdout.includes("### Error")) throw new Error(result.stdout);
  return result.stdout;
};
const step = async (name, code) => {
  await browser(["run-code", `async page=>{const expect=(value,message)=>{if(!value)throw Error(message);};${code};return{passed:${JSON.stringify(name)}};}`]);
  checks.push(name); console.log(`PASS ${name}`);
};
try {
  await mkdir(artifacts, { recursive: true });
  const fixture = await resourceFixture(directory, 4);
  await appendFile(fixture.source, "{malformed synthetic diagnostic\n".repeat(20));
  service = await startService({ home: fixture.home, roots: Object.fromEntries(clientIds.map(client => [client, client === "codex" ? fixture.history : []])),
    resourceInventory: { userHome: fixture.userHome }, staticRoot: fileURLToPath(new URL("../dist/web", import.meta.url)) });
  const base = `http://127.0.0.1:${service.instance.port}`;
  for (let attempt = 0; attempt < 400; attempt++) {
    const status = await (await fetch(`${base}/api/v1/sessions/status?summary=true`)).json();
    if (status.job?.status === "failed") throw Error(status.job.error);
    if (status.version) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const get = async path => { const response = await fetch(`${base}/api/v1${path}`); assert.equal(response.status, 200); return response.json(); };
  await browser(["open", base, "--headed", "--browser=chrome"]);
  for (const kind of ["skill", "mcp"]) {
    const overview = await get(`/resources/overview?kind=${kind}&summary=true`);
    const target = overview.resources.find(row => row.hasHistory);
    assert.ok(target);
    const url = `${base}/#resources?${new URLSearchParams({ kind, tab: "usage", q: target.identity.name, detail: "overview" })}`;
    const ready = `await page.waitForFunction(()=>!document.querySelector('.resource-detail-body[aria-busy="true"]'));`;
    await step(`${kind} 概览不请求历史与证据，位置标签仍可直接管理`, `
      await page.evaluate(()=>performance.clearResourceTimings());await page.goto(${JSON.stringify(url)});
      await page.getByRole('button',{name:${JSON.stringify(`查看${target.identity.name}的使用详情`)},exact:true}).click();
      await page.locator('.resource-detail-tabs').waitFor();${ready}
      const requests=await page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/v1/resources/')).map(e=>new URL(e.name).pathname));
      expect(!requests.some(path=>path.includes('/usage/')),'概览不应读取历史详情或证据');
      const request=await page.request.get(${JSON.stringify(`${base}/api/v1/resources/overview/${encodeURIComponent(target.identity.id)}?kind=${kind}&section=overview`)});
      expect((await request.json()).history===null,'轻量概览不应附带完整历史');
      await page.locator('.resource-detail-tabs').getByRole('button',{name:${JSON.stringify(kind === "skill" ? "文件位置" : "配置位置")},exact:true}).click();
      await page.locator('.resource-location-list').waitFor();
    `);
    await step(`${kind} 历史统计与证据并行，等待期间可返回概览`, `
      const held=[];
      await page.route('**/api/v1/resources/usage/**',route=>{held.push(route);});
      const requested=Promise.all([page.waitForRequest(r=>r.url().includes('summary=true')&&r.url().includes('/usage/')),
        page.waitForRequest(r=>r.url().split('?')[0].endsWith('/evidence'))]);
      await page.locator('.resource-detail-tabs').getByRole('button',{name:'使用记录',exact:true}).click();
      const requests=await requested;
      expect(requests[0].url().split('version=')[1].split('&')[0]===requests[1].url().split('version=')[1].split('&')[0],'统计和证据必须固定同版');
      await page.locator('.resource-detail-tabs').getByRole('button',{name:'概览',exact:true}).click();
      await page.locator('.resource-overview-stats').waitFor();
      for(const route of held)await route.continue().catch(()=>{});
      await page.unroute('**/api/v1/resources/usage/**');
      await page.locator('.resource-detail-tabs').getByRole('button',{name:'使用记录',exact:true}).click();
      await page.locator('.resource-evidence a').first().waitFor();${ready}
      const count=Number((await page.locator('.resource-stats > div').first().locator('strong').innerText()).replaceAll(',',''));
      expect(count===${target.stats.events},'使用次数必须与总览一致');
      expect(await page.locator('.resource-source-gaps > div').count()===0,'缺口未展开不生成诊断节点');
    `);
    await step(`${kind} 完整缺口按需读取，失败可重试，关闭后不构建节点`, `
      const full=route=>route.request().url().includes('/usage/')&&!route.request().url().split('?')[0].endsWith('/evidence')&&!route.request().url().includes('summary=');
      const failure=route=>full(route)?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'SYNTHETIC_FAILURE',message:'synthetic-gap-failure'}})}):route.continue();
      await page.route('**/api/v1/resources/usage/**',failure);
      const summary=page.locator('.resource-detail-body details.resource-data-details > summary').filter({hasText:'来源缺口'});
      await summary.click();await page.getByRole('button',{name:'重试',exact:true}).waitFor();
      await page.unroute('**/api/v1/resources/usage/**',failure);
      await page.getByRole('button',{name:'重试',exact:true}).click();
      await page.locator('.resource-source-gaps > div').first().waitFor();
      await summary.click();await page.locator('.resource-source-gaps').waitFor({state:'detached'});
      await page.screenshot({path:${JSON.stringify(join(artifacts, `${kind}-history.png`))}});
    `);
  }
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  await browser(["close"]).catch(() => {}); await service?.close(); await rm(directory, { recursive: true, force: true });
}
