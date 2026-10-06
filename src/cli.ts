#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { CoverageResult, JobResponse, ServiceInstance } from "./contracts.js";
import { clientIds } from "./clients.js";
import { startService } from "./server.js";
import { apiRequest, connectService, dataHome, delay, RequestError, serviceUrl } from "./service/runtime.js";
import { VERSION } from "./version.js";
import type { SessionJob } from "./session-contracts.js";

type Options = Record<string, string | boolean | undefined>;
const repositoryPath = (id: string) => `/repositories/${encodeURIComponent(id)}`;

function queryString(options: Options, extra: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const key of ["version", "client", "from", "to", "categories", "directory"]) {
    if (typeof options[key] === "string") params.set(key, options[key] as string);
  }
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) params.set(key, value);
  return params.size ? `?${params}` : "";
}

function humanOutput(value: unknown): string {
  if (value && typeof value === "object" && "summary" in value && "files" in value) {
    const result = value as CoverageResult;
    const { summary } = result;
    return [
      `仓库：${result.repository.name} (${result.repository.id})`,
      `分析结果版本：${result.version}；更新时间：${result.createdAt}；状态：${result.stale ? "过期" : "已完成"}`,
      `统计范围：${summary.fileCount} 个文件，${summary.lineCount} 行；筛选：${JSON.stringify(result.filters)}`,
      `读取：精确 ${summary.readExact.files} 个文件 / ${summary.readExact.lines} 行；近似 ${summary.readNear.files} 个文件 / ${summary.readNear.lines} 行`,
      `修改：精确 ${summary.editExact.files} 个文件 / ${summary.editExact.lines} 行；近似 ${summary.editNear.files} 个文件 / ${summary.editNear.lines} 行`,
      "文件\t行数\t读取精确/近似\t修改精确/近似\t活动次数",
      ...result.files.map((file) => `${file.path}\t${file.lineCount}\t${file.readExactLines}/${file.readNearLines}\t${file.editExactLines}/${file.editNearLines}\t${file.activityCount}`),
      `采集缺口：${result.gaps.length}${result.gaps.length ? `\n${result.gaps.map((gap) => `${gap.kind}: ${gap.message}`).join("\n")}` : ""}`,
    ].join("\n");
  }
  // 其他详情按原契约展示，统计始终由同一 API 返回。
  return JSON.stringify(value, null, 2);
}

async function waitJob(instance: ServiceInstance, value: JobResponse | { job: SessionJob }, timeout: string | boolean | undefined): Promise<JobResponse | { job: SessionJob }> {
  const seconds = timeout === undefined ? 120 : Number(timeout);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new RequestError("INVALID_INPUT", "timeout 必须是 0 到 3600 秒之间的数值");
  const deadline = Date.now() + seconds * 1000;
  let result = value;
  while (result.job.status === "queued" || result.job.status === "running") {
    if (Date.now() >= deadline) throw new RequestError("WAIT_TIMEOUT", `等待任务 ${result.job.id} 超时`);
    await delay(100);
    result = await apiRequest<JobResponse>(instance, `/jobs/${encodeURIComponent(result.job.id)}`);
  }
  return result;
}

export function createProgram(): Command {
  const program = new Command().name("agent-manor").description("本地 Agent 历史与仓库代码活动分析")
    .version(VERSION, "-V, --cli-version", "显示程序版本").option("--json", "输出稳定 JSON").option("--home <path>", "分析数据目录");
  const output = (command: Command, value: unknown) => {
    const options = command.optsWithGlobals<Options>();
    process.stdout.write(`${options.json ? JSON.stringify(value) : humanOutput(value)}\n`);
  };
  async function request(command: Command, path: string, method = "GET", body?: unknown, autoStart = true): Promise<unknown> {
    const options = command.optsWithGlobals<Options>();
    const instance = await connectService(autoStart, dataHome(typeof options.home === "string" ? options.home : undefined));
    if (!instance) {
      const result = { stopping: false, running: false };
      output(command, result);
      return result;
    }
    let result = await apiRequest<unknown>(instance, path, method, body);
    if (options.wait && typeof result === "object" && result !== null && "job" in result) {
      const finished = await waitJob(instance, result as JobResponse | { job: SessionJob }, options.timeout);
      result = { ...result, job: finished.job };
      if (finished.job.status === "failed") process.exitCode = 1;
    }
    output(command, result);
    return result;
  }
  const filters = (command: Command) => command.option("--version <id>", "分析结果版本")
    .option("--client <client>", clientIds.join(" 或 ")).option("--from <time>", "ISO 8601 起始时间")
    .option("--to <time>", "ISO 8601 截止时间").option("--categories <list>", "逗号分隔文件类别")
    .option("--directory <path>", "仓库内相对目录");
  const waiting = (command: Command) => command.option("--wait", "等待刷新完成").option("--timeout <seconds>", "等待秒数，默认 120");
  const sessions = program.command("sessions").description("全局会话库、搜索、消息轨迹及画像");
  const sessionFilters = (command: Command) => command.option("--client <client>", clientIds.join(" 或 "))
    .option("--project <path>", "项目绝对路径；none 表示无项目").option("--from <time>", "ISO 8601 起始时间")
    .option("--to <time>", "ISO 8601 截止时间").option("--version <id>", "完整会话索引版本")
    .option("--page <number>", "页码").option("--page-size <number>", "每页条数，最多 200")
    .option("--kinds <list>", "逗号分隔 user、assistant、thinking、tool_call、tool_result、system、context、compression");
  const sessionQueryString = (command: Command, extra: Record<string, string | undefined> = {}) => {
    const opts = command.optsWithGlobals<Options>();
    const params = new URLSearchParams();
    for (const key of ["client", "project", "from", "to", "version", "page", "kinds", "q", "mode", "messageId", "sessionId"]) {
      if (typeof opts[key] === "string") params.set(key, opts[key] as string);
    }
    if (typeof opts.pageSize === "string") params.set("pageSize", opts.pageSize);
    for (const [key, value] of Object.entries(extra)) if (value !== undefined) params.set(key, value);
    return params.size ? `?${params}` : "";
  };
  sessions.command("status").description("会话索引状态与采集缺口")
    .action(async (_options: Options, command: Command) => { await request(command, "/sessions/status"); });
  sessionFilters(sessions.command("list").description("分页列出主会话及独立记录")).option("--q <text>", "标题及正文关键词")
    .option("--include-subagents", "同时列出已确认父关系的子 Agent 会话")
    .action(async (_options: Options, command: Command) => { await request(command, `/sessions${sessionQueryString(command,
      { includeSubagents: command.optsWithGlobals<Options>().includeSubagents ? "true" : undefined })}`); });
  sessionFilters(sessions.command("search <text>").description("搜索全部有效索引，返回消息定位")).option("--session-id <id>", "仅搜索指定会话")
    .action(async (q: string, _options: Options, command: Command) => { await request(command, `/sessions/search${sessionQueryString(command, { q })}`); });
  sessionFilters(sessions.command("messages <id>").description("分页浏览简易、完整或轨迹消息"))
    .option("--mode <mode>", "brief、full 或 trace，默认 full").option("--message-id <id>", "定位消息所在页")
    .action(async (id: string, _options: Options, command: Command) => { await request(command, `/sessions/${encodeURIComponent(id)}/messages${sessionQueryString(command)}`); });
  sessionFilters(sessions.command("profile <id>").description("会话画像、记录用量与留存内容估算"))
    .option("--include-children", "包含明确关联的子会话")
    .action(async (id: string, _options: Options, command: Command) => { await request(command, `/sessions/${encodeURIComponent(id)}/profile${sessionQueryString(command, { includeChildren: command.optsWithGlobals<Options>().includeChildren ? "true" : undefined })}`); });
  for (const name of ["refresh", "cacheclear"] as const) {
    waiting(sessions.command(name).description(name === "refresh" ? "检查并刷新全部历史" : "清除派生会话缓存后重建"))
      .action(async (_options: Options, command: Command) => { await request(command, `/sessions/${name === "refresh" ? "refresh" : "cache"}`, name === "refresh" ? "POST" : "DELETE"); });
  }
  program.command("serve").description("前台运行本地后台服务").option("--port <number>", "监听端口，默认随机空闲端口")
    .action(async (options: Options, command: Command) => {
      const global = command.optsWithGlobals<Options>();
      const service = await startService({ home: typeof global.home === "string" ? global.home : undefined,
        port: options.port === undefined ? undefined : Number(options.port) });
      output(command, { instance: service.instance, url: serviceUrl(service.instance) });
      const shutdown = () => { void service.close(); };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  waiting(program.command("register <path>").description("登记 Git 仓库并刷新"))
    .action(async (path: string, _options: Options, command: Command) => { await request(command, "/repositories", "POST", { path: resolve(path) }); });
  program.command("repositories").description("列出已登记仓库").action(async (_options: Options, command: Command) => { await request(command, "/repositories"); });
  for (const name of ["coverage", "unobserved", "sources"] as const) {
    filters(program.command(`${name} <repositoryId>`).description(name === "coverage" ? "查询覆盖率" : name === "unobserved" ? "查询未观察到读取的文件" : "查询来源与采集缺口"))
      .action(async (id: string, _options: Options, command: Command) => {
        await request(command, `${repositoryPath(id)}/${name}${queryString(command.optsWithGlobals<Options>())}`);
      });
  }
  filters(program.command("hotspots <repositoryId>").description("查询文件活动热点"))
    .option("--metric <metric>", "read、edit 或 activity").option("--limit <number>", "最多返回文件数")
    .action(async (id: string, options: Options, command: Command) => {
      await request(command, `${repositoryPath(id)}/hotspots${queryString(command.optsWithGlobals<Options>(), { metric: options.metric as string | undefined, limit: options.limit as string | undefined })}`);
    });
  filters(program.command("file <repositoryId> <path>").description("查询文件内容、范围及活动"))
    .action(async (id: string, path: string, _options: Options, command: Command) => {
      await request(command, `${repositoryPath(id)}/file${queryString(command.optsWithGlobals<Options>(), { path })}`);
    });
  filters(program.command("events <repositoryId>").description("分页查询历史活动"))
    .option("--path <path>", "仓库内相对文件").option("--kind <kind>", "活动类型")
    .option("--page <number>", "页码").option("--page-size <number>", "每页条数，最多 200")
    .action(async (id: string, options: Options, command: Command) => {
      await request(command, `${repositoryPath(id)}/events${queryString(command.optsWithGlobals<Options>(), {
        path: options.path as string | undefined, kind: options.kind as string | undefined,
        page: options.page as string | undefined, pageSize: options.pageSize as string | undefined,
      })}`);
    });
  filters(program.command("evidence <repositoryId> <eventId>").description("回读索引引用的原始记录"))
    .action(async (id: string, eventId: string, _options: Options, command: Command) => {
      await request(command, `${repositoryPath(id)}/evidence/${encodeURIComponent(eventId)}${queryString(command.optsWithGlobals<Options>())}`);
    });
  waiting(program.command("associate <repositoryId> <sourceId>").description("手动关联来源并刷新"))
    .action(async (id: string, sourceId: string, _options: Options, command: Command) => {
      await request(command, `${repositoryPath(id)}/associations`, "POST", { sourceId });
    });
  for (const name of ["refresh", "cacheclear"] as const) {
    waiting(program.command(`${name} <repositoryId>`).description(name === "refresh" ? "主动刷新分析" : "清除派生缓存后重建"))
      .action(async (id: string, _options: Options, command: Command) => {
        await request(command, `${repositoryPath(id)}/${name === "refresh" ? "refresh" : "cache"}`, name === "refresh" ? "POST" : "DELETE");
      });
  }
  waiting(program.command("jobs <jobId>").description("查询或等待刷新任务"))
    .action(async (id: string, _options: Options, command: Command) => { await request(command, `/jobs/${encodeURIComponent(id)}`); });
  program.command("status").description("查询服务实例、仓库与任务").action(async (_options: Options, command: Command) => { await request(command, "/status"); });
  program.command("stop").description("显式停止现存服务").action(async (_options: Options, command: Command) => { await request(command, "/stop", "POST", undefined, false); });
  program.command("web").description("打开本地代码地图").option("--no-open", "只打印地址")
    .action(async (options: Options, command: Command) => {
      const global = command.optsWithGlobals<Options>();
      const instance = (await connectService(true, dataHome(typeof global.home === "string" ? global.home : undefined)))!;
      const url = serviceUrl(instance);
      if (options.open !== false) {
        const application = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
        const child = spawn(application, [url], { stdio: "ignore", detached: true });
        child.on("error", () => { /* 地址仍可由用户手动打开。 */ });
        child.unref();
      }
      output(command, { instance, url });
    });
  return program;
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  // npm 的 bin 是符号链接，以真实路径判断；普通导入不触发 CLI。
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isEntrypoint()) {
  const program = createProgram();
  if (process.argv.length === 3 && process.argv[2] === "--version") process.stdout.write(`${VERSION}\n`);
  else void program.parseAsync().catch((error: unknown) => {
    const failure = { error: { code: error instanceof RequestError ? error.code : "SERVICE_UNAVAILABLE", message: error instanceof Error ? error.message : "命令执行失败" } };
    process.stderr.write(`${program.opts().json ? JSON.stringify(failure) : failure.error.message}\n`);
    process.exitCode = 1;
  });
}
