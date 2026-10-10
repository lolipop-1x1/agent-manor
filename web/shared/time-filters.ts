import type { Filters } from "../../src/contracts";

export function timeFilters(window: string, from: string, to: string, now = Date.now()): Pick<Filters, "from" | "to"> {
  if (window === "custom") {
    return {
      from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
    };
  }
  return window === "all" ? {} : { from: new Date(now - Number(window) * 86_400_000).toISOString() };
}
