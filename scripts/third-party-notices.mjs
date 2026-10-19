import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const noticeFile = "THIRD_PARTY_NOTICES.txt";
const inventoryFile = "dist/web/.vite/third-party-licenses.json";
const normalize = text => text.replaceAll("\r\n", "\n");

function licenseFor(entry) {
  const id = `${entry.name}@${entry.version}`;
  if (!entry.identifier?.trim()) throw new Error(`${id} 缺少许可标识`);
  if (entry.text?.trim()) return { text: normalize(entry.text).trim() };
  // 此版本的 npm 包未附许可文件；仅为已核对的 MIT 版本补充固定上游全文。
  // 发布元数据中的 gitHead 在公开仓库不可用，因此不能声称这是发布时的原文件。
  if (id === "react-remove-scroll-bar@2.3.8") {
    if (entry.identifier !== "MIT") throw new Error(`${id} 许可标识与补充记录不一致`);
    const text = normalize(readFileSync(new URL("../licenses/react-remove-scroll-bar-2.3.8-LICENSE.txt", import.meta.url), "utf8"));
    if (createHash("sha256").update(text).digest("hex") !== "a79aae0c0f21990d9d963bb3c5a79cdcea9a46f8523ba55c58d7fe776b6ebc84") {
      throw new Error(`${id} 补充许可正文与已核对的上游文件不一致`);
    }
    return {
      text: text.trim(),
      source: "https://raw.githubusercontent.com/theKashey/react-remove-scroll-bar/8ca9ba5ea52de03308fe8ced94f7b159a44d28ff/LICENSE",
      provenance: "The npm release declares MIT but omits the license file. This text is from the pinned public upstream revision above; it is not verified as the license file shipped with this npm release.",
    };
  }
  throw new Error(`${id} 缺少完整许可文本`);
}

export function renderThirdPartyNotices(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("第三方许可清单为空");
  const sorted = [...entries].sort((a, b) => {
    const first = `${a.name}@${a.version}`, second = `${b.name}@${b.version}`;
    return first < second ? -1 : first > second ? 1 : 0;
  });
  const sections = sorted.map(entry => {
    const license = licenseFor(entry);
    return [
      `${entry.name}@${entry.version}`,
      `License: ${entry.identifier}`,
      ...(license.source ? [`Source: ${license.source}`, license.provenance] : []),
      "",
      license.text,
    ].join("\n");
  });
  return [
    "Third-Party Notices",
    "",
    "The following third-party code and fonts are included in the AgentManor Web build.",
    "Generated from the production bundle by scripts/third-party-notices.mjs.",
    "Runtime npm dependencies are installed separately and retain their own license files.",
    "",
    sections.join("\n\n" + "=".repeat(80) + "\n\n"),
    "",
  ].join("\n");
}

function renderFromBuild(directory) {
  const entries = JSON.parse(readFileSync(resolve(directory, inventoryFile), "utf8"));
  return { count: entries.length, text: renderThirdPartyNotices(entries) };
}

export function writeThirdPartyNotices(directory = root) {
  const { count, text } = renderFromBuild(directory);
  writeFileSync(resolve(directory, noticeFile), text);
  return count;
}

export function checkThirdPartyNotices(directory = root) {
  const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  if (!manifest.files?.includes(noticeFile)) throw new Error("npm files 未包含第三方声明");
  const path = resolve(directory, noticeFile);
  if (!existsSync(path)) throw new Error("第三方声明缺失");
  const { count, text } = renderFromBuild(directory);
  if (normalize(readFileSync(path, "utf8")) !== text) throw new Error("第三方声明内容过期，请重新构建");
  return count;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const count = check ? checkThirdPartyNotices() : writeThirdPartyNotices();
  console.log(`已${check ? "核验" : "生成"} ${count} 项随 Web 分发的第三方许可`);
}
