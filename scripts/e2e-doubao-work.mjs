import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startService } from "../dist/server.js";
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
const idle = `await page.waitForLoadState('networkidle'); await page.locator('.session-message-loading').waitFor({state:'hidden'});`;
const resourcesReady = `await page.waitForLoadState('networkidle'); await page.waitForFunction(()=>!document.querySelector('.resource-list-scroll[aria-busy="true"]')&&!document.querySelector('.resource-detail-body[aria-busy="true"]'));`;
const screenshot = name => `await page.screenshot({path:${quote(join(artifacts, name))}});`;

try {
  await mkdir(artifacts, { recursive: true });
  fixture = await createDoubaoWorkScenario(directory, { includeUnlinkedReplies: true });
  service = await startService({ home: fixture.home, roots: fixture.roots, resourceInventory: { userHome: fixture.userHome, environment: {} },
    staticRoot: fileURLToPath(new URL("../dist/web/", import.meta.url)),
    usagePricing: { fetch: async () => { throw new Error("synthetic offline pricing"); } } });
  base = `http://127.0.0.1:${service.instance.port}`;
  for (let attempt = 0; attempt < 400; attempt++) {
    const status = await api("/sessions/status");
    if (status.job?.status === "failed") throw new Error(status.job.error);
    if (status.version) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const list = await api("/sessions?client=doubao-work"); assert.equal(list.total, 1);
  const session = list.sessions[0], sessionUrl = `${base}/#sessions?id=${encodeURIComponent(session.id)}&mode=brief`;
  const initialMessages = await api(`/sessions/${encodeURIComponent(session.id)}/messages?mode=full`);
  const unlinked = fixture.unlinkedReplies.map(text => initialMessages.messages.find(message => message.kind === "assistant" && message.text === text));
  assert.ok(unlinked.every(Boolean)); assert.equal(new Set(unlinked.map(message => message.turnId)).size, 2);
  assert.equal(session.turnCount, 2);
  await api("/preferences", "PUT", { language: "zh-CN", appearance: { mode: "light", preset: "blue" } });
  await browser(["open", sessionUrl, "--headed", "--browser=chrome"]);
  await step("中文客户端筛选、键盘选择与两轮简易对话", `
    await page.setViewportSize({width:1440,height:1000}); page.doubaoErrors=[]; page.on('pageerror',error=>page.doubaoErrors.push(error.message));
    await page.locator('.session-list-item').first().waitFor();
    const client=page.getByRole('combobox',{name:${quote(t("sessions.filter.client"))},exact:true}); await client.click();
    await page.getByRole('option',{name:${quote(t("common.client.doubaoWork"))},exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.session-list-item').length===1);
    await client.focus(); await client.press('ArrowDown'); await page.getByRole('option',{name:${quote(t("common.client.doubaoWork"))},exact:true}).press('Enter');
    await page.locator('.session-list-item').click(); ${idle}
    expect(await page.locator('.sessions-main-heading h1').innerText()===${quote(fixture.title)},'会话标题不符');
    expect(await page.locator('.session-message.kind-thinking,.session-message.kind-context').count()===0,'对话模式混入过程');
    expect((await page.locator('.session-message-scroll').innerText()).includes(${quote(fixture.needle)}),'用户正文缺失');
    ${screenshot("sessions-zh-wide.png")}
  `);
  await step("会话级项目与独立上下文快照启用用量页，缺少调用仍保持未知", `
    expect((await page.locator('.sessions-main-heading').innerText()).includes('synthetic-project'),'会话级工作目录未显示');
    const tabs=page.getByRole('tablist',{name:${quote(t("sessions.profile.categories"))}});
    expect(await tabs.getByRole('tab',{name:${quote(t("sessions.profile.calls"))},exact:true}).count()===0,'未知工具被补造为调用');
    await page.getByRole('tab',{name:${quote(t("sessions.profile.usage"))},exact:true}).click();
    const context=page.getByRole('region',{name:${quote(t("sessions.contextWindow.title"))},exact:true});
    await context.waitFor(); expect((await context.innerText()).includes('65'),'上下文占用未显示');
    expect(await page.getByRole('heading',{name:${quote(t("sessions.trace.usageRequest"))},exact:true}).count()===0,'快照误显示零请求');
    await context.getByRole('button',{name:${quote(t("sessions.contextWindow.help"))},exact:true}).click();
    await page.getByText(${quote(t("sessions.contextWindow.helpText"))},{exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('tab',{name:${quote(t("sessions.profile.overview"))},exact:true}).click();
  `);
  await step("两条未知轮次回复在三种阅读模式独立可达，导航只保留真实两轮", `
    const unlinked=${quote(unlinked)};
    for(const mode of ${quote([t("sessions.mode.brief"), t("sessions.mode.full"), t("sessions.mode.trace")])}) {
      await page.getByRole('group',{name:${quote(t("sessions.reading.mode"))},exact:true}).getByRole('button',{name:mode,exact:true}).click(); ${idle}
      const trace=mode===${quote(t("sessions.mode.trace"))};
      if(trace) {
        await page.getByRole('table',{name:${quote(t("sessions.trace.table"))},exact:true}).waitFor();
        await page.locator('.trace-ledger-scroll').evaluate(element=>element.scrollTop=element.scrollHeight);
      }
      for(const message of unlinked) {
        const group=page.locator('[id='+JSON.stringify('session-turn-'+message.turnId)+']'); await group.waitFor();
        const title=trace?group.locator('.trace-turn-toggle strong'):group.locator(':scope > summary > span').first();
        expect(await title.innerText()===${quote(t("sessions.turn.unrecorded"))},'未知组被标成初始上下文或编号轮次');
        if(trace) await page.locator('.trace-row').filter({hasText:message.text}).waitFor();
        else {
          if(await group.getAttribute('open')===null) await group.locator(':scope > summary').click();
          await group.locator('.session-message.kind-assistant').filter({hasText:message.text}).waitFor();
        }
      }
      await page.getByRole('button',{name:${quote(t("sessions.turn.byQuestion"))},exact:true}).click();
      const questions=page.getByRole('dialog',{name:${quote(t("sessions.turn.byQuestion"))},exact:true});
      await questions.locator('.session-question-row').first().waitFor();
      expect(await questions.locator('.session-question-row').count()===2,'未知展示组变成了假用户轮次');
      expect(!(await questions.innerText()).includes(${quote(t("sessions.turn.unrecorded"))}),'未知组进入了用户问题目录');
      await page.keyboard.press('Escape');
    }
    await page.getByRole('group',{name:${quote(t("sessions.reading.mode"))},exact:true}).getByRole('button',{name:${quote(t("sessions.mode.brief"))},exact:true}).click(); ${idle}
    ${screenshot("sessions-unlinked-brief.png")}
  `);
  await step("未知组实际复制互不串组，保留未确认回复语义", `
    await page.context().grantPermissions(['clipboard-read','clipboard-write']);
    page.doubaoTraceCopyHitTests=[];
    for(const mode of ${quote([t("sessions.mode.brief"), t("sessions.mode.full"), t("sessions.mode.trace")])}) {
      await page.getByRole('group',{name:${quote(t("sessions.reading.mode"))},exact:true}).getByRole('button',{name:mode,exact:true}).click(); ${idle}
      if(mode===${quote(t("sessions.mode.trace"))}) await page.locator('.trace-ledger-scroll').evaluate(element=>element.scrollTop=element.scrollHeight);
      for(const message of ${quote(unlinked)}) {
        const group=page.locator('[id='+JSON.stringify('session-turn-'+message.turnId)+']'); await group.waitFor();
        await page.evaluate(()=>navigator.clipboard.writeText('synthetic-copy-not-completed'));
        const copy=group.getByRole('button',{name:${quote(t("sessions.copy.turn"))},exact:true});
        if(mode===${quote(t("sessions.mode.trace"))}) {
          // 覆盖式滚动条不能遮挡复制按钮；不修改 DOM 或使用强制点击。
          const pointerCheck=await copy.evaluate(element=>{
            const bounds=element.getBoundingClientRect(),hit=document.elementFromPoint(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
            const viewport=element.closest('.trace-ledger-scroll');
            return {group:element.closest('.trace-group').id,bounds:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height},
              centerHitsButton:element===hit||element.contains(hit),hitTag:hit?.tagName,hitClass:hit?.className,
              viewport:{clientWidth:viewport.clientWidth,offsetWidth:viewport.offsetWidth,scrollWidth:viewport.scrollWidth}};
          });
          page.doubaoTraceCopyHitTests.push(pointerCheck);
          expect(pointerCheck.centerHitsButton,'执行轨迹复制按钮的鼠标中心被遮挡');
        }
        await copy.click();
        await group.locator('[role="status"]').filter({hasText:${quote(t("sessions.copy.done"))}}).waitFor();
        await page.waitForFunction(async expected=>(await navigator.clipboard.readText()).includes(expected),message.text);
        const copied=await page.evaluate(()=>navigator.clipboard.readText());
        expect(copied.includes(message.text),'未知组复制丢失本组回复');
        expect(!${quote(fixture.unlinkedReplies)}.some(text=>text!==message.text&&copied.includes(text)),'未知组复制串入另一个未知回复');
        expect(!copied.includes(${quote(fixture.needle)})&&!copied.includes('合成回复：已保留本机证据。')&&!copied.includes('说明可确认的来源边界'),'未知组复制串入已知用户轮次');
        expect(copied.includes('未确认'),'未知组复制丢失未确认语义');
      }
    }
    ${screenshot("sessions-unlinked-trace-copied.png")}
    await page.getByRole('group',{name:${quote(t("sessions.reading.mode"))},exact:true}).getByRole('button',{name:${quote(t("sessions.mode.brief"))},exact:true}).click(); ${idle}
  `);
  const pointerState=await browser(["run-code", "async page => page.doubaoTraceCopyHitTests"]);
  await writeFile(join(artifacts, "trace-copy-pointer-state.txt"),pointerState);
  const pointerChecks=JSON.parse(pointerState.match(/### Result\s*\n([\s\S]*?)\n### Ran/)?.[1]??"[]");
  assert.equal(pointerChecks.length,2);
  await step("未知展示组不扩充真实用户轮次跳转范围", `
    await page.locator('.session-turn-position').click();
    const navigation=page.getByRole('dialog',{name:${quote(t("sessions.turn.navigation"))},exact:true}); await navigation.waitFor();
    expect(await navigation.getByRole('spinbutton').getAttribute('max')==='2','未知回复扩充了跳转轮次上限');
    await navigation.getByRole('button',{name:${quote(t("sessions.turn.last"))},exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.session-turn-position')?.dataset.turn==='2');
    await page.locator('.session-turn-position').click();
    await page.getByRole('dialog',{name:${quote(t("sessions.turn.navigation"))},exact:true}).getByRole('button',{name:${quote(t("sessions.turn.first"))},exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.session-turn-position')?.dataset.turn==='1');
  `);
  await step("全部记录和执行轨迹保留过程及未知文件卡片", `
    await page.getByRole('group',{name:${quote(t("sessions.reading.mode"))},exact:true}).getByRole('button',{name:${quote(t("sessions.mode.full"))},exact:true}).click(); ${idle}
    await page.locator('.session-message.kind-thinking').first().waitFor();
    await page.locator('.session-message.kind-thinking .session-message-detail > summary').first().click();
    for(const summary of await page.locator('.session-message.kind-context .session-message-detail > summary').all()) await summary.click();
    await page.locator('.session-message.kind-thinking pre').filter({hasText:${quote(fixture.thinking)}}).waitFor();
    await page.locator('.session-message.kind-context pre').filter({hasText:'File does not exist'}).waitFor();
    expect((await page.locator('.session-message-scroll').innerText()).includes(${quote(fixture.thinking)}),'过程正文丢失');
    expect((await page.locator('.session-message-scroll').innerText()).includes('File does not exist'),'失败卡片原文丢失');
    await page.getByRole('group',{name:${quote(t("sessions.reading.mode"))},exact:true}).getByRole('button',{name:${quote(t("sessions.mode.trace"))},exact:true}).click();
    await page.getByRole('table',{name:${quote(t("sessions.trace.table"))},exact:true}).waitFor(); ${idle}
    expect(await page.locator('.trace-ledger').count()>0,'执行轨迹未渲染');
    ${screenshot("sessions-zh-trace.png")}
  `);
  await step("全局正文搜索定位与对话导出", `
    await page.getByLabel(${quote(t("sessions.search.globalLabel"))},{exact:true}).fill(${quote(fixture.needle)});
    const hits=page.getByRole('region',{name:${quote(t("sessions.search.globalHits"))},exact:true}); await hits.locator('.session-hit').first().waitFor();
    await hits.locator('.session-hit').first().click(); ${idle}
    expect((await page.locator('.sessions-main-heading h1').innerText())===${quote(fixture.title)},'搜索未定位会话');
    const pending=page.waitForEvent('download'); await page.getByRole('button',{name:${quote(t("sessions.export.branch"))},exact:true}).click();
    const download=await pending; await download.saveAs(${quote(join(artifacts, "conversation.md"))});
  `);
  const exported = await readFile(join(artifacts, "conversation.md"), "utf8");
  assert.ok(exported.includes(fixture.needle) && exported.includes("合成回复") && exported.includes("未确认")); assert.ok(!exported.includes(fixture.thinking));
  for (const reply of fixture.unlinkedReplies) assert.ok(exported.includes(reply), "整段对话下载不能丢失独立未知回复");
  await step("普通与托管资源位置、未知使用范围和只读保护", `
    await page.goto(${quote(`${base}/#resources?kind=skill&tab=usage&window=all`)}); ${resourcesReady}
    await page.locator('.resource-more-filters summary').click();
    await page.getByRole('combobox',{name:${quote(t("resources.workspace.usageClient"))},exact:true}).click();
    expect(await page.getByRole('option',{name:${quote(t("common.client.doubaoWork"))},exact:true}).count()===0,'配置盘点被当作历史资源使用');
    await page.keyboard.press('Escape'); ${resourcesReady}
    await page.getByRole('button',{name:'查看doubao-managed-guide的使用详情',exact:true}).click();
    await page.locator('.resource-detail-tabs').getByRole('button',{name:${quote(t("resources.workspace.fileLocations"))},exact:true}).click(); ${resourcesReady}
    const managed=page.locator('.resource-management-body').filter({has:page.getByText(${quote(fixture.managedSkill)},{exact:true})}); await managed.waitFor();
    expect(await managed.locator('button[data-resource-action]').count()===0,'托管资源开放了写操作');
    expect((await managed.innerText()).includes(${quote(t("resources.management.managedReadOnly"))}),'托管保护原因缺失');
    ${screenshot("resources-managed.png")}
    await page.getByRole('button',{name:'查看doubao-shared-guide的使用详情',exact:true}).click(); ${resourcesReady}
    const ordinary=page.locator('.resource-management-body').filter({has:page.getByText(${quote(fixture.sharedSkill)},{exact:true})}); await ordinary.waitFor();
    expect(await ordinary.getByRole('button',{name:${quote(translate("zh-CN", "resources.management.trashFile", { path: fixture.sharedSkill }))},exact:true}).count()===1,'普通资源没有回收入口');
  `);
  await step("合成普通资源实际回收与恢复", `
    await page.getByRole('button',{name:${quote(translate("zh-CN", "resources.management.trashFile", { path: fixture.sharedSkill }))},exact:true}).click();
    const preview=page.locator('.resource-preview-panel'); await preview.getByRole('button',{name:${quote(t("resources.workspace.trashLocation"))},exact:true}).click();
    await preview.getByRole('button',{name:${quote(t("resources.done"))},exact:true}).waitFor();
    await preview.getByRole('button',{name:'预览还原文件',exact:true}).click();
    await preview.getByRole('button',{name:'还原文件',exact:true}).click();
    await preview.getByRole('button',{name:${quote(t("resources.done"))},exact:true}).waitFor();
    ${screenshot("resource-restored.png")}
    await preview.getByRole('button',{name:${quote(t("resources.done"))},exact:true}).click(); ${resourcesReady}
  `);
  assert.ok((await readFile(join(fixture.sharedSkill, "SKILL.md"), "utf8")).includes("人工合成"));
  await api("/preferences", "PUT", { language: "en", appearance: { mode: "dark", preset: "blue" } });
  await step("英文客户端选择与深色主题保持原始标题", `
    await page.goto(${quote(sessionUrl)}); await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.getByRole('combobox',{name:${quote(t("sessions.filter.client", "en"))},exact:true}).waitFor();
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
    const client=page.getByRole('combobox',{name:${quote(t("sessions.filter.client", "en"))},exact:true}); await client.click();
    await page.getByRole('option',{name:'Doubao Work',exact:true}).click(); ${idle}
    expect((await page.locator('.sessions-main-heading h1').innerText())===${quote(fixture.title)},'英文切换修改原始标题');
    for(const label of ${quote([t("sessions.mode.brief", "en"), t("sessions.mode.full", "en"), t("sessions.mode.trace", "en")])}) {
      await page.getByRole('group',{name:${quote(t("sessions.reading.mode", "en"))},exact:true}).getByRole('button',{name:label,exact:true}).click(); ${idle}
    }
    await page.getByRole('tab',{name:${quote(t("sessions.profile.usage", "en"))},exact:true}).click();
    const context=page.getByRole('region',{name:${quote(t("sessions.contextWindow.title", "en"))},exact:true}); await context.waitFor();
    expect((await context.innerText()).includes(${quote(t("sessions.contextWindow.latest", "en"))}),'英文上下文标签缺失');
    ${screenshot("sessions-en-dark.png")}
  `);
  await step("英文窄屏资源详情与筛选可达", `
    await page.goto(${quote(`${base}/#resources?kind=skill&tab=usage&window=all`)}); ${resourcesReady}
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'View usage details for doubao-managed-guide',exact:true}).click();
    const details=page.getByRole('dialog',{name:'Resource details',exact:true}); await details.waitFor();
    await details.getByRole('button',{name:'File locations',exact:true}).click(); ${resourcesReady}
    expect((await details.innerText()).includes('client-managed'),'英文保护提示缺失');
    expect((await details.boundingBox()).width<=391,'窄屏详情溢出'); ${screenshot("resources-en-phone.png")}
    await page.keyboard.press('Escape'); await details.waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Open resource filters',exact:true}).click();
    const filters=page.getByRole('dialog',{name:'Resource filters',exact:true}); await filters.waitFor();
    await filters.getByRole('combobox',{name:'Local presence',exact:true}).click(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await page.keyboard.press('Escape'); await filters.waitFor({state:'hidden'});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'窄屏横向溢出');
    expect(page.doubaoErrors.length===0,'浏览器异常：'+page.doubaoErrors.join(';'));
  `);
  currentStep="执行轨迹复制按钮的基线鼠标可达性";
  assert.ok(pointerChecks.every(check=>check.centerHitsButton),"执行轨迹复制按钮的原始中心被滚动区遮挡");
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ passed: true, checks, traceCopyPointerChecks:pointerChecks, elapsedMs: Date.now() - started,
    fixtureOnly: true, realHistoryRead: false, realResourceWrites: false }, null, 2) + "\n");
  await Promise.all(["failure.png", "failure-state.txt"].map(name => rm(join(artifacts, name), { force: true })));
  console.log(`PASS 豆包工作正式产物 Chrome ${checks.length} 项`);
} catch (error) {
  await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]).catch(() => {});
  const state = await browser(["run-code", "async page => ({url:page.url(),text:(await page.locator('body').innerText()).slice(0,18000)})"]).catch(() => "");
  await writeFile(join(artifacts, "failure-state.txt"), state);
  await writeFile(join(artifacts, "trace-copy-pointer-state.txt"), await browser(["run-code", "async page => page.doubaoTraceCopyHitTests ?? []"]).catch(() => ""));
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ passed: false, checks, step: currentStep, error: error.message, elapsedMs: Date.now() - started }, null, 2) + "\n");
  throw error;
} finally {
  await browser(["close"]).catch(() => {}); await service?.close().catch(() => {}); await rm(directory, { recursive: true, force: true });
}
