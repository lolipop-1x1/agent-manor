import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import type { CoverageResult, EvidenceResponse, EventsResponse, JobResponse, RegisterRepositoryResponse, StatusResponse } from "../src/contracts.js";
import { delay } from "../src/service/runtime.js";

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const encode = (records: unknown[]) => records.map((record) => JSON.stringify(record) + "\n").join("");

async function stopped(home: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await readFile(join(home, "service.json")); } catch { return; }
    await delay(50);
  }
  throw new Error("后台未完成停止");
}

test("编译产物在包外cwd并发按需启动单实例，CLI/API JSON一致、Worker刷新、重启检查、静态Web与停止", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-cli-")));
  const home = join(directory, "data");
  const repository = join(directory, "repo");
  const history = join(directory, "history");
  const build = join(directory, "build");
  await mkdir(repository);
  await mkdir(history);
  await symlink(join(repositoryRoot, "node_modules"), join(directory, "node_modules"), "dir");
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  const compiler = join(dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))), "bin/tsc");
  await run(process.execPath, [compiler, "-p", join(repositoryRoot, "tsconfig.server.json"), "--outDir", build, "--declaration", "false", "--sourceMap", "false"], { cwd: repositoryRoot });
  await mkdir(join(build, "web"));
  await writeFile(join(build, "web/index.html"), "<!doctype html><title>包外静态资源</title>");
  await run("git", ["init", "-q", repository]);
  await writeFile(join(repository, "a.ts"), "alpha\nbeta\n");
  await writeFile(join(repository, "b.ts"), "unread\n");
  await writeFile(join(history, "source.jsonl"), encode([
    { type: "session_meta", payload: { id: "cli-fixture", cwd: repository } },
    { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "read", arguments: JSON.stringify({ command: "cat a.ts", workdir: repository }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "read", output: "Exit code: 0\nOutput:\nalpha\nbeta\n" } },
  ]));
  const cli = join(build, "cli.js");
  const env = { ...process.env, AGENT_MANOR_HOME: home, AGENT_MANOR_CODEX_DIR: history, AGENT_MANOR_CLAUDE_DIR: join(directory, "missing-claude") };
  const command = async <T>(args: string[]): Promise<T> => {
    const result = await run(process.execPath, [cli, ...args, "--json"], { cwd: tmpdir(), env, timeout: 30_000 });
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout) as T;
  };
  try {
    const instances = await Promise.all(Array.from({ length: 4 }, () => command<StatusResponse>(["status"])));
    assert.equal(new Set(instances.map((status) => status.instance.id)).size, 1);
    assert.equal(new Set(instances.map((status) => status.instance.pid)).size, 1);
    const register = await command<RegisterRepositoryResponse>(["register", repository, "--wait"]);
    assert.equal(register.job.status, "completed", register.job.error);
    const id = register.repository.id;
    const version = register.job.version!;
    const query = ["--version", version, "--client", "codex", "--categories", "source", "--from", "2026-01-01T00:00:00Z"];
    const coverage = await command<CoverageResult>(["coverage", id, ...query]);
    const url = `http://127.0.0.1:${instances[0]!.instance.port}`;
    const response = await fetch(`${url}/api/v1/repositories/${id}/coverage?version=${version}&client=codex&categories=source&from=2026-01-01T00%3A00%3A00Z`);
    assert.deepEqual(coverage, await response.json());
    assert.deepEqual(coverage.summary.readExact, { files: 1, lines: 2 });
    const events = await command<EventsResponse>(["events", id, "--path", "a.ts", "--page-size", "1", ...query]);
    const evidence = await command<EvidenceResponse>(["evidence", id, events.events[0]!.id, ...query]);
    assert.equal(evidence.records.length, 2);
    await command(["file", id, "a.ts", ...query]);
    await command(["sources", id, ...query]);
    await command(["hotspots", id, "--metric", "read", ...query]);
    await command(["unobserved", id, ...query]);
    await command(["repositories"]);
    const refresh = await command<JobResponse>(["refresh", id]);
    assert.equal((await command<JobResponse>(["jobs", refresh.job.id, "--wait"])).job.status, "completed");
    const clear = await command<JobResponse>(["cacheclear", id, "--wait"]);
    assert.equal(clear.job.status, "completed");
    assert.equal((await command<CoverageResult>(["coverage", id])).summary.readExact.lines, 2);
    const web = await command<{ url: string; instance: StatusResponse["instance"] }>(["web", "--no-open"]);
    assert.equal(web.instance.id, instances[0]!.instance.id);
    assert.match(await (await fetch(web.url)).text(), /包外静态资源/);
    assert.equal((await command<StatusResponse>(["status"])).instance.id, web.instance.id);
    assert.deepEqual(await command(["stop"]), { stopping: true });
    await stopped(home);
    assert.deepEqual(await command(["stop"]), { stopping: false, running: false });
    const restarted = await command<StatusResponse>(["status"]);
    assert.notEqual(restarted.instance.id, instances[0]!.instance.id);
    const startup = restarted.jobs.find((job) => job.repositoryId === id && !instances[0]!.jobs.some((before) => before.id === job.id));
    assert.ok(startup);
    const latest = restarted.jobs[0]!;
    await command(["jobs", latest.id, "--wait"]);
    assert.equal((await command<CoverageResult>(["coverage", id])).summary.readExact.lines, 2);
  } finally {
    await command(["stop"]).catch(() => undefined);
    await stopped(home);
    await rm(directory, { recursive: true, force: true });
  }
});

test("源码CLI从外部cwd启动Worker；错误实例状态不会误杀其他PID，stop不会自动启动", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-cli-source-")));
  const home = join(directory, "data");
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const hook = fileURLToPath(import.meta.resolve("tsx/esm"));
  const env = { ...process.env, AGENT_MANOR_HOME: home, AGENT_MANOR_CODEX_DIR: join(directory, "empty"), AGENT_MANOR_CLAUDE_DIR: join(directory, "empty") };
  const command = async <T>(args: string[]): Promise<T> => JSON.parse((await run(process.execPath, ["--import", hook, cli, ...args, "--json"], { cwd: tmpdir(), env, timeout: 30_000 })).stdout) as T;
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await mkdir(home);
    await writeFile(join(home, "service.json"), JSON.stringify({ id: "stale-instance-nonce", pid: other.pid, host: "127.0.0.1", port: 1, startedAt: new Date().toISOString() }));
    assert.deepEqual(await command(["stop"]), { stopping: false, running: false });
    process.kill(other.pid!, 0);
    await mkdir(join(home, "service.lock"));
    await writeFile(join(home, "service.lock/owner.json"), JSON.stringify({ pid: other.pid, nonce: "unrelated-live-owner" }));
    await assert.rejects(command(["status"]), /本地后台启动失败/);
    process.kill(other.pid!, 0);
    await rm(join(home, "service.lock"), { recursive: true });
    const deadPid = Number((await run(process.execPath, ["-e", "process.stdout.write(String(process.pid))"])).stdout);
    for (const lock of ["startup.lock", "service.lock"]) {
      await mkdir(join(home, lock));
      await writeFile(join(home, lock, "owner.json"), JSON.stringify({ pid: deadPid, nonce: "dead-test-owner" }));
    }
    const statuses = await Promise.all([command<StatusResponse>(["status"]), command<StatusResponse>(["status"])]);
    assert.equal(statuses[0]!.instance.id, statuses[1]!.instance.id);
    assert.notEqual(statuses[0]!.instance.pid, other.pid);
    const repository = join(directory, "repo");
    await mkdir(repository);
    await run("git", ["init", "-q", repository]);
    await writeFile(join(repository, "a.ts"), "alpha\n");
    const registered = await command<RegisterRepositoryResponse>(["register", repository, "--wait"]);
    assert.equal(registered.job.status, "completed", registered.job.error);
    process.kill(other.pid!, 0);
  } finally {
    await command(["stop"]).catch(() => undefined);
    await stopped(home).catch(() => undefined);
    other.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
