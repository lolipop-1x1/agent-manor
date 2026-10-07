#!/usr/bin/env node
import { Command, CommanderError } from "commander";
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
import { sessionRefreshOptions } from "./service/session-input.js";
import { detectLanguage, formatDateTime, formatNumber, isLanguagePreference, isMessageDescriptorKnown, translate, translateMessage } from "./i18n/index.js";
import type { Language, MessageDescriptor, MessageParams } from "./i18n/index.js";
import { readPreferences } from "./service/preferences.js";

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

export async function resolveCliLanguage(options: Partial<Pick<Options, "lang" | "home">>, environment: NodeJS.ProcessEnv = process.env): Promise<Language> {
  // 系统变量按优先级取首个非空值；不跨越未支持语言继续查找。
  const systemLanguage = detectLanguage([[environment.LC_ALL, environment.LC_MESSAGES, environment.LANG].find(value => value?.trim())]);
  const override = options.lang ?? environment.AGENT_MANOR_LANG;
  if (override !== undefined) {
    const source = options.lang === undefined ? "AGENT_MANOR_LANG" : "--lang";
    if (!isLanguagePreference(override)) throw new RequestError("INVALID_INPUT", `${source} 必须是 zh-CN、en 或 auto（收到 ${override}）`,
      { key: "cli.error.invalidLanguage", params: { source, value: String(override) } });
    return override === "auto" ? systemLanguage : override;
  }
  const preference = await readPreferences(dataHome(typeof options.home === "string" ? options.home : environment.AGENT_MANOR_HOME));
  return preference.language === "auto" ? systemLanguage : preference.language;
}

export function humanOutput(value: unknown, language: Language): string {
  const t = (key: string, params?: MessageParams) => translate(language, key, params);
  const number = (value: number) => formatNumber(language, value);
  if (value && typeof value === "object" && "summary" in value && "files" in value) {
    const result = value as CoverageResult;
    const { summary } = result;
    return [
      t("cli.summary.repository", { name: result.repository.name, id: result.repository.id }),
      t("cli.summary.version", { version: result.version, createdAt: formatDateTime(language, result.createdAt), status: t(result.stale ? "cli.status.stale" : "cli.status.completed") }),
      t("cli.summary.scope", { files: summary.fileCount, lines: summary.lineCount, filters: JSON.stringify(result.filters) }),
      t("cli.summary.read", { exactFiles: summary.readExact.files, exactLines: summary.readExact.lines, nearFiles: summary.readNear.files, nearLines: summary.readNear.lines }),
      t("cli.summary.edit", { exactFiles: summary.editExact.files, exactLines: summary.editExact.lines, nearFiles: summary.editNear.files, nearLines: summary.editNear.lines }),
      t("cli.summary.columns"),
      ...result.files.map((file) => `${file.path}\t${number(file.lineCount)}\t${number(file.readExactLines)}/${number(file.readNearLines)}\t${number(file.editExactLines)}/${number(file.editNearLines)}\t${number(file.activityCount)}`),
      t("cli.summary.gaps", { count: result.gaps.length }),
      ...result.gaps.map(gap => [
        `${gap.kind}: ${isMessageDescriptorKnown(gap.messageDescriptor) ? translateMessage(language, gap.messageDescriptor) : t("common.originalDetails")}`,
        ...(gap.details ?? []).filter(isMessageDescriptorKnown).map(detail => translateMessage(language, detail)),
        `${t("common.originalDetails")}: ${gap.message}`,
      ].join("\n")),
    ].join("\n");
  }
  // 其他详情按原契约展示，统计始终由同一 API 返回。
  return JSON.stringify(value, null, 2);
}

async function waitJob(instance: ServiceInstance, value: JobResponse | { job: SessionJob }, timeout: string | boolean | undefined): Promise<JobResponse | { job: SessionJob }> {
  const seconds = timeout === undefined ? 120 : Number(timeout);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new RequestError("INVALID_INPUT", "timeout 必须是 0 到 3600 秒之间的数值", { key: "cli.error.timeout" });
  const deadline = Date.now() + seconds * 1000;
  let result = value;
  while (result.job.status === "queued" || result.job.status === "running") {
    if (Date.now() >= deadline) throw new RequestError("WAIT_TIMEOUT", `等待任务 ${result.job.id} 超时`, { key: "cli.error.waitTimeout", params: { id: result.job.id } });
    await delay(100);
    result = await apiRequest<JobResponse>(instance, `/jobs/${encodeURIComponent(result.job.id)}`);
  }
  return result;
}

export function createProgram(language: Language = "en"): Command {
  const t = (key: string, params?: MessageParams) => translate(language, key, params);
  const program = new Command().name("agent-manor").description(t("cli.description"))
    .version(VERSION, "-V, --cli-version", t("cli.version")).option("--json", t("cli.json")).option("--home <path>", t("cli.home"))
    .option("--lang <language>", t("cli.lang"))
    .exitOverride().configureOutput({ outputError: () => {}, writeErr: text => {
      if (!program.opts<Options>().json) process.stderr.write(text);
    } })
    .helpOption("-h, --help", t("cli.help")).helpCommand("help [command]", t("cli.helpCommand"))
    .configureHelp({ showGlobalOptions: true, styleTitle: title => {
      const headings: Record<string, string> = { "Usage:": "cli.usage", "Arguments:": "cli.arguments", "Options:": "cli.options", "Global Options:": "cli.globalOptions", "Commands:": "cli.commands" };
      return headings[title] ? t(headings[title]) : title;
    } });
  const output = (command: Command, value: unknown) => {
    const options = command.optsWithGlobals<Options>();
    process.stdout.write(`${options.json ? JSON.stringify(value) : humanOutput(value, language)}\n`);
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
  const filters = (command: Command) => command.option("--version <id>", t("cli.versionOption"))
    .option("--client <client>", t("cli.clientChoices", { clients: clientIds.join(", ") })).option("--from <time>", t("cli.from"))
    .option("--to <time>", t("cli.to")).option("--categories <list>", t("cli.categories"))
    .option("--directory <path>", t("cli.directory"));
  const waiting = (command: Command) => command.option("--wait", t("cli.wait")).option("--timeout <seconds>", t("cli.timeout"));
  const sessions = program.command("sessions").description(t("cli.sessions"));
  const sessionFilters = (command: Command) => command.option("--client <client>", t("cli.clientChoices", { clients: clientIds.join(", ") }))
    .option("--project <path>", t("cli.project")).option("--from <time>", t("cli.from"))
    .option("--to <time>", t("cli.to")).option("--version <id>", t("cli.sessionVersion"))
    .option("--page <number>", t("cli.page")).option("--page-size <number>", t("cli.pageSize"))
    .option("--kinds <list>", t("cli.kinds"));
  const sessionQueryString = (command: Command, extra: Record<string, string | undefined> = {}) => {
    const opts = command.optsWithGlobals<Options>();
    const params = new URLSearchParams();
    for (const key of ["client", "project", "from", "to", "version", "page", "kinds", "q", "mode", "messageId", "sessionId", "executionMode", "branch"]) {
      if (typeof opts[key] === "string") params.set(key, opts[key] as string);
    }
    if (typeof opts.pageSize === "string") params.set("pageSize", opts.pageSize);
    for (const [key, value] of Object.entries(extra)) if (value !== undefined) params.set(key, value);
    return params.size ? `?${params}` : "";
  };
  sessions.command("status").description(t("cli.sessionStatus"))
    .action(async (_options: Options, command: Command) => { await request(command, "/sessions/status"); });
  sessionFilters(sessions.command("list").description(t("cli.sessionList"))).option("--q <text>", t("cli.sessionKeywords"))
    .option("--execution-mode <mode>", t("cli.executionMode"))
    .option("--include-subagents", t("cli.includeSubagents"))
    .action(async (_options: Options, command: Command) => { await request(command, `/sessions${sessionQueryString(command,
      { includeSubagents: command.optsWithGlobals<Options>().includeSubagents ? "true" : undefined })}`); });
  sessionFilters(sessions.command("search <text>").description(t("cli.sessionSearch"))).option("--session-id <id>", t("cli.sessionId"))
    .option("--execution-mode <mode>", t("cli.searchExecutionMode"))
    .action(async (q: string, _options: Options, command: Command) => { await request(command, `/sessions/search${sessionQueryString(command, { q })}`); });
  sessionFilters(sessions.command("messages <id>").description(t("cli.messages")))
    .option("--branch <id>", t("cli.branch"))
    .option("--mode <mode>", t("cli.mode")).option("--message-id <id>", t("cli.messageId"))
    .action(async (id: string, _options: Options, command: Command) => { await request(command, `/sessions/${encodeURIComponent(id)}/messages${sessionQueryString(command)}`); });
  sessionFilters(sessions.command("profile <id>").description(t("cli.profile")))
    .option("--include-children", t("cli.includeChildren"))
    .action(async (id: string, _options: Options, command: Command) => { await request(command, `/sessions/${encodeURIComponent(id)}/profile${sessionQueryString(command, { includeChildren: command.optsWithGlobals<Options>().includeChildren ? "true" : undefined })}`); });
  waiting(sessions.command("refresh").description(t("cli.sessionRefresh")))
    .option("--client <client>", t("cli.refreshClient", { clients: clientIds.join(", ") }))
    .option("--mode <mode>", t("cli.refreshMode"))
    .action(async (_options: Options, command: Command) => {
      const options = command.optsWithGlobals<Options>();
      const body = sessionRefreshOptions({ client: options.client, mode: options.mode });
      await request(command, "/sessions/refresh", "POST", body);
    });
  waiting(sessions.command("cacheclear").description(t("cli.sessionCacheclear")))
    .action(async (_options: Options, command: Command) => { await request(command, "/sessions/cache", "DELETE"); });
  const resources = program.command("resources").description(t("cli.resources"));
  const resourceFilters = (command: Command) => command.option("--kind <kind>", t("cli.kind"))
    .option("--client <client>", t("cli.clientChoices", { clients: clientIds.join(", ") })).option("--project <path>", t("cli.project"))
    .option("--q <text>", t("cli.resourceKeywords")).option("--from <time>", t("cli.from"))
    .option("--to <time>", t("cli.to")).option("--sort <sort>", t("cli.sort"))
    .option("--order <order>", t("cli.order"))
    .option("--page <number>", t("cli.page")).option("--page-size <number>", t("cli.pageSize")).option("--version <id>", t("cli.resourceVersion"));
  const resourceQueryString = (command: Command) => {
    const opts = command.optsWithGlobals<Options>();
    const params = new URLSearchParams();
    for (const key of ["kind", "client", "project", "q", "from", "to", "sort", "order", "page", "version", "candidate", "tool", "state"]) {
      if (typeof opts[key] === "string") params.set(key, opts[key] as string);
    }
    for (const key of ["pageSize", "lowSessions", "inactiveDays", "evidenceKind"]) if (typeof opts[key] === "string") params.set(key, opts[key] as string);
    if (opts.favorite) params.set("favorite", "true");
    return params.size ? `?${params}` : "";
  };
  resources.command("status").description(t("cli.resourceStatus"))
    .action(async (_options: Options, command: Command) => { await request(command, "/resources/status"); });
  resources.command("refresh").description(t("cli.resourceRefresh"))
    .action(async (_options: Options, command: Command) => { await request(command, "/resources/refresh", "POST", {}); });
  resourceFilters(resources.command("overview").description(t("cli.overview")))
    .option("--candidate <filter>", t("cli.overviewCandidate"))
    .option("--low-sessions <number>", t("cli.lowSessions")).option("--inactive-days <number>", t("cli.inactiveDays"))
    .option("--favorite", t("cli.favoriteOnly"))
    .action(async (_options: Options, command: Command) => { await request(command, `/resources/overview${resourceQueryString(command)}`); });
  resourceFilters(resources.command("usage").description(t("cli.usageRanking"))).option("--favorite", t("cli.favoriteOnly"))
    .action(async (_options: Options, command: Command) => { await request(command, `/resources/usage${resourceQueryString(command)}`); });
  resourceFilters(resources.command("local").description(t("cli.local")))
    .option("--candidate <filter>", t("cli.localCandidate"))
    .option("--low-sessions <number>", t("cli.lowSessions")).option("--inactive-days <number>", t("cli.inactiveDays"))
    .action(async (_options: Options, command: Command) => { await request(command, `/resources/local${resourceQueryString(command)}`); });
  resourceFilters(resources.command("detail <id>").description(t("cli.detail"))).option("--view <view>", t("cli.view"))
    .action(async (id: string, _options: Options, command: Command) => {
      const view = command.optsWithGlobals<Options>().view ?? "usage";
      if (!["overview", "usage", "local"].includes(String(view))) throw new RequestError("INVALID_INPUT", "view 必须是 overview、usage 或 local", { key: "cli.error.view" });
      await request(command, `/resources/${view}/${encodeURIComponent(id)}${resourceQueryString(command)}`);
    });
  resourceFilters(resources.command("evidence <id>").description(t("cli.resourceEvidence")))
    .option("--tool <name>", t("cli.tool")).option("--evidence-kind <kind>", t("cli.evidenceKind"))
    .action(async (id: string, _options: Options, command: Command) => { await request(command, `/resources/usage/${encodeURIComponent(id)}/evidence${resourceQueryString(command)}`); });
  resources.command("favorite <id>").description(t("cli.favorite")).option("--off", t("cli.off"))
    .action(async (id: string, _options: Options, command: Command) => { await request(command, "/resources/favorites", "POST", { id, value: !command.optsWithGlobals<Options>().off }); });
  resourceFilters(resources.command("archives").description(t("cli.archives"))).option("--state <state>", t("cli.state"))
    .action(async (_options: Options, command: Command) => { await request(command, `/resources/archives${resourceQueryString(command)}`); });
  resourceFilters(resources.command("operations").description(t("cli.operations")))
    .action(async (_options: Options, command: Command) => { await request(command, `/resources/operations${resourceQueryString(command)}`); });
  resources.command("source-add <path>").description(t("cli.sourceAdd"))
    .requiredOption("--client <client>", t("cli.clientChoices", { clients: clientIds.join(", ") })).requiredOption("--kind <kind>", t("cli.kind"))
    .option("--project <path>", t("cli.sourceProject")).option("--format <format>", t("cli.format"))
    .option("--key-path <json>", t("cli.keyPath"))
    .action(async (path: string, _options: Options, command: Command) => {
      const opts = command.optsWithGlobals<Options>();
      let keyPath: unknown;
      try { keyPath = opts.keyPath === undefined ? undefined : JSON.parse(String(opts.keyPath)); }
      catch { throw new RequestError("INVALID_INPUT", "key-path 必须是 JSON 数组", { key: "cli.error.keyPath" }); }
      await request(command, "/resources/sources", "POST", { path: resolve(path), client: opts.client, kind: opts.kind,
        project: typeof opts.project === "string" ? resolve(opts.project) : undefined, format: opts.format, keyPath });
    });
  resources.command("source-remove <id>").description(t("cli.sourceRemove"))
    .action(async (id: string, _options: Options, command: Command) => { await request(command, `/resources/sources/${encodeURIComponent(id)}`, "DELETE"); });
  resources.command("preview <action>").description(t("cli.preview"))
    .option("--entry-id <id>", t("cli.entryId")).option("--operation-id <id>", t("cli.operationId"))
    .action(async (action: string, _options: Options, command: Command) => {
      const opts = command.optsWithGlobals<Options>();
      await request(command, "/resources/preview", "POST", { action, entryId: opts.entryId, operationId: opts.operationId });
    });
  resources.command("apply <previewId>").description(t("cli.apply"))
    .requiredOption("--confirm", t("cli.confirm"))
    .action(async (previewId: string, _options: Options, command: Command) => {
      if (command.optsWithGlobals<Options>().confirm !== true) throw new RequestError("INVALID_INPUT", "需要明确确认当前预览", { key: "cli.error.confirm" });
      await request(command, "/resources/apply", "POST", { previewId, confirmed: true });
    });
  program.command("serve").description(t("cli.serve")).option("--port <number>", t("cli.port"))
    .action(async (options: Options, command: Command) => {
      const global = command.optsWithGlobals<Options>();
      const service = await startService({ home: typeof global.home === "string" ? global.home : undefined,
        port: options.port === undefined ? undefined : Number(options.port) });
      output(command, { instance: service.instance, url: serviceUrl(service.instance) });
      const shutdown = () => { void service.close(); };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  waiting(program.command("register <path>").description(t("cli.register")))
    .action(async (path: string, _options: Options, command: Command) => { await request(command, "/repositories", "POST", { path: resolve(path) }); });
  program.command("repositories").description(t("cli.repositories")).action(async (_options: Options, command: Command) => { await request(command, "/repositories"); });
  for (const name of ["coverage", "unobserved", "sources"] as const) {
    filters(program.command(`${name} <repositoryId>`).description(name === "coverage" ? t("cli.coverage") : name === "unobserved" ? t("cli.unobserved") : t("cli.sources")))
      .action(async (id: string, _options: Options, command: Command) => {
        await request(command, `${repositoryPath(id)}/${name}${queryString(command.optsWithGlobals<Options>())}`);
      });
  }
  filters(program.command("hotspots <repositoryId>").description(t("cli.hotspots")))
    .option("--metric <metric>", t("cli.metric")).option("--limit <number>", t("cli.limit"))
    .action(async (id: string, options: Options, command: Command) => {
      await request(command, `${repositoryPath(id)}/hotspots${queryString(command.optsWithGlobals<Options>(), { metric: options.metric as string | undefined, limit: options.limit as string | undefined })}`);
    });
  filters(program.command("file <repositoryId> <path>").description(t("cli.file")))
    .action(async (id: string, path: string, _options: Options, command: Command) => {
      await request(command, `${repositoryPath(id)}/file${queryString(command.optsWithGlobals<Options>(), { path })}`);
    });
  filters(program.command("events <repositoryId>").description(t("cli.events")))
    .option("--path <path>", t("cli.path")).option("--kind <kind>", t("cli.eventKind"))
    .option("--page <number>", t("cli.page")).option("--page-size <number>", t("cli.pageSize"))
    .action(async (id: string, options: Options, command: Command) => {
      await request(command, `${repositoryPath(id)}/events${queryString(command.optsWithGlobals<Options>(), {
        path: options.path as string | undefined, kind: options.kind as string | undefined,
        page: options.page as string | undefined, pageSize: options.pageSize as string | undefined,
      })}`);
    });
  filters(program.command("evidence <repositoryId> <eventId>").description(t("cli.evidence")))
    .action(async (id: string, eventId: string, _options: Options, command: Command) => {
      await request(command, `${repositoryPath(id)}/evidence/${encodeURIComponent(eventId)}${queryString(command.optsWithGlobals<Options>())}`);
    });
  waiting(program.command("associate <repositoryId> <sourceId>").description(t("cli.associate")))
    .action(async (id: string, sourceId: string, _options: Options, command: Command) => {
      await request(command, `${repositoryPath(id)}/associations`, "POST", { sourceId });
    });
  for (const name of ["refresh", "cacheclear"] as const) {
    waiting(program.command(`${name} <repositoryId>`).description(name === "refresh" ? t("cli.refresh") : t("cli.cacheclear")))
      .action(async (id: string, _options: Options, command: Command) => {
        await request(command, `${repositoryPath(id)}/${name === "refresh" ? "refresh" : "cache"}`, name === "refresh" ? "POST" : "DELETE");
      });
  }
  waiting(program.command("jobs <jobId>").description(t("cli.jobs")))
    .action(async (id: string, _options: Options, command: Command) => { await request(command, `/jobs/${encodeURIComponent(id)}`); });
  program.command("status").description(t("cli.status")).action(async (_options: Options, command: Command) => { await request(command, "/status"); });
  program.command("stop").description(t("cli.stop")).action(async (_options: Options, command: Command) => { await request(command, "/stop", "POST", undefined, false); });
  program.command("web").description(t("cli.web")).option("--no-open", t("cli.noOpen"))
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

function startupOptions(args: readonly string[]): Options {
  const options: Options = {};
  for (let index = 0; index < args.length && args[index] !== "--"; index++) {
    const argument = args[index]!;
    if (argument === "--json") options.json = true;
    for (const name of ["home", "lang"]) {
      if (argument.startsWith(`--${name}=`)) options[name] = argument.slice(name.length + 3);
      else if (argument === `--${name}` && args[index + 1] !== undefined && !args[index + 1]!.startsWith("-")) options[name] = args[++index];
    }
  }
  return options;
}

export function cliErrorOutput(error: unknown, language: Language, json: boolean): string {
  const codes = ["missingArgument", "optionMissingArgument", "missingMandatoryOptionValue", "unknownCommand", "unknownOption", "excessArguments", "invalidArgument", "help"];
  const known = error as { code?: string; messageDescriptor?: MessageDescriptor } | undefined;
  const commanderDescriptor = error instanceof CommanderError && codes.some(code => error.code === `commander.${code}`)
    ? { key: `cli.error.${error.code}` } : undefined;
  const messageDescriptor = known?.messageDescriptor ?? commanderDescriptor;
  const failure = { error: {
    code: error instanceof RequestError || error instanceof CommanderError ? error.code : "SERVICE_UNAVAILABLE",
    message: error instanceof Error ? error.message : "命令执行失败",
    ...(messageDescriptor ? { messageDescriptor } : {}),
  } };
  if (json) return JSON.stringify(failure);
  return [isMessageDescriptorKnown(messageDescriptor) ? translateMessage(language, messageDescriptor) : translate(language, "cli.error.commandFailed"),
    `${translate(language, "common.originalDetails")}: ${failure.error.message}`].join("\n");
}

export async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = startupOptions(args);
  let language = detectLanguage([[process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG].find(value => value?.trim())]);
  try {
    // 先读同一数据目录的偏好，再生成帮助；整次命令不重新解析语言。
    language = await resolveCliLanguage(options);
    const program = createProgram(language);
    if (args.length === 1 && args[0] === "--version") process.stdout.write(`${VERSION}\n`);
    else await program.parseAsync([...args], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    process.stderr.write(`${cliErrorOutput(error, language, options.json === true)}\n`);
    process.exitCode = 1;
  }
}

if (isEntrypoint()) void runCli();
