#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCli } from "../packages/cli/src/entry.js";
export { runCli, cliErrorOutput } from "../packages/cli/src/entry.js";
export { createProgram } from "../packages/cli/src/program.js";
export { humanOutput } from "../packages/cli/src/output/format.js";
export { resolveCliLanguage } from "../packages/cli/src/output/language.js";

// npm 的符号链接和直接执行均可进入，普通导入不启动服务。
try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) void runCli();
} catch { /* 导入时没有可执行入口。 */ }
