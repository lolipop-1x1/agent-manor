import { validateCatalogs } from "../src/i18n/validate.ts";
import { catalogs } from "../src/i18n/catalogs.ts";
import { readFile, readdir } from "node:fs/promises";

const errors = validateCatalogs();
const logicalKey = key => key.replace(/_(zero|one|two|few|many|other)$/, "");
const keys = new Set(Object.values(catalogs.en).flatMap(module => Object.keys(module).map(logicalKey)));

// 检查明确的目录标识引用；动态标识仍由对应行为测试核验。
async function checkReferences(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) { if (entry.name !== "locales") await checkReferences(file); continue; }
    if (!/\.tsx?$/.test(entry.name)) continue;
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(["'`])((?:common|codeMap|sessions|resources|usage|overview|diagnostics|cli|site|replay|updates|updateUi)\.[\w.-]+)\1/g)) {
      // 数据库／原生文件名和 wire 类型可能使用相同前缀，不属于文案。
      if (match[2].endsWith(".sqlite") || ["usage.json", "usage.record", "updates.jsonl"].includes(match[2])) continue;
      if (!keys.has(logicalKey(match[2]))) errors.push(`${file.pathname}: 未定义文案 ${match[2]}`);
    }
  }
}
await checkReferences(new URL("../src/", import.meta.url));
await checkReferences(new URL("../web/", import.meta.url));
await checkReferences(new URL("../site/", import.meta.url));
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log("中英文翻译目录、引用、参数与复数检查通过");
