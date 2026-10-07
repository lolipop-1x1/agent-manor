import { languageRegistry } from "./registry.js";
import type { Language } from "./types.js";

type DateValue = Date | number | string;

export function formatNumber(language: Language, value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(languageRegistry[language].formatLocale, options).format(value);
}

/** 百分比使用比例值；不改变原始统计数值。 */
export function formatPercent(language: Language, value: number, options?: Intl.NumberFormatOptions): string {
  return formatNumber(language, value, { style: "percent", maximumFractionDigits: 1, ...options });
}

export function formatDate(language: Language, value: DateValue, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(languageRegistry[language].formatLocale, options ?? { dateStyle: "medium" }).format(new Date(value));
}

export function formatDateTime(language: Language, value: DateValue, options?: Intl.DateTimeFormatOptions): string {
  return formatDate(language, value, options ?? { dateStyle: "medium", timeStyle: "short" });
}

export function formatTime(language: Language, value: DateValue, options?: Intl.DateTimeFormatOptions): string {
  return formatDate(language, value, options ?? { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
