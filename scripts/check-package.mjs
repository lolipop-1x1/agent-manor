import { existsSync, readFileSync } from "node:fs";
import { VERSION } from "../dist/version.js";

const requiredFiles = ["dist/cli.js", "dist/server.js", "dist/worker.js", "dist/semantic/worker.js", "dist/web/index.html"];
for (const path of requiredFiles) {
  if (!existsSync(new URL(`../${path}`, import.meta.url))) {
    throw new Error(`缺少交付入口：${path}`);
  }
}

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (manifest.version !== VERSION) {
  throw new Error("package.json 与 src/version.ts 的版本不一致");
}

console.log(`agent-manor ${VERSION} 的后台、Worker、CLI 和 Web 构建产物已就绪`);
