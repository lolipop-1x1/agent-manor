export type Language = "zh-CN" | "en";
export type LanguagePreference = "auto" | Language;
export type MessageParams = Record<string, string | number>;
export interface MessageDescriptor { key: string; params?: MessageParams }
export interface PreferencesResponse { language: LanguagePreference }
export type MessageCatalog = Record<string, string>;
export const catalogModules = ["common", "codeMap", "sessions", "resources", "diagnostics", "cli"] as const;
export type CatalogModule = typeof catalogModules[number];
export type LanguageCatalogs = Record<Language, Record<CatalogModule, MessageCatalog>>;
