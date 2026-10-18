import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let local = "";
try {
  local = await readFile(resolve(root, ".local/public-denylist.txt"), "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const forbidden = `${local}\n${process.env.AGENT_MANOR_PUBLIC_DENYLIST ?? ""}`.split(/\r?\n/)
  .map(value => value.trim().toLowerCase()).filter(value => value && !value.startsWith("#"));
const rules = [
  ["个人用户目录", /\/(?:Users|home)\/[^\s"'<>/\\]+|[A-Z]:\\+Users\\+[^\s"'<>\\]+/i],
  ["内部域名", /\b[a-z0-9.-]+\.(?:corp|internal|intranet)(?:\b|\.)|\b(?:corp|intranet)\.[a-z0-9.-]+/i],
];
const files = [...new Set(execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean))];
const findings = [];
const inspect = (path, line, value) => {
  for (const [rule, expression] of rules) if (expression.test(value)) findings.push({ path, line, rule });
  if (forbidden.some(term => value.toLowerCase().includes(term))) findings.push({ path, line, rule: "本地禁用词" });
};
let textFiles = 0;
for (const path of files) {
  let bytes;
  try {
    bytes = await readFile(resolve(root, path));
  } catch (error) {
    // 尚未暂存的删除或重命名路径不代表当前公开内容。
    if (error.code === "ENOENT") continue;
    throw error;
  }
  inspect(path, 0, path);
  if (bytes.includes(0)) continue;
  let content;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { continue; }
  content.split(/\r?\n/).forEach((line, index) => inspect(path, index + 1, line));
  textFiles++;
  if (path === "package-lock.json") {
    const lock = JSON.parse(content);
    for (const entry of Object.values(lock.packages)) {
      // 内部 CLI workspace 是仓库内链接，发布依赖仍必须来自公共 registry。
      if (!entry.resolved || entry.link === true && entry.resolved === "packages/cli") continue;
      try {
        if (new URL(entry.resolved).origin !== "https://registry.npmjs.org") findings.push({ path, line: 0, rule: "非公开 npm registry" });
      } catch { findings.push({ path, line: 0, rule: "非公开 npm registry" }); }
    }
  }
}
const identity = execFileSync("git", ["log", "-1", "--format=%an%n%ae%n%cn%n%ce"], { cwd: root, encoding: "utf8" });
identity.split("\n").forEach(value => inspect("Git 当前提交身份", 0, value));
if (findings.length) {
  // 只报告位置与规则，避免把命中的私人内容再次写到 CI 日志。
  for (const finding of findings) {
    const privatePath = forbidden.some(term => finding.path.toLowerCase().includes(term)) || rules.some(([, rule]) => rule.test(finding.path));
    console.error(`${privatePath ? "[已隐藏路径]" : finding.path}:${finding.line} ${finding.rule}`);
  }
  process.exitCode = 1;
} else {
  console.log(`公开内容检查通过：${textFiles} 个文本文件；图片与完整 Git 历史仍需人工审查。`);
}
