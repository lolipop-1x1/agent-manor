import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VERSION } from "../../../src/version.js";
import type { ServiceInstance, StatusResponse } from "../../../src/contracts.js";
import { startBackground } from "../../../src/service/runtime.js";
import { createProgram } from "../src/program.js";
import { startupProgress } from "../src/output/startup-progress.js";

async function fixture(run: (home: string, set: (value: (count: number) => object) => void) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "manor-startup-wait-"));
  let instance: ServiceInstance, count = 0, payload = (_count: number): object => ({});
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ instance, version: VERSION, protocolVersion: 1, ...payload(++count) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  instance = { id: "synthetic-startup-wait", pid: process.pid, host: "127.0.0.1", port: address.port, startedAt: new Date().toISOString() };
  await writeFile(join(home, "service.json"), JSON.stringify(instance));
  try { await run(home, value => { payload = value; count = 0; }); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
}

test("已有会话版本但首次缓存未完成仍等待，已有完整准备结果快速复用", async () => fixture(async (home, set) => {
  set(count => ({ sessions: { version: "synthetic-history" }, preparation: {
    initial: true, state: count >= 4 ? "ready" : "running", phase: count >= 4 ? "complete" : "overview" } }));
  const phases: string[] = [];
  await startBackground(home, { waitData: "initial", timeoutMs: 2000, onProgress: status => { phases.push(status.preparation!.state); } });
  assert.ok(phases.includes("running")); assert.equal(phases.at(-1), "ready");
  set(() => ({ preparation: { initial: false, state: "running", phase: "history" } }));
  await startBackground(home, { waitData: "initial", timeoutMs: 1, onProgress: () => assert.fail("热启动不等待新的后台检查") });
  await assert.rejects(startBackground(home, { waitData: true, timeoutMs: 1 }), { code: "WAIT_TIMEOUT" });
}));

test("首次等待失败和超时不返回地址；web JSON 不混入进度文本", async () => fixture(async (home, set) => {
  set(() => ({ preparation: { initial: true, state: "failed", phase: "overview", error: "synthetic cache failure" } }));
  await assert.rejects(createProgram("en").parseAsync(["--home", home, "--json", "web", "--no-open"], { from: "user" }), { code: "PREPARATION_FAILED" });
  set(() => ({ preparation: { initial: true, state: "running", phase: "history" } }));
  await assert.rejects(createProgram("en").parseAsync(["--home", home, "--json", "start", "--timeout", "0.001"], { from: "user" }), { code: "WAIT_TIMEOUT" });
  const write = process.stdout.write, errorWrite = process.stderr.write; let output = "", errors = "";
  process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { errors += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    set(count => ({ preparation: { initial: true, state: count >= 3 ? "ready" : "running", phase: "overview" } }));
    await createProgram("en").parseAsync(["--home", home, "--json", "web", "--no-open"], { from: "user" });
    assert.equal(output.trim().split("\n").length, 1);
    assert.match(JSON.parse(output).url, /^http:\/\/127\.0\.0\.1:/); assert.equal(errors, "");
  } finally { process.stdout.write = write; process.stderr.write = errorWrite; }
}));

test("终端进度提供双语阶段和实际计数，重复轮询不刷屏", () => {
  const write = process.stderr.write; let output = "";
  process.stderr.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    for (const language of ["en", "zh-CN"] as const) {
      output = "";
      const progress = startupProgress(language);
      const status = { preparation: { state: "running", phase: "history" }, sessions: { job: { phase: "index", processedSources: 3, totalSources: 9 } } } as StatusResponse;
      try {
        progress.update(status); const first = output;
        progress.update(status); assert.equal(output, first);
        assert.match(output, /3 \/ 9/);
        assert.match(output, language === "en" ? /Importing history/ : /导入会话历史/);
        progress.update({ ...status, preparation: { ...status.preparation!, phase: "overview", step: "review", completed: 7, total: 8 } });
        assert.match(output, language === "en" ? /Last 7 days/ : /最近7天/);
        progress.update({ ...status, preparation: { ...status.preparation!, jobIds: ["history"] }, sessions: { job: { ...status.sessions!.job!, status: "complete" } } } as StatusResponse);
        assert.doesNotMatch(output, language === "en" ? /Preparing registered repositories/ : /准备已添加仓库/);
      } finally { progress.close(); }
    }
  } finally { process.stderr.write = write; }
});

test("仓库进度显示完成数、名称、翻译后的阶段及百分比，切换立即更新", () => {
  const write = process.stderr.write; let output = "";
  process.stderr.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    for (const language of ["en", "zh-CN"] as const) {
      output = "";
      const progress = startupProgress(language);
      const preparation = { state: "running", phase: "maps", jobIds: ["history", "map1", "map2", "map3"], completed: 1, total: 3,
        repository: { id: "sample-alpha", name: "sample-alpha", phase: "旧中文阶段", phaseDescriptor: { key: "diagnostics.index.refresh.m007" }, progress: 0.65 } };
      try {
        progress.update({ preparation } as StatusResponse);
        assert.match(output, /1 \/ 3/); assert.match(output, /sample-alpha/); assert.match(output, /65%/);
        assert.doesNotMatch(output, /旧中文阶段/);
        assert.match(output, language === "en" ? /Publishing/ : /发布完整结果/);
        let previous = output;
        progress.update({ preparation: { ...preparation, completed: 2,
          repository: { id: "sample-beta", name: "sample-beta", phase: "等待分析", phaseDescriptor: { key: "diagnostics.index.store.m006" }, progress: 0 } } } as StatusResponse);
        assert.match(output.slice(previous.length), /2 \/ 3/);
        assert.match(output.slice(previous.length), language === "en" ? /Waiting for analysis/ : /等待分析/);
        previous = output;
        progress.update({ preparation: { ...preparation, completed: 2,
          repository: { ...preparation.repository, id: "sample-beta", name: "sample-beta", progress: 0.95 } } } as StatusResponse);
        assert.match(output.slice(previous.length), /2 \/ 3/); assert.match(output.slice(previous.length), /sample-beta/);
        assert.match(output.slice(previous.length), /95%/);
      } finally { progress.close(); }
    }
  } finally { process.stderr.write = write; }
});

test("终端保留来源扫描结果和客户端汇总，导入显示复用与当前来源且不重复刷屏", () => {
  const write = process.stderr.write, now = Date.now;
  let output = "", time = now();
  Date.now = () => time;
  process.stderr.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    for (const language of ["en", "zh-CN"] as const) {
      output = "";
      const progress = startupProgress(language);
      const status = { preparation: { state: "running", phase: "history" }, sessions: { job: { id: "synthetic-import", phase: "discover",
        discovery: [{ client: "codex", path: "/synthetic/sessions", sourceCount: 0, complete: false }] } } } as StatusResponse;
      try {
        progress.update(status);
        assert.match(output, /Codex/); assert.match(output, /\/synthetic\/sessions/);
        const complete = { ...status, sessions: { job: { ...status.sessions!.job!, discovery: [
          { client: "codex", path: "/synthetic/sessions", sourceCount: 9, complete: true },
          { client: "codeflicker-desktop", path: "/synthetic/desktop", sourceCount: 2, complete: true }],
          sourceCounts: [{ client: "codex", count: 9 }, { client: "codeflicker-desktop", count: 2 }] } } } as StatusResponse;
        progress.update(complete);
        assert.match(output, language === "en" ? /9 candidate sources/ : /9 个候选来源/);
        assert.match(output, language === "en" ? /CodeFlicker Desktop: 2/ : /CodeFlicker 桌面版：2/);
        const index = { ...complete, sessions: { job: { ...complete.sessions!.job!, phase: "index", processedSources: 5, totalSources: 11,
          parserConcurrency: 2, counts: { parsed: 2, quickReused: 2, verifiedReused: 1 },
          activeSources: [{ client: "codex", path: "/synthetic/sessions/active.jsonl" }] } } } as StatusResponse;
        progress.update(index);
        assert.match(output, /5 \/ 11/);
        assert.match(output, language === "en" ? /parsed 2 · reused 3 · 2 workers/ : /已解析 2 · 已复用 3 · 2 个解析线程/);
        assert.match(output, /active\.jsonl/);
        const previous = output;
        progress.update(index); assert.equal(output, previous);
        time += 6000;
        progress.update(index);
        assert.equal(output.split("active.jsonl").length, 2);
      } finally { progress.close(); }
    }
  } finally { process.stderr.write = write; Date.now = now; }
});
