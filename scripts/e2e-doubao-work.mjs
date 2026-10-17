import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startService } from "../dist/server.js";
import { SessionStore } from "../dist/sessions/store.js";
import { parseSessionSource } from "../dist/sessions/parser.js";
import { doubaoWorkAdapter } from "../dist/history/adapters/doubao-work.js";
import { translate } from "../dist/i18n/index.js";
import { createDoubaoWorkScenario } from "../tests/helpers/doubao-work-scenario.ts";

// node --import tsx scripts/e2e-doubao-work.mjs；只操作新建的人工历史与资源。
const run = promisify(execFile), quote = JSON.stringify;
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-doubao-e2e-")));
const artifacts = fileURLToPath(new URL("../.local/doubao-work-audit/e2e/", import.meta.url));
const browserSession = `doubao-work-${process.pid}`;
const checks = [], started = Date.now();
let service, fixture, base, currentStep = "setup";
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${browserSession}`, ...args], { cwd: directory,
    env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 5 * 1024 * 1024 });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
const api = async (route, method = "GET", body) => {
  const response = await fetch(`${base}/api/v1${route}`, { method, headers: { "x-agent-manor-instance": service.instance.id,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${route}: ${result.error?.message ?? response.status}`);
  return result;
};
const step = async (name, code) => {
  currentStep = name;
  await browser(["run-code", `async page => { page.setDefaultTimeout(15000); const expect = (value, message) => { if (!value) throw new Error(message); }; ${code} return { passed: ${quote(name)} }; }`]);
  checks.push(name); console.log(`PASS ${name}`);
};
const t = (key, language = "zh-CN") => translate(language, key);

const resourcesReady = `await page.waitForLoadState('networkidle'); await page.waitForFunction(()=>!document.querySelector('.resource-list-scroll[aria-busy="true"]')&&!document.querySelector('.resource-detail-body[aria-busy="true"]'));`;
const screenshot = name => `await page.screenshot({path:${quote(join(artifacts, name))}});`;

try {
  await mkdir(artifacts, { recursive: true });
  fixture = await createDoubaoWorkScenario(directory);
  const history = join(directory, "supported"); await mkdir(history);
  const path = join(history, "supported.jsonl");
  await writeFile(path, [
    { type: "session_meta", payload: { id: "synthetic-supported", cwd: fixture.project } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic supported session" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic supported answer" }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const store = new SessionStore(join(fixture.home, "index.sqlite")), revisions = [];
  let pausedId;
  try {
    const native = (await doubaoWorkAdapter.discoverFile({ client: "doubao-work", path: fixture.current }))[0];
    for (const source of [native, { client: "codex", path, format: "codex-jsonl" }]) {
      const pending = store.createRevision(source.path, "synthetic-legacy");
      const meta = await parseSessionSource(source, pending.sink); pending.flush(); store.finishRevision(pending.revision, meta);
      if (source.client === "doubao-work") pausedId = meta.id;
      revisions.push({ path: source.path, revision: pending.revision, fingerprint: "synthetic-legacy" });
    }
    store.publish(store.createJob().id, revisions, []);
  } finally { store.close(); }
  service = await startService({ home: fixture.home, roots: { ...fixture.roots, codex: [history] }, startupRefresh: false,
    resourceInventory: { userHome: fixture.userHome, environment: {} }, staticRoot: fileURLToPath(new URL("../dist/web/", import.meta.url)),
    usagePricing: { fetch: async () => { throw new Error("synthetic offline pricing"); } } });
  base = `http://127.0.0.1:${service.instance.port}`;
  const list = await api("/sessions"); assert.equal(list.total, 1); assert.equal(list.sessions[0].client, "codex");
  await assert.rejects(api("/sessions?client=doubao-work"));
  await assert.rejects(api("/sessions/refresh", "POST", { client: "doubao-work" }));
  await api("/preferences", "PUT", { language: "zh-CN", appearance: { mode: "light", preset: "blue" } });
  await browser(["open", `${base}/#sessions?id=${encodeURIComponent(pausedId)}&client=doubao-work`, "--headed", "--browser=chrome"]);
  await step("旧豆包深链接清理并显示可用会话", `
    page.pausedErrors=[]; page.on('pageerror',error=>page.pausedErrors.push(error.message));
    await page.locator('.session-list-item').first().waitFor();
    await page.waitForFunction(()=>!location.hash.includes('doubao-work'));
    expect(!(await page.locator('body').innerText()).includes(${quote(fixture.title)}),'旧豆包会话仍可见');
    expect((await page.locator('.session-list').innerText()).includes('Synthetic supported session'),'其他客户端会话丢失');
  `);
  for (const language of ["zh-CN", "en"]) {
    await api("/preferences", "PUT", { language, appearance: { mode: language === "en" ? "dark" : "light", preset: "blue" } });
    await step(`${language} 会话客户端选项停用，鼠标与键盘保留 Codex`, `
      await page.goto(${quote(`${base}/#sessions`)}); await page.reload(); await page.locator('.session-list-item').first().waitFor();
      const client=page.getByRole('combobox',{name:${quote(t("sessions.filter.client",language))},exact:true}); await client.click();
      expect(await page.getByRole('option',{name:${quote(t("common.client.doubaoWork",language))},exact:true}).count()===0,'豆包筛选仍存在');
      await page.getByRole('option',{name:'Codex',exact:true}).click();
      await client.focus(); await client.press('ArrowDown');
      expect(await page.getByRole('option',{name:${quote(t("common.client.doubaoWork",language))},exact:true}).count()===0,'键盘菜单仍有豆包');
      await page.keyboard.press('Escape');
      ${screenshot(`disabled-sessions-${language}.png`)}
    `);
    await step(`${language} 资源与手动来源客户端选项停用`, `
      await page.goto(${quote(`${base}/#resources?kind=skill&tab=usage&window=all&client=doubao-work`)}); ${resourcesReady}
      expect(!(await page.locator('body').innerText()).includes(${quote(t("common.client.doubaoWork",language))}),'资源页仍显示豆包客户端');
      await page.getByRole('button',{name:${quote(t("resources.workspace.tools",language))},exact:true}).click();
      await page.getByRole('menuitem',{name:${quote(t("resources.workspace.scanSettings",language))},exact:true}).click();
      await page.getByRole('button',{name:${quote(t("resources.source.add",language))},exact:true}).click();
      await page.getByRole('combobox',{name:${quote(t("resources.source.client",language))},exact:true}).click();
      expect(await page.getByRole('option',{name:${quote(t("common.client.doubaoWork",language))},exact:true}).count()===0,'手动来源仍允许豆包');
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      ${screenshot(`disabled-resources-${language}.png`)}
    `);
  }
  await step("英文窄屏旧筛选地址可用，无豆包残留或页面异常", `
    await page.setViewportSize({width:390,height:844});
    await page.goto(${quote(`${base}/#sessions?client=doubao-work`)}); await page.locator('.session-list-item').first().waitFor({state:'attached'});
    expect(!(await page.locator('body').innerText()).includes('Doubao Work'),'窄屏仍显示豆包');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'窄屏横向溢出');
    expect(page.pausedErrors.length===0,'浏览器异常：'+page.pausedErrors.join(';'));
    ${screenshot("disabled-phone.png")}
  `);
  await writeFile(join(artifacts, "disabled-report.json"), JSON.stringify({ passed: true, checks, elapsedMs: Date.now()-started, fixtureOnly: true }, null, 2));
  console.log(`PASS 豆包工作停用正式产物 Chrome ${checks.length} 项`);
} catch (error) {
  await browser(["screenshot", `--filename=${join(artifacts, "disabled-failure.png")}`]).catch(()=>{});
  await writeFile(join(artifacts, "disabled-report.json"), JSON.stringify({ passed: false, checks, step: currentStep, error: error.message }, null, 2));
  throw error;
} finally {
  await browser(["close"]).catch(()=>{}); await service?.close().catch(()=>{}); await rm(directory,{recursive:true,force:true});
}
