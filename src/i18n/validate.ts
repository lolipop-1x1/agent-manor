import { catalogs } from "./catalogs.js";
import { languageRegistry, supportedLanguages } from "./registry.js";
import { catalogModules } from "./types.js";
import type { Language, LanguageCatalogs } from "./types.js";

const pluralSuffix = /^(.*)_(zero|one|two|few|many|other)$/;
const parameterPattern = /{{\s*-?\s*([A-Za-z][\w.]*)(?:\s*,[^{}]*)?\s*}}/g;
type Message = { params: string[]; variants: Set<string>; plural: boolean };
const same = (left: readonly string[], right: readonly string[]) => JSON.stringify(left) === JSON.stringify(right);

/** 检查逻辑消息、参数和本语言的复数类别，不要求不同语言使用相同后缀。 */
export function validateCatalogs(input: LanguageCatalogs = catalogs): string[] {
  const errors: string[] = [];
  const messages = new Map<Language, Map<string, Message>>();
  for (const language of supportedLanguages) {
    const registry = languageRegistry[language];
    if (!registry.nativeName || !registry.formatLocale || !registry.calendarLocale) errors.push(`${language}: 缺少语言显示、格式或日历配置`);
    const localized = new Map<string, Message>();
    messages.set(language, localized);
    const seen = new Set<string>();
    for (const module of catalogModules) {
      const entries = input[language]?.[module];
      if (!entries) { errors.push(`${language}.${module}: 缺少目录`); continue; }
      for (const [key, value] of Object.entries(entries)) {
        if (!key.startsWith(`${module}.`)) errors.push(`${language}.${key}: 消息标识必须使用所属目录前缀`);
        if (seen.has(key)) errors.push(`${language}.${key}: 消息标识重复`);
        seen.add(key);
        if (typeof value !== "string" || !value.trim()) { errors.push(`${language}.${key}: 文案必须是非空字符串`); continue; }
        const suffix = key.match(pluralSuffix);
        const base = suffix?.[1] ?? key;
        const variant = suffix?.[2] ?? "plain";
        const params = [...new Set([...value.matchAll(parameterPattern)].map(match => match[1]!))];
        if (suffix && !params.includes("count")) params.push("count");
        params.sort();
        const existing = localized.get(base);
        if (existing && (!same(existing.params, params) || existing.plural !== Boolean(suffix))) {
          errors.push(`${language}.${base}: 复数项参数或消息类型不一致`);
        }
        if (existing) existing.variants.add(variant);
        else localized.set(base, { params, variants: new Set([variant]), plural: Boolean(suffix) });
      }
    }
    const categories = new Intl.PluralRules(registry.formatLocale).resolvedOptions().pluralCategories;
    for (const [key, message] of localized) {
      if (!message.plural) continue;
      for (const category of categories) {
        if (!message.variants.has(category)) errors.push(`${language}.${key}: 缺少复数项 ${category}`);
      }
      for (const variant of message.variants) {
        if (variant !== "zero" && !categories.includes(variant as Intl.LDMLPluralRule)) errors.push(`${language}.${key}: 本语言不支持复数项 ${variant}`);
      }
    }
  }
  const reference = messages.get("en")!;
  for (const language of supportedLanguages.filter(value => value !== "en")) {
    const localized = messages.get(language)!;
    for (const key of new Set([...reference.keys(), ...localized.keys()])) {
      const source = reference.get(key), translated = localized.get(key);
      if (!source || !translated) errors.push(`${language}.${key}: 中英文目录缺少对应消息`);
      else if (source.plural !== translated.plural || !same(source.params, translated.params)) errors.push(`${language}.${key}: 中英文参数或复数类型不匹配`);
    }
  }
  return errors;
}
