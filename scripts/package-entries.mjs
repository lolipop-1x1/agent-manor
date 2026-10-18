import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const compiled = resolve(root, "dist/src");
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = resolve(directory, entry.name);
    if (entry.isDirectory()) await visit(source);
    else if (entry.name.endsWith(".js")) {
      const output = resolve(root, "dist", relative(compiled, source));
      let specifier = relative(dirname(output), source).split(sep).join("/");
      if (!specifier.startsWith(".")) specifier = `./${specifier}`;
      await mkdir(dirname(output), { recursive: true });
      // 兼容入口替代旧构建文件后，不继续发布指向旧代码的 source map。
      await rm(`${output}.map`, { force: true });
      if (output === resolve(root, "dist/cli.js")) {
        await writeFile(output, `#!/usr/bin/env node\nimport { realpathSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\nimport { runCli } from ${JSON.stringify(specifier)};\nexport * from ${JSON.stringify(specifier)};\nfunction isEntrypoint() { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } }\nif (isEntrypoint()) void runCli();\n`);
        await chmod(output, 0o755);
      } else await writeFile(output, `export * from ${JSON.stringify(specifier)};\n`);
    }
  }
}
await visit(compiled);
