import type { Command } from "commander";
import type { CliContext, Options } from "../context.js";
import { RequestError } from "../../../../src/service/runtime.js";
import { resolve } from "node:path";
import { queryOptions, queryParameters } from "../api/input.js";
import { queryString } from "../api/query.js";
const repositoryPath = (id: string) => `/repositories/${encodeURIComponent(id)}`;

export function registerRepositories(program: Command, context: CliContext): void {
  const { t, request, filters, waiting } = context;
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

  const group = program.commands.find(command => command.name() === "repositories")!;
  group.command("list").description(t("cli.repositories")).action(async (_opts, command: Command) => { await request(command, "/repositories"); });
  waiting(group.command("register <path>").description(t("cli.register")))
    .action(async (path: string, _opts, command: Command) => { await request(command, "/repositories", "POST", { path: resolve(path) }); });
  group.command("remove <id>").description(t("cli.ext.repositoryRemove"))
    .action(async (id: string, _opts, command: Command) => { await request(command, repositoryPath(id), "DELETE"); });
  for (const name of ["sessions", "gaps", "replay-sessions", "replay", "replay-evidence"]) {
    const keys = ["version", "client", "from", "to", "categories", "directory", "sessionVersion", "sessionId", "eventId"];
    queryOptions(group.command(`${name} <id>`).description(t(`cli.ext.repository.${name}`)), context, keys)
      .action(async (id: string, _opts, command: Command) => {
        const opts = command.optsWithGlobals<Options>();
        if (name === "replay-evidence" && !opts.eventId) throw new RequestError("INVALID_INPUT", "Provide --event-id", { key: "cli.ext.eventRequired" });
        const suffix = name === "gaps" ? "coverage/gaps" : name === "replay-sessions" ? "replay/sessions" : name === "replay-evidence" ? `replay/evidence/${encodeURIComponent(String(opts.eventId ?? ""))}` : name;
        await request(command, `${repositoryPath(id)}/${suffix}${queryParameters(command, keys.filter(key => key !== "eventId"))}`);
      });
  }
  waiting(group.command("auto-refresh <id>").description(t("cli.ext.autoRefresh")))
    .action(async (id: string, _opts, command: Command) => { await request(command, `${repositoryPath(id)}/auto-refresh`, "POST", {}); });
}
