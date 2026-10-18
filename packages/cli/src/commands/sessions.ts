import type { Command } from "commander";
import type { CliContext, Options } from "../context.js";
import { RequestError } from "../../../../src/service/runtime.js";
import { resolve } from "node:path";
import { clientIds } from "../../../../src/clients.js";
import { writeFile } from "node:fs/promises";
import type { SessionMessageResult } from "../../../../src/session-contracts.js";
import { collectDialogue, dialogueMarkdown } from "../../../../src/sessions/export.js";
import { queryOptions, queryParameters } from "../api/input.js";
import { sessionRefreshOptions } from "../../../../src/service/session-input.js";

export function registerSessions(program: Command, context: CliContext): void {
  const { t, output, request, waiting } = context;
  const sessions = program.command("sessions").description(t("cli.sessions"));
  const sessionFilters = (command: Command) => command.option("--client <client>", t("cli.clientChoices", { clients: clientIds.join(", ") }))
    .option("--project <path>", t("cli.project")).option("--from <time>", t("cli.from"))
    .option("--to <time>", t("cli.to")).option("--version <id>", t("cli.sessionVersion"))
    .option("--page <number>", t("cli.page")).option("--page-size <number>", t("cli.pageSize"))
    .option("--kinds <list>", t("cli.kinds"));
  const sessionQueryString = (command: Command, extra: Record<string, string | undefined> = {}) => {
    const opts = command.optsWithGlobals<Options>();
    const params = new URLSearchParams(queryParameters(command, []).slice(1));
    for (const key of ["client", "project", "from", "to", "version", "page", "kinds", "q", "mode", "messageId", "sessionId", "executionMode", "branch", "sort", "pageUnit", "turnPosition", "toolName", "resourceName", "resourceServer", "resourceKind", "messageLimit", "maxTextChars", "messageOffset", "summary", "stepLimit", "stepOffset", "priceVersion", "section", "textOffset"]) {
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
    .option("--mode <mode>", t("cli.semanticSearchMode"))
    .option("--sort <sort>", t("cli.semanticSearchSort"))
    .option("--include-subagents", t("cli.includeSubagents"))
    .option("--execution-mode <mode>", t("cli.searchExecutionMode"))
    .action(async (q: string, _options: Options, command: Command) => { await request(command, `/sessions/search${sessionQueryString(command,
      { q, includeSubagents: command.optsWithGlobals<Options>().includeSubagents ? "true" : undefined })}`); });
  sessionFilters(sessions.command("messages <id>").description(t("cli.messages")))
    .option("--branch <id>", t("cli.branch"))
    .option("--mode <mode>", t("cli.mode")).option("--message-id <id>", t("cli.messageId"))
    .action(async (id: string, _options: Options, command: Command) => { await request(command, `/sessions/${encodeURIComponent(id)}/messages${sessionQueryString(command)}`); });
  sessionFilters(sessions.command("profile <id>").description(t("cli.profile")))
    .option("--include-children", t("cli.includeChildren"))
    .option("--section <section>", t("cli.profileSection"))
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

  for (const command of sessions.commands) if (!["refresh", "cacheclear"].includes(command.name())) {
    if (!command.options.some(option => option.long === "--query")) command.option("--query <json>", t("cli.ext.query"));
  }
  for (const name of ["messages", "profile"]) {
    const command = sessions.commands.find(item => item.name() === name)!;
    const fields = name === "messages" ? ["pageUnit", "turnPosition", "toolName", "resourceName", "resourceServer", "resourceKind", "messageLimit", "maxTextChars", "messageOffset", "textOffset"] : ["summary", "stepLimit", "stepOffset"];
    for (const key of fields) command.option(`--${key.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`)} <value>`, t("cli.ext.option", { name: key }));
  }
  for (const name of ["facets", "gaps"]) {
    const keys = name === "gaps" ? ["version", "page", "pageSize", "client", "kind"] : ["version"];
    queryOptions(sessions.command(name).description(t(`cli.ext.${name}`)), context, keys)
      .action(async (_opts, command: Command) => { await request(command, `/sessions/${name}${queryParameters(command, keys)}`); });
  }
  const fields = ["client", "project", "from", "to", "version", "page", "pageSize", "kinds", "q", "mode", "executionMode", "includeSubagents", "branch", "pageUnit", "turnPosition", "messageId"];
  queryOptions(sessions.command("groups <text>").description(t("cli.ext.sessionGroups")), context, fields)
    .action(async (q: string, _opts, command: Command) => { await request(command, `/sessions/search/groups${queryParameters(command, fields, { q })}`); });
  for (const name of ["turns", "matches", "timeline", "cost"]) {
    const extra = name === "timeline" ? ["maxEvents"] : name === "cost" ? ["priceVersion", "includeChildren"] : [];
    queryOptions(sessions.command(`${name} <id>`).description(t(`cli.ext.session.${name}`)), context, [...fields, ...extra])
      .action(async (id: string, _opts, command: Command) => { await request(command, `/sessions/${encodeURIComponent(id)}/${name}${queryParameters(command, [...fields, ...extra])}`); });
  }
  const locateFields = ["client", "clientSessionId", "sourceId", "recordLine", "callId"];
  queryOptions(sessions.command("locate").description(t("cli.ext.locate")), context, locateFields)
    .action(async (_opts, command: Command) => { await request(command, `/sessions/locate${queryParameters(command, locateFields)}`); });
  waiting(sessions.command("auto-refresh").description(t("cli.ext.autoRefresh")))
    .action(async (_opts, command: Command) => { await request(command, "/sessions/auto-refresh", "POST", {}); });
  queryOptions(sessions.command("export <id>").description(t("cli.ext.sessionExport")), context, ["version", "branch"])
    .option("--output <file>", t("cli.ext.output"))
    .action(async (id: string, _opts, command: Command) => {
      const opts = command.optsWithGlobals<Options>();
      const extra = { mode: "brief", pageUnit: "message", pageSize: 200 };
      const first = await context.fetch(command, `/sessions/${encodeURIComponent(id)}/messages${queryParameters(command, ["version", "branch"], { ...extra, page: 1 })}`, "GET", undefined, undefined, true) as SessionMessageResult;
      const messages = await collectDialogue(async page => page === 1 ? first : await context.fetch(command, `/sessions/${encodeURIComponent(id)}/messages${queryParameters(command, ["branch"], { ...extra, version: first.version, page })}`, "GET", undefined, undefined, true) as SessionMessageResult, first.version);
      const markdown = dialogueMarkdown(messages, context.language);
      if (typeof opts.output === "string") {
        await writeFile(opts.output, markdown + "\n", "utf8");
        output(command, { path: resolve(opts.output), sessionId: id, version: first.version, messages: messages.length });
      } else if (opts.json) output(command, { sessionId: id, version: first.version, markdown });
      else process.stdout.write(markdown + "\n");
    });
}
