import { RequestError } from "../../../../src/service/runtime.js";
import type { Options } from "../context.js";

export function queryString(options: Options, extra: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  if (typeof options.query === "string") {
    try {
      const values: unknown = JSON.parse(options.query);
      if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("object");
      for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, typeof value === "string" ? value : JSON.stringify(value));
    } catch { throw new RequestError("INVALID_INPUT", "query must be a JSON object", { key: "cli.ext.inputInvalid" }); }
  }
  for (const key of ["version", "client", "from", "to", "categories", "directory", "sessionClient", "clientSessionId"]) {
    if (typeof options[key] === "string") params.set(key, options[key] as string);
  }
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) params.set(key, value);
  return params.size ? `?${params}` : "";
}
