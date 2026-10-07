import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { isLanguage, isLanguagePreference } from "../i18n/registry.js";
import type { LanguagePreference, PreferencesResponse } from "../i18n/types.js";
import { bodyText, ServiceError } from "./input.js";

export const preferencesPath = (home: string): string => join(home, "preferences.json");

/** 设置与可重建索引分开保存；仅文件不存在时表示自动模式。 */
export async function readPreferences(home: string): Promise<PreferencesResponse> {
  let text: string;
  try { text = await readFile(preferencesPath(home), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { language: "auto" };
    throw new ServiceError("INTERNAL_ERROR", "无法读取语言偏好", { key: "diagnostics.service.preferences.m001" });
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "language")
      || value.language !== undefined && !isLanguage(value.language)) throw new Error("invalid_preferences");
    return { language: value.language === undefined ? "auto" : value.language as LanguagePreference };
  } catch { throw new ServiceError("INTERNAL_ERROR", "语言偏好文件无效", { key: "diagnostics.service.preferences.m002" }); }
}

/** 原子替换独立文件；自动模式不保存手动覆盖。 */
export async function writePreferences(home: string, language: LanguagePreference): Promise<PreferencesResponse> {
  if (!isLanguagePreference(language)) throw new ServiceError("INVALID_INPUT", "language 必须是 auto、zh-CN 或 en", { key: "diagnostics.service.preferences.m003" });
  const temporary = `${preferencesPath(home)}.${randomUUID()}.tmp`;
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(language === "auto" ? {} : { language }) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, preferencesPath(home));
  } catch { throw new ServiceError("INTERNAL_ERROR", "语言偏好未保存", { key: "diagnostics.service.preferences.m004" }); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
  return { language };
}

export function registerPreferenceRoutes(app: FastifyInstance, home: string): void {
  app.get("/api/v1/preferences", () => readPreferences(home));
  app.put("/api/v1/preferences", request => {
    const language = bodyText(request.body, "language");
    if (!isLanguagePreference(language)) throw new ServiceError("INVALID_INPUT", "language 必须是 auto、zh-CN 或 en", { key: "diagnostics.service.preferences.m003" });
    return writePreferences(home, language);
  });
}
