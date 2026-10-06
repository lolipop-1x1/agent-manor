import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { appendFile, mkdir, mkdtemp, rename, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverSources } from "../src/history/index.js";
import { sourceQuickStamp } from "../src/sessions/quick-check.js";
import type { SourceLocation } from "../src/history/types.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-source-check-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

const codexHeader = (id: string) => `${JSON.stringify({ type: "session_meta", payload: { id, cwd: "/workspace/example" } })}\n`;

test("来源发现先按 Agent 限制扫描，空范围与空 roots 不触碰其他目录", async () => temporary(async directory => {
  const path = join(directory, "session.jsonl");
  await writeFile(path, codexHeader("example-session"));
  const roots = isolatedHistoryRoots({ codex: directory, claude: path });
  const found = await discoverSources(roots, { clients: ["codex"] });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.client, "codex");
  assert.deepEqual(await discoverSources(roots, { clients: [] }), []);
  assert.deepEqual(await discoverSources(isolatedHistoryRoots({ codex: [] }), { clients: ["codex"] }), []);
}));

test("已核验来源的 stat 标记检测追加、截断、同大小改写及文件替换", async () => temporary(async directory => {
  const path = join(directory, "session.jsonl");
  await writeFile(path, codexHeader("example-a"));
  const location: SourceLocation = { client: "codex", format: "codex-jsonl", path };
  let stamp = await sourceQuickStamp(location);
  assert.ok(stamp);
  assert.equal(await sourceQuickStamp(location), stamp);
  await appendFile(path, "{}\n");
  let changed = await sourceQuickStamp(location);
  assert.notEqual(changed, stamp);
  stamp = changed;
  await truncate(path, 0);
  changed = await sourceQuickStamp(location);
  assert.notEqual(changed, stamp);
  await writeFile(path, codexHeader("example-a"));
  const before = await stat(path);
  stamp = await sourceQuickStamp(location);
  await writeFile(path, codexHeader("example-b"));
  await utimes(path, before.atime, before.mtime);
  changed = await sourceQuickStamp(location);
  assert.notEqual(changed, stamp);
  stamp = changed;
  const replacement = join(directory, "replacement.jsonl");
  await writeFile(replacement, codexHeader("example-b"));
  await utimes(replacement, before.atime, before.mtime);
  await rename(replacement, path);
  assert.notEqual(await sourceQuickStamp(location), stamp);
  await rm(path);
  assert.equal(await sourceQuickStamp(location), undefined);
}));

test("未核验格式和符号链接回退，不借客户端名称推断快检能力", async () => temporary(async directory => {
  const path = join(directory, "source.jsonl");
  await writeFile(path, "{}\n");
  for (const [client, format] of [["pi", "pi-jsonl"], ["dsh", "dsh-jsonl"], ["workbuddy", "workbuddy-jsonl"],
    ["opencode", "opencode-sqlite"], ["zcode", "zcode-sqlite"], ["codex", "unknown-format"]] as const) {
    assert.equal(await sourceQuickStamp({ path, client, format }), undefined);
  }
  const link = join(directory, "linked.jsonl");
  await symlink(path, link);
  assert.equal(await sourceQuickStamp({ path: link, client: "codex", format: "codex-jsonl" }), undefined);
  assert.ok(await sourceQuickStamp({ path, client: "codeflicker", format: "claude-jsonl" }));
}));

test("warm 来源发现无需再次打开 JSONL 头部，变化及缺少标记则重新发现", async context => temporary(async directory => {
  const path = join(directory, "session.jsonl");
  await writeFile(path, codexHeader("example-a"));
  const roots = isolatedHistoryRoots({ codex: directory });
  const [location] = await discoverSources(roots, { clients: ["codex"] });
  const stamp = (await sourceQuickStamp(location!))!;
  let opened = 0;
  const originalOpen = fs.open;
  context.mock.method(fs, "open", (...args: Parameters<typeof fs.open>) => { opened += 1; return originalOpen(...args); });
  syncBuiltinESMExports();
  try {
    const cachedSources = [{ location: location!, stamp }];
    const warm = await discoverSources(roots, { clients: ["codex"], cachedSources });
    assert.deepEqual(warm, [location]);
    assert.notEqual(warm[0], location);
    assert.equal(opened, 0);
    await writeFile(path, codexHeader("example-b"));
    const changed = await discoverSources(roots, { clients: ["codex"], cachedSources });
    assert.equal(changed[0]!.sessionId, "example-b");
    assert.equal(opened, 1);
    await discoverSources(roots, { clients: ["codex"], cachedSources: [] });
    assert.equal(opened, 2);
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); }
}));

test("桌面 JSONL 的 registry 元信息新建、修改及删除都使旧位置失效", async () => temporary(async directory => {
  const session = join(directory, "example-session");
  await mkdir(join(session, "message"), { recursive: true });
  await mkdir(join(session, "checkpoints"));
  const path = join(session, "message", "cache.jsonl");
  const registry = join(session, "checkpoints", "registry.json");
  await writeFile(path, JSON.stringify({ kind: "message", role: "user", content: "hello" }) + "\n");
  const roots = isolatedHistoryRoots({ "codeflicker-desktop": directory });
  let [location] = await discoverSources(roots, { clients: ["codeflicker-desktop"] });
  let stamp = (await sourceQuickStamp(location!))!;
  assert.ok(stamp);
  assert.equal(location!.cwd, undefined);
  await writeFile(registry, JSON.stringify({ sessionId: "example-session", cwd: "/workspace/alpha" }));
  assert.notEqual(await sourceQuickStamp(location!), stamp);
  let found = await discoverSources(roots, { clients: ["codeflicker-desktop"], cachedSources: [{ location: location!, stamp }] });
  assert.equal(found[0]!.cwd, "/workspace/alpha");
  location = found[0]!;
  stamp = (await sourceQuickStamp(location))!;
  await writeFile(registry, JSON.stringify({ sessionId: "example-session", cwd: "/workspace/bravo" }));
  found = await discoverSources(roots, { clients: ["codeflicker-desktop"], cachedSources: [{ location, stamp }] });
  assert.equal(found[0]!.cwd, "/workspace/bravo");
  location = found[0]!;
  stamp = (await sourceQuickStamp(location))!;
  await rm(registry);
  found = await discoverSources(roots, { clients: ["codeflicker-desktop"], cachedSources: [{ location, stamp }] });
  assert.equal(found[0]!.cwd, undefined);
}));

test("单文件原生格式 warm 发现保留选择器，来源内容变化仍更新原生身份", async () => temporary(async directory => {
  const path = join(directory, "session.jsonl");
  await writeFile(path, JSON.stringify({ type: "message", sessionId: "native-a", role: "user", content: "hello", cwd: "/workspace/example" }) + "\n");
  for (const client of ["codebuddy", "qoder"] as const) {
    const roots = isolatedHistoryRoots({ [client]: directory });
    const [location] = await discoverSources(roots, { clients: [client] });
    const stamp = (await sourceQuickStamp(location!))!;
    assert.ok(stamp);
    assert.equal(location!.selector, "native-a");
    assert.deepEqual(await discoverSources(roots, { clients: [client], cachedSources: [{ location: location!, stamp }] }), [location]);
    assert.notEqual(await sourceQuickStamp({ ...location!, selector: "different-selector" }), stamp);
  }
}));
