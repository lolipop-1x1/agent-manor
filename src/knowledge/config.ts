import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KnowledgeConfig, KnowledgeExtractionScope, KnowledgeLanguage, KnowledgeSettings, KnowledgeSettingsInput } from "../knowledge-contracts.js";
import { defaultSemanticConfig, validateSemanticConfig } from "../semantic/config.js";
import type { MessageDescriptor } from "../i18n/types.js";

export class KnowledgeModelError extends Error {
  readonly messageDescriptor: MessageDescriptor;
  constructor(public readonly code: string, message: string, public readonly status = 400, public readonly retryAfterMs?: number) {
    super(message); this.name = "KnowledgeModelError";
    this.messageDescriptor = { key: `knowledge.errors.${code}` };
  }
}

export const defaultExtractionPrompt = "Prioritize reusable methods, stable facts, explicit preferences and constraints, decisions, and evidence-backed lessons. Ignore routine progress, repeated conclusions, and transient execution logs. Methods include applicability and verification. Distinguish attempts, confirmed outcomes, assumptions, and unresolved questions. Return no_value when there is no durable information. /no_think";
export const defaultMergePrompt = "Merge only the same topic and compatible scope. Apply later explicit corrections and confirmed outcomes. Preserve relevant conditions, failures and exceptions; do not turn attempted actions into successful outcomes. Keep original quotations and source identifiers. Prefer a revision proposal for an existing item over a duplicate. Return no_value for an exact duplicate, or needs_context if the evidence cannot support a conclusion. /no_think";

export function defaultKnowledgeConfig(language: KnowledgeLanguage = "zh-CN"): KnowledgeConfig {
  const semantic = defaultSemanticConfig();
  return {
    generation: { url: "", model: "", contextTokens: 32_768, outputTokens: 2048, timeoutMs: 120_000, retries: 2, requestsPerMinute: 0 },
    outputLanguage: language, extractionPrompt: defaultExtractionPrompt, mergePrompt: defaultMergePrompt,
    automatic: { enabled: false, intervalMinutes: 60, quietMinutes: 30, scope: { ...semantic.scope, branch: "current" } },
    embedding: { mode: "off", connection: semantic.connection, timeoutMs: 60_000, retries: 2, requestsPerMinute: 0 },
  };
}
function invalid(field: string): never { throw new KnowledgeModelError("config_invalid", `知识设置无效：${field}`); }
function record(value: unknown, field: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(field); return value as Record<string, unknown>; }
function string(value: unknown, field: string, max = 16_384): string { if (typeof value !== "string" || value.length > max) return invalid(field); return value; }
function number(value: unknown, field: string, min: number, max: number, integer = true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) return invalid(field); return value;
}
function optionalNumber(value: unknown, field: string, max: number): number | undefined { return value === undefined || value === null ? undefined : number(value, field, 0, max, false); }

export function normalizeGenerationUrl(value: string): string {
  let url: URL; try { url = new URL(value.trim()); } catch { return invalid("generation.url"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return invalid("generation.url");
  let path = url.pathname.replace(/\/+$/, ""); if (!path) path = "/v1";
  if (!path.endsWith("/chat/completions")) path += "/chat/completions";
  url.pathname = path; return url.toString();
}

export function validateKnowledgeScope(value: unknown): KnowledgeExtractionScope {
  const source = record(value, "scope"), defaults = defaultSemanticConfig(), branch = source.branch ?? "current";
  if (typeof branch !== "string" || !branch || branch.length > 1024) return invalid("scope.branch");
  let scope;
  try { scope = validateSemanticConfig({ ...defaults, scope: { ...defaults.scope, ...source, branch: branch === "all" ? "all" : "current" } }).scope; }
  catch { return invalid("scope"); }
  const sessionIds = source.sessionIds === undefined ? undefined : source.sessionIds;
  if (sessionIds !== undefined && (!Array.isArray(sessionIds) || sessionIds.length > 10_000 || sessionIds.some(id => typeof id !== "string" || !id || id.length > 1024))) return invalid("scope.sessionIds");
  const turnStart = source.turnStart === undefined ? undefined : number(source.turnStart, "scope.turnStart", 0, 1_000_000_000);
  const turnEnd = source.turnEnd === undefined ? undefined : number(source.turnEnd, "scope.turnEnd", 0, 1_000_000_000);
  if (turnStart !== undefined && turnEnd !== undefined && turnStart > turnEnd) return invalid("scope.turnRange");
  if (source.force !== undefined && typeof source.force !== "boolean") return invalid("scope.force");
  return { ...scope, branch, sessionIds: sessionIds as string[] | undefined, turnStart, turnEnd, force: source.force as boolean | undefined };
}

export function validateKnowledgeConfig(value: unknown): KnowledgeConfig {
  const input = record(value, "config"), generation = record(input.generation, "generation"), automatic = record(input.automatic, "automatic"), embedding = record(input.embedding, "embedding");
  const url = string(generation.url, "generation.url", 4096).trim(); if (url) normalizeGenerationUrl(url);
  const outputLanguage = input.outputLanguage;
  if (outputLanguage !== "zh-CN" && outputLanguage !== "en") return invalid("outputLanguage");
  if (typeof automatic.enabled !== "boolean") return invalid("automatic.enabled");
  if (generation.reasoningEffort !== undefined && !["none", "low", "medium", "high"].includes(generation.reasoningEffort as string)) return invalid("generation.reasoningEffort");
  if (!["off", "reuse", "independent"].includes(embedding.mode as string)) return invalid("embedding.mode");
  const defaults = defaultSemanticConfig();
  let connection;
  try { connection = validateSemanticConfig({ ...defaults, connection: embedding.connection }).connection; } catch { return invalid("embedding.connection"); }
  const config: KnowledgeConfig = {
    generation: {
      url, model: string(generation.model, "generation.model", 1024).trim(), contextTokens: number(generation.contextTokens, "generation.contextTokens", 4096, 2_000_000),
      reasoningEffort: generation.reasoningEffort as KnowledgeConfig["generation"]["reasoningEffort"],
      outputTokens: number(generation.outputTokens, "generation.outputTokens", 128, 65_536), timeoutMs: number(generation.timeoutMs, "generation.timeoutMs", 100, 600_000),
      retries: number(generation.retries, "generation.retries", 0, 5), requestsPerMinute: number(generation.requestsPerMinute, "generation.requestsPerMinute", 0, 1_000_000),
      inputPricePerMillion: optionalNumber(generation.inputPricePerMillion, "generation.inputPricePerMillion", 1_000_000), cachedInputPricePerMillion: optionalNumber(generation.cachedInputPricePerMillion, "generation.cachedInputPricePerMillion", 1_000_000),
      taskInputTokenBudget: generation.taskInputTokenBudget === undefined || generation.taskInputTokenBudget === null ? undefined : number(generation.taskInputTokenBudget, "generation.taskInputTokenBudget", 0, 1_000_000_000), taskBudget: optionalNumber(generation.taskBudget, "generation.taskBudget", 1_000_000_000), outputPricePerMillion: optionalNumber(generation.outputPricePerMillion, "generation.outputPricePerMillion", 1_000_000), dailyBudget: optionalNumber(generation.dailyBudget, "generation.dailyBudget", 1_000_000_000),
    },
    outputLanguage, extractionPrompt: string(input.extractionPrompt, "extractionPrompt", 32_768), mergePrompt: string(input.mergePrompt, "mergePrompt", 32_768),
    automatic: { enabled: automatic.enabled, intervalMinutes: number(automatic.intervalMinutes, "automatic.intervalMinutes", 1, 10_080), quietMinutes: number(automatic.quietMinutes, "automatic.quietMinutes", 0, 10_080), scope: validateKnowledgeScope(automatic.scope) },
    embedding: { mode: embedding.mode as KnowledgeConfig["embedding"]["mode"], connection, timeoutMs: number(embedding.timeoutMs, "embedding.timeoutMs", 100, 600_000), retries: number(embedding.retries, "embedding.retries", 0, 5), requestsPerMinute: number(embedding.requestsPerMinute, "embedding.requestsPerMinute", 0, 1_000_000), pricePerMillion: optionalNumber(embedding.pricePerMillion, "embedding.pricePerMillion", 1_000_000), dailyBudget: optionalNumber(embedding.dailyBudget, "embedding.dailyBudget", 1_000_000_000) },
  };
  if (config.generation.outputTokens + 2048 >= config.generation.contextTokens) return invalid("generation.outputTokens");
  if (config.generation.dailyBudget !== undefined && (config.generation.inputPricePerMillion === undefined || config.generation.outputPricePerMillion === undefined)) return invalid("generation.price");
  if (config.generation.taskBudget !== undefined && (config.generation.inputPricePerMillion === undefined || config.generation.outputPricePerMillion === undefined)) return invalid("generation.price");
  if (config.embedding.dailyBudget !== undefined && config.embedding.pricePerMillion === undefined) return invalid("embedding.pricePerMillion");
  if (config.automatic.enabled && (!url || !config.generation.model || config.automatic.scope.timeRange === "unset" && !config.automatic.scope.sessionIds?.length)) return invalid("automatic.scope");
  if (config.embedding.mode === "independent" && (!connection.url || !connection.model)) return invalid("embedding.connection");
  return config;
}

export function knowledgeFingerprint(config: KnowledgeConfig): string {
  return createHash("sha256").update(JSON.stringify({ template: 3, generation: config.generation, outputLanguage: config.outputLanguage, extractionPrompt: config.extractionPrompt, mergePrompt: config.mergePrompt })).digest("hex");
}
export async function writeKnowledgeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 }); await rename(temporary, path); await chmod(path, 0o600); }
  finally { await rm(temporary, { force: true }); }
}
interface Credentials { generation?: string; embedding?: string; snapshots?: Record<string, string> }
export class KnowledgeConfigStore {
  private readonly directory: string;
  private writes: Promise<void> = Promise.resolve();
  constructor(home: string) { this.directory = join(home, "knowledge"); }
  private async ensure(): Promise<void> { await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700); }
  private async credentials(): Promise<Credentials> {
    try {
      const value = record(JSON.parse(await readFile(join(this.directory, "credentials.json"), "utf8")), "credentials");
      for (const field of ["generation", "embedding"]) if (value[field] !== undefined) string(value[field], field);
      if (value.snapshots !== undefined) for (const key of Object.values(record(value.snapshots, "snapshots"))) string(key, "snapshot");
      return value as Credentials;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new KnowledgeModelError("credentials_unreadable", "无法读取知识模型凭据", 500); }
  }
  private async config(language?: KnowledgeLanguage): Promise<KnowledgeConfig> {
    try { return validateKnowledgeConfig(JSON.parse(await readFile(join(this.directory, "config.json"), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new KnowledgeModelError("config_unreadable", "无法读取知识设置", 500); }
    const config = defaultKnowledgeConfig(language);
    if (language !== undefined) { await this.ensure(); await writeKnowledgeJson(join(this.directory, "config.json"), config); }
    return config;
  }
  async read(language?: KnowledgeLanguage): Promise<KnowledgeSettings> {
    return (await this.capture(language)).settings;
  }
  async capture(language?: KnowledgeLanguage): Promise<{ settings: KnowledgeSettings; generationKey?: string }> {
    await this.writes;
    // 首次语言选择也串行保存，随后界面语言不再改变它。
    let result!: { settings: KnowledgeSettings; generationKey?: string };
    const operation = this.writes.then(async () => {
      const config = await this.config(language), keys = await this.credentials();
      result = { settings: { config, hasGenerationKey: keys.generation !== undefined, hasEmbeddingKey: keys.embedding !== undefined, fingerprint: knowledgeFingerprint(config) }, generationKey: keys.generation };
    });
    this.writes = operation.catch(() => undefined); await operation; return result;
  }
  async key(kind: "generation" | "embedding", snapshot?: string): Promise<string | undefined> { await this.writes; const keys = await this.credentials(); return snapshot ? keys.snapshots?.[snapshot] : keys[kind]; }
  async snapshot(id: string, key?: string): Promise<void> {
    const operation = this.writes.then(async () => { const keys = await this.credentials(); if (key !== undefined) { keys.snapshots = { ...keys.snapshots, [id]: key }; await this.ensure(); await writeKnowledgeJson(join(this.directory, "credentials.json"), keys); } });
    this.writes = operation.catch(() => undefined); await operation;
  }
  async retainSnapshots(ids: string[]): Promise<void> {
    const retained = new Set(ids), operation = this.writes.then(async () => {
      const keys = await this.credentials(); if (!keys.snapshots) return;
      for (const id of Object.keys(keys.snapshots)) if (!retained.has(id)) delete keys.snapshots[id];
      await this.ensure(); await writeKnowledgeJson(join(this.directory, "credentials.json"), keys);
    });
    this.writes = operation.catch(() => undefined); await operation;
  }
  async save(input: KnowledgeSettingsInput): Promise<KnowledgeSettings> {
    const config = validateKnowledgeConfig(input?.config);
    for (const key of [input.generationKey, input.embeddingKey]) if (key !== undefined && key !== null && (typeof key !== "string" || key.length > 16_384 || /[\r\n]/.test(key))) return invalid("key");
    const operation = this.writes.then(async () => {
      await this.ensure(); const keys = await this.credentials();
      for (const kind of ["generation", "embedding"] as const) {
        const value = input[kind === "generation" ? "generationKey" : "embeddingKey"];
        if (value === null || value === "") delete keys[kind]; else if (value !== undefined) keys[kind] = value;
      }
      await writeKnowledgeJson(join(this.directory, "credentials.json"), keys); await writeKnowledgeJson(join(this.directory, "config.json"), config);
    });
    this.writes = operation.catch(() => undefined); await operation; return this.read();
  }
}
