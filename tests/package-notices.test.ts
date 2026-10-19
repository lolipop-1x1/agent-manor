import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { checkThirdPartyNotices, renderThirdPartyNotices, writeThirdPartyNotices } from "../scripts/third-party-notices.mjs";

const run = promisify(execFile);
const entries = [
  { name: "example-font", version: "1.0.0", identifier: "OFL-1.1", text: "Copyright Example Font Authors\n\n完整字体许可文本\n" },
  { name: "example-code", version: "2.0.0", identifier: "MIT", text: "Copyright Example Contributors\n\n完整代码许可文本\n" },
];

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "manor-package-notices-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist/web/.vite"), { recursive: true });
  await writeFile(join(root, "dist/web/.vite/third-party-licenses.json"), JSON.stringify(entries));
  await writeFile(join(root, "package.json"), JSON.stringify({ files: ["dist/", "THIRD_PARTY_NOTICES.txt"] }));
  return root;
}

test("声明按依赖名称稳定排序，保留完整版权和许可正文", () => {
  const text = renderThirdPartyNotices(entries);
  assert.equal(text, renderThirdPartyNotices([...entries].reverse()));
  assert.ok(text.indexOf("example-code@2.0.0") < text.indexOf("example-font@1.0.0"));
  for (const entry of entries) {
    assert.ok(text.includes(entry.identifier));
    assert.ok(text.includes(entry.text.trim()));
  }
  assert.equal(text, renderThirdPartyNotices(entries.map(entry => ({ ...entry, text: entry.text.replaceAll("\n", "\r\n") }))));
});

test("空清单、缺少许可正文和标识的依赖拒绝进入发布声明", () => {
  assert.throws(() => renderThirdPartyNotices([]), /许可清单为空/);
  assert.throws(() => renderThirdPartyNotices([{ ...entries[0], text: undefined }]), /缺少完整许可文本/);
  assert.throws(() => renderThirdPartyNotices([{ ...entries[0], identifier: "" }]), /缺少许可标识/);
});

test("漏发许可的已核对版本使用固定上游全文，未知版本或授权变化不能套用", () => {
  const missing = { name: "react-remove-scroll-bar", version: "2.3.8", identifier: "MIT" };
  const text = renderThirdPartyNotices([missing]);
  assert.ok(text.includes("https://raw.githubusercontent.com/theKashey/react-remove-scroll-bar/8ca9ba5ea52de03308fe8ced94f7b159a44d28ff/LICENSE"));
  assert.ok(text.includes("Permission is hereby granted, free of charge"));
  assert.ok(text.includes("not verified as the license file shipped with this npm release"));
  assert.throws(() => renderThirdPartyNotices([{ ...missing, version: "2.3.9" }]), /缺少完整许可文本/);
  assert.throws(() => renderThirdPartyNotices([{ ...missing, identifier: "Apache-2.0" }]), /许可标识与补充记录不一致/);
});

test("打包检查拒绝声明缺失、内容过期或未进入files，生成后可验证", async t => {
  const root = await fixture(t);
  assert.throws(() => checkThirdPartyNotices(root), /第三方声明缺失/);
  assert.equal(writeThirdPartyNotices(root), entries.length);
  assert.equal(checkThirdPartyNotices(root), entries.length);
  await writeFile(join(root, "THIRD_PARTY_NOTICES.txt"), "old declaration\n");
  assert.throws(() => checkThirdPartyNotices(root), /第三方声明内容过期/);
  writeThirdPartyNotices(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ files: ["dist/"] }));
  assert.throws(() => checkThirdPartyNotices(root), /未包含第三方声明/);
});

test("缺少许可的构建不能改写上一份完整声明", async t => {
  const root = await fixture(t);
  writeThirdPartyNotices(root);
  const path = join(root, "THIRD_PARTY_NOTICES.txt"), before = await readFile(path, "utf8");
  await writeFile(join(root, "dist/web/.vite/third-party-licenses.json"), JSON.stringify([{ ...entries[0], text: "" }]));
  assert.throws(() => writeThirdPartyNotices(root), /缺少完整许可文本/);
  assert.equal(await readFile(path, "utf8"), before);
});

test("清理构建按脚本位置移除历史声明和source map，保留源码及外部cwd", async t => {
  const root = await fixture(t), outside = join(root, "outside"), scripts = join(root, "scripts");
  await mkdir(scripts); await mkdir(join(outside, "dist"), { recursive: true });
  await copyFile(new URL("../scripts/clean-dist.mjs", import.meta.url), join(scripts, "clean-dist.mjs"));
  await writeFile(join(root, "dist/legacy.d.ts"), "old declaration\n");
  await writeFile(join(root, "dist/legacy.js.map"), "{}\n");
  await writeFile(join(root, "source.ts"), "export const preserved = true;\n");
  await writeFile(join(outside, "dist/preserved.txt"), "keep\n");
  await run(process.execPath, [join(scripts, "clean-dist.mjs")], { cwd: outside });
  await assert.rejects(readFile(join(root, "dist/legacy.d.ts")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "dist/legacy.js.map")), { code: "ENOENT" });
  assert.equal(await readFile(join(outside, "dist/preserved.txt"), "utf8"), "keep\n");
  assert.equal(await readFile(join(root, "source.ts"), "utf8"), "export const preserved = true;\n");
});
