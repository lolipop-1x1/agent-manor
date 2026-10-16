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
    await page.waitForLoadState("networkidle");
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
const boundaryRendering = () => {
  const layer = document.querySelector(".resource-map-colors"), style = getComputedStyle(document.documentElement);
  const fills = [...layer.querySelectorAll('path[class^="tone-"]')], borders = [...layer.querySelectorAll(".map-boundary")];
  const rectangles = path => [...path.matchAll(/M([\d.eE+-]+),([\d.eE+-]+)h([\d.eE+-]+)v([\d.eE+-]+)h[\d.eE+-]+Z/g)].map(match => match.slice(1, 5).map(Number));
  const near = (a, b) => Math.abs(a - b) < .001;
  const matches = (fill, border) => near(fill[0], border[0] + .5) && near(fill[1], border[1] + .5) && near(fill[2], border[2] - 1) && near(fill[3], border[3] - 1);
  const allBorders = borders.flatMap(path => rectangles(path.getAttribute("d")));
  const lum = color => {
    const channels = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const contrast = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
  return {
    nodes: layer.children.length,
    tiles: fills.reduce((count, path) => count + rectangles(path.getAttribute("d")).length, 0),
    painted: borders.filter(path => path.getAttribute("d")).length,
    small: fills.flatMap(path => rectangles(path.getAttribute("d"))).filter(fill => (fill[2] <= 8 || fill[3] <= 8) && !allBorders.some(border => matches(fill, border))).length,
    styles: borders.every(path => {
      const computed = getComputedStyle(path), tone = path.dataset.tone;
      return computed.fill === "none" && computed.stroke !== "none" && computed.strokeWidth === "1px"
        && (tone === "missing" ? computed.strokeDasharray !== "none" : computed.strokeDasharray === "none"
          && contrast(style.getPropertyValue(`--map-${tone}`).trim(), style.getPropertyValue(`--map-${tone}-border`).trim()) >= 2);
    }),
    geometry: borders.every(path => {
      const fillsForTone = rectangles(layer.querySelector(`.tone-${path.dataset.tone}`).getAttribute("d"));
      return rectangles(path.getAttribute("d")).every(border => border[2] > 8 && border[3] > 8 && fillsForTone.some(fill => matches(fill, border)));
    }),
  };
};
const resourceTileAreas = (tiles, ids) => {
  const rectangles = [...document.querySelectorAll('.resource-map-colors path[class^="tone-"]')].flatMap(path =>
    [...path.getAttribute("d").matchAll(/M([\d.eE+-]+),([\d.eE+-]+)h([\d.eE+-]+)v([\d.eE+-]+)h[\d.eE+-]+Z/g)].map(match => match.slice(1, 5).map(Number)));
  return ids.map(id => {
    const tile = tiles.find(node => node.dataset.resourceId === id);
    // CSS 样式会舍入小数，面积比例从同位置的实际 SVG 浮点几何读取。
    const rect = rectangles.find(([x, y]) => Math.abs(x - parseFloat(tile.style.left)) < .001 && Math.abs(y - parseFloat(tile.style.top)) < .001);
    return (rect[2] + 1) * (rect[3] + 1);
  });
};

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
    assert.equal(map.review.length, 0);
    assert.ok(map.zero.length >= 90, "新发现资源未纳入零值区");
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
  for (const kind of ["skill", "mcp"]) {
    const overview = await api(`/resources/overview?kind=${kind}&q=map-`);
    assert.equal(overview.counts.review, 0);
    assert.ok(overview.counts.unused >= 90, "新资源仍被首次发现时间或历史缺口排除");
    assert.ok(overview.counts.low >= 215, "低频被历史缺口全局阻断");
    assert.ok(overview.counts.old >= 70, "有日期的长期未用被其他缺日期记录阻断");
    const legacy = await api(`/resources/overview?kind=${kind}&q=map-&candidate=review`);
    assert.equal(legacy.total, overview.total, "旧分类查询没有回到全部");
    assert.deepEqual(legacy.stats, overview.stats);
    const fresh = await api(`/resources/overview?kind=${kind}&q=map-review-000&candidate=unused`);
    assert.equal(fresh.total, 1, "刚发现的本地资源没有立即进入未发现使用");
    assert.equal(fresh.resources[0].stats.sessions, 0);
    const low = await api(`/resources/overview?kind=${kind}&q=map-&candidate=low&lowSessions=1`);
    assert.ok(low.resources.every(row => row.stats.sessions === 1));
    const selected = await api(`/resources/overview?kind=${kind}&q=${kind === "skill" ? "map-skill-000" : "map-mcp-000"}`);
    const id = selected.resources[0].identity.id;
    await api("/resources/favorites", "POST", { id, value: true });
    const protectedLow = await api(`/resources/overview?kind=${kind}&q=map-&candidate=low`);
    assert.equal(protectedLow.counts.low, overview.counts.low, "收藏改变了使用分类");
    await api("/resources/favorites", "POST", { id, value: false });
  }
  const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  for (const language of ["zh-CN", "en"]) {
    const help = await run(process.execPath, [cliPath, "--home", fixture.home, "--lang", language, "resources", "overview", "--help"]);
    assert.ok(!/\breview\b/.test(help.stdout), "CLI 帮助仍推荐待检查分类");
    for (const kind of ["skill", "mcp"]) {
      const result = await run(process.execPath, [cliPath, "--home", fixture.home, "--lang", language, "resources", "overview", "--kind", kind, "--q", "map-", "--candidate", "review", "--json"]);
      const legacy = JSON.parse(result.stdout);
      assert.equal(legacy.counts.review, 0);
      assert.equal(legacy.total, maps[kind].total);
    }
  }
  const systemUnused = await api("/resources/overview?kind=skill&q=map-system&candidate=unused");
  assert.equal(systemUnused.total, 1, "系统保护被误用于使用分类");
  assert.equal(systemUnused.resources[0].protected, true);
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
  assert.equal(skillSessionMap.zero.find(node => node.name === "broken")?.value, null, "断链来源被补成零值");
  assert.equal(skillSessionMap.positive.find(row => row.name === "map-skill-000")?.value, 1);
  assert.equal(skillSessionMap.positive.find(row => row.name === "map-read-000")?.value, 1);
  const configBefore = await readFile(fixture.configPath, "utf8");
  const claudeConfigBefore = await readFile(fixture.claudeConfigPath, "utf8");
  assert.ok(!JSON.stringify(maps).includes("synthetic-secret-keep-private"));
  assert.ok(!JSON.stringify(maps).includes("synthetic-map-secret"));
  await api("/preferences", "PUT", { language: "zh-CN", appearance: { mode: "light", preset: "terracotta" } });
  await browser(["open", `${base}/#resources`, "--headed", "--browser=chrome"]);

  await step("首次列表、地图按需查询与完整范围", `
    page.mapErrors=[]; page.mapRequests=[];
    page.on('pageerror',error=>page.mapErrors.push(error.message));
    page.on('request',request=>{if(request.url().includes('/api/v1/resources/map'))page.mapRequests.push(request.url())});
    await page.setViewportSize({width:1560,height:980});
    const table=page.getByRole('table',{name:'Skill 总览',exact:true}); await table.waitFor();
    expect(await table.getByRole('columnheader').filter({hasText:'调用次数'}).getAttribute('aria-sort')==='descending','Skill 默认排序不是调用次数');
    expect(await table.getByRole('columnheader').count()===6,'Skill 列表缺少次数或会话列');
    expect(await table.getByRole('columnheader',{name:'本地位置',exact:true}).count()===1,'Skill 列表缺少位置列');
    expect(page.mapRequests.length===0,'列表提前读取地图');
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-');
    await page.getByRole('group',{name:'资源展示方式',exact:true}).getByRole('button',{name:'地图',exact:true}).click();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    await page.getByRole('button',{name:'查看map-skill-000的使用详情',exact:true}).waitFor();
    expect(await page.locator('.resource-list-summary').count()===0,'资源地图仍有重复总数行');
    expect(page.mapRequests.length>0,'地图没有完整查询');
    expect(page.mapRequests.every(url=>!url.includes('pageSize=')&&!url.includes('&page=')),'地图沿用列表分页');
    expect(await page.getByRole('combobox',{name:'地图面积指标',exact:true}).count()===1,'地图缺少次数与会话指标切换');
    expect(page.mapRequests.every(url=>/[?&]metric=uses(?:&|$)/.test(url)),'地图默认未使用合并调用次数');
    const area=await page.locator('.resource-map-tile[data-resource-id]').evaluateAll(${resourceTileAreas.toString()},${JSON.stringify([maps.skill.positive.find(row=>row.name==='map-skill-000').id,maps.skill.positive.find(row=>row.name==='map-skill-001').id])});
    expect(Math.abs(area[0]/area[1]-100/11)<1e-7,'面积未包含重复调用与成功读取');
    ${screenshot("skill-map-light.png")}
  `);
  await step("共享地图绘制、固定边界、时间虚线与主题切换状态保留", `
    const settled=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const check=async()=>{const state=await page.evaluate(${boundaryRendering.toString()});expect(state.tiles>200&&state.nodes<=12&&state.painted===4&&state.styles&&state.geometry,'共享填充或边界规则不符合要求：'+JSON.stringify(state))};
    await check();
    const tile=page.getByRole('button',{name:'查看map-skill-002的使用详情',exact:true});
    await tile.click(); await tile.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    await page.getByRole('complementary',{name:'资源详情',exact:true}).getByRole('heading',{name:'map-skill-002',exact:true}).waitFor();
    await page.waitForLoadState('networkidle'); await settled();
    expect(await tile.evaluate(node=>getComputedStyle(node).boxShadow!=='none'&&getComputedStyle(node).outlineStyle!=='none'),'选中或键盘焦点被普通边界覆盖');
    await page.getByRole('button',{name:'放大资源地图',exact:true}).click();
    await settled();
    const scale=await page.locator('.resource-map-canvas').getAttribute('data-scale');
    ${screenshot("boundaries-light-zoom.png")}
    for(const mode of ['light','dark']) for(const preset of ['blue','terracotta','celadon','amber','berry','graphite','custom']) {
      await page.evaluate(async appearance=>{const response=await fetch('/api/v1/preferences',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({appearance})});if(!response.ok)throw new Error('合成外观更新失败');window.dispatchEvent(new Event('focus'))},{mode,preset,customColor:'#ffff00'});
      await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,mode); await page.waitForLoadState('networkidle'); await settled();
      const state=await page.evaluate(${boundaryRendering.toString()});
      expect(state.nodes<=12&&state.painted>0&&state.styles&&state.geometry,'深浅主题共享边界失败 '+mode+' '+preset);
      expect(await page.locator('.resource-map-canvas').getAttribute('data-scale')===scale,'主题切换改变地图缩放 '+mode+' '+preset);
      expect(await tile.getAttribute('class').then(value=>value.includes('is-selected')),'主题切换丢失资源选择');
      if(mode==='dark'&&preset==='terracotta'){${screenshot("boundaries-dark-zoom.png")}}
    }
    await page.getByRole('button',{name:'适应资源地图窗口',exact:true}).click();
  `);
  await step("悬停与键盘展示调用次数，读取型资源直接进入地图", `
    const tile=page.getByRole('button',{name:'查看map-skill-001的使用详情',exact:true});
    await tile.hover();
    const tooltip=page.getByRole('tooltip'); await tooltip.waitFor();
    expect((await tooltip.innerText()).includes('map-skill-001')&&(await tooltip.innerText()).includes('调用次数 · 11 次调用'),'悬停未显示完整名称及合并调用次数');
    await tile.focus(); await tooltip.waitFor();
    expect((await tooltip.innerText()).includes('最近使用'),'键盘聚焦缺少最近使用');
    ${locateResource("map-read-000")}
    await page.getByRole('button',{name:'查看map-read-000的使用详情',exact:true}).focus();
    await tooltip.waitFor();
    expect((await tooltip.innerText()).includes('调用次数 · 1 次调用'),'只读取的 Skill 没有计入调用次数');
    await page.getByRole('button',{name:'适应资源地图窗口',exact:true}).click();
  `);
  await step("次数和会话切换、上限重置、键盘操作及刷新保留", `
    await page.getByRole('spinbutton',{name:'地图调用次数上限',exact:true}).fill('10');
    await page.waitForFunction(()=>new URLSearchParams(location.hash.split('?')[1]).get('maxValue')==='10');
    const metric=page.getByRole('combobox',{name:'地图面积指标',exact:true});
    await metric.click(); await page.getByRole('option',{name:'使用会话数',exact:true}).click();
    await page.getByRole('spinbutton',{name:'地图使用会话数上限',exact:true}).waitFor();
    expect(await page.getByRole('spinbutton',{name:'地图使用会话数上限',exact:true}).inputValue()==='','切换指标没有清空次数上限');
    await page.getByRole('button',{name:'查看map-skill-001的使用详情',exact:true}).hover();
    await page.getByRole('tooltip').filter({hasText:'使用会话数 · 2 个会话'}).waitFor();
    await page.reload();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    expect(await page.getByRole('combobox',{name:'地图面积指标',exact:true}).innerText()==='使用会话数','刷新丢失所选指标');
    await page.getByRole('combobox',{name:'地图面积指标',exact:true}).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('option',{name:'使用会话数',exact:true}).waitFor();
    await page.waitForFunction(()=>document.activeElement?.getAttribute('role')==='option'&&document.activeElement.textContent.includes('使用会话数'));
    await page.keyboard.press('Home');
    await page.waitForFunction(()=>document.activeElement?.getAttribute('role')==='option'&&document.activeElement.textContent.includes('调用次数'));
    await page.keyboard.press('Enter');
    await page.getByRole('spinbutton',{name:'地图调用次数上限',exact:true}).waitFor();
    await page.waitForFunction(()=>!document.querySelector('.resource-list-scroll[aria-busy="true"]'));
    await page.getByRole('button',{name:'查看map-skill-001的使用详情',exact:true}).focus();
    await page.getByRole('tooltip').filter({hasText:'调用次数 · 11 次调用'}).waitFor();
    page.mapRequests=[]; page.mapErrors=[];
  `);
  await step("旧调用与读取链接统一合并调用指标，旧上限不沿用", `
    for(const metric of ['calls','reads']) {
      await page.evaluate(metric=>location.hash='#resources?kind=skill&client=codex&view=map&q=map-read-000&sort='+metric+'&metric='+metric+'&maxValue=0',metric);
      await page.locator('.resource-map-locator > span').filter({hasText:/^1 个色块/}).waitFor();
      const route=await page.evaluate(()=>Object.fromEntries(new URLSearchParams(location.hash.split('?')[1])));
      expect(route.metric==='uses'&&route.sort==='uses'&&!('maxValue' in route),'旧链接未统一指标或误用次数上限');
      expect(route.client==='codex'&&route.q==='map-read-000','兼容旧链接丢失统计范围');
      expect((await page.evaluate(${boundaryRendering.toString()})).tiles===1,'读取型资源在统一地图为空');
      await page.getByRole('group',{name:'资源展示方式',exact:true}).getByRole('button',{name:'列表',exact:true}).click();
      const table=page.getByRole('table',{name:'Skill 总览',exact:true}); await table.waitFor();
      expect(await table.getByRole('columnheader').count()===6,'主列表没有同时保留次数和会话列');
      expect((await table.getByRole('row').nth(1).getByRole('cell').nth(2).innerText())==='1','读取型资源没有计入使用会话');
      expect(await table.getByRole('button',{name:'按调用次数排序',exact:true}).count()===1&&await table.getByRole('button',{name:'按读取次数排序',exact:true}).count()===0,'表头缺少调用排序或仍单列读取次数');
    }
    await page.evaluate(()=>location.hash='#resources?kind=skill&view=map&q=map-&metric=sessions');
    await page.getByRole('button',{name:'查看map-skill-000的使用详情',exact:true}).waitFor();
  `);
  await step("Skill 与 MCP 旧待检查链接回到全部并保留所选资源", `
    for(const kind of ['skill','mcp']) {
      const id=kind==='skill'?${JSON.stringify(maps.skill.positive.find(row=>row.name==='map-skill-000').id)}:${JSON.stringify(maps.mcp.positive.find(row=>row.name==='map-mcp-000').id)};
      const name=kind==='skill'?'map-skill-000':'map-mcp-000';
      await page.evaluate(({kind,id})=>location.hash='#resources?kind='+kind+'&client=codex&view=map&q=map-&metric=sessions&candidate=review&reviewPage=2&reviewSize=50&id='+encodeURIComponent(id),{kind,id});
      await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
      const detail=page.getByRole('complementary',{name:'资源详情',exact:true});
      await detail.getByRole('heading',{name,exact:true}).waitFor();
      const route=await page.evaluate(()=>Object.fromEntries(new URLSearchParams(location.hash.split('?')[1])));
      expect((!route.candidate||route.candidate==='all')&&!route.reviewPage&&!route.reviewSize,'旧待检查视图状态仍保留');
      expect(route.id===id&&route.client==='codex'&&route.q==='map-'&&route.view==='map'&&route.metric==='sessions','兼容旧链接丢失范围或选择');
      const quick=page.getByRole('group',{name:(kind==='skill'?'Skill':'MCP')+' 快速筛选',exact:true});
      expect(await quick.getByRole('button').count()===4,'快捷分类数量错误');
      const more=page.locator('.resource-more-filters');if(await more.getAttribute('open')===null)await more.locator('summary').click();
      await page.getByRole('combobox',{name:'关注条件',exact:true}).click(); await page.getByRole('option',{name:/^低频/}).click();
      const threshold=page.getByRole('spinbutton',{name:'低频使用会话阈值',exact:true});
      await threshold.fill('1');
      await page.waitForFunction(()=>new URLSearchParams(location.hash.split('?')[1]).get('low')==='1');
      await page.getByRole('combobox',{name:'关注条件',exact:true}).click(); await page.getByRole('option',{name:/^长期未用/}).click();
      const days=page.getByRole('spinbutton',{name:'长期未用天数阈值',exact:true});
      await days.fill('180');
      await page.waitForFunction(()=>new URLSearchParams(location.hash.split('?')[1]).get('inactive')==='180');
      await quick.getByRole('button',{name:/^未发现使用/}).click();
      await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
      expect(await page.locator('.resource-map-compact').count()===0,'其他资源分组残留');
      expect(!(await page.locator('.resource-list-scroll').innerText()).includes('待检查'),'地图仍有待检查分组');
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
    await page.locator('.resource-detail-tabs').getByRole('button',{name:'使用记录',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.resource-detail-body[aria-busy="true"]'));
    expect(/1\\s*显式调用/.test(await detail.locator('.resource-stats').innerText()),'微小资源数值错误');
    expect(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('q'))==='map-','定位替代了关键词筛选');
    await page.getByRole('button',{name:'适应资源地图窗口',exact:true}).click();
  `);
  await step("会话上限、零值保留与列表范围", `
    await page.getByRole('spinbutton',{name:'地图使用会话数上限',exact:true}).fill('1');
    await page.waitForFunction(()=>new URLSearchParams(location.hash.split('?')[1]).get('maxValue')==='1');
    await page.waitForFunction(()=>[...document.querySelectorAll('.resource-map-colors path[class^="tone-"]')].reduce((count,path)=>count+(path.getAttribute('d').match(/M/g)?.length??0),0)>200);
    await page.getByRole('button',{name:'查看map-skill-001的使用详情',exact:true}).waitFor({state:'hidden'});
    expect(!(await page.locator('.resource-list-scroll').innerText()).includes('待检查'),'仍有待检查分类');
    expect(await page.locator('.resource-map-compact').count()===0,'其他资源分组仍存在');
    await page.getByRole('group',{name:'资源展示方式',exact:true}).getByRole('button',{name:'列表',exact:true}).click();
    await page.getByRole('table',{name:'Skill 总览',exact:true}).getByRole('button',{name:'按使用会话数排序',exact:true}).click();
    await page.getByRole('table',{name:'Skill 总览',exact:true}).getByRole('button',{name:'查看map-skill-001的使用详情',exact:true}).waitFor();
    await page.getByRole('group',{name:'资源展示方式',exact:true}).getByRole('button',{name:'地图',exact:true}).click();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    expect(await page.getByRole('spinbutton',{name:'地图使用会话数上限',exact:true}).inputValue()==='1','地图返回丢失会话上限');
    await page.getByRole('spinbutton',{name:'地图使用会话数上限',exact:true}).fill('');
    await page.getByRole('button',{name:'查看map-skill-001的使用详情',exact:true}).waitFor();
  `);
  await step("地图不再重复零值列表，统一列表仍保留零值及未知资源", `
    expect(await page.locator('.resource-map-compact').count()===0,'地图仍有其他资源');
    await page.getByRole('group',{name:'资源展示方式',exact:true}).getByRole('button',{name:'列表',exact:true}).click();
    const search=page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true});
    await search.fill('broken');
    await page.getByRole('button',{name:'查看broken的使用详情',exact:true}).waitFor();
    const row=page.getByRole('table',{name:'Skill 总览',exact:true}).locator('tbody tr');
    expect((await row.innerText()).includes('—'),'未知资源被补成零');
    await search.fill('map-review-000');
    await page.getByRole('button',{name:'查看map-review-000的使用详情',exact:true}).click();
    const detail=page.getByRole('complementary',{name:'资源详情',exact:true});
    await detail.getByRole('heading',{name:'map-review-000',exact:true}).waitFor();
    await detail.locator('.resource-detail-tabs').getByRole('button',{name:'使用记录',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.resource-detail-body[aria-busy="true"]'));
    expect(/0\\s*使用会话/.test(await detail.locator('.resource-stats').innerText()),'零使用详情错误');
    await search.fill('map-');
    await page.getByRole('group',{name:'资源展示方式',exact:true}).getByRole('button',{name:'地图',exact:true}).click();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    ${locateResource("map-read-000")}
    await detail.getByRole('heading',{name:'map-read-000',exact:true}).waitFor();
    await detail.locator('.resource-detail-tabs').getByRole('button',{name:'使用记录',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.resource-detail-body[aria-busy="true"]'));
    expect(/1\\s*成功读取/.test(await detail.locator('.resource-stats').innerText()),'读取证据丢失');
  `);
  await step("Agent 与时间筛选、直接链接和视图偏好", `
    if(await page.locator('.resource-more-filters').getAttribute('open')===null)await page.locator('.resource-more-filters > summary').click(); ${select("使用客户端", "Claude Code")}
    await page.getByRole('button',{name:'查看map-skill-001的使用详情',exact:true}).waitFor();
    await page.getByRole('button',{name:'查看map-skill-001的使用详情',exact:true}).click();
    const detail=page.getByRole('complementary',{name:'资源详情',exact:true});
    await detail.getByRole('heading',{name:'map-skill-001',exact:true}).waitFor();
    await page.locator('.resource-detail-tabs').getByRole('button',{name:'使用记录',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.resource-detail-body[aria-busy="true"]'));
    expect(/1\\s*使用会话/.test(await detail.locator('.resource-stats').innerText()),'Agent筛选统计扩大');
    await page.reload(); await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    if(await page.locator('.resource-more-filters').getAttribute('open')===null)await page.locator('.resource-more-filters > summary').click();
    expect(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('metric'))==='sessions','刷新丢失统一指标');
    expect((await page.getByRole('combobox',{name:'使用客户端',exact:true}).innerText()).includes('Claude Code'),'刷新丢失Agent');
    ${select("使用客户端", "全部客户端")}
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
    const hash=await page.evaluate(()=>location.hash);
    const stage=page.getByRole('group',{name:'资源使用地图',exact:true});
    const scale=await stage.getAttribute('data-scale');
    const position=await stage.locator('svg').innerHTML();
    await detail.locator('.resource-detail-tabs').getByRole('button',{name:'文件位置',exact:true}).click();
    const manage=detail.locator('.resource-location-list'); await manage.waitFor();
    expect(await manage.getByRole('button',{name:${JSON.stringify(`将${join(fixture.userHome, '.codex', 'skills', 'map-skill-001')}移入回收区`)},exact:true}).count()===1,'共享物理本体缺少唯一管理入口');
    await manage.locator('.resource-linked-locations > summary').click(); await manage.getByRole('button',{name:${JSON.stringify(`移除链接${fixture.sharedMapLink}，保留目标文件`)},exact:true}).click();
    const dialog=page.locator('.resource-preview-panel');
    await dialog.getByRole('button',{name:'移入回收区',exact:true}).waitFor();
    expect((await dialog.innerText()).includes(${JSON.stringify(fixture.sharedMapLink)}),'预览没有明确所选路径');
    expect(await page.getByRole('dialog').count()===0,'桌面预览不应叠加弹层');
    expect((await dialog.locator('.resource-change-diff').innerText()).includes('回收区（可恢复）'),'回收预览位置标签错误');
    await dialog.getByRole('button',{name:'移入回收区',exact:true}).click();
    await dialog.getByRole('button',{name:'完成',exact:true}).waitFor();
    expect((await dialog.getByRole('status').innerText()).includes('本地修改完成'),'回收未成功');
    expect(!(await dialog.innerText()).includes('待重新加载'),'文件操作不应推测客户端重载状态');
    await dialog.getByRole('button',{name:'完成',exact:true}).click();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    await detail.getByRole('heading',{name:'map-skill-001',exact:true}).waitFor();
    await page.locator('.resource-detail-tabs').getByRole('button',{name:'使用记录',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.resource-detail-body[aria-busy="true"]'));
    expect(/2\\s*使用会话/.test(await detail.locator('.resource-stats').innerText()),'管理抹掉历史使用');
    await page.waitForFunction(()=>!document.querySelector('.resource-list-scroll[aria-busy="true"]'));
    expect(await page.evaluate(before=>{const clean=value=>{const p=new URLSearchParams(value.split('?')[1]);p.delete('detail');return p.toString()};return clean(location.hash)===clean(before)},hash),'管理改变地图筛选或选中项');
    expect(await stage.getAttribute('data-scale')===scale&&await stage.locator('svg').innerHTML()===position,'管理重置地图视野');
  `);
  await assert.rejects(readFile(fixture.sharedMapLink), { code: "ENOENT" });
  assert.ok((await readFile(join(fixture.userHome, ".codex", "skills", "map-skill-001", "SKILL.md"), "utf8")).includes("人工地图资源"));
  await step("共享入口恢复后返回地图保留历史", `
    await page.getByRole('button',{name:'更多资源工具',exact:true}).click(); await page.getByRole('menuitem',{name:'回收区',exact:true}).click();
    await page.getByRole('button',{name:'查看map-skill-001的恢复记录',exact:true}).click();
    await page.getByRole('button',{name:'预览恢复',exact:true}).click();
    const dialog=page.locator('.resource-preview-panel');
    await dialog.getByRole('button',{name:'恢复到原位置',exact:true}).click();
    await dialog.getByRole('button',{name:'完成',exact:true}).waitFor();
    expect((await dialog.getByRole('status').innerText()).includes('本地修改完成'),'恢复未成功');
    await dialog.getByRole('button',{name:'完成',exact:true}).click();
    await page.getByRole('button',{name:'更多资源工具',exact:true}).click(); await page.getByRole('menuitem',{name:'资源清单',exact:true}).click();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
  `);
  assert.equal(await realpath(fixture.sharedMapLink), await realpath(join(fixture.userHome, ".codex", "skills", "map-skill-001")));
  await step("语言切换前选择会话指标", `
    ${select("地图面积指标", "使用会话数")}
    await page.getByRole('spinbutton',{name:'地图使用会话数上限',exact:true}).waitFor();
  `);
  await api("/preferences", "PUT", { language: "en" });
  await step("英文指标、数量与界面状态", `
    await page.reload();
    const metric=page.getByRole('combobox',{name:'Map area metric',exact:true}); await metric.waitFor();
    expect(await metric.innerText()==='Usage sessions','语言切换改变地图指标');
    await metric.click(); await page.getByRole('option',{name:'Calls',exact:true}).click();
    await page.getByRole('spinbutton',{name:'Map Calls maximum',exact:true}).waitFor();
    await page.getByRole('button',{name:'View usage details for map-skill-001',exact:true}).focus();
    await page.getByRole('tooltip').filter({hasText:'Calls · 11 calls'}).waitFor();
  `);
  await api("/preferences", "PUT", { language: "zh-CN" });
  await step("切回中文保留次数指标", `
    await page.reload(); await page.getByRole('combobox',{name:'地图面积指标',exact:true}).waitFor();
    expect(await page.getByRole('combobox',{name:'地图面积指标',exact:true}).innerText()==='调用次数','切回中文丢失次数指标');
  `);
  await step("MCP 默认调用地图及独立注册管理", `
    await page.getByRole('group',{name:'资源类型',exact:true}).getByRole('button',{name:'MCP',exact:true}).click();
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-');
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    expect(await page.getByRole('combobox',{name:'地图面积指标',exact:true}).count()===1,'MCP缺少指标切换');
    expect(await page.evaluate(()=>new URLSearchParams(location.hash.split('?')[1]).get('metric'))==='uses','MCP未默认使用调用次数');
    const tile=page.getByRole('button',{name:'查看map-mcp-001的使用详情',exact:true}); await tile.hover();
    await page.getByRole('tooltip').filter({hasText:'调用次数 · 10 次调用'}).waitFor();
    ${select("地图面积指标", "使用会话数")}
    await tile.focus(); await page.getByRole('tooltip').filter({hasText:'使用会话数 · 1 个会话'}).waitFor();
    ${select("地图面积指标", "调用次数")}
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-mcp-001');
    await page.getByRole('button',{name:'查看map-mcp-001的使用详情',exact:true}).click();
    const detail=page.getByRole('complementary',{name:'资源详情',exact:true});
    await detail.getByRole('heading',{name:'map-mcp-001',exact:true}).waitFor();
    await detail.locator('.resource-detail-tabs').getByRole('button',{name:'配置位置',exact:true}).click();
    const manage=detail.locator('.resource-location-list'); await manage.waitFor();
    expect(await manage.locator('.resource-management-body').count()===2,'不同MCP注册被当成同一对象');
    await manage.getByRole('button',{name:'预览停用map-mcp-001的Codex入口',exact:true}).click();
    const dialog=page.locator('.resource-preview-panel');
    await dialog.getByRole('button',{name:'停用此全局配置',exact:true}).click();
    await dialog.getByRole('button',{name:'完成',exact:true}).waitFor();
    expect((await dialog.getByRole('status').innerText()).includes('本地修改完成'),'MCP停用失败');
    await dialog.getByRole('button',{name:'完成',exact:true}).click();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    await detail.getByRole('heading',{name:'map-mcp-001',exact:true}).waitFor();
    await page.locator('.resource-detail-tabs').getByRole('button',{name:'使用记录',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.resource-detail-body[aria-busy="true"]'));
    expect(/10\\s*调用次数/.test(await detail.locator('.resource-stats').innerText()),'停用改变历史调用');
  `);
  assert.equal(parseToml(await readFile(fixture.configPath, "utf8")).mcp_servers["map-mcp-001"].enabled, false);
  assert.equal(await readFile(fixture.claudeConfigPath, "utf8"), claudeConfigBefore, "所选注册操作误改其他 Agent");
  assert.deepEqual(parseToml(await readFile(fixture.configPath, "utf8")).mcp_servers.sample, parseToml(configBefore).mcp_servers.sample);
  await step("MCP 恢复保持原始配置与地图证据", `
    await page.getByRole('button',{name:'更多资源工具',exact:true}).click(); await page.getByRole('menuitem',{name:'已停用',exact:true}).click();
    await page.getByRole('button',{name:'查看map-mcp-001的恢复记录',exact:true}).click();
    await page.getByRole('button',{name:'预览恢复',exact:true}).click();
    const dialog=page.locator('.resource-preview-panel');
    await dialog.getByRole('button',{name:'恢复到原位置',exact:true}).click();
    await dialog.getByRole('button',{name:'完成',exact:true}).waitFor();
    expect((await dialog.getByRole('status').innerText()).includes('本地修改完成'),'MCP恢复失败');
    await dialog.getByRole('button',{name:'完成',exact:true}).click();
    await page.getByRole('button',{name:'更多资源工具',exact:true}).click(); await page.getByRole('menuitem',{name:'资源清单',exact:true}).click();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-history-only');
    await page.getByRole('button',{name:'查看map-history-only的使用详情',exact:true}).click();
    const detail=page.getByRole('complementary',{name:'资源详情',exact:true});
    await detail.getByRole('heading',{name:'map-history-only',exact:true}).waitFor();
    expect(await detail.getByRole('button',{name:/^预览/}).count()===0,'仅历史资源有写操作');
    await detail.locator('.resource-detail-tabs').getByRole('button',{name:'配置位置',exact:true}).click();
    await detail.getByText('当前结果中没有可管理的本地文件或配置，使用记录仍保留。',{exact:true}).waitFor();
    expect(await detail.getByRole('button',{name:/^预览/}).count()===0,'仅历史资源出现管理操作');
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
    await page.getByRole('button',{name:'适应资源地图窗口',exact:true}).click();
    await page.waitForFunction(scale=>Number(document.querySelector('[data-scale]')?.dataset.scale)<scale,second);
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
    const feedback=page.getByRole('button',{name:'关闭资源操作反馈',exact:true});
    if(await feedback.count()) await feedback.click();
    await page.getByRole('group',{name:'资源类型',exact:true}).getByRole('button',{name:'Skill',exact:true}).click();
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-undated');
    await page.getByRole('button',{name:'查看map-undated的使用详情',exact:true}).focus();
    await page.getByRole('tooltip').waitFor();
    const tooltip=await page.getByRole('tooltip').innerText();
    expect(tooltip.includes('时间未记录')&&!tooltip.includes('部分记录')&&!tooltip.includes('统计不完整'),'具体时间值或概括提示展示不符合要求');
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-system');
    await page.getByRole('group',{name:'资源展示方式',exact:true}).getByRole('button',{name:'列表',exact:true}).click();
    await page.getByRole('button',{name:'查看map-system的使用详情',exact:true}).click();
    const detail=page.getByRole('complementary',{name:'资源详情',exact:true});
    await detail.getByRole('heading',{name:'map-system',exact:true}).waitFor();
    await detail.locator('.resource-detail-tabs').getByRole('button',{name:'文件位置',exact:true}).click();
    const manage=detail.locator('.resource-location-list'); await manage.waitFor();
    expect(await manage.getByRole('button',{name:/^预览/}).count()===0,'系统资源有写操作');
    await page.getByRole('group',{name:'资源展示方式',exact:true}).getByRole('button',{name:'地图',exact:true}).click();
    expect(await manage.getByRole('button',{name:/^将.*移入回收区$/}).count()===0,'系统资源有回收操作');
    await manage.getByText('系统资源受保护，当前入口只读。',{exact:true}).waitFor();
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('no-such-map-resource');
    await page.getByRole('group',{name:'Skill 快速筛选',exact:true}).getByRole('button',{name:/^全部/}).locator('strong').filter({hasText:/^0$/}).waitFor();
    await page.waitForFunction(()=>!document.querySelector('.resource-list-scroll[aria-busy="true"]'));
    expect(await page.getByRole('button',{name:'查看map-system的使用详情',exact:true}).count()===0,'空结果保留旧节点');
    const retainedMap=await page.getByRole('group',{name:'资源使用地图',exact:true}).elementHandle();
    let failed=false;
    await page.route('**/api/v1/resources/map?**',async route=>{if(!failed){failed=true;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_FAILURE',message:'人工地图查询失败'}})})}else await route.continue()});
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-skill-');
    await page.getByRole('alert').filter({hasText:'人工地图查询失败'}).waitFor();
    expect(await retainedMap.evaluate(element=>element.isConnected),'查询失败卸载了已有地图');
    await page.getByRole('button',{name:'重试',exact:true}).click();
    await page.locator('.resource-map-locator > span').filter({hasText:/^${fixture.count} 个色块$/}).waitFor();
    ${locateResource("map-skill-000")}
    await page.getByRole('button',{name:'查看map-skill-000的使用详情',exact:true}).waitFor();
    await page.unroute('**/api/v1/resources/map?**');
  `);
  await step("深浅主题、375px滚动与窄屏详情", `
    await page.getByRole('button',{name:'外观',exact:true}).click(); await page.getByRole('combobox',{name:'显示模式',exact:true}).click(); await page.getByRole('option',{name:'深色',exact:true}).click(); await page.keyboard.press('Escape');
    expect(await page.evaluate(()=>document.documentElement.dataset.theme)==='dark','深色主题没有生效');
    ${screenshot("skill-map-dark.png")}
    await page.getByRole('button',{name:'外观',exact:true}).click(); await page.getByRole('combobox',{name:'显示模式',exact:true}).click(); await page.getByRole('option',{name:'明亮',exact:true}).click(); await page.keyboard.press('Escape');
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-');
    await page.setViewportSize({width:375,height:812});
    const previousDetail=page.getByRole('dialog',{name:'资源详情',exact:true});
    await previousDetail.waitFor();
    await page.keyboard.press('Escape'); await previousDetail.waitFor({state:'hidden'});
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    await page.locator('.resource-map-locator > span').filter({hasText:/^${skillSessionMap.positive.length} 个色块$/}).waitFor();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'窄屏页面横向溢出');
    ${locateResource("map-skill-214")}
    const dialog=page.getByRole('dialog',{name:'资源详情',exact:true});
    await dialog.getByRole('heading',{name:'map-skill-214',exact:true}).waitFor();
    const box=await dialog.boundingBox(); expect(box.x>=0&&box.x+box.width<=375,'窄屏详情溢出');
    await dialog.locator('.resource-detail-tabs').getByRole('button',{name:'文件位置',exact:true}).click();
    const control=dialog.getByRole('button',{name:/^将.*移入回收区$/}).first();await control.click();
    const manage=dialog.locator('.resource-preview-panel');await manage.waitFor();
    expect(await page.getByRole('dialog').count()===1,'窄屏管理与详情弹层重叠');
    const manageBox=await manage.boundingBox();expect(manageBox.x>=0&&manageBox.x+manageBox.width<=375,'窄屏管理面板溢出');
    await page.keyboard.press('Escape');await manage.waitFor({state:'hidden'});await dialog.waitFor();
    await page.waitForFunction(label=>document.activeElement?.getAttribute('aria-label')===label,await control.getAttribute('aria-label'));expect(await control.evaluate(element=>element===document.activeElement),'窄屏Esc未恢复操作焦点');
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
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
    await detail.locator('.resource-detail-tabs').getByRole('button',{name:'文件位置',exact:true}).click();
    const manage=detail.locator('.resource-location-list'); await manage.waitFor();
    await manage.getByRole('button',{name:${JSON.stringify(`将${join(fixture.userHome, '.codex', 'skills', 'map-skill-002')}移入回收区`)},exact:true}).click();
    const protectedPreview=page.locator('.resource-preview-panel');
    await protectedPreview.getByRole('alert').filter({hasText:'此资源已收藏'}).waitFor();
    await protectedPreview.getByRole('button',{name:'取消',exact:true}).click();
    await detail.getByRole('button',{name:'取消收藏map-skill-002',exact:true}).click();
    await detail.getByRole('button',{name:'收藏map-skill-002',exact:true}).waitFor();
    await detail.locator('.resource-detail-tabs').getByRole('button',{name:'文件位置',exact:true}).click(); await manage.waitFor();
    await manage.getByRole('button',{name:${JSON.stringify(`将${join(fixture.userHome, '.codex', 'skills', 'map-skill-002')}移入回收区`)},exact:true}).click();
    const preview=page.locator('.resource-preview-panel');
    await preview.getByRole('button',{name:'移入回收区',exact:true}).click();
    await preview.getByRole('button',{name:'完成',exact:true}).waitFor();
    await preview.getByRole('button',{name:'完成',exact:true}).click();
    await detail.getByRole('heading',{name:'map-skill-002',exact:true}).waitFor();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    await page.locator('.resource-detail-tabs').getByRole('button',{name:'使用记录',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.resource-detail-body[aria-busy="true"]'));
    expect(/1\\s*显式调用/.test(await detail.locator('.resource-stats').innerText()),'回收抹掉真实历史');
    await page.getByRole('button',{name:'更多资源工具',exact:true}).click(); await page.getByRole('menuitem',{name:'回收区',exact:true}).click();
    await page.getByRole('button',{name:'查看map-skill-002的恢复记录',exact:true}).click();
    await page.getByRole('button',{name:'预览恢复',exact:true}).click();
    const restore=page.locator('.resource-preview-panel');
    await restore.getByRole('button',{name:'恢复到原位置',exact:true}).click();
    await restore.getByRole('button',{name:'完成',exact:true}).waitFor();
    await restore.getByRole('button',{name:'完成',exact:true}).click();
    await page.getByRole('button',{name:'更多资源工具',exact:true}).click(); await page.getByRole('menuitem',{name:'资源清单',exact:true}).click();
    await page.getByRole('group',{name:'资源使用地图',exact:true}).waitFor();
    await page.getByRole('button',{name:'查看map-skill-002的使用详情',exact:true}).click();
    await detail.getByRole('heading',{name:'map-skill-002',exact:true}).waitFor();
    await page.locator('.resource-detail-tabs').getByRole('button',{name:'使用记录',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.resource-detail-body[aria-busy="true"]'));
    expect(/1\\s*显式调用/.test(await detail.locator('.resource-stats').innerText()),'恢复统计变化');
  `);
  assert.ok((await readFile(join(fixture.userHome,'.codex','skills','map-skill-002','SKILL.md'),'utf8')).includes('map-skill-002'));

  assert.equal(await readFile(fixture.configPath, "utf8"), configBefore);
  const boundaryNodes = ["map-skill-000", "map-skill-002", "map-undated"].map((name, index) => ({
    ...maps.skill.positive.find(node => node.name === name), value: index === 0 ? 1e12 : 1, share: (index === 0 ? 1e12 : 1) / (1e12 + 2),
  }));
  await step("悬殊面积的小块无间隔无边界，定位后恢复固定细线与时间虚线", `
    const payload=${JSON.stringify({ ...maps.skill, positive: boundaryNodes, zero: [], review: [], total: 3, totalValue: 1e12 + 2 })};
    await page.route('**/api/v1/resources/map?**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload)}));
    await page.getByRole('textbox',{name:'搜索资源名称或路径',exact:true}).fill('map-');
    await page.locator('.resource-map-locator > span').filter({hasText:/^3 个色块$/}).waitFor();
    await page.getByRole('button',{name:'适应资源地图窗口',exact:true}).click();
    const small=await page.evaluate(${boundaryRendering.toString()});
    expect(small.tiles===3&&small.small===2&&small.styles&&small.geometry,'微小正值被间隔吞没或加上边界：'+JSON.stringify(small));
    ${locateResource("map-skill-002")}
    const enlarged=await page.evaluate(${boundaryRendering.toString()});
    expect(enlarged.painted>0&&enlarged.styles&&enlarged.geometry,'放大微小块后没有恢复中性细边界');
    ${locateResource("map-undated")}
    const missing=page.locator('.resource-map-colors .map-boundary[data-tone="missing"]');
    expect(await missing.getAttribute('d').then(Boolean)&&await missing.evaluate(node=>getComputedStyle(node).strokeDasharray!=='none'),'时间缺失块放大后没有恢复虚线');
    ${screenshot("boundaries-tiny-located.png")}
    await page.unroute('**/api/v1/resources/map?**');
  `);
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
