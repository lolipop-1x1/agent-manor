import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { jsonInput, readJsonInput } from "../api/input.js";
export function registerPreferences(program: Command, context: CliContext): void {
  const group = program.command("preferences").description(context.t("cli.ext.preferences"));
  group.command("get").description(context.t("cli.ext.preferences.get")).action(async (_opts, command: Command) => { await context.request(command, "/preferences"); });
  jsonInput(group.command("set").description(context.t("cli.ext.preferences.set")), context)
    .action(async (_opts, command: Command) => { await context.request(command, "/preferences", "PUT", await readJsonInput(command)); });
}
