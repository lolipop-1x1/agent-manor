import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// 只读验收已有服务；真实名称、路径与浏览器细节只保存在本机忽略目录。
const run = promisify(execFile);
const url = process.env.AGENT_MANOR_E2E_URL ?? "http://127.0.0.1:4317";
const target = process.env.AGENT_MANOR_E2E_REPOSITORY;
const artifacts = fileURLToPath(new URL("../.local/map-zoom-e2e/", import.meta.url));
const directory = await mkdtemp("/tmp/manor-map-");
const session = `mz${process.pid}-${Date.now().toString(36)}`;
let browserOpened = false;

async function api(path) {
  const response = await fetch(new URL(path, url), { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, "只读 API 请求失败。");
  return response.json();
}

async function browser(args) {
  let result;
  try {
    // 独立会话与短套接字路径，不操作已有浏览器标签页。
    result = await run("playwright-cli", [`-s=${session}`, ...args], {
      cwd: directory, env: { ...process.env, TMPDIR: "/tmp", PLAYWRIGHT_DAEMON_SESSION_DIR: join(directory, "daemon") },
      timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    await writeFile(join(artifacts, `private-${args[0]}-output.txt`), `${error.stdout ?? ""}\n${error.stderr ?? ""}`);
    throw new Error("浏览器命令失败；详细输出已留在本机忽略目录。");
  }
  if (result.stdout.includes("### Error")) {
    await writeFile(join(artifacts, `private-${args[0]}-output.txt`), result.stdout);
    throw new Error("浏览器断言失败；详细输出已留在本机忽略目录。");
  }
  return result.stdout;
}

async function verify(page, fixture) {
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = { page: 0, console: 0, http: 0, request: 0, listener: 0 };
  const requests = [];
  const steps = [];
  // CLI VM 没有 URL 等 Node 全局；事件异常也不能冒泡到 daemon。
  const guarded = handler => value => { try { return handler(value); } catch { errors.listener += 1; return false; } };
  const mark = async (stage, state = "begin") => page.evaluate(data => {
    console.info(`MAP_ZOOM_E2E ${JSON.stringify(data)}`);
  }, { stage, state, time: Date.now() });
  page.setDefaultTimeout(20_000);
  page.on("pageerror", () => { errors.page += 1; });
  page.on("console", guarded(message => { if (message.type() === "error") errors.console += 1; }));
  page.on("response", guarded(response => { if (response.status() >= 400) errors.http += 1; }));
  page.on("requestfailed", guarded(request => {
    if (!String(request.failure()?.errorText).includes("ERR_ABORTED")) errors.request += 1;
  }));
  page.on("request", guarded(request => {
    if (request.url().split("?")[0].includes("/api/v1/")) requests.push(request.method());
  }));
  const button = name => page.getByRole("button", { name, exact: true });
  const chooseRepository = async path => {
    await page.locator(".repository-trigger").click();
    await page.getByRole("menuitem").filter({ has: page.getByText(path, { exact: true }) }).click();
  };
  const map = page.locator(".code-map");
  const explorer = page.locator(".map-explorer");
  const scale = async () => Number(await map.getAttribute("data-scale"));
  const settle = async () => {
    await map.waitFor({ state: "visible" });
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const fileTile = async path => map.locator(await page.evaluate(value => `.map-file[data-path="${CSS.escape(value)}"]`, path));
  const selected = async () => page.locator(".file-table tbody tr.selected button").textContent();
  const view = async () => {
    const tile = await fileTile(fixture.small.path);
    const [bounds, rect] = await Promise.all([map.boundingBox(), tile.boundingBox()]);
    return { scale: await scale(), bounds, rect };
  };
  const preserved = (before, after, message) => {
    ensure(Math.abs(after.scale / before.scale - 1) < .001, `${message}丢失缩放倍率。`);
    ensure(before.rect && after.rect, `${message}丢失所选文件。`);
    const offset = current => ({
      x: current.rect.x + current.rect.width / 2 - current.bounds.x - current.bounds.width / 2,
      y: current.rect.y + current.rect.height / 2 - current.bounds.y - current.bounds.height / 2,
    });
    const a = offset(before), b = offset(after);
    ensure(Math.hypot(a.x - b.x, a.y - b.y) < 5, `${message}丢失局部位置。`);
  };
  const snapshot = async () => ({
    metrics: await page.locator(".metrics").innerText(),
    version: await page.locator(".baseline-note").innerText(),
    filters: await page.locator(".filters select").evaluateAll(elements => elements.map(element => element.value)),
  });
  const summaryMatches = async summary => {
    const fmt = value => value.toLocaleString("zh-CN");
    const lineText = await page.locator(".metric-primary small").innerText();
    const fileText = await page.locator(".metrics > div").nth(1).locator("small").innerText();
    ensure(lineText.replace(/\s+/g, " ").trim() === `${fmt(summary.readExact.lines)} / ${fmt(summary.lineCount)} 行`, "界面行统计与 HTTP 结果不一致。");
    ensure(fileText.replace(/\s+/g, " ").trim() === `${fmt(summary.readExact.files)} / ${fmt(summary.fileCount)} 个文件`, "界面文件统计与 HTTP 结果不一致。");
  };
  const withoutQuery = async (name, action, compareMetrics = true) => {
    await mark(name);
    await settle();
    const before = await snapshot();
    const requestCount = requests.length;
    const started = Date.now();
    await action();
    await settle();
    const after = await snapshot();
    ensure(requests.length === requestCount, `${name}触发了额外 API 查询。`);
    ensure(after.version === before.version, `${name}改变了结果版本或基线。`);
    ensure(JSON.stringify(after.filters) === JSON.stringify(before.filters), `${name}改变了统计筛选。`);
    if (compareMetrics) ensure(after.metrics === before.metrics, `${name}改变了统计摘要。`);
    steps.push({ name, milliseconds: Date.now() - started });
    await mark(name, "passed");
  };
  const fonts = async tile => tile.evaluate(element => {
    const name = element.querySelector(".tile-name"), value = element.querySelector("strong");
    return {
      name: name ? parseFloat(getComputedStyle(name).fontSize) : 0,
      value: value ? parseFloat(getComputedStyle(value).fontSize) : 0,
      nameText: name?.textContent ?? "", valueText: value?.textContent ?? "",
    };
  });
  const textIsUnobscured = async tile => {
    await map.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    return tile.evaluate(element => [".tile-name", "strong"].every(selector => {
      const text = element.querySelector(selector);
      if (!text?.textContent) return false;
      const range = document.createRange();
      range.selectNodeContents(text);
      const rects = [range.getBoundingClientRect(), text.getBoundingClientRect(), text.parentElement.getBoundingClientRect(), element.getBoundingClientRect(), element.closest(".code-map").getBoundingClientRect()];
      const left = Math.max(0, ...rects.map(rect => rect.left));
      const top = Math.max(0, ...rects.map(rect => rect.top));
      const right = Math.min(innerWidth, ...rects.map(rect => rect.right));
      const bottom = Math.min(innerHeight, ...rects.map(rect => rect.bottom));
      if (right - left < 2 || bottom - top < 2) return false;
      for (const x of [left + 1, (left + right) / 2, right - 1]) {
        for (const y of [top + 1, (top + bottom) / 2, bottom - 1]) {
          if (document.elementFromPoint(x, y)?.closest(".map-file") !== element) return false;
        }
      }
      return true;
    }));
  };

  await mark("加载目标仓库");
  await page.setViewportSize({ width: 1440, height: 1000 });
  // 监听在重新导航前安装，初始资源和 API 的错误也纳入验收。
  await page.goto(fixture.url);
  await chooseRepository(fixture.repository.path);
  await settle();
  ensure((await page.locator(".baseline-note").innerText()).includes(fixture.version), "界面没有绑定独立查询的结果版本。");
  ensure(Number(await map.getAttribute("data-file-count")) === fixture.nonemptyCount, "地图非空文件总数与 API 不一致。");
  await button("适应窗口").click();
  await settle();
  const fitScale = await scale();
  const initialVisible = Number(await map.getAttribute("data-visible-count"));
  ensure(initialVisible === fixture.nonemptyCount, "适应窗口未恢复全部非空文件视野。");
  const rootBefore = await page.evaluate(async endpoint => {
    const response = await fetch(endpoint);
    if (!response.ok) throw new Error("固定版本覆盖查询失败。");
    return response.json();
  }, fixture.endpoint);
  ensure(JSON.stringify(rootBefore.summary) === JSON.stringify(fixture.summary), "浏览器与独立 HTTP 统计摘要不一致。");
  await summaryMatches(fixture.summary);

  await withoutQuery("按钮与地图键盘缩放", async () => {
    await button("放大地图").focus();
    await page.keyboard.press("Enter");
    await settle();
    ensure(await scale() > fitScale, "放大按钮的键盘入口未生效。");
    const enlarged = await scale();
    await button("缩小地图").click();
    await settle();
    ensure(await scale() < enlarged, "缩小按钮未生效。");
    await map.focus();
    await page.keyboard.press("+");
    await settle();
    ensure(await scale() > fitScale, "聚焦地图后加号键未缩放。");
    await page.keyboard.press("0");
    await settle();
    ensure(Math.abs(await scale() / fitScale - 1) < .001, "0 键没有适应窗口。");
  });

  await mark("实际单击文件选择");
  const beforeClick = await snapshot();
  await map.scrollIntoViewIfNeeded();
  const clickTarget = await map.locator(".map-file").evaluateAll((elements, selectedPath) => {
    for (const element of elements) {
      if (element.getAttribute("data-path") === selectedPath) continue;
      const rect = element.getBoundingClientRect();
      for (const fraction of [.5, .75]) {
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height * fraction };
        if (document.elementFromPoint(point.x, point.y)?.closest(".map-file") === element) {
          return { path: element.getAttribute("data-path"), point };
        }
      }
    }
    return null;
  }, fixture.small.path);
  ensure(clickTarget, "完整视野没有可供实际单击的其他文件。");
  await page.mouse.click(clickTarget.point.x, clickTarget.point.y);
  await page.locator(".file-path").waitFor({ state: "visible" });
  await settle();
  ensure(await selected() === clickTarget.path && await page.locator(".file-path").innerText() === clickTarget.path, "实际单击没有选择对应文件。");
  ensure(JSON.stringify(await snapshot()) === JSON.stringify(beforeClick), "文件选择改变了覆盖范围或摘要。");
  await mark("实际单击文件选择", "passed");

  // 文件列表是小文件入口；清空搜索恢复全仓几何后才测定位能力。
  await mark("列表选择小文件");
  await page.getByRole("textbox", { name: "搜索文件或路径" }).fill(fixture.small.path);
  await page.locator(".file-table tbody").getByRole("button", { name: fixture.small.path, exact: true }).click();
  await page.locator(".file-path").waitFor({ state: "visible" });
  ensure(await selected() === fixture.small.path, "列表选择未保留。");
  await button("清空搜索").click();
  await settle();
  ensure(Number(await map.getAttribute("data-file-count")) === fixture.nonemptyCount, "清空搜索未恢复全仓文件集合。");
  let locateMilliseconds;
  let wheelMilliseconds;
  let dragMilliseconds;
  await withoutQuery("定位所选小文件", async () => {
    const started = Date.now();
    await button("定位所选文件").click();
    const tile = await fileTile(fixture.small.path);
    await tile.waitFor({ state: "visible" });
    ensure(await tile.locator(".tile-name").isVisible(), "小文件定位后没有名称。");
    ensure(await tile.locator("strong").isVisible(), "小文件定位后没有百分比。");
    locateMilliseconds = Date.now() - started;
  });
  const locatedScale = await scale();
  ensure(locatedScale > fitScale, "定位小文件没有进入放大局部。");
  const locatedVisible = Number(await map.getAttribute("data-visible-count"));
  const readableCount = await map.locator(".map-file").count();
  ensure(readableCount <= locatedVisible && locatedVisible <= fixture.nonemptyCount, "可读节点与可见几何计数不一致。");
  if (fixture.nonemptyCount > 1) ensure(locatedVisible < initialVisible, "局部视野没有裁掉屏幕外几何。");
  const smallTile = await fileTile(fixture.small.path);
  ensure(await smallTile.evaluate(element => getComputedStyle(element).backgroundColor === "rgba(0, 0, 0, 0)"), "文件按钮背景覆盖了 SVG 色块间隔。");
  const originalFonts = await fonts(smallTile);
  ensure(originalFonts.name >= 12 && originalFonts.name <= 20, "文件名不在正常阅读字号范围。");
  ensure(originalFonts.value >= 22 && originalFonts.value <= 36, "百分比不在正常阅读字号范围。");
  ensure(await textIsUnobscured(smallTile), "所选小文件名称或百分比被其他控件遮挡。");
  ensure(originalFonts.valueText === fixture.small.percent, "地图百分比与 API 精确读取行数不一致。");
  ensure((await smallTile.getAttribute("aria-label")).includes(fixture.small.path), "键盘标签没有完整路径。");
  await smallTile.focus();
  ensure((await map.locator(".map-hover-hint").innerText()).includes(fixture.small.path), "聚焦文件后没有完整路径提示。");
  await map.focus();

  await withoutQuery("普通滚轮缩放与固定字号", async () => {
    await map.scrollIntoViewIfNeeded();
    const bounds = await map.boundingBox();
    const previous = await scale();
    const scroll = await page.evaluate(() => scrollY);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    const started = Date.now();
    await page.mouse.wheel(0, -80);
    await page.waitForFunction(previousScale => Number(document.querySelector(".code-map").dataset.scale) > previousScale, previous);
    wheelMilliseconds = Date.now() - started;
    await settle();
    ensure(await scale() > previous, "普通滚轮没有放大地图。");
    ensure(Math.abs(await page.evaluate(() => scrollY) - scroll) < 1, "地图内滚轮同时滚动了页面。");
    const currentFonts = await fonts(smallTile);
    ensure(currentFonts.name === originalFonts.name && currentFonts.value === originalFonts.value, "文字字号随几何缩放发生变化。");
    ensure(currentFonts.nameText === originalFonts.nameText && currentFonts.valueText === originalFonts.valueText, "放大后标签丢失。");
    await page.mouse.wheel(0, 80);
  });
  await withoutQuery("地图外滚轮滚动页面", async () => {
    await page.locator(".app-header").scrollIntoViewIfNeeded();
    const previousScale = await scale();
    const scroll = await page.evaluate(() => scrollY);
    const bounds = await page.locator(".app-header").boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 220);
    await page.waitForFunction(previous => scrollY > previous, scroll);
    ensure(await scale() === previousScale, "地图外滚轮改变了地图倍率。");
    await map.scrollIntoViewIfNeeded();
  });

  await withoutQuery("鼠标焦点稳定", async () => {
    // 按钮采用裁剪后几何；只在放大一小步仍完全位于视口内的矩形上核对投影。
    await button("适应窗口").click();
    await settle();
    await map.scrollIntoViewIfNeeded();
    const bounds = await map.boundingBox();
    const factor = Math.exp(8 * .002);
    const candidate = await map.locator(".map-file").evaluateAll((elements, input) => {
      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        const focus = { x: rect.x + rect.width * .35, y: rect.y + rect.height * .42 };
        const left = focus.x + (rect.x - focus.x) * input.factor;
        const top = focus.y + (rect.y - focus.y) * input.factor;
        if (rect.width >= 28 && rect.height >= 16 && left > input.bounds.x + 2 && top > input.bounds.y + 2
          && left + rect.width * input.factor < input.bounds.x + input.bounds.width - 2
          && top + rect.height * input.factor < input.bounds.y + input.bounds.height - 2) {
          return { path: element.getAttribute("data-path"), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, focus };
        }
      }
      return null;
    }, { bounds, factor });
    ensure(candidate, "当前仓库没有可用于焦点投影验收的完整可读矩形。");
    const beforeScale = await scale();
    await page.mouse.move(candidate.focus.x, candidate.focus.y);
    await page.mouse.wheel(0, -8);
    await settle();
    const ratio = await scale() / beforeScale;
    const rect = await (await fileTile(candidate.path)).boundingBox();
    ensure(ratio > 1 && rect, "焦点滚轮缩放未生效。");
    const expectedX = candidate.focus.x + (candidate.rect.x - candidate.focus.x) * ratio;
    const expectedY = candidate.focus.y + (candidate.rect.y - candidate.focus.y) * ratio;
    ensure(Math.hypot(rect.x - expectedX, rect.y - expectedY) < 3, "滚轮缩放没有保持鼠标焦点。");
    await button("定位所选文件").click();
  });

  await withoutQuery("拖动平移不选择文件", async () => {
    await map.scrollIntoViewIfNeeded();
    const beforeSelection = await selected();
    const before = await view();
    const x = before.bounds.x + before.bounds.width * .45, y = before.bounds.y + before.bounds.height * .45;
    await page.mouse.move(x, y);
    const started = Date.now();
    await page.mouse.down();
    await page.mouse.move(x + 35, y + 24, { steps: 6 });
    await page.mouse.up();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    dragMilliseconds = Date.now() - started;
    await settle();
    const after = await view();
    ensure(await selected() === beforeSelection, "拖动结束误选了文件。");
    ensure(Math.abs(after.scale / before.scale - 1) < .001, "拖动改变了缩放倍率。");
    ensure(after.rect && Math.hypot(after.rect.x - before.rect.x, after.rect.y - before.rect.y) > 8, "拖动没有平移局部。");
    await button("定位所选文件").click();
  });
  await withoutQuery("目录标题附近拖动不下钻", async () => {
    await button("适应窗口").click();
    await settle();
    await map.scrollIntoViewIfNeeded();
    const title = map.locator(".map-directory").first();
    if (await title.count()) {
      const bounds = await title.boundingBox();
      const previous = await selected();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2 + 32, bounds.y + bounds.height / 2 + 28, { steps: 6 });
      await page.mouse.up();
      await settle();
      ensure(await selected() === previous, "目录标题附近拖动改变了文件选择。");
      ensure(await page.getByRole("button", { name: /^整个仓库/ }).getAttribute("aria-current") === "location", "目录标题拖动误触了下钻。");
    }
    await button("定位所选文件").click();
  });

  await withoutQuery("全屏退出按钮与 Esc", async () => {
    const before = await view();
    await button("全屏查看地图").click();
    await button("退出地图全屏").waitFor({ state: "visible" });
    await settle();
    ensure(await explorer.evaluate(element => document.fullscreenElement === element), "地图没有进入浏览器全屏。");
    preserved(before, await view(), "全屏进入");
    ensure(await page.getByRole("group", { name: "地图着色指标" }).isVisible(), "全屏缺失着色指标。");
    ensure(await page.locator(".breadcrumbs").isVisible() && await page.locator(".map-legend").isVisible(), "全屏缺失目录或图例。");
    ensure(await textIsUnobscured(smallTile), "全屏文件名称或百分比被其他控件遮挡。");
    await explorer.screenshot({ path: `${fixture.artifacts}/fullscreen.png` });
    await mark("fullscreen-exit-button");
    await button("退出地图全屏").click();
    await button("全屏查看地图").waitFor({ state: "visible" });
    await settle();
    preserved(before, await view(), "全屏退出");
    await mark("fullscreen-exit-button", "passed");
    await button("全屏查看地图").click();
    await button("退出地图全屏").waitFor({ state: "visible" });
    await mark("fullscreen-exit-escape");
    await page.keyboard.press("Escape");
    await button("全屏查看地图").waitFor({ state: "visible" });
    await settle();
    ensure(await page.evaluate(() => document.fullscreenElement === null), "Esc 没有退出地图全屏。");
    ensure(await selected() === fixture.small.path, "全屏切换丢失文件选择。");
    preserved(before, await view(), "Esc 退出");
    await mark("fullscreen-exit-escape", "passed");
  });

  await withoutQuery("侧栏切换保留局部", async () => {
    const before = await view();
    await button("收起仓库导航").click();
    await button("收起文件详情").click();
    await settle();
    ensure((await map.boundingBox()).width > before.bounds.width, "侧栏收起未扩大地图。");
    preserved(before, await view(), "侧栏收起");
    ensure(await page.getByRole("navigation", { name: "仓库目录" }).isHidden(), "收起导航后目录仍可访问。");
    await button("展开仓库导航").click();
    await button("展开文件详情").click();
    await settle();
    ensure(await selected() === fixture.small.path, "侧栏切换丢失选择。");
    preserved(before, await view(), "侧栏切换");
  });

  await withoutQuery("着色指标保留视野", async () => {
    const before = await view();
    for (const metric of ["历史修改", "活动次数", "精确读取"]) {
      await button(metric).click();
      await settle();
      ensure(await button(metric).getAttribute("aria-pressed") === "true", "着色指标未切换。");
      preserved(before, await view(), "着色指标切换");
    }
  }, false);
  await withoutQuery("明暗主题与窄屏", async () => {
    const originalTheme = await page.locator("html").getAttribute("data-theme");
    await button("切换主题").click();
    ensure(await page.locator("html").getAttribute("data-theme") !== originalTheme, "主题未切换。");
    await explorer.screenshot({ path: `${fixture.artifacts}/alternate-theme.png` });
    await button("切换主题").click();
    const before = await view();
    for (const viewport of [{ width: 900, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await settle();
      ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "窄屏页面横向溢出。");
      ensure(await button("放大地图").isVisible() && await button("适应窗口").isVisible(), "窄屏缩放入口不可用。");
      const currentFonts = await fonts(smallTile);
      ensure(currentFonts.name >= 12 && currentFonts.value >= 22, "窄屏降低了所选文件名称或指标字号。");
      ensure(await textIsUnobscured(smallTile), "窄屏文件名称或指标被其他控件遮挡。");
    }
    await explorer.screenshot({ path: `${fixture.artifacts}/narrow.png` });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await settle();
    ensure(await selected() === fixture.small.path, "窗口变化丢失文件选择。");
    preserved(before, await view(), "窗口变化");
  });

  const rootAfter = await page.evaluate(async endpoint => (await fetch(endpoint)).json(), fixture.endpoint);
  ensure(JSON.stringify(rootAfter) === JSON.stringify(rootBefore), "缩放、平移和界面切换改变了固定版本覆盖响应。");
  await explorer.screenshot({ path: `${fixture.artifacts}/located.png` });
  let directoryEntryClicked = false;
  if (fixture.directory) {
    const started = Date.now();
    await mark("显式目录切换与范围统计");
    const scopedResponse = page.waitForResponse(guarded(response => {
      const [path, query = ""] = response.url().split("?");
      return path.endsWith("/coverage") && query.split("&").some(pair => pair.startsWith("directory=")
        && decodeURIComponent(pair.slice(10).replace(/\+/g, " ")) === fixture.directory);
    }));
    await button("适应窗口").click();
    await settle();
    const mapEntry = button(`进入目录 ${fixture.directory}`);
    directoryEntryClicked = await mapEntry.isVisible();
    await (directoryEntryClicked ? mapEntry : button(`选择目录 ${fixture.directory}`)).click();
    const scoped = await (await scopedResponse).json();
    await settle();
    ensure(scoped.version === fixture.version && scoped.filters.directory === fixture.directory, "显式目录查询没有绑定范围和版本。");
    ensure(JSON.stringify(scoped.summary) === JSON.stringify(fixture.directorySummary), "显式目录统计与独立 HTTP 查询不一致。");
    await summaryMatches(scoped.summary);
    ensure(await button(`选择目录 ${fixture.directory}`).getAttribute("aria-current") === "location", "目录选择未更新。");
    const scopeScale = await scale();
    await button("适应窗口").click();
    await settle();
    ensure(Math.abs(await scale() / scopeScale - 1) < .001, "显式目录切换未适应新范围。");
    await page.getByRole("button", { name: /^整个仓库/ }).click();
    await settle();
    ensure(Number(await map.getAttribute("data-file-count")) === fixture.nonemptyCount, "返回仓库未恢复文件范围。");
    steps.push({ name: "显式目录切换与范围统计", milliseconds: Date.now() - started });
    await mark("显式目录切换与范围统计", "passed");
  }
  if (fixture.secondary) {
    await mark("切换仓库并恢复完整视野");
    const started = Date.now();
    await chooseRepository(fixture.secondary.path);
    await page.waitForLoadState("networkidle");
    await page.locator(".query-loading").waitFor({ state: "hidden" });
    if (await map.isVisible()) {
      await settle();
      const beforeFit = await scale();
      await button("适应窗口").click();
      await settle();
      ensure(Math.abs(await scale() / beforeFit - 1) < .001, "切换仓库未适应新范围。");
    }
    await chooseRepository(fixture.repository.path);
    await settle();
    ensure(Number(await map.getAttribute("data-file-count")) === fixture.nonemptyCount, "切回目标仓库未恢复文件集合。");
    ensure((await page.locator(".baseline-note").innerText()).includes(fixture.version), "切回仓库改变了结果版本。");
    const restored = await scale();
    await button("适应窗口").click();
    await settle();
    ensure(Math.abs(await scale() / restored - 1) < .001, "切回仓库未适应完整视野。");
    await summaryMatches(fixture.summary);
    steps.push({ name: "切换仓库并恢复完整视野", milliseconds: Date.now() - started });
    await mark("切换仓库并恢复完整视野", "passed");
  }
  ensure(requests.every(method => method === "GET"), "只读验收发出了修改请求。");
  ensure(Object.values(errors).every(count => count === 0), "浏览器发生运行、控制台、HTTP 或网络错误。");
  await mark("验收完成", "passed");
  return {
    status: "passed", fileCount: fixture.fileCount, nonemptyCount: fixture.nonemptyCount,
    smallFileLines: fixture.small.lineCount, locateScaleRatio: Number((locatedScale / fitScale).toFixed(2)),
    initialVisible, locatedVisible, readableCount, locateMilliseconds, wheelMilliseconds, dragMilliseconds,
    errors, steps, directoryChecked: Boolean(fixture.directory), directoryEntryClicked,
    secondaryRepositoryChecked: Boolean(fixture.secondary),
  };
}

try {
  await mkdir(artifacts, { recursive: true });
  assert.ok(target, "请用 AGENT_MANOR_E2E_REPOSITORY 指定已登记仓库的路径或名称。");
  const address = new URL(url);
  const status = await api("/api/v1/status");
  const matches = status.repositories.filter(repository => repository.path === target || repository.name === target);
  assert.equal(matches.length, 1, "指定仓库不存在或名称不唯一；请使用已登记仓库的完整路径。");
  const repository = matches[0];
  const endpoint = `/api/v1/repositories/${encodeURIComponent(repository.id)}/coverage?categories=source`;
  const coverage = await api(endpoint);
  const positive = coverage.files.filter(file => file.lineCount > 0);
  assert.ok(positive.length, "指定仓库没有可供地图验收的非空源码文件。");
  const small = [...positive].sort((a, b) => a.lineCount - b.lineCount || b.readExactLines - a.readExactLines || a.path.length - b.path.length)[0];
  const directoryPath = [...positive].filter(file => file.path.includes("/")).sort((a, b) => b.lineCount - a.lineCount)[0]?.path.split("/")[0];
  const boundEndpoint = `${endpoint}&version=${encodeURIComponent(coverage.version)}`;
  const scoped = directoryPath ? await api(`${boundEndpoint}&directory=${encodeURIComponent(directoryPath)}`) : null;
  const secondary = status.repositories.find(candidate => candidate.id !== repository.id);
  const fixture = {
    url: address.href, artifacts, repository: { path: repository.path }, endpoint: boundEndpoint, version: coverage.version,
    summary: coverage.summary, fileCount: coverage.files.length, nonemptyCount: positive.length,
    small: { path: small.path, lineCount: small.lineCount, percent: `${(small.readExactLines / small.lineCount * 100).toFixed(1)}%` },
    directory: directoryPath, directorySummary: scoped?.summary,
    secondary: secondary ? { path: secondary.path } : undefined,
  };
  const codePath = join(directory, "verify.mjs");
  await writeFile(codePath, `async page => (${verify.toString()})(page, ${JSON.stringify(fixture)})`);
  const configPath = join(directory, "playwright.json");
  await writeFile(configPath, JSON.stringify({ outputDir: join(artifacts, "private-cli") }));
  browserOpened = true;
  await browser(["open", address.href, "--headed", "--browser=chrome", `--config=${configPath}`]);
  const output = await browser(["run-code", `--filename=${codePath}`]);
  await writeFile(join(artifacts, "private-browser-output.txt"), output);
  const result = output.match(/### Result\s*\n([\s\S]*?)\n### /)?.[1]?.trim();
  assert.ok(result, "浏览器没有返回可解析的匿名验收结果。");
  const report = JSON.parse(result.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
  await writeFile(join(artifacts, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "private-failure.txt"), error.stack ?? String(error));
  console.error("FAIL 地图只读浏览器验收；诊断与截图仅保存在 .local/map-zoom-e2e/。");
  process.exitCode = 1;
} finally {
  if (browserOpened) {
    // 只收集本次独立会话的控制台和 daemon 错误，不读取其他会话缓存。
    await browser(["console", "info"]).then(output => writeFile(join(artifacts, "private-console.txt"), output)).catch(() => {});
    await browser(["close"]).catch(() => {});
    for (const name of await readdir(join(directory, "daemon")).catch(() => [])) {
      const data = await readFile(join(directory, "daemon", name, `${session}.err`), "utf8").catch(() => null);
      if (data !== null) await writeFile(join(artifacts, "private-daemon.err"), data);
    }
  }
  await rm(directory, { recursive: true, force: true });
}
