import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { jsonInput, readJsonInput, queryOptions, queryParameters } from "../api/input.js";
const keys = ["version", "priceVersion", "timezone", "from", "to", "clients", "excludeClients", "projects", "excludeProjects", "models", "excludeModels", "speedGroups", "relationship", "sessionType", "coverage", "pricing", "metric", "groupBy", "interval", "sort", "direction", "includeSpeed", "speedGroup", "page", "pageSize", "minTokens", "maxTokens", "minCost", "maxCost"];
export function registerUsage(program: Command, context: CliContext): void {
  const group = program.command("usage").description(context.t("cli.ext.usage"));
  for (const [name, suffix] of [["report", ""], ["status", "/status"], ["requests", "/requests"]]) {
    const fields = name === "requests" ? [...keys, "sessionId", "requestPage", "requestPageSize"] : keys;
    queryOptions(group.command(name!).description(context.t(`cli.ext.usage.${name}`)), context, fields)
      .action(async (_options, command: Command) => { await context.request(command, `/usage${suffix}${queryParameters(command, fields)}`); });
  }
  const pricing = group.command("pricing").description(context.t("cli.ext.pricing"));
  pricing.command("get").description(context.t("cli.ext.pricing.get")).action(async (_opts, command: Command) => { await context.request(command, "/usage/pricing"); });
  queryOptions(pricing.command("list").description(context.t("cli.ext.pricing.list")), context, ["page", "pageSize", "model", "version"])
    .action(async (_opts, command: Command) => { await context.request(command, `/usage/pricing/prices${queryParameters(command, ["page", "pageSize", "model", "version"])}`); });
  pricing.command("refresh").description(context.t("cli.ext.pricing.refresh")).action(async (_opts, command: Command) => { await context.request(command, "/usage/pricing/refresh", "POST", {}); });
  jsonInput(pricing.command("set").description(context.t("cli.ext.pricing.set")), context)
    .action(async (_opts, command: Command) => { await context.request(command, "/usage/pricing", "PUT", await readJsonInput(command)); });
}
