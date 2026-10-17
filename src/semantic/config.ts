import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MessageDescriptor } from "../i18n/types.js";
import { semanticErrorDescriptor } from "./messages.js";
import { clientIds } from "../clients.js";
import type { SemanticConfig, SemanticSettings, SemanticSettingsInput } from "../semantic-contracts.js";

export class SemanticError extends Error {
  get messageDescriptor() { return this.descriptor ?? semanticErrorDescriptor(this.code); }
  constructor(public readonly code: string, message: string, public readonly status?: number, public readonly retryAfterMs?: number, private readonly descriptor?: MessageDescriptor) {
    super(message); this.name = "SemanticError";
  }
}

export function defaultSemanticConfig(): SemanticConfig {
  return {
    enabled: false,
    connection: { url: "", model: "", documentPrefix: "", queryPrefix: "" },
    scope: { timeRange: "unset", recentDays: 30, clients: [], projects: [], relationship: "exclude_children", executionMode: "exclude_quiet", models: [], title: "", branch: "all" },
    strategy: { concurrency: 1, batchSize: 8, batchTokens: 8192, requestsPerMinute: 0, tokensPerMinute: 0, timeoutMs: 60_000, retries: 2, chunkChars: 1200, overlapChars: 120, quietMinutes: 5, maxDelayMinutes: 30, cleanOutsideWindow: false },
  };
}

function invalid(field: string): never { throw new SemanticError("semantic_config_invalid", `语义搜索设置无效：${field}`, 400); }
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(field);
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string, max = 8192): string {
  if (typeof value !== "string" || value.length > max) return invalid(field);
  return value;
}
function number(value: unknown, field: string, min: number, max: number, integer = true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) return invalid(field);
  return value;
}
function optionalNumber(value: unknown, field: string, min: number, max: number, integer = true): number | undefined {
  return value === undefined || value === null || value === "" ? undefined : number(value, field, min, max, integer);
}
function bool(value: unknown, field: string): boolean { if (typeof value !== "boolean") return invalid(field); return value; }
function enumeration<T extends string>(value: unknown, options: readonly T[], field: string): T {
  if (typeof value !== "string" || !options.includes(value as T)) return invalid(field);
  return value as T;
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 10_000) return invalid(field);
  return [...new Set(value.map(item => string(item, field, 32_768)))];
}
function date(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = string(value, field, 64);
  if (!Number.isFinite(Date.parse(text))) return invalid(field);
  return text;
}

export function normalizeEmbeddingUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return invalid("connection.url"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return invalid("connection.url");
  let path = url.pathname.replace(/\/+$/, "");
  if (!path) path = "/v1";
  if (!path.endsWith("/embeddings")) path += "/embeddings";
  url.pathname = path;
  return url.toString();
}

export function validateSemanticConfig(value: unknown): SemanticConfig {
  const input = record(value, "config"), defaults = defaultSemanticConfig();
  const connection = record(input.connection, "connection"), scope = record(input.scope, "scope"), strategy = record(input.strategy, "strategy");
  const url = string(connection.url, "connection.url", 4096).trim();
  if (url) normalizeEmbeddingUrl(url);
  const config: SemanticConfig = {
    enabled: bool(input.enabled, "enabled"),
    connection: { url, model: string(connection.model, "connection.model", 1024).trim(), dimensions: optionalNumber(connection.dimensions, "connection.dimensions", 1, 65_536), documentPrefix: string(connection.documentPrefix ?? "", "connection.documentPrefix"), queryPrefix: string(connection.queryPrefix ?? "", "connection.queryPrefix") },
    scope: {
      timeRange: enumeration(scope.timeRange, ["unset", "all", "recent"], "scope.timeRange"),
      recentDays: number(scope.recentDays, "scope.recentDays", 1, 36_500),
      clients: strings(scope.clients, "scope.clients").map(client => enumeration(client, clientIds, "scope.clients")),
      projects: strings(scope.projects, "scope.projects"),
      relationship: enumeration(scope.relationship, ["all", "exclude_children", "children", "forks", "unknown"], "scope.relationship"),
      executionMode: enumeration(scope.executionMode, ["all", "exclude_quiet", "quiet", "unknown"], "scope.executionMode"),
      models: strings(scope.models, "scope.models"), title: string(scope.title, "scope.title", 4096),
      branch: enumeration(scope.branch, ["all", "current"], "scope.branch"),
      minMessages: optionalNumber(scope.minMessages, "scope.minMessages", 0, 1_000_000_000), maxMessages: optionalNumber(scope.maxMessages, "scope.maxMessages", 0, 1_000_000_000),
      minTurns: optionalNumber(scope.minTurns, "scope.minTurns", 0, 1_000_000_000), maxTurns: optionalNumber(scope.maxTurns, "scope.maxTurns", 0, 1_000_000_000),
      from: date(scope.from, "scope.from"), to: date(scope.to, "scope.to"),
    },
    strategy: {
      concurrency: number(strategy.concurrency, "strategy.concurrency", 1, 8), batchSize: number(strategy.batchSize, "strategy.batchSize", 1, 128),
      batchTokens: number(strategy.batchTokens, "strategy.batchTokens", 1, 1_000_000), requestsPerMinute: number(strategy.requestsPerMinute, "strategy.requestsPerMinute", 0, 1_000_000),
      tokensPerMinute: number(strategy.tokensPerMinute, "strategy.tokensPerMinute", 0, 1_000_000_000), timeoutMs: number(strategy.timeoutMs, "strategy.timeoutMs", 100, 600_000),
      retries: number(strategy.retries, "strategy.retries", 0, 5), chunkChars: number(strategy.chunkChars, "strategy.chunkChars", 128, 32_000),
      overlapChars: number(strategy.overlapChars, "strategy.overlapChars", 0, 31_999), quietMinutes: number(strategy.quietMinutes, "strategy.quietMinutes", 0, 1440),
      maxDelayMinutes: number(strategy.maxDelayMinutes, "strategy.maxDelayMinutes", 0, 10_080),
      pricePerMillion: optionalNumber(strategy.pricePerMillion, "strategy.pricePerMillion", 0, 1_000_000, false), dailyBudget: optionalNumber(strategy.dailyBudget, "strategy.dailyBudget", 0, 1_000_000_000, false),
      cleanOutsideWindow: bool(strategy.cleanOutsideWindow ?? defaults.strategy.cleanOutsideWindow, "strategy.cleanOutsideWindow"),
    },
  };
  if (config.enabled && (!config.connection.url || !config.connection.model)) return invalid("connection");
  if (config.strategy.overlapChars >= config.strategy.chunkChars) return invalid("strategy.overlapChars");
  if (config.strategy.maxDelayMinutes < config.strategy.quietMinutes) return invalid("strategy.maxDelayMinutes");
  for (const [min, max] of [[config.scope.minMessages, config.scope.maxMessages], [config.scope.minTurns, config.scope.maxTurns]]) if (min !== undefined && max !== undefined && min > max) return invalid("scope.range");
  if (config.scope.from && config.scope.to && Date.parse(config.scope.from) > Date.parse(config.scope.to)) return invalid("scope.dates");
  if (config.strategy.dailyBudget !== undefined && config.strategy.pricePerMillion === undefined) return invalid("strategy.pricePerMillion");
  return config;
}

export function encodingFingerprint(config: SemanticConfig): string {
  const connection = config.connection;
  return createHash("sha256").update(JSON.stringify({ recipe: 1, url: connection.url ? normalizeEmbeddingUrl(connection.url) : "", model: connection.model, dimensions: connection.dimensions ?? null, documentPrefix: connection.documentPrefix, queryPrefix: connection.queryPrefix, chunkChars: config.strategy.chunkChars, overlapChars: config.strategy.overlapChars })).digest("hex");
}

export async function writeSemanticJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 }); await rename(temporary, path); await chmod(path, 0o600); }
  finally { await rm(temporary, { force: true }); }
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

export class SemanticConfigStore {
  private readonly directory: string;
  private writes: Promise<void> = Promise.resolve();
  constructor(home: string) { this.directory = join(home, "semantic"); }
  private async ensure(): Promise<void> { await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700); }
  private async readConfig(): Promise<SemanticConfig> {
    try { return validateSemanticConfig(JSON.parse(await readFile(join(this.directory, "config.json"), "utf8"))); }
    catch (error) { if (missing(error)) return defaultSemanticConfig(); throw new SemanticError("semantic_config_unreadable", "无法读取语义搜索设置", 500); }
  }
  private async readKey(): Promise<string | undefined> {
    try { const stored: unknown = JSON.parse(await readFile(join(this.directory, "credentials.json"), "utf8")); const key = record(stored, "credentials").apiKey; if (typeof key !== "string") throw new Error(); return key; }
    catch (error) { if (missing(error)) return undefined; throw new SemanticError("semantic_key_unreadable", "无法读取模型凭据", 500); }
  }
  async read(): Promise<SemanticSettings> { await this.writes; const [config, key] = await Promise.all([this.readConfig(), this.readKey()]); return { config, hasKey: key !== undefined, fingerprint: encodingFingerprint(config) }; }
  async key(): Promise<string | undefined> { await this.writes; return this.readKey(); }
  async save(input: SemanticSettingsInput): Promise<SemanticSettings> {
    const config = validateSemanticConfig(input.config);
    if (input.apiKey !== undefined && input.apiKey !== null && (typeof input.apiKey !== "string" || input.apiKey.length > 16_384 || /[\r\n]/.test(input.apiKey))) return invalid("apiKey");
    const operation = this.writes.then(async () => {
      await this.ensure();
      if (input.apiKey === null || input.apiKey === "") await rm(join(this.directory, "credentials.json"), { force: true });
      else if (input.apiKey !== undefined) await writeSemanticJson(join(this.directory, "credentials.json"), { apiKey: input.apiKey });
      await writeSemanticJson(join(this.directory, "config.json"), config);
    });
    this.writes = operation.catch(() => undefined);
    await operation;
    return this.read();
  }
}
