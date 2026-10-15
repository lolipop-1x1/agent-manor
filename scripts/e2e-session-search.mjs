import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AnalysisStore } from "../dist/index/store.js";
import { SessionStore } from "../dist/sessions/store.js";
import { startService } from "../dist/server.js";
import { writePreferences } from "../dist/service/preferences.js";
import { clientIds } from "../dist/clients.js";

const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "manor-search-e2e-"));
const artifacts = fileURLToPath(new URL("../.local/session-search-e2e/", import.meta.url));
const session = `search-${process.pid}`;
const browser = async args => {
  const result = await run("playwright-cli", [`-s=${session}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.stdout.includes("### Error")) throw new Error(result.stdout);
  return result.stdout;
};
let service;
try {
  await mkdir(artifacts, { recursive: true });
  const home = join(directory, "data"); await mkdir(home); await writePreferences(home, "zh-CN");
  const path = join(home, "index.sqlite"); const analysis = new AnalysisStore(path); analysis.close();
  const store = new SessionStore(path), revisions = [];
  for (let index = 0; index < 30; index++) {
    const id = `synthetic-${String(index).padStart(2, "0")}`, path = `/workspace/history/${id}.jsonl`;
    const pending = store.createRevision(path, "synthetic");
    pending.sink.message({ id: `user-${index}`, sessionId: id, ordinal: 0, recordLine: 1, turnId: "turn", kind: "user", text: "事务与锁的合成问题" });
    pending.sink.message({ id: `reply-${index}`, sessionId: id, ordinal: 1, recordLine: 2, turnId: "turn", kind: "assistant", text: "事务处理完成", final: "recorded" });
    pending.flush();
    store.finishRevision(pending.revision, { id, client: "codex", clientSessionId: id, sourceId: `synthetic-${index}`, path,
      title: `检索合成 ${index}`, titleOrigin: "recorded", messageCount: 2, turnCount: 1, models: [], gaps: [] });
    revisions.push({ path, revision: pending.revision, fingerprint: "synthetic" });
  }
  store.publish(store.createJob().id, revisions, []); store.close();
  service = await startService({ home, port: 0, startupRefresh: false,
    roots: Object.fromEntries(clientIds.map(client => [client, join(directory, `empty-${client}`)])), resourceInventory: { environment: {} } });
  await browser(["open", `http://127.0.0.1:${service.instance.port}/#sessions`, "--headed", "--browser=chrome"]);
  const output = await browser(["run-code", `async page => {
    const ensure = (value, message) => { if (!value) throw new Error(message); };
    const requests = [], failed = [];
    const info = raw => {
      const query = Object.fromEntries((raw.split('?')[1]||'').split('&').map(part=>part.split('=').map(decodeURIComponent)));
      return {pathname:'/'+raw.split('?')[0].split('/').slice(3).join('/'),searchParams:{get:key=>query[key]}};
    };
    page.on('request', request => { const url = info(request.url()); if (url.pathname.startsWith('/api/v1/sessions')) requests.push(url); });
    page.on('requestfailed', request => failed.push(request.url()));
    const input = page.getByRole('textbox', {name:'搜索会话标题和消息',exact:true});
    await page.getByRole('heading',{name:'检索合成 0',exact:true}).waitFor();
    requests.length=0;
    await input.fill('事务'); await page.locator('.session-search-group').first().waitFor();
    await page.waitForTimeout(150);
    ensure(requests.filter(url=>url.pathname.endsWith('/search/groups')).length===1,'首词重复请求');
    ensure(!requests.some(url=>url.pathname==='/api/v1/sessions'),'搜索发出隐藏列表请求');
    const matches=requests.filter(url=>url.pathname.endsWith('/matches')).length;
    requests.length=0;
    await page.getByRole('button',{name:'会话列表分页下一页',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.resource-pager-compact input')?.value==='2');
    await page.waitForTimeout(150);
    ensure(requests.filter(url=>url.pathname.endsWith('/search/groups')).length===1,'翻页重复查询');
    ensure(!requests.some(url=>url.pathname.endsWith('/matches')),'翻页重新检查范围');
    requests.length=0;
    await input.fill('锁');
    await page.waitForFunction(()=>document.querySelector('.session-search-group mark')?.textContent==='锁');
    ensure(requests.filter(url=>url.pathname.endsWith('/search/groups')).every(url=>url.searchParams.get('page')==='1'),'新词先查询旧页');
    await input.fill('没有任何命中');
    await page.locator('.session-search-empty').waitFor();
    ensure(await input.evaluate(element=>element===document.activeElement),'搜索丢失焦点');
    let delayed;
    await page.route('**/api/v1/sessions/search/groups?*',async route=>{
      if(info(route.request().url()).searchParams.get('q')==='事') { delayed=true; await page.waitForTimeout(800); }
      await route.continue().catch(()=>{});
    });
    await input.fill('事'); await page.waitForTimeout(350); ensure(delayed,'旧请求尚未启动');
    await input.fill('事务');
    await page.waitForFunction(()=>document.querySelector('.session-search-group mark')?.textContent==='事务');
    await page.waitForTimeout(900);
    ensure(failed.some(url=>info(url).searchParams.get('q')==='事'),'输入变化未取消旧请求');
    ensure(await page.evaluate(()=>document.querySelector('.session-search-group mark')?.textContent==='事务'),'旧响应覆盖新词');
    ensure(await page.getByRole('spinbutton',{name:'会话列表分页跳转页码',exact:true}).inputValue()==='1','返回之前的关键词恢复了旧页');
    await page.getByRole('button',{name:'清除搜索',exact:true}).click();
    await page.locator('.session-list-item').first().waitFor();
    await page.getByRole('heading',{name:'检索合成 0',exact:true}).waitFor();
    await page.screenshot({path:${JSON.stringify(join(artifacts, "search.png"))}});
    return {singleRequest:true,noHiddenList:true,noMatchesOnPage:true,pageReset:true,staleAborted:true,empty:true,focus:true,readingRetained:true,initialMatches:matches};
  }`]);
  assert.match(output, /"staleAborted"\s*:\s*true/);
  await writeFile(join(artifacts, "report.txt"), output);
  console.log(output);
} finally {
  await browser(["close"]).catch(() => undefined);
  if (service) await service.close();
  await rm(directory, { recursive: true, force: true });
}
