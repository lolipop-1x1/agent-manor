import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { VERSION } from "../src/version.js";
import type { CoverageResult, ServiceInstance } from "../src/contracts.js";
import { cliErrorOutput, createProgram, humanOutput, resolveCliLanguage } from "../src/cli.js";
import { formatDateTime, translate } from "../src/i18n/index.js";
import { preferencesPath, writePreferences } from "../src/service/preferences.js";
import { delay, RequestError } from "../src/service/runtime.js";
import { isolatedHistoryEnvironment } from "./helpers/history-roots.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const hook = fileURLToPath(import.meta.resolve("tsx/esm"));

async function command(directory: string, args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const env = isolatedHistoryEnvironment(directory, { AGENT_MANOR_HOME: join(directory, "data"), AGENT_MANOR_LANG: undefined,
    LC_ALL: undefined, LC_MESSAGES: undefined, LANG: "C", ...overrides });
  try {
    const result = await run(process.execPath, ["--import", hook, cli, ...args], { cwd: tmpdir(), env, timeout: 15_000 });
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as Error & { code: number; stdout: string; stderr: string };
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}

function coverage(): CoverageResult {
  return {
    repository: { id: "fixture-repository", name: "原始项目", path: "/workspace/example", commonDir: "/workspace/example/.git", stale: false },
    version: "fixture-version", baselineHash: "fixture-baseline", createdAt: "2026-01-02T03:04:05Z", stale: false, filters: {},
    files: [{ path: "src/原文.ts", category: "source", hash: "fixture-hash", lineCount: 1234,
      readExactLines: 1, readNearLines: 0, editExactLines: 0, editNearLines: 0, readCount: 1, editCount: 0,
      activityCount: 1, searchCount: 0, failedCount: 0, unknownCount: 0,
      readExactRanges: [{ start: 1, end: 1 }], readNearRanges: [], editExactRanges: [], editNearRanges: [] }],
    summary: { fileCount: 1, lineCount: 1234, readExact: { files: 1, lines: 1 }, readNear: { files: 0, lines: 0 }, editExact: { files: 0, lines: 0 }, editNear: { files: 0, lines: 0 } },
    gaps: [{ kind: "parse_error", message: "external parser detail: 原文" },
      { kind: "range_unknown", message: "raw product diagnostic", messageDescriptor: { key: "cli.error.view" }, details: [{ key: "cli.error.keyPath" }] }],
  };
}

test("CLI 参数、环境、共享偏好和系统首个非空变量按优先级解析，覆盖不写回", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-cli-language-"));
  const home = join(directory, "data");
  try {
    await writePreferences(home, "zh-CN");
    const before = await readFile(preferencesPath(home), "utf8");
    const env = { AGENT_MANOR_HOME: home, AGENT_MANOR_LANG: "en", LC_ALL: "zh_TW.UTF-8", LANG: "en_US.UTF-8" };
    assert.equal(await resolveCliLanguage({ lang: "zh-CN" }, env), "zh-CN");
    assert.equal(await resolveCliLanguage({}, env), "en");
    assert.equal(await resolveCliLanguage({ home }, { LANG: "en_US.UTF-8" }), "zh-CN");
    assert.equal(await resolveCliLanguage({ lang: "auto", home }, env), "zh-CN");
    assert.equal(await resolveCliLanguage({ lang: "auto", home }, { AGENT_MANOR_LANG: "invalid", LANG: "en_US.UTF-8" }), "en");
    assert.equal(await resolveCliLanguage({ home }, { AGENT_MANOR_LANG: "auto", LANG: "en_US.UTF-8" }), "en");
    assert.equal(await readFile(preferencesPath(home), "utf8"), before);
    await writePreferences(home, "auto");
    for (const [environment, expected] of [
      [{ LC_ALL: "  ", LC_MESSAGES: "zh_HK.UTF-8", LANG: "en_US.UTF-8" }, "zh-CN"],
      [{ LC_ALL: "fr_FR.UTF-8", LC_MESSAGES: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }, "en"],
      [{ LC_ALL: "C", LANG: "zh_CN.UTF-8" }, "en"],
      [{ LC_ALL: "POSIX", LANG: "zh_CN.UTF-8" }, "en"],
      [{ LANG: "zh_CN.UTF-8@variant" }, "zh-CN"],
      [{}, "en"],
    ] as const) assert.equal(await resolveCliLanguage({ home }, environment), expected);
    await assert.rejects(resolveCliLanguage({ home, lang: "zh" }, env), { code: "INVALID_INPUT" });
    await assert.rejects(resolveCliLanguage({ home }, { AGENT_MANOR_LANG: "" }), { code: "INVALID_INPUT" });
    await assert.rejects(resolveCliLanguage({ home }, { AGENT_MANOR_LANG: "fr" }), { code: "INVALID_INPUT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("帮助读取 --home 对应偏好，支持参数位置与等号语法，命令和选项名保持稳定", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-cli-help-"));
  const home = join(directory, "alternate");
  try {
    await writePreferences(home, "zh-CN");
    const initial = await readFile(preferencesPath(home), "utf8");
    const chinese = await command(directory, ["resources", "--home", home, "--help"]);
    assert.equal(chinese.code, 0, chinese.stderr);
    assert.match(chinese.stdout, /可恢复本地管理/);
    assert.match(chinese.stdout, /全局选项：/);
    const english = await command(directory, ["--home", home, "resources", "--help", "--lang=en"], { AGENT_MANOR_LANG: "zh-CN" });
    assert.equal(english.code, 0, english.stderr);
    assert.match(english.stdout, /recoverable local management/);
    assert.match(english.stdout, /--lang <language>/);
    const automatic = await command(directory, ["--home", home, "--lang", "auto", "--help"], { LANG: "en_US.UTF-8" });
    assert.match(automatic.stdout, /Local Agent history/);
    const repeated = await command(directory, ["--home=" + home, "--lang", "en", "--lang=zh-CN", "--help"]);
    assert.match(repeated.stdout, /本地 Agent 历史/);
    const terminated = await command(directory, ["--home", home, "--", "--lang=en"]);
    assert.equal(terminated.code, 1);
    assert.match(terminated.stderr, /未知命令/);
    assert.equal(await readFile(preferencesPath(home), "utf8"), initial);
    for (const language of ["en", "zh-CN"] as const) {
      const program = createProgram(language);
      for (const group of [program, ...program.commands]) {
        assert.doesNotMatch(group.helpInformation(), /Translation unavailable|翻译暂不可用/);
        assert.ok(group.options.every(option => option.long?.startsWith("--")));
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Commander 和语言值错误按稳定码翻译语境，原始详情及 JSON 完整保留", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-cli-errors-"));
  try {
    for (const [args, code, en, zh] of [
      [["register"], "commander.missingArgument", "A required argument is missing", "缺少必填参数"],
      [["--home"], "commander.optionMissingArgument", "An option argument is missing", "选项缺少参数值"],
      [["resources", "apply", "fixture-preview"], "commander.missingMandatoryOptionValue", "A required option is missing", "缺少必填选项"],
      [["unknown-fixture-command"], "commander.unknownCommand", "Unknown command", "未知命令"],
      [["--unknown-fixture-option"], "commander.unknownOption", "Unknown option", "未知选项"],
      [["resources"], "commander.help", "Select a command", "请选择命令"],
    ] as const) {
      const english = await command(directory, ["--lang", "en", ...args]);
      const chinese = await command(directory, ["--lang", "zh-CN", ...args]);
      assert.equal(english.code, 1);
      assert.equal(chinese.code, 1);
      assert.ok(english.stderr.includes(en), english.stderr);
      assert.ok(chinese.stderr.includes(zh), chinese.stderr);
      assert.match(english.stderr, /Original details:/);
      assert.match(chinese.stderr, /原始详情:/);
      const jsonEn = await command(directory, ["--json", "--lang", "en", ...args]);
      const jsonZh = await command(directory, ["--json", "--lang", "zh-CN", ...args]);
      assert.equal(jsonEn.stdout, "");
      assert.equal(jsonEn.stderr, jsonZh.stderr);
      assert.equal(JSON.parse(jsonEn.stderr).error.code, code);
    }
    const invalid = await command(directory, ["--lang", "unsupported", "--json", "--help"]);
    assert.equal(invalid.code, 1);
    assert.equal(JSON.parse(invalid.stderr).error.code, "INVALID_INPUT");
    const invalidEnv = await command(directory, ["--json", "--help"], { AGENT_MANOR_LANG: "unsupported" });
    assert.equal(JSON.parse(invalidEnv.stderr).error.messageDescriptor.params.source, "AGENT_MANOR_LANG");
    const raw = new Error("第三方原始错误: synthetic");
    assert.match(cliErrorOutput(raw, "en", false), /Original details: 第三方原始错误: synthetic/);
    assert.equal(JSON.parse(cliErrorOutput(Object.assign(raw, { code: "ENOENT" }), "en", true)).error.code, "SERVICE_UNAVAILABLE");
    const product = new RequestError("INVALID_INPUT", "原始产品诊断", { key: "cli.error.view" });
    assert.match(cliErrorOutput(product, "en", false), /view must be overview, usage or local/);
    assert.equal(cliErrorOutput(product, "en", true), cliErrorOutput(product, "zh-CN", true));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("覆盖摘要格式化产品标签、日期与数字，并保留标题、路径和所有原始诊断", () => {
  const value = coverage();
  const original = JSON.stringify(value);
  const english = humanOutput(value, "en");
  const chinese = humanOutput(value, "zh-CN");
  assert.match(english, /Repository: 原始项目/);
  assert.match(chinese, /仓库：原始项目/);
  for (const language of ["en", "zh-CN"] as const) {
    const output = humanOutput(value, language);
    assert.ok(output.includes(formatDateTime(language, value.createdAt)));
    assert.match(output, /1,234/);
    assert.match(output, /src\/原文.ts/);
    assert.match(output, /external parser detail: 原文/);
    assert.match(output, /raw product diagnostic/);
  }
  assert.match(english, /view must be overview, usage or local/);
  assert.match(english, /key-path must be a JSON array/);
  assert.equal(JSON.stringify(value), original);
  const rawJson = { title: "未命名", message: "原始消息", count: 1234, occurredAt: value.createdAt };
  assert.equal(humanOutput(rawJson, "en"), humanOutput(rawJson, "zh-CN"));
  assert.deepEqual(JSON.parse(humanOutput(rawJson, "en")), rawJson);
});

test("CLI 未知产品描述保留原始错误及缺口详情，JSON 不受语言影响", () => {
  const descriptor = { key: "diagnostics.synthetic.obsolete" };
  const error = new RequestError("INVALID_INPUT", "原始合成旧错误", descriptor);
  const value = coverage();
  value.gaps = [{ kind: "parse_error", message: "原始旧缺口及未知详情", messageDescriptor: descriptor, details: [descriptor, { key: "cli.error.view" }] }];
  const original = JSON.stringify(value);
  for (const language of ["en", "zh-CN"] as const) {
    const failed = cliErrorOutput(error, language, false);
    assert.ok(failed.includes(translate(language, "common.originalDetails")));
    assert.match(failed, /原始合成旧错误/);
    assert.doesNotMatch(failed, /Translation unavailable|diagnostics.synthetic.obsolete/);
    const output = humanOutput(value, language);
    assert.match(output, /原始旧缺口及未知详情/);
    assert.ok(output.includes(translate(language, "cli.error.view")));
    assert.doesNotMatch(output, /Translation unavailable|diagnostics.synthetic.obsolete/);
  }
  assert.equal(JSON.stringify(value), original);
  assert.equal(cliErrorOutput(error, "en", true), cliErrorOutput(error, "zh-CN", true));
  assert.deepEqual(JSON.parse(cliErrorOutput(error, "en", true)).error.messageDescriptor, descriptor);
});

test("CLI status 维护提示求值中英文描述，原始错误和 JSON 契约保持一致", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-cli-maintenance-language-"));
  const home = join(directory, "data");
  let instance: ServiceInstance;
  const maintenance = { status: "failed", reason: "error", messageDescriptor: { key: "diagnostics.index.maintenance.error" }, details: "synthetic external disk failure" };
  const payload = () => ({ instance, version: VERSION, protocolVersion: 1, repositories: [], jobs: [], indexMaintenance: maintenance });
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(payload()));
  });
  try {
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    instance = { id: "fixture-maintenance-service-identity", version: VERSION, protocolVersion: 1, pid: process.pid, host: "127.0.0.1", port: address.port, startedAt: "2026-01-01T00:00:00Z" };
    await mkdir(home);
    await writeFile(join(home, "service.json"), JSON.stringify(instance));
    const before = JSON.stringify(payload());
    for (const language of ["en", "zh-CN"] as const) {
      const human = await command(directory, ["--lang", language, "status"]);
      assert.equal(human.code, 0, human.stderr);
      assert.ok(human.stdout.includes(translate(language, maintenance.messageDescriptor.key)));
      assert.ok(human.stdout.includes(translate(language, "common.originalDetails")));
      assert.match(human.stdout, /synthetic external disk failure/);
      assert.doesNotMatch(human.stdout, /diagnostics\.index\.maintenance\.error/);
      const json = await command(directory, ["--lang", language, "--json", "status"]);
      assert.equal(json.code, 0, json.stderr);
      const status = JSON.parse(json.stdout);
      assert.equal(status.running, true);
      assert.deepEqual(status.status, JSON.parse(before));
    }
    assert.equal(JSON.stringify(payload()), before);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("参数覆盖坏偏好和无效环境仍能自动启动，内部服务启动不受显示偏好阻塞", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-cli-language-startup-"));
  const home = join(directory, "data");
  const original = "{invalid synthetic preference}";
  const overrides = { AGENT_MANOR_LANG: "unsupported" };
  try {
    await mkdir(home);
    await writeFile(preferencesPath(home), original);
    const result = await command(directory, ["--lang", "en", "start", "--json"], overrides);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).instance.host, "127.0.0.1");
    assert.equal(await readFile(preferencesPath(home), "utf8"), original);
    const stopped = await command(directory, ["--lang", "auto", "stop", "--wait", "--json"], overrides);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).stopped, true);
  } finally {
    await command(directory, ["--lang", "auto", "stop", "--wait", "--json"], overrides);
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await readFile(join(home, "service.json")); } catch { break; }
      await delay(50);
    }
    await assert.rejects(readFile(join(home, "service.json")), { code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  }
});

test("执行期间语言固定，下次命令读取更新偏好，pretty JSON 和 --json 不随语言改变", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-cli-fixed-language-"));
  const home = join(directory, "data");
  const value = coverage();
  let instance: ServiceInstance;
  let completeResponse: (() => void) | undefined;
  let requested!: () => void;
  const firstRequest = new Promise<void>(done => { requested = done; });
  let hold = true;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url?.split("?")[0] === "/api/v1/status") response.end(JSON.stringify({ instance, version: VERSION, protocolVersion: 1 }));
    else if (request.url === "/api/v1/repositories/missing/coverage") {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: "REPOSITORY_NOT_FOUND", message: "原始服务产品错误",
        messageDescriptor: { key: "cli.error.view" } } }));
    }
    else {
      const finish = () => response.end(JSON.stringify(request.url === "/api/v1/repositories" ? { repositories: [value.repository] } : value));
      if (hold) { completeResponse = finish; requested(); } else finish();
    }
  });
  try {
    await writePreferences(home, "en");
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    instance = { id: "fixture-service-language-identity", version: VERSION, protocolVersion: 1, pid: process.pid, host: "127.0.0.1", port: address.port, startedAt: "2026-01-01T00:00:00Z" };
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "service.json"), JSON.stringify(instance));
    const running = command(directory, ["coverage", value.repository.id]);
    await Promise.race([firstRequest, running.then(result => { throw new Error(result.stderr || "CLI 未请求合成服务"); })]);
    await writePreferences(home, "zh-CN");
    hold = false;
    completeResponse!();
    const first = await running;
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /Repository: 原始项目/);
    const next = await command(directory, ["coverage", value.repository.id]);
    assert.equal(next.code, 0, next.stderr);
    assert.match(next.stdout, /仓库：原始项目/);
    for (const args of [["repositories"], ["coverage", value.repository.id, "--json"], ["repositories", "--json"]]) {
      const english = await command(directory, ["--lang", "en", ...args]);
      const chinese = await command(directory, ["--lang", "zh-CN", ...args]);
      assert.equal(english.code, 0, english.stderr);
      assert.equal(chinese.code, 0, chinese.stderr);
      assert.equal(english.stdout, chinese.stdout);
      assert.equal(english.stderr, "");
      assert.equal(chinese.stderr, "");
      assert.doesNotThrow(() => JSON.parse(english.stdout));
    }
    const errorEn = await command(directory, ["--lang", "en", "coverage", "missing"]);
    const errorZh = await command(directory, ["--lang", "zh-CN", "coverage", "missing"]);
    assert.equal(errorEn.code, 1);
    assert.equal(errorZh.code, 1);
    assert.match(errorEn.stderr, /view must be overview, usage or local/);
    assert.match(errorEn.stderr, /Original details: 原始服务产品错误/);
    assert.match(errorZh.stderr, /view 必须是 overview、usage 或 local/);
    const jsonErrorEn = await command(directory, ["--lang", "en", "coverage", "missing", "--json"]);
    const jsonErrorZh = await command(directory, ["--lang", "zh-CN", "coverage", "missing", "--json"]);
    assert.equal(jsonErrorEn.stdout, "");
    assert.equal(jsonErrorEn.stderr, jsonErrorZh.stderr);
    assert.equal(JSON.parse(jsonErrorEn.stderr).error.message, "原始服务产品错误");
  } finally {
    completeResponse?.();
    await new Promise<void>(done => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
