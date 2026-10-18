import type { Command } from "commander";
import type { CliContext, Options } from "../context.js";
import { RequestError } from "../../../../src/service/runtime.js";
import { queryOptions, queryParameters } from "../api/input.js";
import { resolve } from "node:path";
import { clientIds } from "../../../../src/clients.js";

export function registerResources(program: Command, context: CliContext): void {
  const { t, request } = context;
  const resources = program.command("resources").description(t("cli.resources"));
  const resourceFilters = (command: Command) => command.option("--kind <kind>", t("cli.kind"))
    .option("--client <client>", t("cli.clientChoices", { clients: clientIds.join(", ") })).option("--project <path>", t("cli.project"))
    .option("--q <text>", t("cli.resourceKeywords")).option("--from <time>", t("cli.from"))
    .option("--to <time>", t("cli.to")).option("--sort <sort>", t("cli.sort"))
    .option("--order <order>", t("cli.order"))
    .option("--page <number>", t("cli.page")).option("--page-size <number>", t("cli.pageSize")).option("--version <id>", t("cli.resourceVersion"));
  const resourceQueryString = (command: Command) => {
    const opts = command.optsWithGlobals<Options>();
    const params = new URLSearchParams(queryParameters(command, []).slice(1));
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

  queryOptions(resources.command("map").description(t("cli.ext.resourceMap")), context, ["kind", "client", "project", "q", "from", "to", "version", "favorite", "dimension", "parent"])
    .action(async (_opts, command: Command) => { await request(command, `/resources/map${queryParameters(command, ["kind", "client", "project", "q", "from", "to", "version", "favorite", "dimension", "parent"])}`); });
  for (const command of resources.commands) if (!command.options.some(option => option.long === "--query")) command.option("--query <json>", t("cli.ext.query"));
}
