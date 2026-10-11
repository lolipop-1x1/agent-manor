import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { usageFixture } from "./usage-fixture.mjs";

// 价格与映射写操作只作用于隔离的合成数据。
const run = promisify(execFile), fixture = await usageFixture({ matchingCandidates: true });
const artifacts = fileURLToPath(new URL("../.local/usage-price-matching-e2e/", import.meta.url));
const session = `usage-price-matching-${process.pid}`;
let opened = false;
const browser = async args => {
  const { stdout } = await run("playwright-cli", [`-s=${session}`, ...args], {
    cwd: fixture.directory, env: { ...process.env, TMPDIR: "/tmp" }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout;
};
try {
  await mkdir(artifacts, { recursive: true });
  await browser(["open", `${fixture.base}/#usage?window=all`, "--headed", "--browser=chrome"]); opened = true;
  const verify = async (page, options) => {
    let checks = 0; const errors = []; page.on("pageerror", error => errors.push(error.message));
    const ensure = (condition, message) => { if (!condition) throw new Error(message); checks++; };
    const button = name => page.getByRole("button", { name, exact: true });
    await page.locator(".usage-metrics").waitFor(); await page.waitForLoadState("networkidle");
    await button("管理模型价格").click();
    let dialog = page.getByRole("dialog", { name: "模型价格", exact: true });
    await dialog.getByRole("textbox", { name: "搜索原始模型、计价模型或服务商", exact: true }).fill("fixture-unpriced");
    const row = dialog.locator("tbody tr").filter({ has: page.getByText("fixture-unpriced", { exact: true }) });
    ensure((await row.innerText()).includes("模型身份存在冲突"), "同名不同标准身份没有解释冲突");
    ensure(await row.getByRole("button", { name: "修改映射", exact: true }).isVisible(), "价格冲突没有提供调整映射入口");
    await button("价格依据与规则").click();
    ensure((await page.locator(".help-popover-body").innerText()).includes("请求明细按记录的服务商和时间取价"), "匹配范围帮助没有说明");
    await button("关闭价格依据与规则").click();
    await row.getByRole("button", { name: "修改映射", exact: true }).click();
    ensure(await button("保存配置").isDisabled(), "歧义候选被自动选成第一个");
    const target = button("计价模型及服务商"); await target.click();
    ensure(await page.getByRole("option").count() === 2, "相关候选菜单混入无关型号");
    const search = page.getByRole("combobox", { name: "计价模型及服务商搜索", exact: true });
    await search.fill("no-such-price"); ensure(await page.getByRole("option").count() === 0, "候选搜索没有空结果");
    await search.fill("beta"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    ensure(await button("保存配置").isEnabled(), "键盘选择候选没有更新目标");
    await target.click(); await page.keyboard.press("Escape"); ensure(await target.evaluate(element => element === document.activeElement), "Escape 没有恢复候选按钮焦点");
    const saved = page.waitForResponse(response => response.url().endsWith("/usage/pricing") && response.request().method() === "PUT");
    await button("保存配置").click(); ensure((await saved).ok(), "候选映射保存失败");
    await dialog.locator(".pricing-editor").waitFor({ state: "hidden" });
    ensure((await row.innerText()).includes("beta / fixture-unpriced"), "调整映射没有显示用户选中的目标");
    await row.getByRole("button", { name: "修改映射", exact: true }).click();
    ensure((await target.innerText()).includes("fixture-unpriced"), "已有有效映射没有预填目标");
    await button("取消").click(); await button("删除映射，恢复自动").click();
    await row.getByText("模型身份存在冲突", { exact: true }).waitFor();
    // 仅在临时目录制造失效映射，验证不会静默切换为另一个计价目标。
    await page.evaluate(async () => {
      const response = await fetch("/api/v1/usage/pricing", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: [], mappings: [{ model: "fixture-unpriced", targetProvider: "missing", targetModel: "missing" }] }) });
      if (!response.ok) throw new Error("synthetic mapping update failed");
    });
    await page.reload(); await page.locator(".usage-metrics").waitFor(); await page.waitForLoadState("networkidle");
    await button("管理模型价格").click(); await dialog.getByRole("textbox", { name: "搜索原始模型、计价模型或服务商", exact: true }).fill("fixture-unpriced");
    ensure((await row.innerText()).includes("手动映射目标已失效"), "失效配置没有直接显示原因");
    await row.getByRole("button", { name: "修改映射", exact: true }).click();
    ensure(await button("保存配置").isDisabled(), "失效映射偷偷预填其他目标");
    await button("取消").click(); await button("关闭模型价格").click();
    await button("外观").click(); await page.getByRole("combobox", { name: "显示模式", exact: true }).click();
    await page.getByRole("option", { name: "深色", exact: true }).click(); await page.keyboard.press("Escape");
    await button("显示语言").click(); await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
    await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 900 }); await button("Manage model prices").click();
    dialog = page.getByRole("dialog", { name: "Model prices", exact: true });
    await dialog.getByRole("textbox", { name: "Search original model, priced model, or provider", exact: true }).fill("fixture-unpriced");
    ensure((await dialog.innerText()).includes("Manual mapping target unavailable"), "失效映射原因缺少英文");
    const bounds = await dialog.boundingBox(); ensure(bounds.x >= 0 && bounds.x + bounds.width <= 390, "窄屏映射对话框越界");
    await page.screenshot({ path: `${options.artifacts}/en-mobile-dark.png` });
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
    ensure(await button("Manage model prices").evaluate(element => element === document.activeElement), "关闭对话框没有恢复管理按钮焦点");
    ensure(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "窄屏页面横向溢出");
    ensure(errors.length === 0, `浏览器错误：${errors.join(";")}`);
    return { passed: true, checks, errors, identityConflict: true, relatedCandidates: true, manualMapping: true, invalidMapping: true, keyboard: true, english: true, darkMobile: true };
  };
  const output = await browser(["run-code", `async page => (${verify.toString()})(page, ${JSON.stringify({ artifacts })})`]);
  console.log(output.split("### Ran Playwright code")[0]); await writeFile(`${artifacts}/report.txt`, output);
} catch (error) {
  if (opened) await browser(["screenshot", `--filename=${artifacts}/failure.png`]).catch(() => {});
  throw error;
} finally { if (opened) await browser(["close"]).catch(() => {}); await fixture.close(); }
