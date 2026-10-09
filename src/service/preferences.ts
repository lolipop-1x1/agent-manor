import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { isLanguage, isLanguagePreference } from "../i18n/registry.js";
import type { LanguagePreference, PreferencesResponse } from "../i18n/types.js";
import { isAutoRefreshInterval } from "../refresh-preferences.js";
import { ServiceError } from "./input.js";

export const preferencesPath = (home: string): string => join(home, "preferences.json");

/** 设置与可重建索引分开保存；旧文件未记录刷新间隔时默认关闭。 */
export async function readPreferences(home: string): Promise<PreferencesResponse> {
  let text: string;
  try { text = await readFile(preferencesPath(home), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { language: "auto", sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 0 };
    throw new ServiceError("INTERNAL_ERROR", "无法读取偏好设置", { key: "diagnostics.service.preferences.m001" });
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "language" && key !== "sessionsAutoRefreshInterval" && key !== "mapAutoRefreshInterval")
      || value.language !== undefined && !isLanguage(value.language)
      || value.sessionsAutoRefreshInterval !== undefined && !isAutoRefreshInterval(value.sessionsAutoRefreshInterval)
      || value.mapAutoRefreshInterval !== undefined && !isAutoRefreshInterval(value.mapAutoRefreshInterval)) throw new Error("invalid_preferences");
    return { language: value.language === undefined ? "auto" : value.language as LanguagePreference,
      sessionsAutoRefreshInterval: value.sessionsAutoRefreshInterval === undefined ? 0 : value.sessionsAutoRefreshInterval as PreferencesResponse["sessionsAutoRefreshInterval"],
      mapAutoRefreshInterval: value.mapAutoRefreshInterval === undefined ? 0 : value.mapAutoRefreshInterval as PreferencesResponse["mapAutoRefreshInterval"] };
  } catch { throw new ServiceError("INTERNAL_ERROR", "偏好设置文件无效", { key: "diagnostics.service.preferences.m002" }); }
}

const pendingWrites = new Map<string, Promise<PreferencesResponse>>();

/** 合并更新串行保存，避免语言和刷新设置的并发写入互相覆盖。 */
export function updatePreferences(home: string, body: unknown): Promise<PreferencesResponse> {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.keys(body).length
    || Object.keys(body).some(key => key !== "language" && key !== "sessionsAutoRefreshInterval" && key !== "mapAutoRefreshInterval")) {
    throw new ServiceError("INVALID_INPUT", "请求体只能包含 language、sessionsAutoRefreshInterval 或 mapAutoRefreshInterval", { key: "diagnostics.service.preferences.fields" });
  }
  const patch = body as Partial<PreferencesResponse>;
  if ("language" in patch && !isLanguagePreference(patch.language)) throw new ServiceError("INVALID_INPUT", "language 必须是 auto、zh-CN 或 en", { key: "diagnostics.service.preferences.m003" });
  if ("sessionsAutoRefreshInterval" in patch && !isAutoRefreshInterval(patch.sessionsAutoRefreshInterval)
    || "mapAutoRefreshInterval" in patch && !isAutoRefreshInterval(patch.mapAutoRefreshInterval)) throw new ServiceError("INVALID_INPUT", "刷新间隔必须是受支持的毫秒间隔", { key: "diagnostics.service.preferences.interval" });
  const key = resolve(home);
  const operation = (pendingWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(() => savePreferences(home, patch));
  pendingWrites.set(key, operation);
  const release = () => { if (pendingWrites.get(key) === operation) pendingWrites.delete(key); };
  void operation.then(release, release);
  return operation;
}

export async function writePreferences(home: string, language: LanguagePreference): Promise<PreferencesResponse> {
  return updatePreferences(home, { language });
}

async function savePreferences(home: string, patch: Partial<PreferencesResponse>): Promise<PreferencesResponse> {
  const temporary = `${preferencesPath(home)}.${randomUUID()}.tmp`;
  try {
    const preferences = { ...await readPreferences(home), ...patch };
    const stored = { ...(preferences.language === "auto" ? {} : { language: preferences.language }),
      ...(preferences.sessionsAutoRefreshInterval ? { sessionsAutoRefreshInterval: preferences.sessionsAutoRefreshInterval } : {}),
      ...(preferences.mapAutoRefreshInterval ? { mapAutoRefreshInterval: preferences.mapAutoRefreshInterval } : {}) };
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(stored) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, preferencesPath(home));
    return preferences;
  } catch { throw new ServiceError("INTERNAL_ERROR", "偏好设置未保存", { key: "diagnostics.service.preferences.m004" }); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}

export function registerPreferenceRoutes(app: FastifyInstance, home: string): void {
  app.get("/api/v1/preferences", () => readPreferences(home));
  app.put("/api/v1/preferences", request => updatePreferences(home, request.body));
}
