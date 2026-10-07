import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { parse as parseToml } from "smol-toml";
import { clientIds } from "../dist/clients.js";
import { startService } from "../dist/server.js";
import { resourceMapFixture } from "./resource-map-fixture.mjs";

// 历史及资源均隔离，管理操作只作用于人工夹具。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-map-e2e-")));
const artifacts = fileURLToPath(new URL("../.local/resource-map-e2e/", import.meta.url));
const session = `resourcemap${process.pid}`;
const checks = [];
const started = Date.now();
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
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? String(response.status));
  return result;
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
const select = (label, option) => `await page.getByRole('combobox',{name:${JSON.stringify(label)},exact:true}).click(); await page.getByRole('option',{name:${JSON.stringify(option)},exact:true}).click();`;
const locateResource = name => `await page.getByRole('button',{name:'定位资源',exact:true}).click(); await page.getByRole('combobox',{name:'定位资源搜索',exact:true}).fill(${JSON.stringify(name)}); await page.getByRole('option',{name:${JSON.stringify(name)},exact:true}).click();`;
const screenshot = name => `await page.screenshot({path:${JSON.stringify(join(artifacts, name))}});`;

try {
  await mkdir(artifacts, { recursive: true });
  const fixture = await resourceMapFixture(directory);
  service = await startService({ home: fixture.home,
    roots: { ...Object.fromEntries(clientIds.map(id => [id, []])), codex: fixture.history, claude: fixture.claudeHistory },
    resourceInventory: { userHome: fixture.userHome }, startupRefresh: true,
    staticRoot: fileURLToPath(new URL("../dist/web", import.meta.url)),
  });
  base = `http://127.0.0.1:${service.instance.port}`;
  let ready = false;
  for (let attempt = 0; attempt < 500; attempt++) {
    const status = await api("/sessions/status");
    if (status.job?.status === "failed") throw new Error(status.job.error);
    if (status.version) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(ready, "地图人工历史未完成索引");
  await api("/resources/status");
  const management = new Database(join(fixture.home, "resources.sqlite"));
  try {
    const update = management.prepare("UPDATE resource_seen SET first_seen=? WHERE id=?");
    for (const kind of ["skill", "mcp"]) {
      const local = await api(`/resources/local?kind=${kind}&q=map-zero&pageSize=100`);
      for (const row of local.rows) for (const entry of row.entries) update.run("2025-01-01T00:00:00Z", entry.id);
    }
  } finally { management.close(); }
  // 清单发布时间改变，避免复用修改人工观测时间之前的缓存。
  await api("/resources/refresh", "POST");
  const maps = {};
  for (const kind of ["skill", "mcp"]) {
    const map = await api(`/resources/map?kind=${kind}&q=map-&page=99&pageSize=1`);
    assert.equal(map.complete, true);
    assert.ok(map.positive.length > 200, "地图受列表分页限制");
    assert.ok(map.review.length >= 45);
    assert.ok(map.zero.length >= 45);
    assert.equal(map.total, map.positive.length + map.zero.length + map.review.length);
    assert.equal(map.totalValue, map.positive.reduce((sum, row) => sum + row.value, 0));
    const prefix = kind === "skill" ? "map-skill-" : "map-mcp-";
    const high = map.positive.find(row => row.name === `${prefix}000`);
    const low = map.positive.find(row => row.name === `${prefix}001`);
    assert.equal(high.value / low.value, 10);
    assert.ok(Math.abs(high.share / low.share - 10) < 1e-9);
    const capped = await api(`/resources/map?kind=${kind}&q=map-&maxValue=1`);
    assert.ok(capped.positive.every(row => row.value <= 1));
    assert.equal(capped.review.length, map.review.length);
    assert.equal(capped.zero.length, map.zero.length);
    assert.equal(capped.version, map.version);
    maps[kind] = map;
  }
  const reads = await api("/resources/map?kind=skill&q=map-&metric=reads");
  const readOnly = reads.positive.find(row => row.name === "map-read-000");
  assert.equal(readOnly.value, 1);
  assert.equal(maps.skill.zero.find(row => row.id === readOnly.id)?.metrics.reads, 1);
  assert.equal(maps.skill.positive.find(row => row.name === "map-skill-001")?.lastUsedAt,
    reads.positive.find(row => row.name === "map-skill-001")?.lastUsedAt);
  const claude = await api("/resources/map?kind=skill&q=map-skill-001&client=claude&metric=sessions");
  assert.equal(claude.positive[0].value, 1);
  const combined = await api("/resources/map?kind=skill&q=map-skill-001&metric=sessions");
  assert.equal(combined.positive[0].value, 2);
  const skillSessionMap = await api("/resources/map?kind=skill&q=map-&metric=sessions");
  assert.equal(skillSessionMap.positive.find(row => row.name === "map-skill-000")?.value, 1);
  assert.equal(skillSessionMap.positive.find(row => row.name === "map-read-000")?.value, 1);
  const configBefore = await readFile(fixture.configPath, "utf8");
  const claudeConfigBefore = await readFile(fixture.claudeConfigPath, "utf8");
  assert.ok(!JSON.stringify(maps).includes("synthetic-secret-keep-private"));
  assert.ok(!JSON.stringify(maps).includes("synthetic-map-secret"));
  await api("/preferences", "PUT", { language: "zh-CN" });
  await browser(["open", `${base}/#resources`, "--headed", "--browser=chrome"]);

  await step("首次列表、地图按需查询与完整范围", `
    page.mapErrors=[]; page.mapRequests=[];
    page.on('pageerror',error=>page.mapErrors.push(error.message));
    page.on('request',request=>{if(request.url().includes('/api/v1/resources/map'))page.mapRequests.push(request.url())});
    await page.setViewportSize({width:1560,height:980});
    await page.getByRole('table',{name:'Skill 总览',exact:true}).waitFor();
    expect(page.mapRequests.length===0,'列表提前读取地图');
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-');
    await page.getByRole('group',{name:'资源展示方式',exact:true}).getByRole('button',{name:'地图',exact:true}).click();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    await page.getByRole('button',{name:'查看map-skill-000的使用详情',exact:true}).waitFor();
    expect(page.mapRequests.length>0,'地图没有完整查询');
    expect(page.mapRequests.every(url=>!url.includes('pageSize=')&&!url.includes('&page=')),'地图沿用列表分页');
    expect(await page.getByRole('combobox',{name:'地图面积指标',exact:true}).count()===0,'主界面仍区分调用与读取指标');
    expect(page.mapRequests.every(url=>/[?&]metric=sessions(?:&|$)/.test(url)),'地图未统一使用会话数');
    const area=await page.locator('rect[data-resource-id]').evaluateAll((rects,ids)=>ids.map(id=>{const rect=rects.find(node=>node.getAttribute('data-resource-id')===id);return (Number(rect.getAttribute('width'))+1)*(Number(rect.getAttribute('height'))+1)}),${JSON.stringify([maps.skill.positive.find(row=>row.name==='map-skill-000').id,maps.skill.positive.find(row=>row.name==='map-skill-001').id])});
    expect(Math.abs(area[0]/area[1]-.5)<1e-7,'同会话重复调用未去重或跨会话读取未纳入面积');
    ${screenshot("skill-map-light.png")}
  `);
  await step("悬停与键盘展示使用会话，读取型资源直接进入地图", `
    const tile=page.getByRole('button',{name:'查看map-skill-001的使用详情',exact:true});
    await tile.hover();
    const tooltip=page.getByRole('tooltip'); await tooltip.waitFor();
    expect((await tooltip.innerText()).includes('map-skill-001')&&(await tooltip.innerText()).includes('使用会话数 · 2 个会话'),'悬停未显示完整名称及去重会话数');
    await tile.focus(); await tooltip.waitFor();
    expect((await tooltip.innerText()).includes('最近使用'),'键盘聚焦缺少最近使用');
    await page.getByRole('button',{name:'查看map-read-000的使用详情',exact:true}).focus();
    await tooltip.waitFor();
    expect((await tooltip.innerText()).includes('使用会话数 · 1 个会话'),'只读取的 Skill 没有使用会话');
  `);
  await step("旧调用与读取链接统一会话指标，旧次数上限不沿用", `
    for(const metric of ['calls','reads']) {
      await page.evaluate(metric=>location.hash='#resources?kind=skill&client=codex&view=map&q=map-read-000&sort='+metric+'&metric='+metric+'&maxValue=0',metric);
      await page.locator('.resource-map-locator > span').filter({hasText:/^1 个色块/}).waitFor();
      const route=await page.evaluate(()=>Object.fromEntries(new URLSearchParams(location.hash.split('?')[1])));
      expect(route.metric==='sessions'&&route.sort==='sessions'&&!('maxValue' in route),'旧链接未统一指标或误用次数上限');
      expect(route.client==='codex'&&route.q==='map-read-000','兼容旧链接丢失统计范围');
      expect(await page.locator('rect[data-resource-id]').count()===1,'读取型资源在统一地图为空');
      await page.getByRole('group',{name:'资源展示方式',exact:true}).getByRole('button',{name:'列表',exact:true}).click();
      const table=page.getByRole('table',{name:'Skill 总览',exact:true}); await table.waitFor();
      expect(await table.getByRole('columnheader').count()===5,'主列表没有简化');
      expect((await table.getByRole('row').nth(1).getByRole('cell').nth(1).innerText())==='1','读取型资源没有计入使用会话');
      const sorting=page.getByRole('combobox',{name:'资源排序',exact:true}); await sorting.click();
      expect(await page.getByRole('option',{name:'调用次数',exact:true}).count()===0&&await page.getByRole('option',{name:'读取次数',exact:true}).count()===0,'排序仍区分调用与读取');
      await page.keyboard.press('Escape');
    }
    await page.evaluate(()=>location.hash='#resources?kind=skill&view=map&q=map-&metric=sessions');
    await page.getByRole('button',{name:'查看map-skill-000的使用详情',exact:true}).waitFor();
  `);
  await step("微小资源可定位，选择保持完整统计范围", `
    const requests=page.mapRequests.length;
    ${locateResource("map-skill-214")}
    const detail=page.getByRole('complementary',{name:'资源详情',exact:true});
    await detail.getByRole('heading',{name:'map-skill-214',exact:true}).waitFor();
    await page.getByRole('button',{name:'查看map-skill-214的使用详情',exact:true}).waitFor();
    expect(page.mapRequests.length===requests,'定位改变地图查询范围');
    expect(/1\\s*显式调用/.test(await detail.locator('.resource-stats').innerText()),'微小资源数值错误');
    expect(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('q'))==='map-','定位替代了关键词筛选');
    await page.getByRole('button',{name:'适应资源地图窗口',exact:true}).click();
  `);
  await step("会话上限、未知保留与列表范围", `
    await page.getByRole('spinbutton',{name:'地图使用会话数上限',exact:true}).fill('1');
    await page.waitForFunction(()=>new URLSearchParams(location.hash.split('?')[1]).get('maxValue')==='1');
    await page.waitForFunction(()=>document.querySelectorAll('rect[data-resource-id]').length>200);
    expect(await page.getByRole('button',{name:'查看map-skill-001的使用详情',exact:true}).count()===0,'上限没有过滤多会话资源');
    expect((await page.locator('.resource-list-scroll').innerText()).includes('待检查'),'上限删除未知入口');
    await page.getByRole('group',{name:'资源展示方式',exact:true}).getByRole('button',{name:'列表',exact:true}).click();
    ${select("资源排序", "使用会话数")}
    await page.getByRole('table',{name:'Skill 总览',exact:true}).getByRole('button',{name:'查看map-skill-001的使用详情',exact:true}).waitFor();
    await page.getByRole('group',{name:'资源展示方式',exact:true}).getByRole('button',{name:'地图',exact:true}).click();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    expect(await page.getByRole('spinbutton',{name:'地图使用会话数上限',exact:true}).inputValue()==='1','地图返回丢失会话上限');
    await page.getByRole('spinbutton',{name:'地图使用会话数上限',exact:true}).fill('');
    await page.getByRole('button',{name:'查看map-skill-001的使用详情',exact:true}).waitFor();
  `);
  await step("零值与待检查独立分页，不重新查询地图", `
    const zero=page.locator('details').filter({has:page.locator('summary').filter({hasText:'未发现使用'})});
    const review=page.locator('details').filter({has:page.locator('summary').filter({hasText:'待检查'})});
    if(await zero.getAttribute('open')===null) await zero.locator('summary').click();
    if(await review.getAttribute('open')===null) await review.locator('summary').click();
    const before=page.mapRequests.length;
    const zeroPager=zero.getByRole('navigation',{name:'零值资源',exact:true});
    await zeroPager.getByRole('spinbutton',{name:'零值资源跳转页码',exact:true}).fill('2');
    await zeroPager.getByRole('button',{name:'零值资源跳转',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('nav[aria-label="零值资源"]')?.textContent.includes('21–40'));
    const reviewPager=review.getByRole('navigation',{name:'待检查资源',exact:true});
    await reviewPager.getByRole('button',{name:'待检查资源末页',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[aria-label="待检查资源末页"]')?.disabled);
    expect((await zeroPager.innerText()).includes('21–40'),'待检查翻页重置零区');
    expect(page.mapRequests.length===before,'零值分页重新查询整图');
    await zeroPager.getByRole('button',{name:'零值资源首页',exact:true}).click();
    const detail=page.getByRole('complementary',{name:'资源详情',exact:true});
    await zero.getByRole('button',{name:'查看map-zero-000的使用详情',exact:true}).click();
    await detail.getByRole('heading',{name:'map-zero-000',exact:true}).waitFor();
    expect(/0\\s*使用会话/.test(await detail.locator('.resource-stats').innerText()),'零使用详情错误');
    ${locateResource("map-read-000")}
    await detail.getByRole('heading',{name:'map-read-000',exact:true}).waitFor();
    const stats=await detail.locator('.resource-stats').innerText();
    expect(/0\\s*显式调用/.test(stats)&&/1\\s*成功读取/.test(stats),'零调用被认定未使用');
    expect((await detail.locator('.resource-tags').first().innerText()).includes('已使用'),'读取证据未保留已使用状态');
  `);
  await step("Agent 与时间筛选、直接链接和视图偏好", `
    ${select("资源Agent", "Claude Code")}
    await page.getByRole('button',{name:'查看map-skill-001的使用详情',exact:true}).waitFor();
    await page.getByRole('button',{name:'查看map-skill-001的使用详情',exact:true}).click();
    const detail=page.getByRole('complementary',{name:'资源详情',exact:true});
    await detail.getByRole('heading',{name:'map-skill-001',exact:true}).waitFor();
    expect(/1\\s*使用会话/.test(await detail.locator('.resource-stats').innerText()),'Agent筛选统计扩大');
    await page.reload(); await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    expect(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('metric'))==='sessions','刷新丢失统一指标');
    expect((await page.getByRole('combobox',{name:'资源Agent',exact:true}).innerText()).includes('Claude Code'),'刷新丢失Agent');
    ${select("资源Agent", "全部 Agent")}
    ${select("资源使用时间", "近 7 天")}
    await page.getByRole('button',{name:'查看map-skill-000的使用详情',exact:true}).waitFor();
    ${select("资源使用时间", "全部历史")}
    await page.evaluate(()=>location.hash='#resources');
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    expect(await page.getByRole('table',{name:'Skill 总览',exact:true}).count()===0,'新入口丢失地图偏好');
  `);
  await step("证据轨迹跳转返回保留地图、指标与范围", `
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-skill-001');
    await page.waitForFunction(()=>new URLSearchParams(location.hash.split('?')[1]).get('q')==='map-skill-001'&&!document.querySelector('.resource-list-scroll[aria-busy="true"]'));
    await page.locator('.resource-map-locator > span').filter({hasText:/^1 个色块/}).waitFor();
    const selectedDetail=page.getByRole('complementary',{name:'资源详情',exact:true});
    if(!await selectedDetail.getByRole('heading',{name:'map-skill-001',exact:true}).isVisible()) await page.getByRole('button',{name:'查看map-skill-001的使用详情',exact:true}).click();
    await selectedDetail.getByRole('heading',{name:'map-skill-001',exact:true}).waitFor();
    const evidence=page.locator('.resource-evidence a'); await evidence.first().waitFor();
    const stage=page.locator('[data-scale]');
    const initialScale=Number(await stage.getAttribute('data-scale'));
    await page.getByRole('button',{name:'放大资源地图',exact:true}).click();
    await page.waitForFunction(scale=>Number(document.querySelector('[data-scale]')?.dataset.scale)>scale,initialScale);
    const position=await stage.locator('svg').innerHTML();
    const scale=await stage.getAttribute('data-scale');
    const requests=page.mapRequests.length;
    const hash=await page.evaluate(()=>location.hash);
    await evidence.first().click(); await page.waitForURL(/#sessions/);
    expect(page.url().includes('mode=trace')&&page.url().includes('message='),'证据未定位轨迹');
    await page.goBack(); await page.waitForURL(/#resources/);
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    expect(await page.evaluate(()=>location.hash)===hash,'返回丢失地图路由状态');
    await page.waitForFunction(scale=>document.querySelector('[data-scale]')?.getAttribute('data-scale')===scale,scale);
    expect(await stage.getAttribute('data-scale')===scale,'返回丢失地图倍率');
    expect(await stage.locator('svg').innerHTML()===position,'返回丢失地图平移位置');
    expect(page.mapRequests.length===requests,'返回重复请求相同地图');
  `);
  await step("地图共享 Skill 直接管理具体入口与确认预览", `
    const detail=page.getByRole('complementary',{name:'资源详情',exact:true});
    const summary=detail.locator('summary').filter({hasText:/^管理具体入口$/});
    await summary.click();
    expect(await detail.getByRole('button',{name:'预览移到备用map-skill-001的Codex入口',exact:true}).count()===0,'共享物理本体仍可移走');
    await detail.getByRole('button',{name:'预览移到备用map-skill-001的Claude Code入口',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'移到备用预览',exact:true});
    await dialog.getByRole('button',{name:'确认移到备用',exact:true}).waitFor();
    expect((await dialog.innerText()).includes('Claude Code'),'预览没有明确所选入口');
    await dialog.getByRole('button',{name:'确认移到备用',exact:true}).click();
    await dialog.getByRole('button',{name:'完成',exact:true}).waitFor();
    expect((await dialog.getByRole('status').innerText()).includes('本地修改完成'),'备用未成功');
    expect((await dialog.innerText()).includes('待重新加载'),'未保留客户端生效边界');
    await dialog.getByRole('button',{name:'完成',exact:true}).click();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    await detail.getByRole('heading',{name:'map-skill-001',exact:true}).waitFor();
    expect(/2\\s*使用会话/.test(await detail.locator('.resource-stats').innerText()),'管理抹掉历史使用');
  `);
  await assert.rejects(readFile(fixture.sharedMapLink), { code: "ENOENT" });
  assert.ok((await readFile(join(fixture.userHome, ".codex", "skills", "map-skill-001", "SKILL.md"), "utf8")).includes("人工地图资源"));
  await step("共享入口恢复后返回地图保留历史", `
    await page.getByRole('navigation',{name:'资源视图',exact:true}).getByRole('button',{name:'备用',exact:true}).click();
    await page.getByRole('button',{name:'查看map-skill-001的恢复记录',exact:true}).click();
    await page.getByRole('button',{name:'预览恢复',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'恢复预览',exact:true});
    await dialog.getByRole('button',{name:'确认恢复',exact:true}).click();
    await dialog.getByRole('button',{name:'完成',exact:true}).waitFor();
    expect((await dialog.getByRole('status').innerText()).includes('本地修改完成'),'恢复未成功');
    await dialog.getByRole('button',{name:'完成',exact:true}).click();
    await page.getByRole('navigation',{name:'资源视图',exact:true}).getByRole('button',{name:'Skill 总览',exact:true}).click();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
  `);
  assert.equal(await realpath(fixture.sharedMapLink), await realpath(join(fixture.userHome, ".codex", "skills", "map-skill-001")));
  await step("MCP 同样使用会话地图及独立注册管理", `
    await page.getByRole('group',{name:'资源类型',exact:true}).getByRole('button',{name:'MCP',exact:true}).click();
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-');
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    expect(await page.getByRole('combobox',{name:'地图面积指标',exact:true}).count()===0,'MCP仍提供次数指标切换');
    expect(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('metric'))==='sessions','MCP未沿用使用会话数');
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-mcp-001');
    await page.getByRole('button',{name:'查看map-mcp-001的使用详情',exact:true}).click();
    const detail=page.getByRole('complementary',{name:'资源详情',exact:true});
    await detail.getByRole('heading',{name:'map-mcp-001',exact:true}).waitFor();
    const summaries=detail.locator('summary').filter({hasText:/^管理具体入口$/});
    expect(await summaries.count()===2,'不同MCP注册被当成同一对象');
    for(const summary of await summaries.all()) await summary.click();
    await detail.getByRole('button',{name:'预览停用map-mcp-001的Codex入口',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'停用预览',exact:true});
    await dialog.getByRole('button',{name:'确认停用',exact:true}).click();
    await dialog.getByRole('button',{name:'完成',exact:true}).waitFor();
    expect((await dialog.getByRole('status').innerText()).includes('本地修改完成'),'MCP停用失败');
    await dialog.getByRole('button',{name:'完成',exact:true}).click();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    await detail.getByRole('heading',{name:'map-mcp-001',exact:true}).waitFor();
    expect(/10\\s*工具调用/.test(await detail.locator('.resource-stats').innerText()),'停用改变历史调用');
  `);
  assert.equal(parseToml(await readFile(fixture.configPath, "utf8")).mcp_servers["map-mcp-001"].enabled, false);
  assert.equal(await readFile(fixture.claudeConfigPath, "utf8"), claudeConfigBefore, "所选注册操作误改其他 Agent");
  assert.deepEqual(parseToml(await readFile(fixture.configPath, "utf8")).mcp_servers.sample, parseToml(configBefore).mcp_servers.sample);
  await step("MCP 恢复保持原始配置与地图证据", `
    await page.getByRole('navigation',{name:'资源视图',exact:true}).getByRole('button',{name:'已停用',exact:true}).click();
    await page.getByRole('button',{name:'查看map-mcp-001的恢复记录',exact:true}).click();
    await page.getByRole('button',{name:'预览恢复',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'恢复预览',exact:true});
    await dialog.getByRole('button',{name:'确认恢复',exact:true}).click();
    await dialog.getByRole('button',{name:'完成',exact:true}).waitFor();
    expect((await dialog.getByRole('status').innerText()).includes('本地修改完成'),'MCP恢复失败');
    await dialog.getByRole('button',{name:'完成',exact:true}).click();
    await page.getByRole('navigation',{name:'资源视图',exact:true}).getByRole('button',{name:'MCP 总览',exact:true}).click();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-history-only');
    await page.getByRole('button',{name:'查看map-history-only的使用详情',exact:true}).click();
    const detail=page.getByRole('complementary',{name:'资源详情',exact:true});
    await detail.getByRole('heading',{name:'map-history-only',exact:true}).waitFor();
    expect(await detail.getByRole('button',{name:/^预览/}).count()===0,'仅历史资源有写操作');
    expect((await detail.innerText()).includes('仅历史'),'历史资源状态不可见');
  `);
  await step("滚轮、拖动、字体与全屏定位，Escape恢复焦点", `
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-mcp-');
    await page.locator('.resource-map-locator > span').filter({hasText:/^${fixture.count} 个色块$/}).waitFor();
    ${locateResource("map-mcp-000")}
    await page.getByRole('button',{name:'查看map-mcp-000的使用详情',exact:true}).waitFor();
    const stage=page.locator('[data-scale]'); await stage.waitFor();
    const tile=page.getByRole('button',{name:'查看map-mcp-000的使用详情',exact:true});
    const font=await tile.evaluate(element=>getComputedStyle(element).fontSize);
    const first=Number(await stage.getAttribute('data-scale'));
    await page.getByRole('button',{name:'放大资源地图',exact:true}).click();
    await page.waitForFunction(scale=>Number(document.querySelector('[data-scale]')?.dataset.scale)>scale,first);
    expect(await tile.evaluate(element=>getComputedStyle(element).fontSize)===font,'文字字号随倍率放大');
    const box=await stage.boundingBox();
    const second=Number(await stage.getAttribute('data-scale'));
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.wheel(0,-150);
    await page.waitForFunction(scale=>Number(document.querySelector('[data-scale]')?.dataset.scale)>scale,second);
    const before=await stage.locator('svg').innerHTML();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down();
    await page.mouse.move(box.x+box.width/2+50,box.y+box.height/2+30,{steps:5}); await page.mouse.up();
    await page.waitForFunction(html=>document.querySelector('[data-scale] svg')?.innerHTML!==html,before);
    await page.getByRole('button',{name:'适应资源地图窗口',exact:true}).click();
    await page.bringToFront();
    await page.getByRole('button',{name:'全屏查看资源地图',exact:true}).click();
    await page.waitForFunction(()=>Boolean(document.fullscreenElement));
    const locate=page.getByRole('button',{name:'定位资源',exact:true});
    await locate.click();
    await page.getByRole('combobox',{name:'定位资源搜索',exact:true}).fill('no-such-resource');
    await page.getByText('没有匹配结果',{exact:true}).waitFor();
    await page.getByRole('combobox',{name:'定位资源搜索',exact:true}).fill('map-mcp-214');
    await page.getByRole('option',{name:'map-mcp-214',exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='定位资源');
    expect(await locate.evaluate(element=>element===document.activeElement),'全屏菜单未恢复焦点');
    expect(await page.evaluate(()=>Boolean(document.fullscreenElement)),'菜单Escape同时退出全屏');
    ${screenshot("map-fullscreen.png")}
    ${locateResource("map-mcp-214")}
    await page.waitForFunction(()=>!document.fullscreenElement);
    await page.getByRole('complementary',{name:'资源详情',exact:true}).getByRole('heading',{name:'map-mcp-214',exact:true}).waitFor();
    await page.bringToFront();
    await page.getByRole('button',{name:'全屏查看资源地图',exact:true}).click();
    await page.waitForFunction(()=>Boolean(document.fullscreenElement));
    await page.getByRole('button',{name:'退出资源地图全屏',exact:true}).click();
    await page.waitForFunction(()=>!document.fullscreenElement);
    await page.getByRole('button',{name:'适应资源地图窗口',exact:true}).click();
  `);
  await step("缺失时间、系统保护、空结果与失败重试", `
    await page.getByRole('group',{name:'资源类型',exact:true}).getByRole('button',{name:'Skill',exact:true}).click();
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-undated');
    await page.getByRole('button',{name:'查看map-undated的使用详情',exact:true}).focus();
    await page.getByRole('tooltip').waitFor();
    const tooltip=await page.getByRole('tooltip').innerText();
    expect(tooltip.includes('时间未记录')&&tooltip.includes('部分记录'),'缺失时间或部分记录不可见');
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-system');
    const review=page.locator('details').filter({has:page.locator('summary').filter({hasText:'待检查'})});
    await review.locator('summary').filter({hasText:/待检查\\s*1$/}).waitFor();
    if(await review.getAttribute('open')===null) await review.locator('summary').click();
    await page.getByRole('button',{name:'查看map-system的使用详情',exact:true}).click();
    const detail=page.getByRole('complementary',{name:'资源详情',exact:true});
    await detail.getByRole('heading',{name:'map-system',exact:true}).waitFor();
    await detail.locator('summary').filter({hasText:/^管理具体入口$/}).click();
    expect(await detail.getByRole('button',{name:/^预览/}).count()===0,'系统资源有写操作');
    expect((await detail.innerText()).includes('受保护'),'系统保护不可见');
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('no-such-map-resource');
    await page.getByText('0 个 Skill',{exact:true}).waitFor();
    await page.waitForFunction(()=>!document.querySelector('.resource-list-scroll[aria-busy="true"]'));
    expect(await page.getByRole('button',{name:'查看map-system的使用详情',exact:true}).count()===0,'空结果保留旧节点');
    let failed=false;
    await page.route('**/api/v1/resources/map?**',async route=>{if(!failed){failed=true;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_FAILURE',message:'人工地图查询失败'}})})}else await route.continue()});
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-skill-');
    await page.getByRole('alert').filter({hasText:'人工地图查询失败'}).waitFor();
    expect(await page.getByRole('group',{name:'资源使用地图',exact:true}).count()===0,'失败后仍展示旧地图');
    await page.getByRole('button',{name:'重试',exact:true}).click();
    await page.locator('.resource-map-locator > span').filter({hasText:/^${fixture.count} 个色块$/}).waitFor();
    ${locateResource("map-skill-000")}
    await page.getByRole('button',{name:'查看map-skill-000的使用详情',exact:true}).waitFor();
    await page.unroute('**/api/v1/resources/map?**');
  `);
  await step("深浅主题、375px滚动与窄屏详情", `
    await page.getByRole('button',{name:'切换主题',exact:true}).click();
    expect(await page.evaluate(()=>document.documentElement.dataset.theme)==='dark','深色主题没有生效');
    ${screenshot("skill-map-dark.png")}
    await page.getByRole('button',{name:'切换主题',exact:true}).click();
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-');
    await page.setViewportSize({width:375,height:812});
    const previousDetail=page.getByRole('dialog',{name:'资源详情',exact:true});
    await previousDetail.waitFor();
    await page.keyboard.press('Escape'); await previousDetail.waitFor({state:'hidden'});
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    await page.locator('.resource-map-locator > span').filter({hasText:/^${skillSessionMap.positive.length} 个色块$/}).waitFor();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.documentElement.scrollHeight<=innerHeight+1),'窄屏页面溢出');
    ${locateResource("map-skill-214")}
    const dialog=page.getByRole('dialog',{name:'资源详情',exact:true});
    await dialog.getByRole('heading',{name:'map-skill-214',exact:true}).waitFor();
    const box=await dialog.boundingBox(); expect(box.x>=0&&box.x+box.width<=375,'窄屏详情溢出');
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
    ${screenshot("skill-map-phone.png")}
    expect(page.mapErrors.length===0,'浏览器异常：'+page.mapErrors.join(';'));
  `);
  await step("地图名称收藏保护与回收恢复保留真实活动", `
    await page.setViewportSize({width:1560,height:980});
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-skill-002');
    await page.getByRole('button',{name:'查看map-skill-002的使用详情',exact:true}).click();
    const detail=page.getByRole('complementary',{name:'资源详情',exact:true});
    await detail.getByRole('heading',{name:'map-skill-002',exact:true}).waitFor();
    await detail.getByRole('button',{name:'收藏map-skill-002',exact:true}).click();
    await detail.getByRole('button',{name:'取消收藏map-skill-002',exact:true}).waitFor();
    const manage=detail.locator('details').filter({has:page.locator('summary').filter({hasText:/^管理具体入口$/})});
    if(await manage.getAttribute('open')===null) await manage.locator('summary').click();
    await detail.locator('.resource-tags').first().getByText('受保护',{exact:true}).waitFor();
    await manage.getByRole('button',{name:'预览移入回收区map-skill-002的Codex入口',exact:true}).click();
    const protectedPreview=page.getByRole('dialog',{name:'移入回收区预览',exact:true});
    await protectedPreview.getByRole('alert').filter({hasText:'此资源已收藏'}).waitFor();
    await protectedPreview.locator('.resource-preview-heading').getByText('受保护',{exact:true}).waitFor();
    await protectedPreview.getByRole('button',{name:'关闭移入回收区预览',exact:true}).click();
    await detail.getByRole('button',{name:'取消收藏map-skill-002',exact:true}).click();
    await detail.getByRole('button',{name:'收藏map-skill-002',exact:true}).waitFor();
    if(await manage.getAttribute('open')===null) await manage.locator('summary').click();
    await manage.getByRole('button',{name:'预览移入回收区map-skill-002的Codex入口',exact:true}).click();
    const preview=page.getByRole('dialog',{name:'移入回收区预览',exact:true});
    await preview.getByRole('button',{name:'确认移入回收区',exact:true}).click();
    await preview.getByRole('button',{name:'完成',exact:true}).waitFor();
    await preview.getByRole('button',{name:'完成',exact:true}).click();
    await detail.getByRole('heading',{name:'map-skill-002',exact:true}).waitFor();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    expect(/1\\s*显式调用/.test(await detail.locator('.resource-stats').innerText()),'回收抹掉真实历史');
    await page.getByRole('navigation',{name:'资源视图',exact:true}).getByRole('button',{name:'回收区',exact:true}).click();
    await page.getByRole('button',{name:'查看map-skill-002的恢复记录',exact:true}).click();
    await page.getByRole('button',{name:'预览恢复',exact:true}).click();
    const restore=page.getByRole('dialog',{name:'恢复预览',exact:true});
    await restore.getByRole('button',{name:'确认恢复',exact:true}).click();
    await restore.getByRole('button',{name:'完成',exact:true}).waitFor();
    await restore.getByRole('button',{name:'完成',exact:true}).click();
    await page.getByRole('navigation',{name:'资源视图',exact:true}).getByRole('button',{name:'Skill 总览',exact:true}).click();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    await page.getByRole('button',{name:'查看map-skill-002的使用详情',exact:true}).click();
    await detail.getByRole('heading',{name:'map-skill-002',exact:true}).waitFor();
    expect(/1\\s*显式调用/.test(await detail.locator('.resource-stats').innerText()),'恢复统计变化');
  `);
  assert.ok((await readFile(join(fixture.userHome,'.codex','skills','map-skill-002','SKILL.md'),'utf8')).includes('map-skill-002'));

  assert.equal(await readFile(fixture.configPath, "utf8"), configBefore);
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ passed: true, checks, elapsedMs: Date.now() - started }, null, 2));
  console.log(`PASS 资源地图 Chrome 端到端 ${checks.length} 项`);
} catch (error) {
  await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]).catch(() => {});
  const state = await browser(["run-code", "async page => ({url:page.url(),text:(await page.locator('body').innerText()).slice(0,20000)})"]).catch(() => "页面状态无法读取");
  await writeFile(join(artifacts, "failure-state.txt"), state);
  await writeFile(join(artifacts, "report.json"), JSON.stringify({ passed: false, checks, error: error.message, elapsedMs: Date.now() - started }, null, 2));
  throw error;
} finally {
  await browser(["close"]).catch(() => {});
  await service?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
