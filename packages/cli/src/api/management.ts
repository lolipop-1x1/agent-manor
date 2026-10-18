import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { RequestError } from "../../../../src/service/runtime.js";
import type { CliContext, Options } from "../context.js";

export function managementConfirmation(method: string, path: string, body?: unknown): string {
  return createHash("sha256").update(JSON.stringify({ method: method.toUpperCase(), path, body: body ?? null })).digest("hex");
}
export function managementOptions(command: Command, context: CliContext): Command {
  return command.option("--authorize <digest>", context.t("cli.ext.authorize"));
}
export async function managementRequest(command: Command, context: CliContext, path: string, method: string, body?: unknown, preview?: unknown): Promise<void> {
  const confirmation = managementConfirmation(method, path, body);
  const operation = { method, path, body: body ?? null, confirmation, ...(preview === undefined ? {} : { preview }) };
  const opts = command.optsWithGlobals<Options>();
  let authorization = opts.authorize;
  if (authorization === undefined && process.stdin.isTTY && process.stderr.isTTY) {
    process.stderr.write(`${JSON.stringify(operation, null, 2)}\n`);
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try { authorization = await prompt.question(`${context.t("cli.ext.confirmDigest")}\n> `); }
    finally { prompt.close(); }
  }
  if (authorization !== confirmation) {
    const error = new RequestError("CONFIRMATION_REQUIRED", "Explicit authorization of this exact operation is required", { key: "cli.ext.confirmationRequired" });
    Object.assign(error, { details: operation });
    throw error;
  }
  const grant = await context.fetch(command, "/management/authorizations", "POST", { method: method.toUpperCase(), path, body: body ?? null, confirmation }) as { token: string };
  const result = await context.fetch(command, path, method, body, { "x-agent-manor-management": grant.token });
  context.output(command, result);
}
