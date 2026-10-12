import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import Database from "better-sqlite3";
import { buildCoverage } from "../src/analysis/index.js";
import { AnalysisStore, StoreError } from "../src/index/index.js";
import { refreshRepository } from "../src/index/refresh.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

const git = promisify(execFile);
const encode = (records: unknown[]) => records.map((record) => JSON.stringify(record) + "\n").join("");
const meta = (cwd: string | undefined, id = "synthetic-index", extra = {}) => ({ type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { id, cwd, ...extra } });
const call = (cwd: string | undefined, id: string, command = "cat a.ts") => ({ type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: id, arguments: JSON.stringify({ command, workdir: cwd }) } });
const output = (id: string, content = "alpha\nbeta\n") => ({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: `Exit code: 0\nOutput:\n${content}` } });

async function fixture(run: (context: { directory: string; repositoryPath: string; history: string; sourcePath: string; store: AnalysisStore; repositoryId: string; refresh: (clear?: boolean) => Promise<string> }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "manor-index-test-"));
  const repositoryPath = join(directory, "repo");
  const history = join(directory, "history");
  await mkdir(repositoryPath);
  await mkdir(history);
  await git("git", ["init", "-q", repositoryPath]);
  await writeFile(join(repositoryPath, "a.ts"), "alpha\nbeta\n");
  const sourcePath = join(history, "source.jsonl");
  const store = new AnalysisStore(join(directory, "index.sqlite"));
  try {
    const repository = await store.registerRepository(repositoryPath);
    const refresh = async (clear = false) => {
      const job = store.createJob(repository.id);
      await refreshRepository(store, job.id, isolatedHistoryRoots({ codex: history }), clear);
      assert.equal(store.getJob(job.id).status, "completed", store.getJob(job.id).error);
      return store.getJob(job.id).version!;
    };
    await run({ directory, repositoryPath: repository.path, history, sourcePath, store, repositoryId: repository.id, refresh });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("SQLite新结构与WAL；登记、完整版本和手动关联重开后保留", async () => fixture(async ({ directory, repositoryPath, history, sourcePath, store, repositoryId, refresh }) => {
  await writeFile(sourcePath, encode([meta(repositoryPath), call(repositoryPath, "first"), output("first")]));
  const orphan = join(history, "orphan.jsonl");
  await writeFile(orphan, encode([meta(undefined, "orphan"), call(undefined, "manual"), output("manual")]));
  assert.throws(() => store.getSnapshot(repositoryId), (error) => error instanceof StoreError && error.code === "ANALYSIS_NOT_READY");
  await refresh();
  const unknown = store.listSources(repositoryId).unassociated.find((source) => source.sessionId === "orphan")!;
  store.associateSource(repositoryId, unknown.sourceId);
  const version = await refresh(true);
  assert.equal(buildCoverage(store.getSnapshot(repositoryId)).files[0]!.readCount, 2);
  assert.equal(store.listSources(repositoryId).sources.find((source) => source.sourceId === unknown.sourceId)!.association, "manual");
  const second = new AnalysisStore(join(directory, "index.sqlite"));
  try {
    assert.equal(second.getRepository(repositoryId).version, version);
    assert.ok(second.getManualAssociations(repositoryId).has(unknown.sourceId));
    assert.equal(second.getSnapshot(repositoryId).events.length, 2);
    assert.ok(second.getTrackedSources(repositoryId).every(source => source.format === "codex-jsonl"));
    const database = new Database(second.dbPath);
    assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(database.pragma("user_version", { simple: true }), 4);
    database.close();
  } finally { second.close(); }
}));

test("总览覆盖快照在 SQL 中移除正文，计数与映射覆盖保持一致", async () => fixture(async ({ repositoryPath, sourcePath, store, repositoryId, refresh }) => {
  await writeFile(sourcePath, encode([meta(repositoryPath), call(repositoryPath, "read"), output("read")]));
  const version = await refresh();
  const full = store.getSnapshot(repositoryId, version);
  const narrow = store.getCoverageSnapshot(repositoryId, version);
  assert.deepEqual(buildCoverage(narrow), buildCoverage(full));
  assert.deepEqual(narrow.mappings, full.mappings);
  assert.deepEqual(narrow.sources, full.sources);
  assert.equal(narrow.baseline.files[0]!.content, "");
  assert.ok(narrow.events.every(event => event.input === undefined && event.output === undefined
    && event.fragments.every(fragment => fragment.content === "")));
  assert.ok(JSON.stringify(narrow).length < JSON.stringify(full).length);
  assert.deepEqual(store.getSnapshot(repositoryId, version), full);
  assert.throws(() => store.getCoverageSnapshot(repositoryId, "missing"), error => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
}));

test("无变化快检复用正文和旧版，当前单文件变化只使对应失效", async () => fixture(async ({ repositoryPath, sourcePath, store, repositoryId, refresh }) => {
  const content = "const alpha = 1;\nconst beta = 2;\n";
  await writeFile(join(repositoryPath, "a.ts"), content);
  const original = encode([meta(repositoryPath), call(repositoryPath, "first"), output("first", content)]);
  await writeFile(sourcePath, original);
  const first = await refresh();
  assert.equal(store.getRefreshStats(repositoryId).parsedRecords, 3);
  assert.equal(store.getRefreshStats(repositoryId).mappingsComputed, 1);
  const next = await refresh();
  assert.equal(next, first);
  assert.equal(store.getRefreshStats(repositoryId).sourcesParsed, 0);
  assert.equal(store.getRefreshStats(repositoryId).sourcesReused, 1);
  assert.equal(store.getRefreshStats(repositoryId).parsedRecords, 0);
  assert.equal(store.getRefreshStats(repositoryId).mappingsComputed, 0);
  assert.equal(store.getRefreshStats(repositoryId).mappingsReused, 1);
  assert.equal(buildCoverage(store.getSnapshot(repositoryId)).files[0]!.readCount, 1);
  const oldCreatedAt = store.getSnapshot(repositoryId, next).createdAt;
  await writeFile(join(repositoryPath, "a.ts"), "inserted\n" + content);
  await refresh();
  assert.equal(store.getRefreshStats(repositoryId).mappingsComputed, 1);
  assert.equal(store.getRefreshStats(repositoryId).parsedRecords, 0);
  assert.deepEqual(store.getSnapshot(repositoryId).mappings[0]!.exactRanges, [{ start: 2, end: 3 }]);
  assert.equal(store.getSnapshot(repositoryId, next).createdAt, oldCreatedAt);
  assert.equal(store.getSnapshot(repositoryId, first).createdAt, oldCreatedAt);
  assert.equal(await readFile(sourcePath, "utf8"), original);
}));

test("无变化检查不写正文分块，快检失效但内容相同也只更新缓存头部", async () => fixture(async ({ repositoryPath, sourcePath, store, repositoryId, refresh }) => {
  const original = encode([meta(repositoryPath), call(repositoryPath, "stable"), output("stable")]);
  await writeFile(sourcePath, original);
  const version = await refresh();
  const published = store.getSnapshot(repositoryId);
  const database = new Database(store.dbPath);
  try {
    database.exec(`
      CREATE TRIGGER reject_payload_insert BEFORE INSERT ON payload_parts BEGIN SELECT RAISE(ABORT,'unchanged payload insert'); END;
      CREATE TRIGGER reject_payload_delete BEFORE DELETE ON payload_parts BEGIN SELECT RAISE(ABORT,'unchanged payload delete'); END;
      CREATE TRIGGER reject_payload_update BEFORE UPDATE ON payload_parts BEGIN SELECT RAISE(ABORT,'unchanged payload update'); END;
      CREATE TRIGGER reject_mapping_update BEFORE UPDATE ON mapping_cache BEGIN SELECT RAISE(ABORT,'unchanged mapping update'); END;
    `);
    assert.equal(await refresh(), version);
    assert.equal(store.getRefreshStats(repositoryId).sourcesParsed, 0);
    assert.equal(store.getRefreshStats(repositoryId, version).parsedRecords, 3, "发布时统计不能被后续检查覆盖");
    assert.deepEqual(store.getSnapshot(repositoryId), published);
    await writeFile(sourcePath, original);
    assert.equal(await refresh(), version);
    assert.equal(store.getRefreshStats(repositoryId).sourcesParsed, 1, "变化指示失效必须重新核对内容");
    assert.equal(store.getRefreshStats(repositoryId).parsedRecords, 0);
    assert.deepEqual(store.getSnapshot(repositoryId), published);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM versions").get() as { count: number }).count, 1);
  } finally { database.close(); }
}));

test("单个来源追加只改该来源缓存，其他来源分块不写入且增量与完整结果一致", async () => fixture(async ({ repositoryPath, sourcePath, history, store, repositoryId, refresh }) => {
  const stablePath = join(history, "stable.jsonl");
  await writeFile(sourcePath, encode([meta(repositoryPath), call(repositoryPath, "changed"), output("changed")]));
  await writeFile(stablePath, encode([meta(repositoryPath, "stable-source"), call(repositoryPath, "stable"), output("stable")]));
  const first = await refresh();
  const stable = store.getParsedSources(repositoryId).find(source => source.path === stablePath)!;
  const database = new Database(store.dbPath);
  const owner = JSON.stringify([stable.sourceId, stable.path]);
  const oldParts = database.prepare("SELECT * FROM payload_parts WHERE kind='parsed' AND owner=? ORDER BY field,part").all(owner);
  database.exec("CREATE TABLE protected_source (owner TEXT PRIMARY KEY)");
  database.prepare("INSERT INTO protected_source(owner) VALUES(?)").run(owner);
  try {
    database.exec(`
      CREATE TRIGGER reject_stable_insert BEFORE INSERT ON payload_parts WHEN NEW.kind='parsed' AND NEW.owner IN (SELECT owner FROM protected_source) BEGIN SELECT RAISE(ABORT,'stable payload insert'); END;
      CREATE TRIGGER reject_stable_delete BEFORE DELETE ON payload_parts WHEN OLD.kind='parsed' AND OLD.owner IN (SELECT owner FROM protected_source) BEGIN SELECT RAISE(ABORT,'stable payload delete'); END;
    `);
    await appendFile(sourcePath, encode([call(repositoryPath, "appended"), output("appended")]));
    const next = await refresh();
    assert.notEqual(next, first);
    assert.equal(store.getRefreshStats(repositoryId).sourcesParsed, 1);
    assert.equal(store.getRefreshStats(repositoryId).sourcesReused, 1);
    assert.equal(store.getRefreshStats(repositoryId).parsedRecords, 2);
    assert.equal(store.getSnapshot(repositoryId).events.length, 3);
    assert.deepEqual(database.prepare("SELECT * FROM payload_parts WHERE kind='parsed' AND owner=? ORDER BY field,part").all(owner), oldParts);
    const incremental = store.getSnapshot(repositoryId);
    database.exec("DROP TRIGGER reject_stable_insert; DROP TRIGGER reject_stable_delete;");
    await refresh(true);
    const complete = store.getSnapshot(repositoryId);
    assert.deepEqual(complete.events, incremental.events);
    assert.deepEqual(complete.mappings, incremental.mappings);
    assert.deepEqual(complete.gaps, incremental.gaps);
    assert.deepEqual(complete.sources, incremental.sources);
    assert.deepEqual(buildCoverage(complete).summary, buildCoverage(incremental).summary);
  } finally { database.close(); }
}));

test("桌面来源registry依赖改变后重建归属，不把同一正文快检复用到新cwd", async () => fixture(async ({ directory, repositoryPath, store, repositoryId }) => {
  const sessionsPath = join(directory, "desktop");
  const sessionPath = join(sessionsPath, "desktop-synthetic");
  const sourcePath = join(sessionPath, "message", "cache.jsonl");
  const registryPath = join(sessionPath, "checkpoints", "registry.json");
  await mkdir(join(sessionPath, "message"), { recursive: true });
  await mkdir(join(sessionPath, "checkpoints"));
  await writeFile(sourcePath, encode([
    { kind: "message", role: "assistant", id: "request", toolCalls: [{ id: "call", function: { name: "read_file", arguments: JSON.stringify({ path: "a.ts", start_line: 1, line_count: 2 }) } }] },
    { kind: "message", role: "tool", id: "result", toolCallId: "call", extra: { toolName: "read_file", output: { content: "alpha\nbeta\n", start_line: 1, line_count: 2, success: true } } },
  ]));
  await writeFile(registryPath, JSON.stringify({ sessionId: "desktop-synthetic", cwd: repositoryPath }));
  const refresh = async () => {
    const job = store.createJob(repositoryId);
    await refreshRepository(store, job.id, isolatedHistoryRoots({ "codeflicker-desktop": sessionsPath }));
    assert.equal(store.getJob(job.id).status, "completed", store.getJob(job.id).error);
    return store.getJob(job.id).version!;
  };
  const first = await refresh();
  assert.equal(store.getSnapshot(repositoryId).sources.length, 1);
  assert.equal(await refresh(), first);
  assert.equal(store.getRefreshStats(repositoryId).sourcesParsed, 0);
  await writeFile(registryPath, JSON.stringify({ sessionId: "desktop-synthetic", cwd: "/synthetic/outside" }));
  assert.notEqual(await refresh(), first);
  assert.equal(store.getRefreshStats(repositoryId).sourcesParsed, 1);
  assert.equal(store.getSnapshot(repositoryId).sources.length, 0);
  assert.equal(store.getSnapshot(repositoryId).events.length, 0);
  assert.equal(store.getSnapshot(repositoryId, first).sources.length, 1);
}));

test("来源与仓库内容未变但路径归属变化时必须发布新版", async () => fixture(async ({ directory, repositoryPath, sourcePath, store, repositoryId, refresh }) => {
  const alias = join(directory, "history-file-alias");
  const outside = join(directory, "outside.ts");
  await writeFile(outside, "alpha\nbeta\n");
  await symlink(join(repositoryPath, "a.ts"), alias);
  await writeFile(sourcePath, encode([meta(repositoryPath), call(repositoryPath, "alias", `cat '${alias}'`), output("alias")]));
  const first = await refresh();
  const before = store.getSnapshot(repositoryId);
  assert.equal(before.events.length, 1);
  assert.equal(before.events[0]!.path, "a.ts");
  await rm(alias);
  await symlink(outside, alias);
  assert.notEqual(await refresh(), first);
  const after = store.getSnapshot(repositoryId);
  assert.equal(store.getRefreshStats(repositoryId).sourcesParsed, 0);
  assert.equal(after.baseline.hash, before.baseline.hash);
  assert.equal(after.sources.length, 1);
  assert.equal(after.events.length, 0);
  assert.equal(store.getSnapshot(repositoryId, first).events.length, 1);
}));

test("原生 Agent 跨来源关系贯通来源列表与快照，重复刷新不增加调用且缓存保持原始元数据", async () => fixture(async ({ repositoryPath, history, sourcePath, store, repositoryId }) => {
  const fixturePath = (name: string) => new URL(`./fixtures/history/${name}`, import.meta.url).pathname;
  const parent = await readFile(fixturePath("codeflicker-agent-parent.jsonl"), "utf8");
  const child = (await readFile(fixturePath("agent-child-a.jsonl"), "utf8")).replaceAll("/synthetic/repo", repositoryPath);
  const childPath = join(history, "agent-child-a.jsonl");
  await writeFile(sourcePath, parent);
  await writeFile(childPath, child);
  const refresh = async () => {
    const job = store.createJob(repositoryId);
    await refreshRepository(store, job.id, isolatedHistoryRoots({ codeflicker: history }));
    assert.equal(store.getJob(job.id).status, "completed", store.getJob(job.id).error);
  };
  await refresh();
  const first = store.getSnapshot(repositoryId);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0]!.sessionId, "agent-child-a");
  assert.equal(first.events[0]!.parentSessionId, "synthetic-parent");
  assert.ok(first.events[0]!.sources.some(reference => reference.path === sourcePath && reference.recordLine === 2));
  assert.equal(first.sources.find(source => source.sessionId === "agent-child-a")!.parentSessionId, "synthetic-parent");
  assert.equal(store.listSources(repositoryId).sources.find(source => source.sessionId === "agent-child-a")!.parentSessionId, "synthetic-parent");
  assert.equal(store.getParsedSources(repositoryId).find(source => source.sessionId === "agent-child-a")!.parentSessionId, undefined);
  assert.equal(buildCoverage(first).files[0]!.readCount, 1);
  await refresh();
  const next = store.getSnapshot(repositoryId);
  assert.deepEqual(next.events.map(event => event.id), first.events.map(event => event.id));
  assert.equal(store.getRefreshStats(repositoryId).parsedRecords, 0);
  assert.equal(buildCoverage(next).files[0]!.readCount, 1);
  await rm(sourcePath);
  await refresh();
  const orphan = store.getSnapshot(repositoryId);
  assert.equal(orphan.events.length, 1);
  assert.equal(orphan.events[0]!.parentSessionId, undefined);
  assert.equal(orphan.sources.find(source => source.sessionId === "agent-child-a")!.parentSessionId, undefined);
  assert.ok(orphan.gaps.some(gap => gap.kind === "ambiguous"));
  assert.ok(!orphan.events[0]!.sources.some(reference => reference.path === sourcePath));
}));

test("矛盾 Agent 父关系不发布到来源列表与快照，重复刷新仍保留缺口和原始声明", async () => fixture(async ({ repositoryPath, history, sourcePath, store, repositoryId }) => {
  const fixturePath = (name: string) => new URL(`./fixtures/history/${name}`, import.meta.url).pathname;
  await writeFile(sourcePath, await readFile(fixturePath("codeflicker-agent-parent.jsonl")));
  await writeFile(join(history, "second.jsonl"), encode([{ type: "message", role: "assistant", sessionId: "second", content: [] }]));
  const childRecords = (await readFile(fixturePath("agent-child-a.jsonl"), "utf8")).replaceAll("/synthetic/repo", repositoryPath)
    .trim().split("\n").map(line => ({ ...JSON.parse(line), parentSessionId: "second" }));
  await writeFile(join(history, "agent-child-a.jsonl"), encode(childRecords));
  let eventIds: string[] | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const job = store.createJob(repositoryId);
    await refreshRepository(store, job.id, isolatedHistoryRoots({ codeflicker: history }));
    assert.equal(store.getJob(job.id).status, "completed", store.getJob(job.id).error);
    const snapshot = store.getSnapshot(repositoryId);
    const child = snapshot.sources.find(source => source.sessionId === "agent-child-a")!;
    assert.equal(child.parentSessionId, undefined);
    assert.equal(snapshot.events[0]!.parentSessionId, undefined);
    assert.ok(snapshot.gaps.some(gap => gap.sourceId === child.sourceId && gap.kind === "ambiguous"));
    assert.equal(store.listSources(repositoryId).sources.find(source => source.sourceId === child.sourceId)!.parentSessionId, undefined);
    assert.equal(store.getParsedSources(repositoryId).find(source => source.sourceId === child.sourceId)!.parentSessionId, "second");
    assert.equal(buildCoverage(snapshot).files[0]!.readCount, 1);
    if (eventIds) {
      assert.deepEqual(snapshot.events.map(event => event.id), eventIds);
      assert.equal(store.getRefreshStats(repositoryId).parsedRecords, 0);
    } else eventIds = snapshot.events.map(event => event.id);
  }
}));

test("跨刷新补结果与未完整Unicode尾部，只续读完整新增记录且不累加同一调用", async () => fixture(async ({ repositoryPath, sourcePath, store, repositoryId, refresh }) => {
  await writeFile(join(repositoryPath, "a.ts"), "你好\n");
  await writeFile(sourcePath, encode([meta(repositoryPath), call(repositoryPath, "pending")]));
  const first = await refresh();
  assert.equal(store.getSnapshot(repositoryId).events[0]!.status, "unknown");
  const tail = Buffer.from(encode([output("pending", "你好\n")]));
  const split = tail.indexOf(Buffer.from("你好")) + 2;
  await appendFile(sourcePath, tail.subarray(0, split));
  const partial = await refresh();
  assert.equal(store.getRefreshStats(repositoryId).parsedRecords, 0);
  assert.ok(store.getSnapshot(repositoryId).gaps.some((gap) => gap.kind === "incomplete_record"));
  await appendFile(sourcePath, tail.subarray(split));
  await refresh();
  const snapshot = store.getSnapshot(repositoryId);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0]!.status, "success");
  assert.equal(store.getRefreshStats(repositoryId).parsedRecords, 1);
  assert.ok(!snapshot.gaps.some((gap) => gap.kind === "unpaired_call" || gap.kind === "incomplete_record"));
  assert.equal(buildCoverage(snapshot).summary.readExact.lines, 1);
  assert.equal(store.getSnapshot(repositoryId, partial).events[0]!.status, "unknown");
  assert.throws(() => store.getSnapshot(repositoryId, first), (error) => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
}));

test("来源移动不新增活动；ENOENT从新版排除且上一版可查询；无关来源不形成missing gap", async () => fixture(async ({ repositoryPath, history, sourcePath, store, repositoryId, refresh }) => {
  await writeFile(sourcePath, encode([meta(repositoryPath), call(repositoryPath, "first"), output("first")]));
  const unrelated = join(history, "unrelated.jsonl");
  await writeFile(unrelated, encode([meta("/synthetic/other-repository", "unrelated"), call("/synthetic/other-repository", "outside"), output("outside")]));
  const first = await refresh();
  assert.equal(store.getRefreshStats(repositoryId).sourcesParsed, 1);
  const moved = join(history, "archived.jsonl");
  await rename(sourcePath, moved);
  await rm(unrelated);
  const second = await refresh();
  assert.equal(store.getSnapshot(repositoryId).events[0]!.id, store.getSnapshot(repositoryId, first).events[0]!.id);
  assert.equal(store.getRefreshStats(repositoryId).parsedRecords, 0);
  assert.equal(buildCoverage(store.getSnapshot(repositoryId)).files[0]!.readCount, 1);
  assert.ok(!store.getSnapshot(repositoryId).gaps.some((gap) => gap.kind === "source_missing"));
  assert.ok(store.getSnapshot(repositoryId).events[0]!.sources.every((source) => source.path === moved));
  await rm(moved);
  await refresh();
  assert.equal(store.getSnapshot(repositoryId).events.length, 0);
  assert.equal(store.getSnapshot(repositoryId).previousVersion, second);
  assert.ok(store.getSnapshot(repositoryId).gaps.some((gap) => gap.kind === "source_missing"));
  assert.equal(store.getSnapshot(repositoryId, second).events.length, 1);
  await refresh();
  assert.ok(store.getSnapshot(repositoryId).gaps.some((gap) => gap.kind === "source_missing"));
  await writeFile(moved, encode([meta(repositoryPath), call(repositoryPath, "first"), output("first")]));
  await refresh();
  assert.equal(store.getSnapshot(repositoryId).events.length, 1);
  assert.ok(!store.getSnapshot(repositoryId).gaps.some((gap) => gap.kind === "source_missing"));
}));

test("截断、同大小替换和解析规则变化重算受影响来源", async () => fixture(async ({ repositoryPath, sourcePath, store, repositoryId, refresh }) => {
  const original = encode([meta(repositoryPath), call(repositoryPath, "first"), output("first"), call(repositoryPath, "second"), output("second")]);
  await writeFile(sourcePath, original);
  await refresh();
  assert.equal(store.getSnapshot(repositoryId).events.length, 2);
  await writeFile(sourcePath, encode([meta(repositoryPath), call(repositoryPath, "first"), output("first")]));
  await refresh();
  assert.equal(store.getSnapshot(repositoryId).events.length, 1);
  assert.equal(store.getRefreshStats(repositoryId).parsedRecords, 3);
  await writeFile(sourcePath, encode([meta(repositoryPath), call(repositoryPath, "third"), output("third")]));
  await refresh();
  assert.equal(store.getRefreshStats(repositoryId).parsedRecords, 3);
  const database = new Database(store.dbPath);
  database.exec("UPDATE source_cache SET json=json_set(json,'$.value.cursor.ruleVersion','obsolete')");
  database.close();
  await refresh();
  assert.equal(store.getRefreshStats(repositoryId).parsedRecords, 3);
  assert.equal(store.getSnapshot(repositoryId).events.length, 1);
  const incompatible = new Database(store.dbPath);
  incompatible.exec("UPDATE source_cache SET json=json_set(json,'$.value.cursor.format','obsolete-format')");
  incompatible.close();
  await refresh();
  assert.equal(store.getRefreshStats(repositoryId).sourcesParsed, 1);
  assert.equal(store.getRefreshStats(repositoryId).parsedRecords, 3, "格式游标失效不能被未变依赖快检覆盖");
}));

test("临时I/O失败不当来源缺失；清缓存失败仍保留旧版和可复用缓存", async () => fixture(async ({ repositoryPath, history, sourcePath, store, repositoryId, refresh }) => {
  await writeFile(sourcePath, encode([meta(repositoryPath), call(repositoryPath, "first"), output("first")]));
  const first = await refresh();
  await rename(history, `${history}-saved`);
  await writeFile(history, "temporary IO failure");
  const job = store.createJob(repositoryId);
  await refreshRepository(store, job.id, isolatedHistoryRoots({ codex: history }), true);
  assert.equal(store.getJob(job.id).status, "failed");
  assert.equal(store.getRepository(repositoryId).version, first);
  assert.equal(store.getRepository(repositoryId).stale, true);
  assert.equal(store.getSnapshot(repositoryId).events.length, 1);
  assert.ok(!store.getSnapshot(repositoryId).gaps.some((gap) => gap.kind === "source_missing"));
  assert.equal(store.getParsedSources(repositoryId).length, 1);
  await rm(history);
  await rename(`${history}-saved`, history);
  await refresh(true);
  assert.equal(store.getRefreshStats(repositoryId).parsedRecords, 3);
  assert.equal(store.getRefreshStats(repositoryId).mappingsReused, 0);
  assert.equal(store.getRepository(repositoryId).stale, false);
  assert.equal(buildCoverage(store.getSnapshot(repositoryId)).files[0]!.readCount, 1);
}));

test("事务发布失败不泄漏新版、缓存或完成任务；已有version不能覆盖", async () => fixture(async ({ repositoryPath, sourcePath, store, repositoryId, refresh }) => {
  await writeFile(sourcePath, encode([meta(repositoryPath), call(repositoryPath, "first"), output("first")]));
  const first = await refresh();
  await appendFile(sourcePath, encode([call(repositoryPath, "second"), output("second")]));
  const database = new Database(store.dbPath);
  const partsBefore = database.prepare("SELECT kind,owner,field,part,json FROM payload_parts ORDER BY kind,owner,field,part").all();
  database.exec("CREATE TRIGGER reject_publish BEFORE UPDATE OF version ON repositories BEGIN SELECT RAISE(ABORT,'synthetic publish failure'); END;");
  const job = store.createJob(repositoryId);
  await refreshRepository(store, job.id, isolatedHistoryRoots({ codex: join(sourcePath, "..") }));
  assert.equal(store.getJob(job.id).status, "failed");
  assert.equal(store.getRepository(repositoryId).version, first);
  assert.equal(store.getSnapshot(repositoryId).events.length, 1);
  assert.equal(store.getParsedSources(repositoryId)[0]!.events.length, 1);
  assert.equal((database.prepare("SELECT count(*) AS count FROM versions").get() as { count: number }).count, 1);
  assert.deepEqual(database.prepare("SELECT kind,owner,field,part,json FROM payload_parts ORDER BY kind,owner,field,part").all(), partsBefore);
  database.exec("DROP TRIGGER reject_publish");
  const snapshot = store.getSnapshot(repositoryId);
  const duplicateJob = store.createJob(repositoryId);
  store.updateJob(duplicateJob.id, { status: "running" });
  assert.throws(() => store.publish({ snapshot: { ...snapshot, createdAt: "changed" }, sources: store.listSources(repositoryId), parsed: [], mappings: [],
    stats: { sourcesParsed: 0, parsedRecords: 0, mappingsComputed: 0, mappingsReused: 0 }, clearCache: false, jobId: duplicateJob.id }), /UNIQUE/);
  assert.equal(store.getSnapshot(repositoryId).createdAt, snapshot.createdAt);
  database.close();
  await refresh();
  assert.equal(store.getSnapshot(repositoryId).events.length, 2);
}));

test("大结果分块发布，来源汇总与解析游标完整往返，重开和清缓存保留旧版", async () => fixture(async ({ directory, repositoryPath, sourcePath, store, repositoryId, refresh }) => {
  await writeFile(sourcePath, encode([meta(repositoryPath), call(repositoryPath, "first"), output("first")]));
  await refresh();
  const snapshot = store.getSnapshot(repositoryId);
  const parsed = store.getParsedSources(repositoryId);
  snapshot.version = "large-synthetic-version";
  snapshot.events = Array.from({ length: 80 }, (_, index) => ({ ...snapshot.events[0]!, id: `large-${index}`, output: "证据".repeat(4096) }));
  parsed[0]!.events = snapshot.events;
  parsed[0]!.cursor = { pending: [], recordEnds: Array.from({ length: 30000 }, (_, index) => index),
    seen: Object.fromEntries(Array.from({ length: 10000 }, (_, index) => [`request:${index}`, `event:${index}`])), occurrences: {}, relationships: [] };
  const sources = store.listSources(repositoryId);
  sources.version = snapshot.version;
  sources.gaps = Array.from({ length: 80 }, () => ({ kind: "range_unknown", message: "范围".repeat(4096) }));
  snapshot.gaps = sources.gaps;
  const job = store.createJob(repositoryId);
  const stringify = JSON.stringify;
  store.updateJob(job.id, { status: "running" });
  // 缩小字符串上限复现聚合溢出，避免回归测试为此分配半 GB 以上内存。
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const value = stringify(...args);
    if (value && value.length > 128 * 1024) throw new RangeError("Invalid string length (synthetic limit)");
    return value;
  }) as typeof JSON.stringify;
  try {
    store.publish({ snapshot, sources, parsed, mappings: [], stats: { sourcesParsed: 1, parsedRecords: 0, mappingsComputed: 0, mappingsReused: 0 }, clearCache: true, jobId: job.id });
  } finally { JSON.stringify = stringify; }
  const reopened = new AnalysisStore(join(directory, "index.sqlite"));
  try {
    assert.deepEqual(reopened.getSnapshot(repositoryId).events, snapshot.events);
    assert.ok(reopened.getSnapshot(repositoryId).sources.every((source) => !("events" in source) && !("cursor" in source)));
    assert.deepEqual(reopened.listSources(repositoryId), sources);
    assert.deepEqual(reopened.getSnapshot(repositoryId).gaps, sources.gaps);
    const database = new Database(store.dbPath);
    try {
      const row = database.prepare("SELECT sources FROM versions WHERE version=?").get(snapshot.version) as { sources: string };
      assert.ok(!("gaps" in (JSON.parse(row.sources) as { value: object }).value));
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM payload_parts WHERE kind='sources' AND field='gaps'").get() as { count: number }).count, 0);
      assert.ok((database.prepare("SELECT COUNT(*) AS count FROM payload_parts WHERE kind='snapshot' AND field='gaps' AND owner=?").get(snapshot.version) as { count: number }).count > 0);
      const event = database.prepare("SELECT part,json FROM payload_parts WHERE kind='snapshot' AND field='events' AND owner=? LIMIT 1").get(snapshot.version) as { part: number; json: string };
      database.prepare("UPDATE payload_parts SET json='invalid-synthetic-json' WHERE kind='snapshot' AND field='events' AND owner=? AND part=?").run(snapshot.version, event.part);
      assert.deepEqual(reopened.listSources(repositoryId), sources, "来源查询不能为了缺口读取事件正文");
      database.prepare("UPDATE payload_parts SET json=? WHERE kind='snapshot' AND field='events' AND owner=? AND part=?").run(event.json, snapshot.version, event.part);
    } finally { database.close(); }
    assert.deepEqual(reopened.getParsedSources(repositoryId), parsed);
    const version = snapshot.version;
    await refresh(true);
    assert.equal(reopened.getParsedSources(repositoryId)[0]!.events.length, 1);
    assert.deepEqual(reopened.getSnapshot(repositoryId, version).events, snapshot.events);
    assert.deepEqual(reopened.listSources(repositoryId, version), sources);
  } finally { reopened.close(); }
}));

test("先解析fork父来源再逐事件关联；初始cwd和manual都不能混入外部活动", async () => fixture(async ({ repositoryPath, history, sourcePath, store, repositoryId, refresh }) => {
  const parent = encode([meta("/synthetic/outside", "parent"), call(repositoryPath, "shared"), output("shared")]);
  await writeFile(join(history, "parent.jsonl"), parent);
  await writeFile(sourcePath, encode([meta(repositoryPath, "child", { history_base: { thread_id: "parent", end_byte_offset: Buffer.byteLength(parent) } }), call("/synthetic/outside", "outside"), output("outside")]));
  await refresh();
  assert.equal(store.getRefreshStats(repositoryId).sourcesParsed, 2);
  const snapshot = store.getSnapshot(repositoryId);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0]!.sessionId, "parent");
  assert.equal(buildCoverage(snapshot).files[0]!.readCount, 1);
  const child = store.listSources(repositoryId).sources.find((source) => source.sessionId === "child")!;
  store.associateSource(repositoryId, child.sourceId);
  await refresh();
  assert.equal(store.getSnapshot(repositoryId).events.length, 1);
}));

test("同commonDir worktree历史映射到当前相对路径，独立clone候选不解析", async () => fixture(async ({ directory, repositoryPath, history, sourcePath, store, repositoryId, refresh }) => {
  await git("git", ["-C", repositoryPath, "add", "a.ts"]);
  await git("git", ["-C", repositoryPath, "-c", "user.name=synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "fixture"]);
  const worktree = join(directory, "worktree");
  await git("git", ["-C", repositoryPath, "worktree", "add", "-qb", "fixture-worktree", worktree]);
  const clone = join(directory, "clone");
  await git("git", ["clone", "-q", repositoryPath, clone]);
  await writeFile(sourcePath, encode([meta(worktree), call(worktree, "worktree"), output("worktree")]));
  await writeFile(join(history, "clone.jsonl"), encode([meta(clone, "clone"), call(clone, "clone"), output("clone")]));
  await refresh();
  assert.equal(store.getRefreshStats(repositoryId).sourcesParsed, 1);
  assert.equal(buildCoverage(store.getSnapshot(repositoryId)).files[0]!.readCount, 1);
  assert.equal(buildCoverage(store.getSnapshot(repositoryId)).summary.readExact.lines, 2);
  assert.equal(store.getSnapshot(repositoryId).events[0]!.cwd, repositoryPath);
  assert.equal(store.getSnapshot(repositoryId).events[0]!.path, "a.ts");
}));

test("未关联元数据在追加相关读取或后补历史 worktree 证明后恢复完整证据", async () => fixture(async ({ directory, repositoryPath, history, sourcePath, store, repositoryId, refresh }) => {
  const worktree = join(directory, "deleted-worktree");
  const orphan = join(history, "orphan.jsonl");
  const concrete = (id: string, command: string, content: string, seconds: number, cwd?: string) => ({
    type: "event_msg", timestamp: `2026-01-01T00:00:0${seconds}Z`, payload: { type: "item_completed", item: {
      id, type: "CommandExecution", command: ["/bin/sh", "-c", command], cwd, status: "completed", exit_code: 0, formatted_output: content,
    } },
  });
  await writeFile(orphan, encode([meta(undefined, "orphan"), concrete("read", `cat '${join(worktree, "a.ts")}'`, "alpha\nbeta\n", 3)]));
  await refresh();
  assert.equal(store.getSnapshot(repositoryId).events.length, 0);
  assert.equal((store.getParsedSources(repositoryId)[0]!.cursor as { associationOnly: boolean }).associationOnly, true);
  const porcelain = [repositoryPath, worktree].map(path => `worktree ${path}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/main\n\n`).join("");
  await writeFile(sourcePath, encode([meta(repositoryPath),
    concrete("create", `git worktree add -b synthetic '${worktree}'`, "Preparing worktree (new branch 'synthetic')\nHEAD is now at abc123 fixture\n", 2, repositoryPath),
    concrete("list", "git worktree list --porcelain", porcelain, 4, repositoryPath),
  ]));
  await refresh();
  let coverage = buildCoverage(store.getSnapshot(repositoryId));
  assert.equal(coverage.files[0]!.readCount, 1);
  assert.equal(coverage.summary.readExact.lines, 2);
  assert.equal(store.getSnapshot(repositoryId).events.find(event => event.kind === "read")!.fragments[0]!.content, "alpha\nbeta\n");
  await appendFile(orphan, encode([concrete("new-read", `cat '${join(repositoryPath, "a.ts")}'`, "alpha\nbeta\n", 5)]));
  await refresh();
  coverage = buildCoverage(store.getSnapshot(repositoryId));
  assert.equal(coverage.files[0]!.readCount, 2);
  const eventIds = store.getSnapshot(repositoryId).events.map(event => event.id);
  await refresh(true);
  assert.deepEqual(store.getSnapshot(repositoryId).events.map(event => event.id), eventIds);
}));

test("旧索引结构明确拒绝，初始化不增加迁移或兼容读写", async () => fixture(async ({ directory }) => {
  for (const version of [1, 2, 3, 5]) {
    const path = join(directory, `unsupported-${version}.sqlite`);
    const database = new Database(path);
    database.pragma(`user_version = ${version}`);
    database.close();
    assert.throws(() => new AnalysisStore(path), /不支持的索引版本/);
    const untouched = new Database(path);
    assert.equal(untouched.pragma("user_version", { simple: true }), version);
    assert.equal((untouched.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get() as { count: number }).count, 0);
    untouched.close();
  }
  const unversioned = join(directory, "unversioned.sqlite");
  const database = new Database(unversioned);
  database.exec("CREATE TABLE repositories (id TEXT PRIMARY KEY, json TEXT NOT NULL)");
  try {
    assert.throws(() => new AnalysisStore(unversioned), /不支持的索引版本/);
    assert.equal(database.pragma("user_version", { simple: true }), 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get() as { count: number }).count, 1);
  } finally { database.close(); }
}));

test("按成功发布顺序保留每仓库最近两版，淘汰分块而保留配置与解析缓存", async () => fixture(async ({ directory, repositoryPath, sourcePath, store, repositoryId, refresh }) => {
  await writeFile(sourcePath, encode([meta(repositoryPath), call(repositoryPath, "first"), output("first")]));
  const original = await refresh();
  const snapshot = store.getSnapshot(repositoryId);
  const sources = store.listSources(repositoryId);
  const parsed = store.getParsedSources(repositoryId);
  store.associateSource(repositoryId, sources.sources[0]!.sourceId);
  const otherPath = join(directory, "other-repository");
  await mkdir(otherPath);
  await git("git", ["init", "-q", otherPath]);
  await writeFile(join(otherPath, "other.ts"), "other\n");
  const other = await store.registerRepository(otherPath);
  for (let attempt = 0; attempt < 2; attempt++) {
    const job = store.createJob(other.id);
    await refreshRepository(store, job.id, isolatedHistoryRoots());
    assert.equal(store.getJob(job.id).status, "completed");
  }
  const database = new Database(store.dbPath);
  const otherVersions = database.prepare("SELECT version FROM versions WHERE repository_id=? ORDER BY publication").all(other.id);
  const firstCache = database.prepare("SELECT key,json FROM mapping_cache WHERE repository_id=? ORDER BY key").all(repositoryId);
  const tracked = store.getTrackedSources(repositoryId);
  try {
    for (const [index, version] of ["z-first", "a-second", "m-third"].entries()) {
      const job = store.createJob(repositoryId);
      store.updateJob(job.id, { status: "running" });
      store.publish({ snapshot: { ...snapshot, version, createdAt: `2026-01-0${3 - index}T00:00:00Z`,
        events: snapshot.events.map(event => ({ ...event, output: "完整长结果".repeat(4096) })) },
      sources: { ...sources, version }, parsed, mappings: [],
      stats: { sourcesParsed: 0, parsedRecords: 0, mappingsComputed: 0, mappingsReused: 1 }, clearCache: false, jobId: job.id });
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM versions WHERE repository_id=?").get(repositoryId) as { count: number }).count, 2);
      assert.equal(store.getJob(job.id).status, "completed");
      assert.equal(store.getSnapshot(repositoryId).version, version);
    }
    assert.deepEqual(database.prepare("SELECT version FROM versions WHERE repository_id=? ORDER BY publication").all(repositoryId), [{ version: "a-second" }, { version: "m-third" }]);
    assert.deepEqual(database.prepare("SELECT version FROM versions WHERE repository_id=? ORDER BY publication").all(other.id), otherVersions);
    for (const version of [original, "z-first"]) {
      assert.throws(() => store.getSnapshot(repositoryId, version), error => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
      assert.throws(() => store.listSources(repositoryId, version), error => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM payload_parts WHERE repository_id=? AND kind IN ('snapshot','sources') AND owner=?").get(repositoryId, version) as { count: number }).count, 0);
    }
    for (const version of ["a-second", "m-third"]) assert.equal(store.getSnapshot(repositoryId, version).events[0]!.output, "完整长结果".repeat(4096));
    assert.deepEqual(database.prepare("SELECT key,json FROM mapping_cache WHERE repository_id=? ORDER BY key").all(repositoryId), firstCache);
    assert.deepEqual(store.getParsedSources(repositoryId), parsed);
    assert.deepEqual(store.getTrackedSources(repositoryId), tracked);
    assert.ok(store.getManualAssociations(repositoryId).has(sources.sources[0]!.sourceId));
  } finally { database.close(); }
}));

test("淘汰阶段失败回滚新版、分块、仓库指针及任务完成状态", async () => fixture(async ({ repositoryPath, sourcePath, store, repositoryId, refresh }) => {
  await writeFile(sourcePath, encode([meta(repositoryPath), call(repositoryPath, "first"), output("first")]));
  const first = await refresh();
  const second = await refresh(true);
  const database = new Database(store.dbPath);
  const beforeVersions = database.prepare("SELECT * FROM versions ORDER BY publication").all();
  const beforeParts = database.prepare("SELECT * FROM payload_parts ORDER BY kind,owner,field,part").all();
  const beforeCache = store.getParsedSources(repositoryId);
  const snapshot = store.getSnapshot(repositoryId);
  const job = store.createJob(repositoryId);
  store.updateJob(job.id, { status: "running" });
  try {
    database.exec("CREATE TRIGGER reject_prune BEFORE DELETE ON versions BEGIN SELECT RAISE(ABORT,'synthetic prune failure'); END");
    assert.throws(() => store.publish({ snapshot: { ...snapshot, version: "failed-third" }, sources: { ...store.listSources(repositoryId), version: "failed-third" }, parsed: [], mappings: [],
      stats: { sourcesParsed: 0, parsedRecords: 0, mappingsComputed: 0, mappingsReused: 0 }, clearCache: true, jobId: job.id }), /synthetic prune failure/);
    assert.deepEqual(database.prepare("SELECT * FROM versions ORDER BY publication").all(), beforeVersions);
    assert.deepEqual(database.prepare("SELECT * FROM payload_parts ORDER BY kind,owner,field,part").all(), beforeParts);
    assert.deepEqual(store.getParsedSources(repositoryId), beforeCache);
    assert.equal(store.getRepository(repositoryId).version, second);
    assert.equal(store.getSnapshot(repositoryId, first).events.length, 1);
    assert.equal(store.getSnapshot(repositoryId, second).events.length, 1);
    assert.equal(store.getJob(job.id).status, "running");
    assert.throws(() => store.getSnapshot(repositoryId, "failed-third"), error => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
    database.exec("DROP TRIGGER reject_prune");
  } finally { database.close(); }
  const third = await refresh(true);
  assert.equal(store.getSnapshot(repositoryId).version, third);
  assert.throws(() => store.getSnapshot(repositoryId, first), error => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
  assert.equal(store.getSnapshot(repositoryId, second).events.length, 1);
}));
