import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { queryOptions, queryParameters } from "../api/input.js";
const keys = ["version", "priceVersion", "timezone", "from", "to", "clients", "projects", "models", "window", "anchorDay"];
export function registerOverview(program: Command, context: CliContext): void {
  const group = program.command("overview").description(context.t("cli.ext.overview"));
  for (const name of ["snapshot", "panel", "review", "review-detail", "detail", "report", "evidence"]) {
    const queryKeys = [...keys, ...(name === "panel" ? ["panel", "dimension"] : name === "evidence" ? ["evidence"] : ["detail", "review-detail"].includes(name) ? ["detail"] : [])];
    queryOptions(group.command(name).description(context.t(`cli.ext.overview.${name}`)), context, queryKeys)
      .action(async (_options, command: Command) => { await context.request(command, `/overview/${name.replace("-", "/")}${queryParameters(command, queryKeys)}`); });
  }
}
