import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";
import { writePreferences } from "../dist/service/preferences.js";

// 独立数据目录与人工历史，真实会话验证另存于本机辅助工具。
const run = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-session-replay-")));
const artifacts = fileURLToPath(new URL("../.local/session-code-replay-e2e/", import.meta.url));
const browserName = `session-replay-${process.pid}`;
const repository = join(directory, "repo");
const roots = Object.fromEntries(clientIds.map(client => [client, []]));
roots.codex = join(directory, "codex");
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${browserName}`, ...args], {
    cwd: directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
const encode = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const stamp = second => second === undefined ? {} : { timestamp: new Date(Date.parse("2026-10-09T00:00:00Z") + second * 1_000).toISOString() };
const record = (payload, second, type = "response_item") => ({ type, ...stamp(second), payload });
const command = (id, text, second, output, code = 0) => [
  record({ type: "function_call", name: "shell_command", call_id: id, arguments: JSON.stringify({ command: text, workdir: repository }) }, second),
  ...(output === undefined ? [] : [record({ type: "function_call_output", call_id: id, output: `Exit code: ${code}\nOutput:\n${output}` }, second)]),
];
const patch = (id, paths, second, status = "success") => [
  record({ type: "custom_tool_call", name: "apply_patch", call_id: id,
    input: `*** Begin Patch\n${paths.map(path => `*** Update File: ${path}\n@@\n-alpha\n+beta\n`).join("")}*** End Patch` }, second),
  ...(status === "unknown" ? [] : [record({ type: "custom_tool_call_output", call_id: id,
    output: status === "failure" ? "Exit code: 1\nOutput:\nFailed to find expected lines\n" : `Success. Updated the following files:\n${paths.map(path => `M ${path}`).join("\n")}\n` }, second)]),
];
const history = (id, title, events, parent) => [
  record({ id, cwd: repository, title,
    ...(parent ? { source: { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: `/root/${id}` } } } } : {}) }, 0, "session_meta"),
  record({ type: "message", role: "user", content: [{ type: "input_text", text: title }] }, 1),
  ...events,
  record({ type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "合成验收任务完成。" }] }, 601),
];

async function verifyBrowser(page, fixture) {
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  page.setDefaultTimeout(20_000);
  const errors = [], failedRequests = [], requests = [], failedResponses = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("request", request => { if (request.url().includes("/api/v1/")) requests.push(request.url()); });
  page.on("requestfailed", request => { if (!request.failure()?.errorText?.includes("ERR_ABORTED")) failedRequests.push(request.url()); });
  page.on("response", response => { if (response.url().includes("/api/v1/") && response.status() >= 400) failedResponses.push({ url: response.url(), status: response.status() }); });
  const button = name => page.getByRole("button", { name, exact: true });
  const tab = name => page.getByRole("tab", { name, exact: true });
  const picker = () => button("回放会话");
  const search = () => page.getByRole("combobox", { name: "回放会话搜索", exact: true });
  const slider = () => page.getByRole("slider", { name: "回放进度", exact: true });
  const settle = async () => { await page.waitForLoadState("networkidle"); };
  const choose = async title => {
    await picker().click(); await search().fill(title);
    await page.getByRole("option").filter({ hasText: title }).first().click();
    await slider().waitFor(); await settle();
  };
  const position = async () => Number(await page.locator(".activity-replay").getAttribute("data-position"));
  const snapshot = name => page.screenshot({ path: `${fixture.artifacts}/${name}.png` });
  await page.setViewportSize({ width: 1440, height: 960 });
  await tab("活动分布").waitFor();
  await tab("活动回放").click(); await picker().waitFor();
  const distribution = tab("活动分布"), replay = tab("活动回放");
  const [distributionBounds, replayBounds] = await Promise.all([distribution.boundingBox(), replay.boundingBox()]);
  ensure(Math.abs(distributionBounds.y - replayBounds.y) < 4, "两个功能 Tab 未在同一工作区栏对齐");
  ensure((await page.locator(".code-map-toolbar").boundingBox()).height <= 60, "桌面工作区工具栏仍占用多行大标题空间");
  await choose("并行主会话");
  ensure(await button("播放").isVisible(), "选中会话后不应自动播放");
  ensure(await page.locator(".replay-track-row[data-track-id]").count() === 4, "主会话和三个子会话未完整分轨");
  await snapshot("replay-desktop-start");
  await button("播放").click(); await button("暂停").waitFor();
  const requestsBefore = requests.length;
  await page.waitForFunction(() => Number(document.querySelector(".activity-replay")?.dataset.position) > 0);
  await button("暂停").click();
  const paused = await position();
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350)));
  ensure(await position() === paused, "暂停后播放头仍推进");
  const requestsDuringPlayback = requests.length - requestsBefore;
  ensure(requestsDuringPlayback <= 2, "播放推进逐帧请求 API");
  const speed = page.getByRole("combobox", { name: "播放速度", exact: true });
  await speed.click();
  await page.getByRole("option", { name: "4×", exact: true }).click();
  ensure((await speed.innerText()).includes("4"), "倍速选择没有生效");
  // 键盘定位与鼠标拖动共享同一播放头，并检查回退会清除未来累计状态。
  await slider().focus(); await slider().press("End");
  const end = await position();
  ensure(end > paused, "End 无法定位终点");
  const visited = async () => page.locator("[data-replay-visited]").evaluateAll(elements => elements.filter(element => Number(element.dataset.replayVisited) > 0).length);
  const finalVisited = await visited();
  ensure(finalVisited > 0, "结束位置没有累计文件活动");
  await snapshot("replay-desktop-final");
  await slider().press("Home");
  ensure(await position() < end, "Home 无法返回开头");
  ensure(await visited() < finalVisited, "向后定位保留了未来活动痕迹");
  const bar = await slider().boundingBox();
  await page.mouse.click(bar.x + bar.width * 0.45, bar.y + bar.height / 2);
  ensure(await position() > 0 && await position() < end, "鼠标无法定位回放进度");
  await slider().press("Home");
  await button("下一活动").click();
  ensure(await position() > 0, "无法跳到下一活动");
  ensure(await page.locator('[data-replay-current="true"]').count() >= 3, "并行子会话同一时刻未同时高亮三个文件");
  await button("下一活动").click();
  ensure(await page.locator('[data-replay-current="true"]').count() === 2, "同一调用的两个修改文件未同时高亮");
  await button("下一活动").click();
  await button("查看当前全部 4 个活动").click();
  ensure(await page.locator(".replay-activity-list").getByRole("button").count() === 4, "四轨同刻活动未全部提供证据入口");
  await snapshot("replay-concurrent");
  await button("关闭活动证据").click();
  await button("上一活动").click();
  await button("播放").click();
  await tab("活动分布").click(); await tab("活动回放").click();
  ensure(await button("播放").isVisible(), "切换 Tab 后仍在自动播放");
  // 选择活动同时暂停，原始证据和会话返回链路使用真实解析结果。
  await button("下一活动").click();
  await page.locator("[data-step-id]").first().click();
  ensure(await button("播放").isVisible(), "打开活动证据未暂停");
  await page.getByRole("complementary", { name: "活动证据", exact: true }).waitFor();
  await snapshot("replay-evidence");
  await button("关闭活动证据").click();
  // 同轨同刻、全部基线外的活动必须仍能从同一个时间点逐项读取证据。
  await choose("同轨六项活动");
  ensure(await page.locator(".replay-track-row[data-track-id]").count() === 1, "独立同轨样本混入其他会话");
  ensure(await page.locator(".replay-step-hit[data-step-id]").count() === 6, "六个同刻调用发生隐性截断");
  await page.locator(".replay-step-hit[data-step-id]").last().click();
  const overlapping = page.locator(".replay-activity-list").getByRole("button");
  ensure(await overlapping.count() === 6, "点击同轨同刻时间点未展开全部六个调用");
  ensure(await page.locator('.activity-replay [data-path^="src/retired-"]').count() === 0, "基线外历史文件被伪造为地图矩形");
  for (const index of [3, 4]) {
    const response = page.waitForResponse(response => response.url().includes(`/evidence/${encodeURIComponent(fixture.overlapActivities[index].id)}`) && response.status() === 200);
    await overlapping.nth(index).click();
    const evidence = await (await response).json();
    ensure(evidence.event.id === fixture.overlapActivities[index].id && evidence.version === fixture.version, "切换第四或第五项没有读取对应同版证据");
    ensure(evidence.records.some(record => record.raw.includes(`overlap-${index}`)), "第四或第五项证据没有对应原始调用记录");
  }
  await snapshot("replay-same-time-six");
  await button("关闭活动证据").click();
  // 数百轨与数百断轴不能把动态层扩成通高合成区域，也不能扩大实际滚动范围。
  await choose("密集多轨会话");
  const timeline = page.getByRole("group", { name: "会话活动时间线", exact: true });
  ensure(await timeline.locator(".replay-track-row").count() === 363, "密集会话没有保留全部363条轨道");
  const denseGeometry = async () => timeline.evaluate(element => ({
    clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
    overlayHeight: element.querySelector(".replay-timeline-overlay").getBoundingClientRect().height,
    gaps: element.querySelectorAll(".replay-gap-help").length,
  }));
  const checkDenseGeometry = async () => {
    const geometry = await denseGeometry();
    ensure(geometry.overlayHeight <= geometry.clientHeight + 2, "密集轨道动态层超过滚动视口高度");
    ensure(Math.abs(geometry.scrollHeight - (363 * 42 + 28)) <= 2, "密集轨道动态层扩大了内容滚动高度");
    ensure(geometry.gaps >= 360, "密集样本没有产生数百个共享折叠空档");
    return geometry;
  };
  await checkDenseGeometry();
  await timeline.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(() => {
    const scroll = document.querySelector(".replay-timeline-scroll"), overlay = scroll?.querySelector(".replay-timeline-overlay");
    return scroll && overlay && Math.abs(overlay.getBoundingClientRect().top - scroll.getBoundingClientRect().top) <= 3;
  });
  const lastTrack = await timeline.locator(".replay-track-row").last().boundingBox(), timelineBounds = await timeline.boundingBox();
  ensure(lastTrack.y >= timelineBounds.y && lastTrack.y + lastTrack.height <= timelineBounds.y + timelineBounds.height + 2, "密集轨道滚到底后末轨不可见");
  const gapKeyboard = async () => {
    const index = await timeline.evaluate(element => {
      const viewport = element.getBoundingClientRect();
      return [...element.querySelectorAll(".replay-gap-help")].findIndex(button => {
        const bounds = button.getBoundingClientRect();
        return bounds.left >= viewport.left + 176 && bounds.right <= viewport.right && bounds.top >= viewport.top + 28 && bounds.bottom <= viewport.bottom;
      });
    });
    ensure(index >= 0, "滚动或缩放后没有位于当前视口的空档帮助入口");
    const gap = timeline.locator(".replay-gap-help").nth(index), label = await gap.getAttribute("aria-label");
    await gap.focus(); await gap.press("Enter");
    const help = page.getByRole("dialog", { name: label, exact: true }); await help.waitFor();
    await page.keyboard.press("Escape"); await help.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.classList.contains("replay-gap-help"));
    ensure(await gap.evaluate(element => element === document.activeElement), "空档帮助Escape关闭后未恢复键盘焦点");
  };
  await gapKeyboard();
  await button("放大时间轴").click(); await checkDenseGeometry(); await gapKeyboard();
  await timeline.evaluate(element => { element.scrollTop = 0; element.scrollLeft = 0; });
  await page.waitForFunction(() => Number.parseFloat(document.querySelector(".replay-timeline-overlay")?.style.top ?? "-1") === 0);
  const denseResult = await checkDenseGeometry(); await gapKeyboard();
  await snapshot("replay-dense-tracks");
  await choose("并行主会话");
  ensure(await page.locator(".replay-track-row[data-track-id]").count() === 4, "离开密集样本后原四轨回放没有恢复");
  await picker().click(); await search().fill("不存在的会话");
  await page.getByText("没有匹配结果", { exact: true }).waitFor();
  await search().fill("同名候选");
  ensure(await page.getByRole("option").count() === 2, "同名候选搜索结果不完整");
  ensure((await page.getByRole("option").allTextContents()).every(text => text.includes("replay-extra-")), "同名候选缺少可区分身份");
  await search().fill(""); await page.getByRole("option").last().scrollIntoViewIfNeeded();
  ensure(await page.locator(".project-picker-options").evaluate(element => element.scrollTop) > 0, "长候选列表未独立滚动");
  await search().press("Escape");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "回放会话");
  ensure(await picker().evaluate(element => element === document.activeElement), "关闭会话选择器后未恢复焦点");
  await picker().press("Enter"); await search().fill("并行主会话");
  await search().press("ArrowDown"); await search().press("Enter"); await settle();
  ensure((await picker().innerText()).includes("并行主会话"), "键盘不能选择回放会话");
  // 两个 Tab 独立保存上下文，库入口与直接入口使用同一播放器。
  await tab("活动分布").click();
  await button("筛选会话").click();
  await page.getByRole("combobox", { name: "筛选会话搜索", exact: true }).fill("实现子会话");
  await page.getByRole("option").filter({ hasText: "实现子会话" }).click(); await settle();
  await tab("活动回放").click();
  ensure((await picker().innerText()).includes("并行主会话"), "分布页会话筛选污染回放目标");
  await tab("活动分布").click();
  ensure((await button("筛选会话").innerText()).includes("实现子会话"), "回放切换丢失分布页筛选");
  await tab("活动回放").click();
  await button("查看会话").click();
  await page.getByRole("heading", { name: "并行主会话", exact: true }).waitFor();
  await button("活动回放").click(); await slider().waitFor(); await settle();
  ensure(await tab("活动回放").getAttribute("aria-selected") === "true", "会话库入口未定位回放 Tab");
  ensure((await picker().innerText()).includes("并行主会话"), "会话库回放未预选原目标");
  await button("下一活动").click();
  const savedPosition = await position();
  await page.reload(); await slider().waitFor(); await settle();
  ensure((await picker().innerText()).includes("并行主会话"), "回放地址不能恢复目标会话");
  ensure(await button("播放").isVisible(), "恢复回放地址后不应自动播放");
  ensure(await position() === savedPosition, "刷新回放地址未恢复同版本播放位置");
  ensure((await page.getByRole("combobox", { name: "播放速度", exact: true }).innerText()).includes("4"), "刷新回放地址未恢复倍速");
  await button("外观").click();
  await page.getByRole("combobox", { name: "显示模式", exact: true }).click();
  await page.getByRole("option", { name: "深色", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await button("外观").click(); await snapshot("replay-dark");
  await button("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
  await tab("Activity replay").waitFor();
  ensure((await button("Playback session").innerText()).includes("并行主会话"), "语言切换丢失当前会话");
  await button("Playback session").click();
  const englishSearch = page.getByRole("combobox", { name: "Search Playback session", exact: true });
  await englishSearch.fill("同名候选");
  ensure(await page.getByRole("option").count() === 2, "英文单数验收没有匹配到两个独立单活动候选");
  ensure((await page.getByRole("option").allTextContents()).every(text => /\b1 activity\b/.test(text) && /\b1 track\b/.test(text)), "英文单数候选未使用1 activity与1 track");
  await englishSearch.press("Escape");
  await snapshot("replay-english");
  await page.setViewportSize({ width: 390, height: 844 });
  ensure(await tab("Activity distribution").isVisible() && await tab("Activity replay").isVisible(), "窄屏功能 Tab 不可达");
  await button("Playback session").click();
  const menu = await page.locator(".project-picker-menu").boundingBox();
  ensure(menu.x >= 8 && menu.x + menu.width <= 382 && menu.y >= 8 && menu.y + menu.height <= 836, "窄屏会话选择器超出视口");
  await snapshot("replay-narrow-picker");
  await page.getByRole("combobox", { name: "Search Playback session", exact: true }).press("Escape");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await button("Next activity").click(); await snapshot("replay-narrow");
  ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "窄屏整页发生横向溢出");
  ensure(errors.length === 0, "浏览器发生页面异常");
  ensure(failedRequests.length === 0, "浏览器发生非取消网络失败");
  ensure(failedResponses.length === 0, "浏览器 API 返回失败状态");
  return { passed: true, tracks: 4, requests: requests.length, requestsDuringPlayback,
    errors, failedRequests, failedResponses, sameTrackSameTime: { calls: 6, evidenceIndexes: [4, 5] },
    denseTracks: { tracks: 363, steps: 362, ...denseResult }, keyboard: true, narrow: true, reducedMotion: true, languages: ["zh-CN", "en"] };
}

let service, opened = false;
try {
  await mkdir(artifacts, { recursive: true }); await mkdir(roots.codex); await mkdir(join(repository, "src"), { recursive: true });
  await mkdir(join(repository, "docs")); await run("git", ["init", "-q", repository]);
  for (const path of ["src/entry.ts", "src/a.ts", "src/b.ts", "src/c.ts", "docs/guide.md", "settings.json"]) {
    await writeFile(join(repository, path), "alpha\nbeta\ngamma\n");
  }
  await writeFile(join(repository, "src/empty.ts"), "");
  const fixtures = [
    ["replay-parent", "并行主会话", [
      ...command("parent-read", "cat src/entry.ts", 2, "alpha\nbeta\ngamma\n"),
      ...patch("parent-batch", ["src/a.ts", "src/b.ts"], 10),
      ...command("parent-search", "rg -n alpha src", 12, "src/a.ts:1:alpha\nsrc/b.ts:1:alpha\n"),
      ...command("parent-late", "cat docs/guide.md", 600, "alpha\nbeta\ngamma\n"),
    ]],
    ["replay-child-a", "实现子会话", [
      ...command("a-read", "cat src/a.ts", 8, "alpha\nbeta\ngamma\n"),
      ...patch("a-patch", ["src/a.ts"], 12),
      ...command("a-untimed", "cat settings.json", undefined, "alpha\nbeta\ngamma\n"),
      ...command("a-failed", "cat src/b.ts", 20, "permission denied\n", 1),
    ], "replay-parent"],
    ["replay-child-b", "测试子会话", [
      ...command("b-read", "cat src/b.ts", 8, "alpha\nbeta\ngamma\n"),
      ...command("b-search", "rg -n alpha src/b.ts", 12, "1:alpha\n"),
      ...patch("b-unknown", ["src/b.ts"], 30, "unknown"),
    ], "replay-parent"],
    ["replay-child-c", "文档子会话", [
      ...command("c-read", "cat docs/guide.md", 8, "alpha\nbeta\ngamma\n"),
      ...patch("c-patch", ["docs/guide.md"], 12),
      ...command("c-deleted", "cat src/removed.ts", 25, "historical source\n"),
      ...command("c-empty", "cat src/empty.ts", 26, ""),
    ], "replay-parent"],
    ["replay-delegator", "只委派的主会话", []],
    ["replay-delegated-child", "委派活动子会话", command("delegated-read", "cat src/c.ts", 3, "alpha\n"), "replay-delegator"],
    ["replay-empty", "没有文件活动", []],
    ["replay-overlap", "同轨六项活动", Array.from({ length: 6 }, (_, index) =>
      command(`overlap-${index}`, `cat src/retired-${index}.ts`, 4, `historical evidence ${index}\n`)).flat()],
    ["replay-dense", "密集多轨会话", []],
    ...Array.from({ length: 362 }, (_, index) => [`replay-dense-child-${index}`, `密集子会话 ${index + 1}`,
      command(`dense-${index}`, "cat src/entry.ts", index * 60 + 2, "alpha\n"), "replay-dense"]),
    ...Array.from({ length: 38 }, (_, index) => [`replay-extra-${index}`, index < 2 ? "同名候选" : `合成回放候选 ${index}`,
      command(`extra-${index}`, "cat src/entry.ts", 2, "alpha\n")]),
  ];
  for (const [id, title, events, parent] of fixtures) await writeFile(join(roots.codex, `${id}.jsonl`), encode(history(id, title, events, parent)));
  const home = join(directory, "data"); await mkdir(home); await writePreferences(home, "zh-CN");
  service = await startService({ home, roots, resourceInventory: { environment: {} } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  const api = async (path, body) => {
    const response = await fetch(`${base}/api/v1${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    assert.equal(response.status, 200, `API 状态错误：${path}`); return response.json();
  };
  const registration = await api("/repositories", { path: repository });
  let ready = false;
  for (let attempt = 0; attempt < 400; attempt++) {
    const [{ job }, status] = await Promise.all([api(`/jobs/${registration.job.id}`), api("/sessions/status")]);
    assert.notEqual(job.status, "failed"); assert.notEqual(status.job?.status, "failed");
    if (job.status === "completed" && status.version) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, "人工历史分析未完成");
  const list = await api("/sessions?includeSubagents=true&pageSize=200");
  for (let page = 2; list.sessions.length < list.total; page++) {
    const more = await api(`/sessions?includeSubagents=true&pageSize=200&page=${page}&version=${list.version}`);
    assert.equal(more.version, list.version); assert.ok(more.sessions.length); list.sessions.push(...more.sessions);
  }
  const primary = list.sessions.find(session => session.clientSessionId === "replay-parent"); assert.ok(primary);
  const mapBase = `/repositories/${registration.repository.id}`;
  const coverage = await api(`${mapBase}/coverage`);
  const started = performance.now();
  const candidates = await api(`${mapBase}/replay/sessions?version=${coverage.version}&sessionVersion=${list.version}`);
  const parent = candidates.sessions.find(session => session.id === primary.id); assert.ok(parent);
  assert.equal(parent.trackCount, 4, "候选未包含三个明确子会话");
  assert.ok(candidates.sessions.some(session => session.title === "只委派的主会话"), "候选漏掉只有子活动的主会话");
  assert.ok(!candidates.sessions.some(session => session.title === "没有文件活动"), "候选包含完全无活动会话");
  const replay = await api(`${mapBase}/replay?sessionId=${encodeURIComponent(primary.id)}&version=${coverage.version}&sessionVersion=${list.version}`);
  const elapsedMs = Math.round(performance.now() - started);
  assert.equal(replay.tracks.length, 4); assert.equal(replay.version, coverage.version); assert.equal(replay.sessionVersion, list.version);
  assert.ok(replay.steps.some(step => step.activities.length >= 2 && step.activities.flatMap(activity => activity.paths).includes("src/a.ts")
    && step.activities.flatMap(activity => activity.paths).includes("src/b.ts")), "同一调用的批量修改未归组");
  assert.ok(replay.steps.some(step => step.time === undefined), "缺失时间被编造为可对齐时间");
  assert.ok(replay.steps.some(step => step.activities.some(activity => activity.status === "failure")), "失败活动丢失或变为成功");
  assert.ok(replay.steps.some(step => step.activities.some(activity => activity.status === "unknown")), "未知结果丢失或变为成功");
  assert.ok(replay.steps.some(step => step.activities.some(activity => activity.kind === "search")), "搜索活动没有进入回放");
  assert.ok(replay.steps.some(step => step.activities.some(activity => activity.paths.includes("src/removed.ts"))), "已删除路径活动丢失");
  assert.ok(replay.files.some(file => file.path === "src/empty.ts" && file.lineCount === 0), "零行文件基线丢失");
  const simultaneous = Object.values(Object.groupBy(replay.steps.filter(step => step.time !== undefined), step => step.time));
  assert.ok(simultaneous.some(steps => new Set(steps.map(step => step.trackId)).size >= 3), "并行子会话未对齐共享时间");
  const bytes = Buffer.byteLength(JSON.stringify(replay));
  const overlapTarget = candidates.sessions.find(session => session.clientSessionId === "replay-overlap"); assert.ok(overlapTarget);
  const overlap = await api(`${mapBase}/replay?sessionId=${encodeURIComponent(overlapTarget.id)}&version=${coverage.version}&sessionVersion=${list.version}`);
  assert.equal(overlap.steps.length, 6); assert.equal(new Set(overlap.steps.map(step => step.time)).size, 1);
  assert.ok(overlap.steps.every(step => step.activities.every(activity => activity.paths.every(path => !overlap.files.some(file => file.path === path)))));
  const denseTarget = candidates.sessions.find(session => session.clientSessionId === "replay-dense"); assert.ok(denseTarget);
  const dense = await api(`${mapBase}/replay?sessionId=${encodeURIComponent(denseTarget.id)}&version=${coverage.version}&sessionVersion=${list.version}`);
  assert.equal(dense.tracks.length, 363); assert.equal(dense.steps.length, 362); assert.equal(dense.totalActivities, 362);
  await writeFile(join(artifacts, "api-result.json"), JSON.stringify({ passed: true, elapsedMs, bytes, candidates: candidates.sessions.length,
    tracks: replay.tracks.length, steps: replay.steps.length, activities: replay.totalActivities, untimed: replay.steps.filter(step => step.time === undefined).length,
    denseTracks: dense.tracks.length, denseSteps: dense.steps.length }, null, 2));
  await writeFile(join(artifacts, "fixture.json"), JSON.stringify({ base, directory, repository, sessionId: primary.id, version: coverage.version, sessionVersion: list.version }, null, 2));
  if (!process.argv.includes("--api-only")) {
    await browser(["open", `${base}/#map`, "--headed", "--browser=chrome"]); opened = true;
    const result = await browser(["run-code", `async page => (${verifyBrowser.toString()})(page, ${JSON.stringify({ artifacts, version: coverage.version,
      overlapActivities: overlap.steps.map(step => ({ id: step.activities[0].id })) })})`]);
    await writeFile(join(artifacts, "browser-result.txt"), result);
  }
  console.log(`会话活动回放验收通过：${replay.tracks.length} 条轨道，${replay.steps.length} 个步骤，API ${elapsedMs}ms，${bytes} 字节。`);
} catch (error) {
  await writeFile(join(artifacts, "failure.txt"), String(error));
  if (opened) await browser(["screenshot", "--filename", join(artifacts, "failure.png")]).catch(() => {});
  throw error;
} finally {
  if (opened) await browser(["close"]).catch(() => {});
  await service?.close();
  if (!process.argv.includes("--keep-fixture")) await rm(directory, { recursive: true, force: true });
}
