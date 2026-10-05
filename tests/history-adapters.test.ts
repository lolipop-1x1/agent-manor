import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CLIENTS, clientIds, clientName } from "../src/clients.js";
import { discoverSources, parseSource } from "../src/history/index.js";
import { HISTORY_CLIENTS } from "../src/history/adapters/index.js";
import { readEvidence } from "../src/service/files.js";

const fixture = (name: string) => new URL(`./fixtures/history/${name}`, import.meta.url).pathname;

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-adapters-test-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("客户端身份与 Node 来源声明分别注册，查询入口共享稳定名称与缩写", () => {
  assert.deepEqual(clientIds, ["codex", "claude", "codeflicker", "codeflicker-desktop"]);
  assert.deepEqual(HISTORY_CLIENTS.map(item => item.client), clientIds);
  assert.equal(clientName("codeflicker"), "CodeFlicker CLI");
  assert.equal(CLIENTS.find(item => item.id === "codeflicker")!.abbreviation, "CF");
});

test("未注册格式产生明确缺口，不把 CodeFlicker 记录按 Claude 兜底", async () => {
  const parsed = await parseSource(fixture("claude-tools.jsonl"), "codeflicker", undefined, "unknown-jsonl");
  assert.equal(parsed.client, "codeflicker");
  assert.equal(parsed.format, "unknown-jsonl");
  assert.equal(parsed.events.length, 0);
  assert.ok(parsed.gaps.some(gap => gap.kind === "unsupported_format" && gap.message.includes("unknown-jsonl")));
  const continued = await parseSource(parsed.path, "codeflicker", parsed, "unknown-jsonl");
  assert.equal(continued.gaps.filter(gap => gap.kind === "unsupported_format").length, 1);
});

test("复用同一格式仍保留实际客户端身份与原始工具名，切换格式使游标重建", async () => {
  for (const [name, format] of [["codex-legacy.jsonl", "codex-jsonl"], ["claude-tools.jsonl", "claude-jsonl"]]) {
    const parsed = await parseSource(fixture(name!), "codeflicker", undefined, format!);
    assert.ok(parsed.events.length > 0);
    assert.ok(parsed.sourceId.startsWith("codeflicker:"));
    assert.equal(parsed.format, format);
    assert.ok(parsed.events.every(event => event.client === "codeflicker" && event.sources.every(source => source.format === format)));
    const original = await parseSource(fixture(name!), format === "codex-jsonl" ? "codex" : "claude");
    assert.deepEqual(parsed.events.map(event => [event.tool, event.kind, event.status, event.fragments]), original.events.map(event => [event.tool, event.kind, event.status, event.fragments]));
    const continued = await parseSource(parsed.path, "codeflicker", parsed, format);
    assert.equal((continued.cursor as { parsedRecords: number }).parsedRecords, 0);
    const different = await parseSource(parsed.path, "codeflicker", continued, "unregistered-format");
    assert.equal(different.events.length, 0);
    assert.ok((different.cursor as { parsedRecords: number }).parsedRecords > 0);
  }
});

test("显式停用 roots 与缺省客户端环境变量同时生效，来源 format 可跨 Worker 序列化", async () => temporary(async directory => {
  await writeFile(join(directory, "session.jsonl"), "{}\n");
  const previous = process.env.AGENT_MANOR_CODEFLICKER_DIR;
  process.env.AGENT_MANOR_CODEFLICKER_DIR = directory;
  try {
    const sources = await discoverSources({ codex: [], claude: [], "codeflicker-desktop": [] });
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.client, "codeflicker");
    assert.equal(sources[0]!.format, "codeflicker-jsonl");
    assert.deepEqual(JSON.parse(JSON.stringify(sources)), sources);
    assert.deepEqual(await discoverSources({ codex: [], claude: [], codeflicker: [], "codeflicker-desktop": [] }), []);
  } finally {
    if (previous === undefined) delete process.env.AGENT_MANOR_CODEFLICKER_DIR;
    else process.env.AGENT_MANOR_CODEFLICKER_DIR = previous;
  }
}));

test("原始证据按引用格式回读，保留旧引用兼容、行哈希和符号链接拒绝", async () => temporary(async directory => {
  const path = join(directory, "session.jsonl");
  await writeFile(path, await readFile(fixture("codex-legacy.jsonl")));
  const parsed = await parseSource(path, "codeflicker", undefined, "codex-jsonl");
  const reference = parsed.events[0]!.sources[0]!;
  const record = await readEvidence(reference);
  assert.ok(record?.raw.includes("function_call"));
  assert.equal(await readEvidence({ ...reference, format: "unregistered-format" }), undefined);
  assert.equal(await readEvidence({ ...reference, hash: "changed" }), undefined);
  const legacy = await parseSource(path, "codex");
  const { format: _format, ...legacyReference } = legacy.events[0]!.sources[0]!;
  assert.ok(await readEvidence(legacyReference));
  const link = join(directory, "linked.jsonl");
  await symlink(path, link);
  assert.equal(await readEvidence({ ...reference, path: link }), undefined);
}));
