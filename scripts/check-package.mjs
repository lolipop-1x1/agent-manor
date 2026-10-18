import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../dist/version.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const requiredFiles = ["dist/cli.js", "dist/server.js", "dist/worker.js", "dist/semantic/worker.js", "dist/src/server.js", "dist/packages/cli/src/entry.js", "dist/packages/cli/src/program.js", "dist/web/index.html", "skills/agent-manor/SKILL.md", "LICENSE"];
for (const path of requiredFiles) if (!existsSync(resolve(root, path))) throw new Error(`缺少交付入口：${path}`);
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const cliManifest = JSON.parse(readFileSync(resolve(root, "packages/cli/package.json"), "utf8"));
if (manifest.version !== VERSION || cliManifest.version !== VERSION) throw new Error("产品、CLI workspace 与 src/version.ts 的版本不一致");
if (manifest.license !== "MIT" || cliManifest.private !== true) throw new Error("交付许可或内部 CLI workspace 设置不正确");
if (manifest.bin["agent-manor"] !== "dist/cli.js" || manifest.bin.am !== manifest.bin["agent-manor"]) throw new Error("两个产品 bin 必须共享同一个入口");
if (!readFileSync(resolve(root, "dist/cli.js"), "utf8").startsWith("#!/usr/bin/env node\n")) throw new Error("CLI 缺少可执行 Node 入口");
if (manifest.publishConfig?.registry !== "https://registry.npmjs.org/") throw new Error("发布目标必须是公共 npm registry");
if (Object.values(manifest.dependencies).some(value => /^(?:workspace:|file:|link:)/.test(value))) throw new Error("产品不能依赖未发布 workspace 或开发目录链接");
function verifySkill(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) verifySkill(path);
    else if (entry.name.endsWith(".md")) {
      for (const match of readFileSync(path, "utf8").matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const link = match[1].split("#")[0];
        if (!link || /^[a-z]+:/i.test(link)) continue;
        const target = resolve(dirname(path), link);
        const within = relative(resolve(root, "skills/agent-manor"), target);
        if (within.startsWith("..") || isAbsolute(within) || !existsSync(target)) throw new Error(`Skill 引用必须随副本自包含：${entry.name}: ${link}`);
      }
    }
  }
}
verifySkill(resolve(root, "skills/agent-manor"));
console.log(`agent-manor ${VERSION} 的后台、Worker、CLI、Web、Skill 与 MIT 交付入口已就绪`);
