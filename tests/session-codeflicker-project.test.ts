import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { AnalysisStore } from "../src/index/store.js";
import { SessionStore } from "../src/sessions/store.js";
import { refreshSessions } from "../src/sessions/refresh.js";
import { loadCodeFlickerProjects } from "../src/sessions/codeflicker-projects.js";

const encode = (records: unknown[]) => records.map(record => JSON.stringify(record)).join("\n") + "\n";

test("CodeFlicker 正式项目映射优先于跨仓库工具目标，并独立更新缓存", async () => {
  const directory = await realpath(await mkdtemp("/tmp/manor-project-meta-"));
  const dbPath = join(directory, "index.sqlite");
  new AnalysisStore(dbPath).close();
  const store = new SessionStore(dbPath);
  try {
    const repositories = [join(directory, "primary"), join(directory, "reference")];
    for (const repository of repositories) {
      await mkdir(repository);
      await promisify(execFile)("git", ["init", "--quiet", repository]);
      await writeFile(join(repository, "entry.ts"), "export const healthy = true;\n");
    }
    const primary = repositories[0]!;
    const home = join(directory, "client");
    const slug = primary.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
    const sourcePath = join(home, "projects", slug, "demo.jsonl");
    await mkdir(dirname(sourcePath), { recursive: true });
    const native = (uuid: string, path: string) => ({ type: "message", sessionId: "project-demo", uuid, role: "assistant",
      content: [{ type: "tool_use", id: uuid, name: "read", input: { file_path: path } }] });
    await writeFile(sourcePath, encode(repositories.map((repository, index) => native(`read-${index}`, join(repository, "entry.ts")))));
    const roots = { codex: [], claude: [], codeflicker: dirname(sourcePath), "codeflicker-desktop": [] };
    const refresh = () => refreshSessions(store, store.createJob().id, roots);
    const summary = () => store.list().sessions[0]!;
    await refresh();
    assert.equal(summary().project, undefined);
    const previousRevision = store.cachedRevisions()[0]!.revision;
    const metadataPath = join(home, "data.json");
    await writeFile(metadataPath, JSON.stringify({ projects: { [primary]: { history: [] } }, recentModels: [] }));
    await refresh();
    assert.equal(summary().project, primary);
    assert.equal(summary().projectOrigin, "client_metadata");
    assert.ok(!summary().gaps.some(gap => gap.kind === "ambiguous"));
    assert.notEqual(store.cachedRevisions()[0]!.revision, previousRevision);
    assert.ok(store.status().projects.includes(primary));
    const revision = store.cachedRevisions()[0]!.revision;
    await writeFile(metadataPath, JSON.stringify({ projects: { [primary]: { history: ["新的历史提示"] } }, recentModels: ["fixture-model"] }));
    await refresh();
    assert.equal(store.cachedRevisions()[0]!.revision, revision, "无关历史提示不使项目映射缓存失效");
    // 原生目录编码会合并大小写；两个完整路径碰撞时不能任选一个。
    await writeFile(metadataPath, JSON.stringify({ projects: { [primary]: {}, [primary.toUpperCase()]: {} } }));
    await refresh();
    assert.equal(summary().project, undefined);
    assert.ok(summary().gaps.some(gap => gap.kind === "ambiguous"));
    const records = repositories.map((repository, index) => native(`read-${index}`, join(repository, "entry.ts")));
    await writeFile(sourcePath, encode([{ ...records[0], cwd: repositories[1] }, records[1]]));
    await refresh();
    assert.equal(summary().project, repositories[1]);
    assert.equal(summary().projectOrigin, "cwd", "记录中的明确 cwd 优先于客户端映射");
    await writeFile(sourcePath, encode(records));
    await rm(metadataPath);
    await refresh();
    assert.equal(summary().project, undefined, "映射删除后恢复实际输入的未知状态");
    const version = store.status().version;
    await writeFile(metadataPath, "{invalid");
    await assert.rejects(refresh(), /项目元数据/);
    assert.equal(store.status().version, version, "读取元数据失败保留上一版");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("CodeFlicker 项目目录兼容原生字符合并与长路径哈希，不反向解码目录", async () => {
  const home = await mkdtemp("/tmp/manor-metadata-encoding-");
  try {
    const short = "/workspace/Demo__Project/";
    const long = `/workspace/${"a".repeat(90)}`;
    const shortSource = join(home, "projects", "workspace-demo-project", "demo.jsonl");
    const longSource = join(home, "projects", `workspace-${"a".repeat(70)}-1e59310b`, "demo.jsonl");
    const unknownSource = join(home, "projects", "workspace-unknown", "demo.jsonl");
    const customSource = join(home, "custom", "demo.jsonl");
    await writeFile(join(home, "data.json"), JSON.stringify({ projects: { [short]: {}, [long]: {}, "relative/path": {} } }));
    const locations = [shortSource, longSource, unknownSource, customSource].map(path => ({ client: "codeflicker" as const, path }));
    const metadata = await loadCodeFlickerProjects(locations);
    assert.equal(metadata.get(shortSource)?.project, "/workspace/Demo__Project");
    assert.equal(metadata.get(longSource)?.project, long);
    assert.equal(metadata.has(unknownSource), false, "缺少完整路径映射时不还原 slug");
    assert.equal(metadata.has(customSource), false, "任意来源目录不猜测客户端数据目录");
    assert.equal((await loadCodeFlickerProjects([{ client: "codex", path: shortSource }])).size, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
});
