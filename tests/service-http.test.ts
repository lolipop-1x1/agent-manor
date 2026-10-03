import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { CoverageResult, EvidenceResponse, EventsResponse, FileDetail, JobResponse, RegisterRepositoryResponse, SourcesResponse } from "../src/contracts.js";
import { startService } from "../src/server.js";
import { apiRequest, delay, serviceUrl } from "../src/service/runtime.js";

const run = promisify(execFile);
const encode = (records: unknown[]) => records.map((record) => JSON.stringify(record) + "\n").join("");
function history(cwd?: string, session = "service-fixture") {
  return encode([
    { type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { id: session, cwd } },
    { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "read", arguments: JSON.stringify({ command: "cat src/a.ts", workdir: cwd }) } },
    { timestamp: "2026-01-01T00:00:02Z", type: "response_item", payload: { type: "function_call_output", call_id: "read", output: "Exit code: 0\nOutput:\nalpha\nbeta\n" } },
  ]);
}

async function fixture(runFixture: (context: { directory: string; repository: string; source: string; service: Awaited<ReturnType<typeof startService>>; register: RegisterRepositoryResponse }) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "manor-http-"));
  const directory = await realpath(temporary);
  const repository = join(directory, "repo");
  const sources = join(directory, "history");
  const staticRoot = join(directory, "web");
  await mkdir(join(repository, "src"), { recursive: true });
  await mkdir(sources);
  await mkdir(staticRoot);
  await run("git", ["init", "-q", repository]);
  await writeFile(join(repository, "src/a.ts"), "alpha\nbeta\n");
  await writeFile(join(repository, "src/b.ts"), "unread\n");
  await writeFile(join(repository, "README.md"), "说明\n");
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>真实静态页</title>");
  const source = join(sources, "source.jsonl");
  await writeFile(source, history(repository));
  await writeFile(join(sources, "orphan.jsonl"), history(undefined, "orphan"));
  const service = await startService({ home: join(directory, "data"), roots: { codex: sources, claude: [] }, staticRoot });
  try {
    const register = await apiRequest<RegisterRepositoryResponse>(service.instance, "/repositories", "POST", { path: repository });
    await wait(service, register.job.id);
    await runFixture({ directory, repository, source, service, register });
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function wait(service: Awaited<ReturnType<typeof startService>>, jobId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { job } = await apiRequest<JobResponse>(service.instance, `/jobs/${jobId}`);
    if (job.status === "completed" || job.status === "failed") { assert.equal(job.status, "completed", job.error); return job; }
    await delay(25);
  }
  throw new Error("测试刷新超时");
}

test("真实 HTTP 可查询并回读已删编辑、目录及无路径搜索，不增加当前覆盖", async () => fixture(async ({ service, register, source, repository }) => {
  const base = `/repositories/${register.repository.id}`;
  const timestamp = "2026-02-01T00:00:00Z";
  await appendFile(source, encode([
    { timestamp, type: "event_msg", payload: { type: "item_completed", item: { id: "deleted", type: "FileChange", status: "completed", changes: { "src/deleted.ts": { type: "delete" } } } } },
    ...["rg -n alpha src", "rg alpha"].flatMap((command, index) => [
      { timestamp, type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: `search-${index}`, arguments: JSON.stringify({ command, workdir: index ? join(repository, "src") : repository }) } },
      { timestamp, type: "response_item", payload: { type: "function_call_output", call_id: `search-${index}`, output: "Exit code: 0\nOutput:\nsrc/a.ts:1:alpha\n" } },
    ]),
  ]));
  const refresh = await apiRequest<JobResponse>(service.instance, `${base}/refresh`, "POST");
  await wait(service, refresh.job.id);
  const coverage = await apiRequest<CoverageResult>(service.instance, `${base}/coverage`);
  assert.equal(coverage.summary.fileCount, 2);
  assert.equal(coverage.summary.lineCount, 3);
  assert.deepEqual(coverage.summary.readExact, { files: 1, lines: 2 });
  assert.equal(coverage.summary.editExact.lines, 0);
  const key = `version=${coverage.version}&from=${timestamp}&categories=source,config,docs,unknown`;
  const events = await apiRequest<EventsResponse>(service.instance, `${base}/events?${key}`);
  assert.equal(events.total, 3);
  for (const event of events.events) {
    const evidence = await apiRequest<EvidenceResponse>(service.instance, `${base}/evidence/${encodeURIComponent(event.id)}?${key}`);
    assert.equal(evidence.event.id, event.id);
    assert.equal(evidence.records.length, event.sources.length);
    assert.equal(evidence.unavailable.length, 0);
  }
  const searches = await apiRequest<EventsResponse>(service.instance, `${base}/events?version=${coverage.version}&categories=unknown&kind=search`);
  assert.equal(searches.total, 1);
  const scoped = await apiRequest<EventsResponse>(service.instance, `${base}/events?version=${coverage.version}&categories=unknown&directory=src&kind=search`);
  assert.equal(scoped.total, 1);
  assert.equal(scoped.events[0]!.cwd, join(repository, "src"));
  const outside = await apiRequest<EventsResponse>(service.instance, `${base}/events?version=${coverage.version}&categories=unknown&directory=src-other&kind=search`);
  assert.equal(outside.total, 0);
  const deleted = await apiRequest<EventsResponse>(service.instance, `${base}/events?version=${coverage.version}&path=src/deleted.ts`);
  assert.equal(deleted.total, 1);
}));

test("真实 HTTP 版本、筛选、文件与证据闭环；追加后原记录仍可回查", async () => fixture(async ({ service, register, source }) => {
  const base = `/repositories/${register.repository.id}`;
  const coverage = await apiRequest<CoverageResult>(service.instance, `${base}/coverage?client=codex&directory=src`);
  assert.deepEqual(coverage.summary.readExact, { files: 1, lines: 2 });
  assert.equal(coverage.summary.fileCount, 2);
  assert.deepEqual(coverage.filters, { client: "codex", categories: ["source"], directory: "src" });
  const key = `version=${coverage.version}&client=codex&directory=src`;
  const file = await apiRequest<FileDetail>(service.instance, `${base}/file?path=src%2Fa.ts&${key}`);
  assert.equal(file.content, "alpha\nbeta\n");
  assert.equal(file.contentStale, false);
  assert.deepEqual(file.file.readExactRanges, [{ start: 1, end: 2 }]);
  const events = await apiRequest<EventsResponse>(service.instance, `${base}/events?path=src%2Fa.ts&pageSize=1&${key}`);
  assert.equal(events.total, 1);
  assert.equal(events.events[0]!.id, file.events[0]!.id);
  const evidencePath = `${base}/evidence/${encodeURIComponent(events.events[0]!.id)}?${key}`;
  const evidence = await apiRequest<EvidenceResponse>(service.instance, evidencePath);
  assert.equal(evidence.records.length, 2);
  assert.equal(evidence.unavailable.length, 0);
  await appendFile(source, encode([{ type: "event_msg", payload: { type: "irrelevant" } }]));
  assert.deepEqual((await apiRequest<EvidenceResponse>(service.instance, evidencePath)).records, evidence.records);
  const hotspots = await apiRequest<CoverageResult>(service.instance, `${base}/hotspots?metric=read&${key}`);
  assert.deepEqual(hotspots.files.map((item) => item.path), ["src/a.ts"]);
  const unobserved = await apiRequest<CoverageResult>(service.instance, `${base}/unobserved?${key}`);
  assert.deepEqual(unobserved.files.map((item) => item.path), ["src/b.ts"]);
  assert.equal((await apiRequest<CoverageResult>(service.instance, `${base}/coverage?client=claude`)).summary.readExact.lines, 0);
  assert.equal((await apiRequest<CoverageResult>(service.instance, `${base}/coverage?categories=docs`)).summary.lineCount, 1);
  assert.equal((await apiRequest<CoverageResult>(service.instance, `${base}/coverage?from=2026-01-02T00%3A00%3A00Z`)).summary.readExact.lines, 0);
  const sources = await apiRequest<SourcesResponse>(service.instance, `${base}/sources?version=${coverage.version}`);
  assert.equal(sources.unassociated.length, 1);
  const associated = await apiRequest<JobResponse>(service.instance, `${base}/associations`, "POST", { sourceId: sources.unassociated[0]!.sourceId });
  await wait(service, associated.job.id);
  assert.equal((await apiRequest<CoverageResult>(service.instance, `${base}/coverage`)).files[0]!.readCount, 2);
  const clear = await apiRequest<JobResponse>(service.instance, `${base}/cache`, "DELETE");
  await wait(service, clear.job.id);
  assert.equal((await apiRequest<CoverageResult>(service.instance, `${base}/coverage?version=${coverage.version}`)).files[0]!.readCount, 1);
  const modified = (await readFile(source, "utf8")).replace("alpha", "changed");
  await writeFile(source, modified);
  const invalidated = await apiRequest<EvidenceResponse>(service.instance, evidencePath);
  assert.equal(invalidated.records.length, 1);
  assert.equal(invalidated.unavailable.length, 1);
}));

test("当前内容变化不给旧高亮；路径穿越、文件及父目录符号链接被拒绝", async () => fixture(async ({ directory, repository, service, register }) => {
  const base = `/repositories/${register.repository.id}`;
  const coverage = await apiRequest<CoverageResult>(service.instance, `${base}/coverage`);
  await writeFile(join(repository, "src/a.ts"), "changed\n");
  const stale = await apiRequest<FileDetail>(service.instance, `${base}/file?path=src/a.ts&version=${coverage.version}`);
  assert.equal(stale.content, null);
  assert.equal(stale.contentStale, true);
  assert.equal(stale.events[0]!.mapping, undefined);
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "a.ts"), "秘密\n");
  await rm(join(repository, "src/a.ts"));
  await symlink(join(outside, "a.ts"), join(repository, "src/a.ts"));
  for (const path of ["../outside/a.ts", outside, "src/../a.ts", "src\\a.ts"]) {
    const response = await fetch(`${serviceUrl(service.instance)}/api/v1${base}/file?path=${encodeURIComponent(path)}`);
    assert.equal(response.status, 400);
  }
  assert.equal((await fetch(`${serviceUrl(service.instance)}/api/v1${base}/file?path=src/a.ts`)).status, 403);
  await rename(join(repository, "src"), join(repository, "old-src"));
  await symlink(outside, join(repository, "src"));
  assert.equal((await fetch(`${serviceUrl(service.instance)}/api/v1${base}/file?path=src/a.ts`)).status, 403);
}));

test("Host、Origin、JSON 与静态路径安全边界；错误契约稳定", async () => fixture(async ({ directory, service, register }) => {
  const url = serviceUrl(service.instance);
  assert.equal((await fetch(url)).status, 200);
  await symlink(join(directory, "repo/src/a.ts"), join(directory, "web/leak.ts"));
  assert.equal((await fetch(`${url}/leak.ts`)).status, 404);
  const invalidHost = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(`${url}/api/v1/status`, { headers: { host: "evil.example" } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
    request.end();
  });
  assert.equal(invalidHost, 403);
  for (const headers of [{ origin: "https://evil.example" }, { "x-agent-manor-instance": "wrong" }]) {
    assert.equal((await fetch(`${url}/api/v1/status`, { headers })).status, 403, JSON.stringify(headers));
  }
  assert.equal((await fetch(`${url}/api/v1/status`, { headers: { origin: url } })).status, 200);
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded"]) {
    assert.equal((await fetch(`${url}/api/v1/repositories`, { method: "POST", headers: { "content-type": contentType }, body: "{}" })).status, 400);
  }
  assert.equal((await fetch(`${url}/api/v1/repositories`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: "{}" })).status, 403);
  const invalidBody = await fetch(`${url}/api/v1/repositories`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"path":"/","extra":true}' });
  assert.deepEqual(await invalidBody.json(), { error: { code: "INVALID_INPUT", message: "请求体只能包含 path" } });
  assert.equal((await fetch(`${url}/api/v1/repositories/${register.repository.id}/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"path":"/"}' })).status, 400);
  assert.equal((await fetch(`${url}/api/v1/repositories`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"path":"/nonexistent"}' })).status, 400);
  for (const query of ["client=other", "categories=other", "from=yesterday", "page=0", "pageSize=201"]) {
    assert.equal((await fetch(`${url}/api/v1/repositories/${register.repository.id}/events?${query}`)).status, 400);
  }
  const missing = await fetch(`${url}/api/v1/repositories/${register.repository.id}/coverage?version=missing`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json() as { error: { code: string } }).error.code, "VERSION_NOT_FOUND");
}));
