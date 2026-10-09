import { CLIENTS, type Client } from "../src/clients";
export interface SessionFilters {
  client: Client | "all"; project: string; from: string; to: string; q: string; process: boolean; subagents: boolean; execution: "regular" | "quiet" | "all";
}
export function readSessionFilters(hash: string): SessionFilters {
  const params = new URLSearchParams(hash.startsWith("#sessions") ? hash.split("?")[1] : "");
  const client = params.get("client");
  const execution = params.get("execution");
  const date = (key: string) => {
    const value = params.get(key) ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
    const parsed = new Date(`${value}T00:00:00`);
    return !Number.isNaN(parsed.getTime()) && parsed.getDate() === Number(value.slice(-2)) && parsed.getMonth() + 1 === Number(value.slice(5, 7)) ? value : "";
  };
  return { client: CLIENTS.some(item => item.id === client) ? client as Client : "all", project: params.get("project") || "all",
    from: date("from"), to: date("to"), q: params.get("q") ?? "", process: params.get("process") === "true", subagents: params.get("subagents") === "true",
    execution: execution === "quiet" || execution === "all" ? execution : "regular" };
}
export function writeSessionFilters(params: URLSearchParams, filters: SessionFilters): void {
  for (const [key, value] of Object.entries(filters)) {
    if (value === false || value === "" || key === "client" && value === "all" || key === "project" && value === "all" || key === "execution" && value === "regular") params.delete(key);
    else params.set(key, String(value));
  }
}
