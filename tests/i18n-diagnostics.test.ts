import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import Database from "better-sqlite3";
import type { AnalysisSnapshot, BaselineFile, HistoryEvent } from "../src/contracts.js";
import { buildCoverage, hashContent, matchEvent } from "../src/analysis/index.js";
import { parseSource, resolveSharedHistory } from "../src/history/index.js";
import { patchEvidence } from "../src/history/adapters/common.js";
import { errorDescriptor, DiagnosticError } from "../src/i18n/diagnostics.js";
import { translateMessage } from "../src/i18n/index.js";
import enDiagnostics from "../src/i18n/locales/en/diagnostics.js";
import { AnalysisStore } from "../src/index/store.js";
import { refreshRepository } from "../src/index/refresh.js";
import { SessionStore } from "../src/sessions/store.js";
import { ServiceError, textValue } from "../src/service/input.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

const git = promisify(execFile);
const encode = (value: unknown) => `${JSON.stringify(value)}\n`;
async function temporary(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "manor-diagnostics-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

const call = { type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "synthetic-call", arguments: JSON.stringify({ command: "cat a.ts" }) } };
const result = { type: "response_item", payload: { type: "function_call_output", call_id: "synthetic-call", output: "Exit code: 0\nOutput:\nconst alpha = 1;\n" } };


test("全部英文产品诊断有英语目录，数值参数与语言呈现不进入持久协议", () => {
  for (const [key, text] of Object.entries(enDiagnostics)) {
    assert.doesNotMatch(text, /[\u3400-\u9fff]/, key);
  }
  const descriptor = { key: "diagnostics.history.extraction.m001", params: { p0: 17 } };
  assert.equal(translateMessage("en", descriptor), "Exit code 17");
  assert.equal(translateMessage("zh-CN", descriptor), "退出码 17");
  assert.deepEqual(descriptor.params, { p0: 17 });
});

test("自有输入错误附稳定描述，旧错误与外部错误不按原文猜测", () => {
  assert.throws(() => textValue(0, "path", true), error => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.code, "INVALID_INPUT");
    assert.equal(error.message, "path 必须是非空字符串");
    assert.deepEqual(error.messageDescriptor, { key: "diagnostics.service.input.m001", params: { p0: "path" } });
    assert.match(translateMessage("zh-CN", error.messageDescriptor), /path/);
    assert.match(translateMessage("en", error.messageDescriptor), /path/);
    return true;
  });
  assert.equal(errorDescriptor(new Error("path 必须是非空字符串")), undefined);
  assert.equal(errorDescriptor(new ServiceError("INVALID_INPUT", "旧诊断")), undefined);
  assert.equal(errorDescriptor({ messageDescriptor: { key: 1 } }), undefined);
  const descriptor = { key: "diagnostics.history.toolFailed" };
  assert.deepEqual(errorDescriptor(new DiagnosticError("原文", descriptor)), descriptor);
});

test("追加成功结果清除待配对描述，范围缺口及合并冲突保留实际原因描述", async () => temporary(async directory => {
  const path = join(directory, "source.jsonl");
  const meta = { type: "session_meta", payload: { id: "synthetic-session", cwd: "/synthetic/repository" } };
  await writeFile(path, encode(meta) + encode(call));
  const pending = await parseSource(path, "codex");
  assert.equal(pending.events[0]?.reasonDescriptor?.key, "diagnostics.history.index.m001");
  assert.ok(pending.gaps.every(gap => gap.messageDescriptor));
  await appendFile(path, encode(result));
  const complete = await parseSource(path, "codex", pending);
  assert.equal(complete.events[0]?.status, "success");
  assert.equal(complete.events[0]?.reason, undefined);
  assert.equal(complete.events[0]?.reasonDescriptor, undefined);
  const success = complete.events[0]!;
  const conflicting = { ...complete, sourceId: "conflicting-source", events: [{ ...success, status: "failure" as const }] };
  const merged = resolveSharedHistory([complete, conflicting]);
  const event = merged.events[0]!;
  assert.equal(event.status, "unknown");
  assert.deepEqual(merged.gaps.find(gap => gap.kind === "ambiguous")?.messageDescriptor, event.reasonDescriptor);
  const deletion = patchEvidence("*** Begin Patch\n*** Delete File: a.ts\n*** End Patch")[0]!;
  assert.equal(deletion.reasonDescriptor?.key, "diagnostics.history.adapters.common.m001");
  const addition = patchEvidence("*** Begin Patch\n*** Add File: a.ts\n+const alpha = 1;\n*** End Patch")[0]!;
  assert.equal(addition.reason, undefined);
  assert.equal(addition.reasonDescriptor, undefined);
}));

test("来源类型恰好等于产品兜底文本时仍保留原文，不按句子匹配生成描述", async () => temporary(async directory => {
  const path = join(directory, "source.jsonl");
  await writeFile(path, encode({}) + encode({ type: "<缺少类型>" }));
  const parsed = await parseSource(path, "codeflicker");
  const missing = parsed.gaps.find(gap => gap.messageDescriptor?.key === "diagnostics.history.adapters.codeflicker.m014")!;
  const original = parsed.gaps.find(gap => gap.messageDescriptor?.key === "diagnostics.history.adapters.codeflicker.m013")!;
  assert.ok(missing); assert.ok(original);
  assert.equal(original.messageDescriptor?.params?.p1, "<缺少类型>");
  assert.equal(missing.messageDescriptor?.params?.p1, undefined);
  assert.match(translateMessage("en", original.messageDescriptor!), /<缺少类型>/);
  assert.doesNotMatch(translateMessage("en", missing.messageDescriptor!), /缺少类型/);
}));

test("范围对应组合保留排序及完整子描述，旧映射仅保留原始诊断", () => {
  const file: BaselineFile = { path: "a.ts", category: "source", content: "const alpha = 1;\n", lineCount: 1, hash: hashContent("const alpha = 1;\n") };
  const event: HistoryEvent = { id: "synthetic-event", client: "codex", sessionId: "synthetic-session", tool: "Read", kind: "read", status: "success", path: file.path,
    fragments: [{ kind: "read", content: "partial", completeLines: false }, { kind: "read", content: "", completeLines: true }],
    sources: [{ sourceId: "synthetic-source", path: "/synthetic/source.jsonl", recordLine: 1, hash: "synthetic-hash" }] };
  const mapping = matchEvent(event, file);
  assert.equal(mapping.unknownReasonDescriptors?.length, 2);
  assert.match(mapping.unknownReason!, /片段包含不完整行；range_unknown: 没有历史源码内容/);
  const repository = { id: "synthetic-repository", path: "/synthetic/repository", commonDir: "/synthetic/repository/.git", name: "repository", stale: false };
  const snapshot: AnalysisSnapshot = { repository, version: "synthetic-version", createdAt: "2026-01-01T00:00:00Z", sources: [], events: [event], mappings: [mapping], gaps: [],
    baseline: { repository, hash: "synthetic-baseline", createdAt: "2026-01-01T00:00:00Z", git: { dirty: false }, files: [file], excluded: [] } };
  const gap = buildCoverage(snapshot).gaps[0]!;
  assert.deepEqual(gap.details, mapping.unknownReasonDescriptors);
  assert.equal(gap.messageDescriptor?.params?.path, file.path);
  assert.equal(gap.message, `${file.path}: ${mapping.unknownReason}`);
  const oldMapping = { ...mapping, unknownReasonDescriptors: undefined };
  const oldGap = buildCoverage({ ...snapshot, mappings: [oldMapping] }).gaps[0]!;
  assert.equal(oldGap.message, gap.message);
  assert.equal(oldGap.messageDescriptor, undefined);
  assert.equal(oldGap.details, undefined);
});

test("任务错误描述跨重开保留，重复失败不抹去首个明确描述，旧 JSON 不回填", async () => temporary(async directory => {
  const dbPath = join(directory, "index.sqlite");
  const store = new AnalysisStore(dbPath);
  const descriptor = { key: "diagnostics.history.toolFailed" };
  const repositoryPath = join(directory, "repository");
  await mkdir(repositoryPath);
  await git("git", ["init", "-q", repositoryPath]);
  const repository = await store.registerRepository(repositoryPath);
  const job = store.createJob(repository.id);
  assert.ok(job.phaseDescriptor);
  store.failJob(job.id, "原始错误", descriptor);
  store.failJob(job.id, "后续错误");
  assert.equal(store.getJob(job.id).error, "原始错误");
  store.close();
  const reopened = new AnalysisStore(dbPath);
  assert.deepEqual(reopened.getJob(job.id).errorDescriptor, descriptor);
  reopened.close();
  const sessions = new SessionStore(dbPath);
  const sessionJob = sessions.createJob();
  sessions.failJob(sessionJob.id, "原始会话错误", descriptor);
  sessions.failJob(sessionJob.id, "后续错误");
  sessions.close();
  const next = new SessionStore(dbPath);
  assert.deepEqual(next.getJob(sessionJob.id).errorDescriptor, descriptor);
  assert.equal(next.getJob(sessionJob.id).error, "原始会话错误");
  next.close();
  const db = new Database(dbPath);
  const old = { ...job, phaseDescriptor: undefined, phase: "历史自由文本" };
  db.prepare("UPDATE jobs SET json=? WHERE id=?").run(JSON.stringify(old), job.id);
  db.close();
  const legacy = new AnalysisStore(dbPath);
  assert.equal(legacy.getJob(job.id).phase, "历史自由文本");
  assert.equal(legacy.getJob(job.id).phaseDescriptor, undefined);
  legacy.close();
}));

test("地图解析缓存及对应缓存跨持久化保留描述，语言呈现不改变 JSON", async () => temporary(async directory => {
  const repositoryPath = join(directory, "repository");
  const history = join(directory, "history");
  await mkdir(repositoryPath); await mkdir(history);
  await git("git", ["init", "-q", repositoryPath]);
  await writeFile(join(repositoryPath, "a.ts"), "const alpha = 1;\n");
  const unknownRead = { ...call, payload: { ...call.payload, arguments: JSON.stringify({ command: "cat a.ts b.ts" }) } };
  await writeFile(join(history, "source.jsonl"), encode({ type: "session_meta", payload: { id: "synthetic-cache", cwd: repositoryPath } }) + encode(unknownRead) + encode(result));
  const dbPath = join(directory, "index.sqlite");
  const store = new AnalysisStore(dbPath);
  const repository = await store.registerRepository(repositoryPath);
  const job = store.createJob(repository.id);
  await refreshRepository(store, job.id, isolatedHistoryRoots({ codex: history }));
  const snapshot = store.getSnapshot(repository.id);
  assert.ok(snapshot.events[0]?.reasonDescriptor);
  assert.ok(snapshot.mappings[0]?.unknownReasonDescriptors?.length);
  assert.ok(store.getParsedSources(repository.id)[0]?.gaps[0]?.messageDescriptor);
  const serialized = JSON.stringify(snapshot);
  for (const language of ["zh-CN", "en"] as const) {
    for (const gap of snapshot.gaps) if (gap.messageDescriptor) translateMessage(language, gap.messageDescriptor);
    for (const event of snapshot.events) if (event.reasonDescriptor) translateMessage(language, event.reasonDescriptor);
    assert.equal(JSON.stringify(snapshot), serialized);
  }
  store.close();
  const next = new AnalysisStore(dbPath);
  assert.deepEqual(next.getSnapshot(repository.id), snapshot);
  assert.ok(next.getParsedSources(repository.id)[0]?.events[0]?.reasonDescriptor);
  const refresh = next.createJob(repository.id);
  await refreshRepository(next, refresh.id, isolatedHistoryRoots({ codex: history }));
  assert.equal(next.getRefreshStats(repository.id).parsedRecords, 0);
  assert.equal(next.getRefreshStats(repository.id).mappingsComputed, 0);
  assert.ok(next.getSnapshot(repository.id).mappings[0]?.unknownReasonDescriptors?.length);
  next.close();
}));
