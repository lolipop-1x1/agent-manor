import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { RequestError } from "../../../../src/service/runtime.js";
import type { CliContext, Options } from "../context.js";
import { manageSkill, skillTargetPath } from "../skills/manager.js";
export function registerSkills(program: Command, context: CliContext): void {
  const group = program.command("skills").description(context.t("cli.ext.skills"));
  for (const action of ["install", "status", "update", "remove"] as const) group.command(action).description(context.t(`cli.ext.skills.${action}`))
    .option("--target <client>", context.t("cli.ext.skillTarget")).option("--scope <scope>", context.t("cli.ext.skillScope"))
    .option("--directory <path>", context.t("cli.ext.skillDirectory")).option("--project-directory <path>", context.t("cli.ext.skillProject"))
    .option("--overwrite", context.t("cli.ext.overwrite"))
    .action(async (_opts, command: Command) => {
      const opts = command.optsWithGlobals<Options>(); let target = opts.target, scope = opts.scope, directory = opts.directory;
      if (!target && opts.directory) target = "custom";
      if (!target && opts.json !== true && process.stdin.isTTY && process.stderr.isTTY) {
        const prompt = createInterface({ input: process.stdin, output: process.stderr });
        try {
          target = (await prompt.question(`${context.t("cli.ext.skillChoose")}\n> `)).trim();
          scope ??= (await prompt.question(`${context.t("cli.ext.skillChooseScope")}\n> `)).trim() || "user";
          if (target === "custom") directory ??= (await prompt.question(`${context.t("cli.ext.skillDirectory")}\n> `)).trim();
        }
        finally { prompt.close(); }
      }
      if (!["codex", "claude", "custom"].includes(String(target))) throw new RequestError("INVALID_INPUT", "Select --target codex|claude|custom", { key: "cli.ext.skillChoose" });
      const options = { target: target as "codex" | "claude" | "custom", scope: (scope ?? "user") as "user" | "project", directory: directory as string | undefined,
        projectDirectory: opts.projectDirectory as string | undefined, overwrite: opts.overwrite === true };
      if (!opts.json) process.stderr.write(`${skillTargetPath(options)}\n`);
      const result = await manageSkill(action, options);
      context.output(command, result);
    });
}
