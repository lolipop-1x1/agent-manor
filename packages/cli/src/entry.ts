import { CommanderError } from "commander";
import { RequestError } from "../../../src/service/runtime.js";
import { detectLanguage, isMessageDescriptorKnown, translate, translateMessage } from "../../../src/i18n/index.js";
import type { Language, MessageDescriptor } from "../../../src/i18n/index.js";
import { VERSION } from "../../../src/version.js";
import type { Options } from "./context.js";
import { resolveCliLanguage } from "./output/language.js";
import { createProgram } from "./program.js";

export function startupOptions(args: readonly string[]): Options {
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
    code: error instanceof RequestError || error instanceof CommanderError || known?.code?.startsWith("SKILL_") ? known!.code : "SERVICE_UNAVAILABLE",
    message: error instanceof Error ? error.message : "命令执行失败",
    ...(messageDescriptor ? { messageDescriptor } : {}),
    ...((error as { details?: unknown })?.details ? { details: (error as { details?: unknown }).details } : {}),
  } };
  if (json) return JSON.stringify(failure);
  return [isMessageDescriptorKnown(messageDescriptor) ? translateMessage(language, messageDescriptor) : translate(language, "cli.error.commandFailed"),
    `${translate(language, "common.originalDetails")}: ${failure.error.message}`,
    ...(failure.error.details ? [JSON.stringify(failure.error.details, null, 2)] : [])].join("\n");
}

function versionOnly(args: readonly string[]): boolean {
  let found = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (["--version", "--cli-version", "-V"].includes(value)) { found = true; continue; }
    if (value === "--json" || value.startsWith("--home=") || value.startsWith("--lang=")) continue;
    if ((value === "--home" || value === "--lang") && args[index + 1] !== undefined) { index++; continue; }
    return false;
  }
  return found;
}

export async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = startupOptions(args);
  let language = detectLanguage([[process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG].find(value => value?.trim())]);
  try {
    // 先读同一数据目录的偏好，再生成帮助；整次命令不重新解析语言。
    language = await resolveCliLanguage(options);
    const program = createProgram(language);
    if (versionOnly(args)) process.stdout.write(`${options.json ? JSON.stringify({ version: VERSION }) : VERSION}\n`);
    else await program.parseAsync([...args], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    process.stderr.write(`${cliErrorOutput(error, language, options.json === true)}\n`);
    process.exitCode = 1;
  }
}
