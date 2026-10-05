import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

test("公开检查拒绝私人内容及非公开依赖，失败日志不回显正文，删除路径和忽略资料不误报", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-manor-public-"));
  const marker = "synthetic-private-marker";
  try {
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, ".local"));
    await copyFile(new URL("../scripts/check-public-content.mjs", import.meta.url), join(directory, "scripts/check-public-content.mjs"));
    await writeFile(join(directory, ".gitignore"), ".local/\n");
    await writeFile(join(directory, ".local/public-denylist.txt"), `${marker}\n`);
    await writeFile(join(directory, ".local/private.txt"), marker);
    await writeFile(join(directory, `${marker}.md`), "人工样例\n");
    await run("git", ["init", directory]);
    await run("git", ["add", "--", "."], { cwd: directory });
    await run("git", ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-m", "synthetic"], { cwd: directory });
    await rm(join(directory, `${marker}.md`));
    const check = () => run(process.execPath, ["scripts/check-public-content.mjs"], { cwd: directory, env: { ...process.env, AGENT_MANOR_PUBLIC_DENYLIST: "" } });
    assert.match((await check()).stdout, /公开内容检查通过/);
    const fail = async (rule: string) => assert.rejects(check(), (error: { stderr: string }) => {
      assert.match(error.stderr, new RegExp(rule));
      assert.ok(!error.stderr.includes(marker));
      return true;
    });
    await writeFile(join(directory, `${marker}.md`), "人工样例\n");
    await fail("已隐藏路径");
    await rm(join(directory, `${marker}.md`));
    await writeFile(join(directory, "sample.md"), marker);
    await fail("本地禁用词");
    await writeFile(join(directory, "sample.md"), ["", "Users", "synthetic-private", "repository"].join("/"));
    await fail("个人用户目录");
    await writeFile(join(directory, "sample.md"), ["https://packages", "internal/archive"].join("."));
    await fail("内部域名");
    await rm(join(directory, "sample.md"));
    await writeFile(join(directory, "package-lock.json"), JSON.stringify({ packages: { demo: { resolved: "https://packages.example.invalid/demo.tgz" } } }));
    await fail("非公开 npm registry");
    await writeFile(join(directory, "package-lock.json"), JSON.stringify({ packages: { demo: { resolved: "https://registry.npmjs.org/demo/-/demo-1.0.0.tgz" } } }));
    assert.match((await check()).stdout, /公开内容检查通过/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
