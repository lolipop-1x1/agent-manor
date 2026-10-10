import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { clientIds } from "../dist/clients.js";
import { startService } from "../dist/server.js";

// 管理写操作只作用于隔离合成仓库；覆盖率来自人工历史的真实解析和发布。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp("/tmp/manor-map-boundaries-"));
const artifacts = fileURLToPath(new URL("../.local/map-boundaries-e2e/", import.meta.url));
const session = `map-boundaries-${process.pid}`;
let service;
let opened = false;
const browser = async args => {
  const result = await run("playwright-cli", [`-s=${session}`, ...args], { cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.stdout.includes("### Error")) throw new Error(result.stdout);
  return result.stdout;
};
try {
  await mkdir(artifacts, { recursive: true });
  const repository = join(directory, "synthetic-repository"), historyRoot = join(directory, "history");
  await mkdir(join(repository, "src"), { recursive: true }); await mkdir(historyRoot);
  await run("git", ["init", "-q", repository]);
  const samples = [["untouched-alpha", 600, 0], ["untouched-beta", 500, 0], ["untouched-gamma", 450, 0], ["quarter-read", 420, .2],
    ["half-read", 400, .4], ["mostly-read", 360, .6], ["fully-read", 320, 1], ["untouched-utils", 240, 0], ["untouched-model", 120, 0], ["tiny-a", 1, 0], ["tiny-b", 1, 0]];
  const records = [{ type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { id: "synthetic-boundaries", cwd: repository } }];
  for (const [index, [name, lines, ratio]] of samples.entries()) {
    const content = Array.from({ length: lines }, (_, line) => `export const file${index}Line${line} = ${line};`);
    await writeFile(join(repository, "src", name + ".ts"), content.join("\n") + "\n");
    const read = Math.floor(lines * ratio);
    if (read) records.push(
      { type: "response_item", timestamp: "2026-01-01T00:00:01Z", payload: { type: "function_call", name: "shell_command", call_id: name, arguments: JSON.stringify({ command: `sed -n '1,${read}p' src/${name}.ts`, workdir: repository }) } },
      { type: "response_item", timestamp: "2026-01-01T00:00:02Z", payload: { type: "function_call_output", call_id: name, output: "Exit code: 0\nOutput:\n" + content.slice(0, read).join("\n") + "\n" } },
    );
  }
  await writeFile(join(historyRoot, "synthetic.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
  service = await startService({ home: join(directory, "data"), roots: Object.fromEntries(clientIds.map(client => [client, client === "codex" ? historyRoot : []])),
    resourceInventory: { userHome: join(directory, "isolated-user"), environment: {} }, startupRefresh: false });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const api = async (path, method = "GET", body) => {
    const response = await fetch(`${base}/api/v1${path}`, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200); return response.json();
  };
  await api("/preferences", "PUT", { language: "zh-CN", appearance: { mode: "light", preset: "terracotta" } });
  const registration = await api("/repositories", "POST", { path: repository });
  let completed = false;
  for (let attempt = 0; attempt < 400; attempt++) {
    const { job } = await api(`/jobs/${registration.job.id}`);
    if (job.status === "completed") { completed = true; break; }
    assert.notEqual(job.status, "failed"); await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(completed);
  const coverage = await api(`/repositories/${registration.repository.id}/coverage?categories=source`);
  assert.deepEqual([...new Set(coverage.files.map(file => file.readExactLines === 0 ? 0 : Math.ceil(file.readExactLines / file.lineCount * 4)))].sort(), [0, 1, 2, 3, 4]);
  await browser(["open", base, "--headed", "--browser=chrome"]); opened = true;
  const verify = async (page, fixture) => {
    page.setDefaultTimeout(15_000);
    const checks = [], errors = [];
    const ensure = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); };
    page.on("pageerror", error => errors.push(error.message));
    const button = name => page.getByRole("button", { name, exact: true });
    const settled = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const map = page.locator(".code-map");
    await page.setViewportSize({ width: 1440, height: 1000 }); await map.waitFor(); await page.waitForLoadState("networkidle");
    const rendering = () => page.evaluate(() => {
      const style = getComputedStyle(document.documentElement), fills = [...document.querySelectorAll('.map-colors path[class^="tone-"]')];
      const borders = [...document.querySelectorAll(".map-boundary")];
      const lum = color => { const channels = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4); return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722; };
      const contrast = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
      const rectangles = path => [...path.matchAll(/M([\d.eE+-]+),([\d.eE+-]+)h([\d.eE+-]+)v([\d.eE+-]+)h[\d.eE+-]+Z/g)].map(match => match.slice(1, 5).map(Number));
      return { fillCount: fills.length, borderCount: borders.length,
        painted: borders.filter(path => path.getAttribute("d")).length,
        styles: borders.every((path, index) => getComputedStyle(path).fill === "none" && getComputedStyle(path).stroke !== "none" && getComputedStyle(path).strokeWidth === "1px"
          && contrast(style.getPropertyValue(`--map-${index}`).trim(), style.getPropertyValue(`--map-${index}-border`).trim()) >= 2),
        geometry: borders.every((path, index) => rectangles(path.getAttribute("d")).every(([x, y, width, height]) => width > 8 && height > 8
          && rectangles(fills[index].getAttribute("d")).some(([fx, fy, fw, fh]) => Math.abs(fx - x - .5) < .001 && Math.abs(fy - y - .5) < .001 && Math.abs(fw - width + 1) < .001 && Math.abs(fh - height + 1) < .001))),
        small: fills.flatMap(path => rectangles(path.getAttribute("d"))).filter(([, , width, height]) => width <= 8 || height <= 8).length };
    });
    const checkRendering = async label => {
      const state = await rendering();
      ensure(state.fillCount === 5 && state.borderCount === 5 && state.painted > 0 && state.styles && state.geometry, label + "：共享边界固定1px、实际SVG颜色可区分、原填充内缩不变");
      return state;
    };
    ensure((await checkRendering("浅色赤陶适配全图")).small > 0, "小于等于8px的方块仍无边界");
    await page.screenshot({ path: fixture.artifacts + "/terracotta-light-fit.png" });
    const select = page.locator('.map-file[data-path="src/untouched-beta.ts"]');
    await select.click(); await page.locator(".map-file.selected").waitFor(); await select.focus();
    await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
    ensure(await select.evaluate(node => getComputedStyle(node).boxShadow !== "none" && getComputedStyle(node).outlineStyle !== "none"), "选中与键盘焦点保持明确边界");
    await button("放大地图").click(); await button("放大地图").click(); await settled();
    await checkRendering("放大视图");
    const before = await map.getAttribute("data-scale");
    await page.screenshot({ path: fixture.artifacts + "/terracotta-light-zoom.png" });
    for (const mode of ["light", "dark"]) for (const preset of ["blue", "terracotta", "celadon", "amber", "berry", "graphite", "custom"]) {
      await page.evaluate(async appearance => {
        const response = await fetch("/api/v1/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appearance }) });
        if (!response.ok) throw new Error("合成偏好更新失败"); window.dispatchEvent(new Event("focus"));
      }, { mode, preset, customColor: "#ffff00" });
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, mode); await page.waitForLoadState("networkidle"); await settled();
      await checkRendering(mode + " " + preset);
      ensure(await map.getAttribute("data-scale") === before && await select.getAttribute("class").then(value => value.includes("selected")), "主题切换保留缩放和文件选择 " + mode + " " + preset);
      if (preset === "terracotta" && mode === "dark") await page.screenshot({ path: fixture.artifacts + "/terracotta-dark-zoom.png" });
    }
    await button("适应窗口").click(); await page.setViewportSize({ width: 390, height: 844 }); await settled();
    await checkRendering("390px窄屏"); await page.screenshot({ path: fixture.artifacts + "/narrow-dark.png" });
    ensure(errors.length === 0, "浏览器无运行异常");
    return { passed: true, checks, errors };
  };
  const output = await browser(["run-code", `async page => (${verify.toString()})(page,${JSON.stringify({ artifacts })})`]);
  await writeFile(join(artifacts, "browser-report.txt"), output); console.log(output.split("### Ran Playwright code")[0]);
} catch (error) {
  if (opened) await browser(["screenshot", `--filename=${join(artifacts, "failure.png")}`]).catch(() => {});
  await writeFile(join(artifacts, "failure.txt"), String(error)); throw error;
} finally {
  if (opened) await browser(["close"]).catch(() => {});
  await service?.close(); await rm(directory, { recursive: true, force: true });
}
