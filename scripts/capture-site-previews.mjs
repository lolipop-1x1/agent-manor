import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sitePreviewFixture } from "./site-preview-fixture.mjs";

// 先运行 npm run build。所有截图均来自真实产品与隔离合成后台，不替换浏览器内容。
const run = promisify(execFile), fixture = await sitePreviewFixture();
const output = fileURLToPath(new URL("../site/public/previews/", import.meta.url));
const diagnostics = fileURLToPath(new URL("../.local/manor-site-previews/", import.meta.url));
const browser = async args => {
  const { stdout } = await run("playwright-cli", ["-s=manor-site-previews", ...args], { cwd: fixture.directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
try {
  await mkdir(output, { recursive: true }); await mkdir(diagnostics, { recursive: true });
  await browser(["open", `${fixture.base}/#overview`, "--headed", "--browser=chrome"]);
  const capture = async (page, options) => {
    page.setDefaultTimeout(30_000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    const ready = async () => {
      await page.waitForLoadState("networkidle");
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    };
    const summaries = [];
    for (const language of ["zh", "en"]) {
      if (language === "en") {
        await page.getByRole("button", { name: "显示语言", exact: true }).click();
        await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
        await page.locator('html[lang="en"]').waitFor();
      }
      for (const [name, hash, selector] of [
        ["overview", "overview", ".weekly-review[aria-busy='false'] .weekly-review-groups"],
        ["sessions", `sessions?id=${options.dialogueSessionId}&mode=brief`, ".session-list"],
        ["code-map", "map", ".code-map"],
        ["resources", "resources", ".resource-list-scroll[aria-busy='false'] .resource-overview-table tbody tr"],
        ["knowledge", `knowledge?view=all&review=all&id=${options.knowledge[language === "zh" ? "zh-CN" : "en"]}`, ".knowledge-entry-list[aria-busy='false']"],
        ["usage", "usage", ".usage-results[aria-busy='false']"],
        ["replay", `map?view=replay&repository=${options.repositoryId}&session=${options.replaySessionId}`, ".activity-replay[data-position]"],
      ]) {
        await page.goto(`${options.base}/#${hash}`);
        await page.locator(selector).first().waitFor();
        if (name === "sessions") {
          await page.locator(".session-profile").waitFor();
          await page.locator(".session-cost[data-price-version] .session-cost-value").waitFor();
        }
        if (name === "knowledge") await page.locator(".knowledge-reader[aria-busy='false'] h1").waitFor();
        if (name === "resources") {
          await page.locator(".resource-overview-table tbody tr").first().click();
          await page.locator(".resource-detail-body[aria-busy='false']").waitFor();
        }
        if (name === "replay") {
          const slider = page.getByRole("slider", { name: language === "zh" ? "回放进度" : "Replay position", exact: true });
          await slider.waitFor();
          await slider.focus();
          await page.keyboard.press("Home");
          await page.getByRole("button", { name: language === "zh" ? "下一次修改" : "Next modification", exact: true }).click();
          await page.locator(".replay-track-row").nth(1).waitFor();
        }
        await ready();
        const text = await page.locator("body").innerText();
        if (/\/Users\/|Translation unavailable|翻译暂不可用/.test(text)) throw new Error(`Unexpected private content or untranslated UI in ${name}`);
        await page.mouse.move(1420, 990);
        await page.screenshot({ path: `${options.output}/${name}-${language}.png` });
        summaries.push({ name, language, text });
      }
    }
    if (errors.length) throw new Error(JSON.stringify(errors));
    return summaries;
  };
  const result = await browser(["run-code", `page => (${capture.toString()})(page, ${JSON.stringify({ base: fixture.base, output, knowledge: fixture.knowledge, repositoryId: fixture.repositoryId, replaySessionId: fixture.replaySessionId, dialogueSessionId: fixture.dialogueSessionId })})`]);
  await writeFile(join(diagnostics, "capture-report.txt"), result);
  console.log("Captured fourteen 1440 × 1000 product previews from isolated synthetic data.");
} catch (error) {
  await browser(["screenshot", `--filename=${join(diagnostics, "failure.png")}`]).catch(() => {});
  const state = await browser(["run-code", "async page => ({ url: page.url(), text: await page.locator('body').innerText() })"]).catch(() => "No browser state");
  await writeFile(join(diagnostics, "failure-state.txt"), state);
  throw error;
} finally {
  await browser(["close"]).catch(() => {});
  await fixture.close();
}
