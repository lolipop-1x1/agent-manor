import { readFile } from "node:fs/promises";
import { RequestError } from "../../../../src/service/runtime.js";
import type { Command } from "commander";
import type { CliContext, Options } from "../context.js";

const maximumBytes = 2_097_152;
export async function readJsonInput(command: Command, required = true): Promise<Record<string, unknown>> {
  const opts = command.optsWithGlobals<Options>();
  if (opts.input !== undefined && opts.data !== undefined) throw new RequestError("INVALID_INPUT", "Use either --input or --data", { key: "cli.ext.inputConflict" });
  if (opts.input === undefined && opts.data === undefined) {
    if (!required) return {};
    throw new RequestError("INVALID_INPUT", "Provide --input <file|-> or --data <json>", { key: "cli.ext.inputRequired" });
  }
  let text: string;
  if (typeof opts.data === "string") text = opts.data;
  else if (opts.input === "-") {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length;
      if (size > maximumBytes) throw new RequestError("INVALID_INPUT", "JSON input exceeds 2 MiB", { key: "cli.ext.inputTooLarge" });
      chunks.push(buffer);
    }
    text = Buffer.concat(chunks).toString("utf8");
  } else {
    try { text = await readFile(String(opts.input), "utf8"); }
    catch (error) { throw new RequestError("INPUT_UNREADABLE", error instanceof Error ? error.message : String(error), { key: "cli.ext.inputUnreadable" }); }
  }
  if (Buffer.byteLength(text) > maximumBytes) throw new RequestError("INVALID_INPUT", "JSON input exceeds 2 MiB", { key: "cli.ext.inputTooLarge" });
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object");
    return value as Record<string, unknown>;
  } catch { throw new RequestError("INVALID_INPUT", "Input must be a JSON object", { key: "cli.ext.inputInvalid" }); }
}
export function jsonInput(command: Command, context: CliContext): Command {
  return command.option("--input <file>", context.t("cli.ext.input")).option("--data <json>", context.t("cli.ext.data"));
}
export function queryOptions(command: Command, context: CliContext, keys: readonly string[]): Command {
  command.option("--query <json>", context.t("cli.ext.query"));
  for (const key of keys) {
    const flag = key.replace(/[A-Z]/g, character => `-${character.toLowerCase()}`);
    command.option(`--${flag} <value>`, context.t("cli.ext.option", { name: key }));
  }
  return command;
}
export function queryParameters(command: Command, keys: readonly string[], extra: Record<string, unknown> = {}): string {
  const opts = command.optsWithGlobals<Options>();
  let value: Record<string, unknown> = {};
  if (typeof opts.query === "string") {
    try { value = JSON.parse(opts.query) as Record<string, unknown>; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object"); }
    catch { throw new RequestError("INVALID_INPUT", "query must be a JSON object", { key: "cli.ext.inputInvalid" }); }
  }
  for (const key of keys) if (opts[key] !== undefined) value[key] = opts[key];
  Object.assign(value, extra);
  const params = new URLSearchParams();
  for (const [key, item] of Object.entries(value)) if (item !== undefined) params.set(key, typeof item === "string" ? item : JSON.stringify(item));
  return params.size ? `?${params}` : "";
}
