import type { Command } from "commander";
import { translate, type Language, type MessageParams } from "../../../src/i18n/index.js";
import { clientIds } from "../../../src/clients.js";
import { apiRequest, connectService, dataHome, RequestError } from "../../../src/service/runtime.js";
import { humanOutput } from "./output/format.js";
import { timeoutMilliseconds, waitForTask } from "./api/tasks.js";

export type Options = Record<string, string | boolean | undefined>;
export interface CliContext {
  language: Language;
  t(key: string, params?: MessageParams): string;
  output(command: Command, value: unknown): void;
  fetch(command: Command, path: string, method?: string, body?: unknown, headers?: Record<string, string>): Promise<unknown>;
  request(command: Command, path: string, method?: string, body?: unknown, autoStart?: boolean, waitPath?: string): Promise<unknown>;
  filters(command: Command): Command;
  waiting(command: Command): Command;
}
export function createContext(language: Language): CliContext {
  const t = (key: string, params?: MessageParams) => translate(language, key, params);
  const output = (command: Command, value: unknown) => {
    process.stdout.write(`${command.optsWithGlobals<Options>().json ? JSON.stringify(value) : humanOutput(value, language)}\n`);
  };
  const fetchValue = async (command: Command, path: string, method = "GET", body?: unknown, headers?: Record<string, string>): Promise<unknown> => {
    const opts = command.optsWithGlobals<Options>();
    if (opts.wait) timeoutMilliseconds(opts.timeout);
    const instance = await connectService(true, dataHome(typeof opts.home === "string" ? opts.home : undefined));
    if (!instance) throw new RequestError("SERVICE_UNAVAILABLE", "Service did not start");
    return apiRequest(instance, path, method, body, headers);
  };
  return { language, t, output, fetch: fetchValue,
    async request(command, path, method = "GET", body, autoStart = true, waitPath) {
      const opts = command.optsWithGlobals<Options>();
      if (opts.wait) timeoutMilliseconds(opts.timeout);
      const instance = await connectService(autoStart, dataHome(typeof opts.home === "string" ? opts.home : undefined));
      if (!instance) { const result = { running: false }; output(command, result); return result; }
      let result = await apiRequest<unknown>(instance, path, method, body);
      if (opts.wait) result = await waitForTask(instance, result, opts.timeout, waitPath);
      output(command, result);
      return result;
    },
    filters: command => command.option("--query <json>", t("cli.ext.query"))
      .option("--session-client <client>", t("cli.ext.option", { name: "sessionClient" })).option("--client-session-id <id>", t("cli.ext.option", { name: "clientSessionId" }))
      .option("--version <id>", t("cli.versionOption"))
      .option("--client <client>", t("cli.clientChoices", { clients: clientIds.join(", ") })).option("--from <time>", t("cli.from"))
      .option("--to <time>", t("cli.to")).option("--categories <list>", t("cli.categories")).option("--directory <path>", t("cli.directory")),
    waiting: command => command.option("--wait", t("cli.wait")).option("--timeout <seconds>", t("cli.timeout")),
  };
}
