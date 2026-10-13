import type { Appearance } from "../appearance.js";
import type { AutoRefreshInterval } from "../refresh-preferences.js";

export type Language = "zh-CN" | "en";
export type LanguagePreference = "auto" | Language;
export type MessageParams = Record<string, string | number>;
export interface MessageDescriptor { key: string; params?: MessageParams }
export interface PreferencesResponse { appearance?: Appearance; language: LanguagePreference; sessionsAutoRefreshInterval: AutoRefreshInterval; mapAutoRefreshInterval: AutoRefreshInterval }
export type MessageCatalog = Record<string, string>;
export const catalogModules = ["common", "codeMap", "sessions", "resources", "usage", "overview", "diagnostics", "cli", "site"] as const;
export type CatalogModule = typeof catalogModules[number];
export type LanguageCatalogs = Record<Language, Record<CatalogModule, MessageCatalog>>;
