import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// 仅验收静态官网和合成预览，不启动产品服务，也不读取本机历史。
const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = join(root, ".local", "manor-site-e2e");
const directory = await mkdtemp("/tmp/manor-site-e2e-");
const session = `site-${process.pid}-${Date.now().toString(36)}`;
const origin = "http://127.0.0.1:4187";
const base = "/agent-manor/";
const address = `${origin}${base}`;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let browserOpened = false;
let service;
let serviceOutput = "";
let serviceFailure;

async function browser(args) {
  let output;
  try {
    const result = await run("playwright-cli", [`-s=${session}`, ...args], {
      cwd: directory,
      env: { ...process.env, TMPDIR: "/tmp", PLAYWRIGHT_DAEMON_SESSION_DIR: join(directory, "daemon") },
      timeout: 240_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    output = result.stdout;
  } catch (error) {
    await writeFile(join(artifacts, `private-${args[0]}-output.txt`), `${error.stdout ?? ""}\n${error.stderr ?? ""}`);
    throw new Error("官网浏览器命令失败；完整诊断保存在 .local/manor-site-e2e/。", { cause: error });
  }
  if (output.includes("### Error")) {
    await writeFile(join(artifacts, `private-${args[0]}-output.txt`), output);
    throw new Error("官网浏览器断言失败；完整诊断保存在 .local/manor-site-e2e/。");
  }
  return output;
}

async function verify(page, fixture) {
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  const steps = [];
  const requests = [];
  const errors = { page: [], console: [], http: [], request: [], listener: [] };
  const expectedFallbackErrors = [];
  const screenshots = [];
  const images = [];
  const guarded = handler => value => {
    try { handler(value); } catch (error) { errors.listener.push(String(error)); }
  };
  function observe(target, fallback = false) {
    target.on("pageerror", guarded(error => errors.page.push(String(error))));
    target.on("console", guarded(message => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (fallback && /Error creating WebGL context/.test(text)) expectedFallbackErrors.push(text);
      else errors.console.push(text);
    }));
    target.on("response", guarded(response => {
      if (response.status() >= 400) errors.http.push({ status: response.status(), url: response.url() });
    }));
    target.on("requestfailed", guarded(request => {
      const error = request.failure()?.errorText ?? "unknown";
      if (!error.includes("ERR_ABORTED")) errors.request.push({ error, url: request.url() });
    }));
    target.on("request", guarded(request => requests.push({ method: request.method(), url: request.url(), type: request.resourceType() })));
  }
  async function step(name, action) {
    const started = Date.now();
    await page.evaluate(value => console.info(`MANOR_SITE_E2E ${value}`), name);
    try { await action(); }
    catch (error) {
      await page.screenshot({ path: `${fixture.artifacts}/failure.png` }).catch(() => {});
      throw new Error(`${name}：${String(error)}`);
    }
    steps.push({ name, milliseconds: Date.now() - started });
  }
  async function screenshot(name, target = page) {
    await target.screenshot({ path: `${fixture.artifacts}/${name}.png` });
    screenshots.push(`${name}.png`);
  }
  async function resourceSizes() {
    return page.evaluate(() => {
      const entries = performance.getEntriesByType("resource").map(entry => ({
        path: new URL(entry.name).pathname,
        initiatorType: entry.initiatorType,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
        transferSize: entry.transferSize,
        durationMs: Number(entry.duration.toFixed(2)),
      }));
      const summarize = values => ({
        requestCount: values.length,
        encodedBodySize: values.reduce((sum, entry) => sum + entry.encodedBodySize, 0),
        decodedBodySize: values.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
        transferSize: values.reduce((sum, entry) => sum + entry.transferSize, 0),
      });
      const fonts = entries.filter(entry => /\.woff2$/.test(entry.path));
      const scripts = entries.filter(entry => /\.m?js$/.test(entry.path));
      const threeScripts = scripts.filter(entry => /\/three-[^/]+\.js$/.test(entry.path));
      const applicationScripts = scripts.filter(entry => !threeScripts.includes(entry));
      return {
        total: summarize(entries),
        fonts: { ...summarize(fonts), files: fonts },
        threeScripts: { ...summarize(threeScripts), files: threeScripts },
        applicationScripts: { ...summarize(applicationScripts), files: applicationScripts },
        entries,
      };
    });
  }
  const button = name => page.getByRole("button", { name, exact: true });
  const host = page.locator(".manor-renderer");
  const canvas = host.locator("canvas");
  const camera = () => host.getAttribute("data-camera");
  const sceneTime = async () => Number(await host.getAttribute("data-scene-time"));
  const scroll = () => page.evaluate(() => window.scrollY);
  const nextFrames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function changedCamera(before) {
    await page.waitForFunction(value => {
      const valueNow = document.querySelector(".manor-renderer")?.getAttribute("data-camera");
      return valueNow && valueNow !== value;
    }, before);
  }
  async function restoredCamera(expected) {
    await page.waitForFunction(value => document.querySelector(".manor-renderer")?.getAttribute("data-camera") === value, expected);
  }
  async function settledCamera() {
    // 镜头动画为 850ms；随后等待连续稳定帧，不依赖 Three.js 私有对象。
    await page.evaluate(() => new Promise((resolve, reject) => {
      const start = performance.now();
      let previous = "", same = 0;
      const sample = now => {
        const value = document.querySelector(".manor-renderer")?.getAttribute("data-camera") ?? "";
        same = value && value === previous ? same + 1 : 0;
        previous = value;
        if (now - start > 1000 && same >= 4) resolve(undefined);
        else if (now - start > 10_000) reject(new Error("镜头未在期限内稳定。"));
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }));
    return camera();
  }
  async function visibleCanvasPoint() {
    return canvas.evaluate(element => {
      const rect = element.getBoundingClientRect();
      for (const [xFraction, yFraction] of [[.73, .48], [.8, .36], [.66, .64], [.87, .6]]) {
        const x = rect.x + rect.width * xFraction;
        const y = rect.y + rect.height * yFraction;
        if (document.elementFromPoint(x, y) === element) return { x, y };
      }
      throw new Error("没有找到未被网页控件遮挡的场景操作点。");
    });
  }
  async function top() {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.waitForFunction(() => document.querySelector(".manor-renderer")?.getAttribute("data-visible") === "true");
    await nextFrames();
  }
  async function checkFeatureImages(language) {
    const names = language === "zh" ? ["总览", "会话库", "代码地图", "资源管理"] : ["Overview", "Sessions", "Code map", "Resources"];
    const keys = ["overview", "sessions", "code-map", "resources"];
    for (let index = 0; index < keys.length; index += 1) {
      const tab = page.getByRole("tab", { name: names[index], exact: true });
      await tab.click();
      ensure(await tab.getAttribute("aria-selected") === "true", `${names[index]}未被选中。`);
      const panel = page.getByRole("tabpanel", { name: names[index], exact: true });
      await panel.waitFor({ state: "visible" });
      const image = panel.getByRole("img");
      await image.scrollIntoViewIfNeeded();
      const asset = await image.evaluate(async element => {
        await element.decode();
        return { src: element.currentSrc, width: element.naturalWidth, height: element.naturalHeight, alt: element.alt, complete: element.complete };
      });
      ensure(asset.complete && asset.width === 1440 && asset.height === 1000, `${names[index]}产品截图没有完整加载。`);
      ensure(asset.src.endsWith(`/previews/${keys[index]}-${language}.png`), "语言与产品截图不一致。");
      ensure(asset.src.includes(fixture.base), "产品截图没有沿用 GitHub Pages 项目路径。");
      ensure(asset.alt.length > 15, "产品截图缺少有意义的替代文本。");
      images.push({ feature: keys[index], language, width: asset.width, height: asset.height });
    }
  }

  page.setDefaultTimeout(20_000);
  observe(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.origin });
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(2000);
    localStorage.setItem("agent-manor-site-language", "zh-CN");
  });
  let initialCamera, teaCamera, frameSample, canvasIdentity, firstScreenResources;

  await step("项目路径加载庄园和中文页面", async () => {
    await page.goto(fixture.address, { waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean(document.querySelector(".manor-renderer")?.getAttribute("data-camera")));
    ensure(await canvas.count() === 1, "实时场景没有唯一画布。");
    ensure(await canvas.getAttribute("tabindex") === "0", "画布无法通过键盘聚焦。");
    ensure((await canvas.getAttribute("aria-label"))?.includes("方向键"), "画布缺少键盘操作说明。");
    ensure(await button("庄园全景").isEnabled(), "全景控制尚未就绪。");
    ensure(await page.locator("html").getAttribute("lang") === "zh-CN", "初始语言不是简体中文。");
    initialCamera = await settledCamera();
    canvasIdentity = await canvas.elementHandle();
    await screenshot("01-estate-zh");
    firstScreenResources = await resourceSizes();
  });

  await step("鼠标拖动与方向键旋转", async () => {
    const beforeDrag = await camera();
    const point = await visibleCanvasPoint();
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x - 130, point.y + 32, { steps: 12 });
    await page.mouse.up();
    await changedCamera(beforeDrag);
    const beforeKey = await camera();
    await canvas.focus();
    await page.keyboard.press("ArrowRight");
    await changedCamera(beforeKey);
    ensure(await page.getByRole("dialog").count() === 0, "旋转误打开了安装面板。");
  });

  await step("Ctrl滚轮缩放与普通滚轮阅读", async () => {
    const before = await camera();
    const scrollBefore = await scroll();
    const point = await visibleCanvasPoint();
    await page.mouse.move(point.x, point.y);
    await page.keyboard.down("Control");
    try { await page.mouse.wheel(0, -160); }
    finally { await page.keyboard.up("Control"); }
    await changedCamera(before);
    const afterZoom = await camera();
    ensure(Number(afterZoom.split(",")[6]) > Number(before.split(",")[6]), "Ctrl滚轮没有放大庄园。");
    ensure(Math.abs(await scroll() - scrollBefore) < 2, "Ctrl滚轮同时滚动了页面。");
    await page.mouse.wheel(0, 1100);
    await page.waitForFunction(() => window.scrollY > 200);
    ensure(await camera() === afterZoom, "普通滚轮改变了场景缩放。");
    await page.locator("#product").scrollIntoViewIfNeeded();
    ensure(await page.getByRole("tablist", { name: "产品能力" }).isVisible(), "普通滚动后无法阅读产品介绍。");
    await top();
  });

  await step("暂停和恢复时间", async () => {
    await button("暂停动效").click();
    await page.waitForFunction(() => document.querySelector(".manor-renderer")?.getAttribute("data-paused") === "true");
    await nextFrames();
    const pausedTime = await sceneTime();
    await page.waitForTimeout(350);
    ensure(await sceneTime() === pausedTime, "暂停后场景时间仍在推进。");
    await button("播放动效").click();
    await page.waitForFunction(before => Number(document.querySelector(".manor-renderer")?.getAttribute("data-scene-time")) > before + .05, pausedTime);
  });

  await step("开始使用推进镜头、复制规划命令、Escape还原", async () => {
    const before = await camera();
    const opener = page.locator(".hero-actions").getByRole("button", { name: "开始使用", exact: true });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "欢迎来到庄园" });
    await dialog.waitFor({ state: "visible" });
    await changedCamera(before);
    await settledCamera();
    ensure(await host.getAttribute("data-view") === "installation", "安装没有进入近景状态。");
    ensure((await dialog.innerText()).includes("规划占位"), "安装面板没有明确规划占位。");
    ensure((await dialog.innerText()).includes("尚未公共发布"), "安装面板误导用户以为已发布。");
    for (const [name, command] of [["复制安装命令", "npm install -g agent-manor"], ["复制启动命令", "agent-manor start"]]) {
      await dialog.getByRole("button", { name, exact: true }).click();
      await page.waitForFunction(label => {
        const control = Array.from(document.querySelectorAll(".copy-button")).find(element => element.getAttribute("aria-label") === label);
        return control?.closest("li")?.querySelector(".copy-status")?.textContent === "已复制";
      }, name);
      ensure(await page.evaluate(() => navigator.clipboard.readText()) === command, "实际剪贴板内容与安装命令不一致。");
    }
    await screenshot("02-installation");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await restoredCamera(before);
    ensure(await opener.evaluate(element => element === document.activeElement), "Escape后没有恢复开始使用按钮焦点。");
  });

  await step("茶庭、全景和重置保留各自视角", async () => {
    await button("茶庭近景").click();
    teaCamera = await settledCamera();
    ensure(await host.getAttribute("data-view") === "tea" && teaCamera !== initialCamera, "茶庭近景没有切换。");
    await screenshot("03-tea-garden");
    await canvas.focus();
    await page.keyboard.press("ArrowLeft");
    await changedCamera(teaCamera);
    await button("重置视角").click();
    await restoredCamera(teaCamera);
    await button("庄园全景").click();
    await restoredCamera(initialCamera);
    ensure(await host.getAttribute("data-view") === "estate", "返回全景没有更新状态。");
  });

  await step("30帧桌面rAF采样", async () => {
    frameSample = await page.evaluate(() => new Promise(resolve => {
      const samples = [];
      let previous;
      const sample = now => {
        if (previous !== undefined) samples.push(now - previous);
        previous = now;
        if (samples.length < 30) { requestAnimationFrame(sample); return; }
        const sorted = [...samples].sort((a, b) => a - b);
        const renderer = document.querySelector(".manor-renderer");
        resolve({
          frames: samples.length,
          meanMs: Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(2)),
          medianMs: Number(sorted[15].toFixed(2)), p95Ms: Number(sorted[28].toFixed(2)), maxMs: Number(sorted[29].toFixed(2)),
          drawCalls: Number(renderer?.getAttribute("data-draw-calls")), triangles: Number(renderer?.getAttribute("data-triangles")),
          viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        });
      };
      requestAnimationFrame(sample);
    }));
    ensure(frameSample.frames === 30 && frameSample.drawCalls > 0 && frameSample.triangles > 0, "没有取得有效帧采样。");
  });

  await step("中英四个产品Tab与八张真实界面预览", async () => {
    await checkFeatureImages("zh");
    const resources = page.getByRole("tab", { name: "资源管理", exact: true });
    await resources.focus();
    await page.keyboard.press("Home");
    ensure(await page.getByRole("tab", { name: "总览", exact: true }).getAttribute("aria-selected") === "true", "Home未选择第一个产品Tab。");
    await page.keyboard.press("ArrowRight");
    ensure(await page.getByRole("tab", { name: "会话库", exact: true }).getAttribute("aria-selected") === "true", "方向键未选择下一产品Tab。");
    await screenshot("04-product-zh");
    await top();
    await button("暂停动效").click();
    await nextFrames();
    const beforeLanguage = { camera: await camera(), time: await sceneTime() };
    await button("切换为 English").click();
    await page.waitForFunction(() => document.documentElement.lang === "en");
    ensure(await canvasIdentity.evaluate(element => element.isConnected && element === document.querySelector(".manor-renderer canvas")), "切换语言重建了canvas。");
    ensure(await camera() === beforeLanguage.camera && await sceneTime() === beforeLanguage.time, "切换语言丢失了镜头或暂停状态。");
    ensure(await page.getByRole("tab", { name: "Sessions", exact: true }).getAttribute("aria-selected") === "true", "切换语言丢失了选中的产品。");
    ensure((await canvas.getAttribute("aria-label"))?.includes("arrow keys"), "画布操作说明没有翻译。");
    await screenshot("05-estate-en");
    await checkFeatureImages("en");
    await screenshot("06-product-en");
    ensure(images.length === 8, "没有验收全部中英产品预览。");
    await top();
    await button("切换为简体中文").click();
    await button("播放动效").click();
  });

  await step("页尾可达、离屏暂停及底部CTA滚动恢复", async () => {
    await page.locator("footer").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector(".manor-renderer")?.getAttribute("data-visible") === "false");
    const hiddenTime = await sceneTime();
    await page.waitForTimeout(350);
    ensure(await sceneTime() === hiddenTime, "场景离屏后仍在推进动画。");
    ensure(await page.locator("footer").evaluate(element => element.getBoundingClientRect().bottom <= innerHeight + 2), "页尾不能完整到达。");
    const opener = page.locator(".closing-section").getByRole("button", { name: "开始使用", exact: true });
    await opener.scrollIntoViewIfNeeded();
    const originalScroll = await scroll();
    const originalCamera = await camera();
    await opener.click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    ensure(await scroll() < 100, "底部开始使用没有带用户回到庄园。");
    await settledCamera();
    await page.getByRole("button", { name: "返回庄园", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    // Radix 在卸载后的任务中恢复焦点；面板消失不代表滚动恢复回调已执行。
    await page.waitForFunction(expected => Math.abs(window.scrollY - expected) < 2
      && document.activeElement === document.querySelector(".closing-section > button"), originalScroll);
    ensure(Math.abs(await scroll() - originalScroll) < 2, "关闭底部CTA面板后没有恢复滚动位置。");
    ensure(await opener.evaluate(element => element === document.activeElement), "底部CTA关闭后没有恢复焦点。");
    await top();
    await restoredCamera(originalCamera);
    await page.waitForFunction(before => Number(document.querySelector(".manor-renderer")?.getAttribute("data-scene-time")) > before, hiddenTime);
  });

  await step("减少动态效果自动暂停且镜头直接切换", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => document.querySelector(".manor-renderer")?.getAttribute("data-paused") === "true");
    await nextFrames();
    const pausedTime = await sceneTime();
    await page.waitForTimeout(350);
    ensure(await sceneTime() === pausedTime, "减少动态效果后场景仍在运行。");
    await button("茶庭近景").click();
    await nextFrames();
    ensure(await camera() === teaCamera, "减少动态效果仍执行了缓动镜头过渡。");
    await button("庄园全景").click();
    await nextFrames();
    ensure(await camera() === initialCamera, "减少动态效果的全景切换没有直接到位。");
    await page.locator(".hero-actions").getByRole("button", { name: "开始使用", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "visible" });
    await nextFrames();
    ensure(await camera() === teaCamera, "减少动态效果的安装近景没有直接到位。");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await nextFrames();
    ensure(await camera() === initialCamera, "减少动态效果的镜头还原没有直接到位。");
    await screenshot("07-reduced-motion");
  });

  await step("WebGL不可用仍可阅读产品和安装指南", async () => {
    const fallback = await page.context().newPage();
    try {
      observe(fallback, true);
      fallback.setDefaultTimeout(20_000);
      await fallback.setViewportSize({ width: 1440, height: 1000 });
      // 只在这个独立标签页模拟浏览器能力缺失，不修改生产代码。
      await fallback.addInitScript(() => {
        localStorage.setItem("agent-manor-site-language", "zh-CN");
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...options) {
          if (kind === "webgl" || kind === "webgl2" || kind === "experimental-webgl") return null;
          return original.call(this, kind, ...options);
        };
      });
      await fallback.goto(fixture.address, { waitUntil: "networkidle" });
      await fallback.getByRole("heading", { name: "庄园暂时无法展示", exact: true }).waitFor({ state: "visible" });
      ensure(await fallback.locator(".manor-renderer canvas").count() === 0, "WebGL失败后仍留下无效画布。");
      await fallback.locator(".hero-actions").getByRole("button", { name: "开始使用", exact: true }).click();
      const dialog = fallback.getByRole("dialog", { name: "欢迎来到庄园" });
      await dialog.waitFor({ state: "visible" });
      ensure((await dialog.innerText()).includes("agent-manor start"), "WebGL不可用时丢失安装步骤。");
      await fallback.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await screenshot("08-webgl-fallback", fallback);
      await fallback.getByRole("tab", { name: "会话库", exact: true }).click();
      const image = fallback.getByRole("tabpanel", { name: "会话库", exact: true }).getByRole("img");
      await image.scrollIntoViewIfNeeded();
      ensure(await image.evaluate(async element => { await element.decode(); return element.naturalWidth > 0; }), "WebGL不可用时产品预览无法加载。");
      await fallback.locator("footer").scrollIntoViewIfNeeded();
      ensure(await fallback.locator("footer").getByRole("link", { name: "GitHub", exact: true }).isVisible(), "WebGL不可用时页尾不可用。");
    } finally {
      await fallback.close();
      await page.bringToFront();
    }
  });

  const externalRequests = requests.filter(request => !request.url.startsWith(`${fixture.origin}/`) && !/^(data:|blob:)/.test(request.url));
  const apiRequests = requests.filter(request => /\/api(?:\/|[?#]|$)/.test(request.url));
  ensure(externalRequests.length === 0, "静态官网发出了额外的公网请求。");
  ensure(apiRequests.length === 0, "静态官网请求了产品后台API。");
  ensure(Object.values(errors).every(items => items.length === 0), `浏览器出现错误：${JSON.stringify(errors)}`);
  const fullVisitResources = await resourceSizes();
  return {
    status: "passed", base: fixture.base, steps, images, screenshots, errors, expectedFallbackErrors,
    requests, externalRequests, apiRequests, frameSample,
    resourceLoading: {
      firstScreen: firstScreenResources,
      fullVisit: fullVisitResources,
      scope: "同源 Resource Timing 字节统计；首屏在初次加载和截图后采集，完整访问包含中英切换与交互，不含另一个 WebGL 降级标签页。transferSize 为本次传输量，缓存命中可能为零。",
    },
    performanceScope: "独立Chrome桌面会话的30帧rAF间隔，仅记录本次设备表现，不等同GPU时间或通用帧率承诺。",
  };
}

try {
  await mkdir(artifacts, { recursive: true });
  const build = await run("npm", ["run", "build:site"], {
    cwd: root, env: { ...process.env, SITE_BASE_PATH: base }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  await writeFile(join(artifacts, "build-output.txt"), `${build.stdout}\n${build.stderr}`);
  service = spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "preview", "--config", "site/vite.config.ts", "--host", "127.0.0.1", "--port", "4187", "--strictPort"], {
    cwd: root, env: { ...process.env, SITE_BASE_PATH: base, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  service.stdout.on("data", chunk => { serviceOutput += chunk; });
  service.stderr.on("data", chunk => { serviceOutput += chunk; });
  service.on("error", error => { serviceFailure = error; });
  const started = Date.now();
  while (!serviceOutput.includes(address)) {
    if (serviceFailure) throw serviceFailure;
    if (service.exitCode !== null) throw new Error("官网独立预览服务启动失败，可能是4187端口已被占用。");
    if (Date.now() - started > 20_000) throw new Error("官网独立预览服务启动超时。");
    await pause(100);
  }
  const response = await fetch(address, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200, "项目路径预览没有返回静态入口。");
  assert.ok((await response.text()).includes(base), "production入口没有使用GitHub Pages项目路径。");
  const configPath = join(directory, "playwright.json");
  const codePath = join(directory, "verify.mjs");
  await writeFile(configPath, JSON.stringify({ outputDir: join(artifacts, "private-cli") }));
  await writeFile(codePath, `async page => (${verify.toString()})(page, ${JSON.stringify({ artifacts, origin, base, address })})`);
  browserOpened = true;
  await browser(["open", "about:blank", "--headed", "--browser=chrome", `--config=${configPath}`]);
  const output = await browser(["run-code", `--filename=${codePath}`]);
  await writeFile(join(artifacts, "private-browser-output.txt"), output);
  const json = output.match(/### Result\s*\n([\s\S]*?)\n### /)?.[1]?.trim();
  assert.ok(json, "浏览器没有返回可解析的验收结果。");
  const report = JSON.parse(json.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
  await writeFile(join(artifacts, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    status: report.status, passed: report.steps.length, productPreviews: report.images.length,
    externalRequests: report.externalRequests.length, apiRequests: report.apiRequests.length,
    frameSample: report.frameSample,
    firstScreenResources: Object.fromEntries(["total", "fonts", "threeScripts", "applicationScripts"].map(key => {
      const { requestCount, encodedBodySize, transferSize } = report.resourceLoading.firstScreen[key];
      return [key, { requestCount, encodedBodySize, transferSize }];
    })),
    artifacts: ".local/manor-site-e2e/",
  }, null, 2));
} catch (error) {
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, "private-failure.txt"), error.stack ?? String(error));
  console.error("FAIL 官网浏览器验收；诊断与截图保存在 .local/manor-site-e2e/。");
  process.exitCode = 1;
} finally {
  if (browserOpened) {
    await browser(["console", "info"]).then(output => writeFile(join(artifacts, "private-console.txt"), output)).catch(() => {});
    await browser(["network"]).then(output => writeFile(join(artifacts, "private-network.txt"), output)).catch(() => {});
    await browser(["close"]).catch(() => {});
    for (const name of await readdir(join(directory, "daemon")).catch(() => [])) {
      const output = await readFile(join(directory, "daemon", name, `${session}.err`), "utf8").catch(() => null);
      if (output !== null) await writeFile(join(artifacts, "private-daemon.err"), output);
    }
  }
  if (service && service.exitCode === null && service.signalCode === null && !serviceFailure) {
    const exited = once(service, "exit");
    service.kill("SIGTERM");
    await Promise.race([exited, pause(3000)]);
    if (service.exitCode === null && service.signalCode === null) {
      service.kill("SIGKILL");
      await Promise.race([exited, pause(3000)]);
    }
  }
  await writeFile(join(artifacts, "preview-output.txt"), serviceOutput).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
