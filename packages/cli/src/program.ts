import { Command } from "commander";
import { VERSION } from "../../../src/version.js";
import { createContext } from "./context.js";
import type { Language } from "../../../src/i18n/index.js";
import { registerSessions } from "./commands/sessions.js";
import { registerResources } from "./commands/resources.js";
import { registerRepositories } from "./commands/repositories.js";
import { registerOverview } from "./commands/overview.js";
import { registerUsage } from "./commands/usage.js";
import { registerKnowledge } from "./commands/knowledge.js";
import { registerSemantic } from "./commands/semantic.js";
import { registerPreferences } from "./commands/preferences.js";
import { registerLifecycle } from "./commands/lifecycle.js";
import { registerSkills } from "./commands/skills.js";
import type { Options } from "./context.js";

export function createProgram(language: Language = "en"): Command {
  const context = createContext(language), { t } = context;
  const program = new Command().name("agent-manor").description(t("cli.description"))
    .version(VERSION, "-V, --cli-version", t("cli.version")).option("--json", t("cli.json"))
    .option("--full", t("cli.full"))
    .option("--home <path>", t("cli.home")).option("--lang <language>", t("cli.lang"))
    .exitOverride().configureOutput({ outputError: () => {}, writeErr: text => {
      if (!program.opts<Options>().json) process.stderr.write(text);
    } })
    .helpOption("-h, --help", t("cli.help")).helpCommand("help [command]", t("cli.helpCommand"))
    .configureHelp({ showGlobalOptions: true, styleTitle: title => {
      const headings: Record<string, string> = { "Usage:": "cli.usage", "Arguments:": "cli.arguments", "Options:": "cli.options", "Global Options:": "cli.globalOptions", "Commands:": "cli.commands" };
      return headings[title] ? t(headings[title]) : title;
    } });
  for (const register of [registerSessions, registerResources, registerRepositories, registerOverview, registerUsage,
    registerKnowledge, registerSemantic, registerPreferences, registerLifecycle, registerSkills]) register(program, context);
  return program;
}
