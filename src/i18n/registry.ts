import type { Language } from "./types.js";

export const languageRegistry = {
  "zh-CN": { nativeName: "简体中文", labelKey: "common.language.chinese", formatLocale: "zh-CN", calendarLocale: "zhCN", weekStartsOn: 1 },
  en: { nativeName: "English", labelKey: "common.language.english", formatLocale: "en-US", calendarLocale: "enUS", weekStartsOn: 0 },
} as const;
export const supportedLanguages = Object.keys(languageRegistry) as Language[];
export const isLanguage = (value: unknown): value is Language => value === "zh-CN" || value === "en";
export const isLanguagePreference = (value: unknown): value is "auto" | Language => value === "auto" || isLanguage(value);

/** 按候选顺序匹配已支持语言系列；编码后缀不参与检测。 */
export function detectLanguage(candidates: readonly (string | undefined)[]): Language {
  for (const candidate of candidates) {
    const language = candidate?.trim().replaceAll("_", "-").split(/[.@]/)[0]?.toLowerCase();
    if (language === "zh" || language?.startsWith("zh-")) return "zh-CN";
    if (language === "en" || language?.startsWith("en-")) return "en";
  }
  return "en";
}
