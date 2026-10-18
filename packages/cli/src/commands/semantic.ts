import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { jsonInput, readJsonInput } from "../api/input.js";
import { managementOptions, managementRequest } from "../api/management.js";
export function registerSemantic(program: Command, context: CliContext): void {
  const group = program.command("semantic").description(context.t("cli.ext.semantic"));
  for (const name of ["facets", "status"]) group.command(name).description(context.t(`cli.ext.${name}`))
    .action(async (_opts, command: Command) => { await context.request(command, `/semantic/${name}`); });
  const settings = group.command("settings").description(context.t("cli.ext.settings"));
  settings.command("get").description(context.t("cli.ext.settings.get")).action(async (_opts, command: Command) => { await context.request(command, "/semantic/settings"); });
  jsonInput(settings.command("set").description(context.t("cli.ext.settings.set")), context)
    .action(async (_opts, command: Command) => { await context.request(command, "/semantic/settings", "PUT", await readJsonInput(command)); });
  managementOptions(settings.command("key").description(context.t("cli.ext.settings.key")), context)
    .action(async (_opts, command: Command) => { await managementRequest(command, context, "/semantic/key", "GET"); });
  for (const name of ["test", "preview", "search"]) jsonInput(group.command(name).description(context.t(`cli.ext.semantic.${name}`)), context)
    .action(async (_opts, command: Command) => { await context.request(command, `/semantic/${name}`, "POST", await readJsonInput(command, name !== "test")); });
  context.waiting(group.command("build <previewId>").description(context.t("cli.ext.index.build")))
    .action(async (previewId: string, _opts, command: Command) => { await context.request(command, "/semantic/build", "POST", { previewId }, true, "/semantic/status"); });
  for (const action of ["pause", "resume"]) context.waiting(group.command(action).description(context.t(`cli.ext.${action}`)))
    .action(async (_opts, command: Command) => { await context.request(command, "/semantic/action", "POST", { action }, true, "/semantic/status"); });
}
