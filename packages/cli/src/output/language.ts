import { dataHome, RequestError } from "../../../../src/service/runtime.js";
import { detectLanguage, isLanguagePreference } from "../../../../src/i18n/index.js";
import type { Language } from "../../../../src/i18n/index.js";
import { readPreferences } from "../../../../src/service/preferences.js";
import type { Options } from "../context.js";

export async function resolveCliLanguage(options: Partial<Pick<Options, "lang" | "home">>, environment: NodeJS.ProcessEnv = process.env): Promise<Language> {
  // 系统变量按优先级取首个非空值；不跨越未支持语言继续查找。
  const systemLanguage = detectLanguage([[environment.LC_ALL, environment.LC_MESSAGES, environment.LANG].find(value => value?.trim())]);
  const override = options.lang ?? environment.AGENT_MANOR_LANG;
  if (override !== undefined) {
    const source = options.lang === undefined ? "AGENT_MANOR_LANG" : "--lang";
    if (!isLanguagePreference(override)) throw new RequestError("INVALID_INPUT", `${source} 必须是 zh-CN、en 或 auto（收到 ${override}）`,
      { key: "cli.error.invalidLanguage", params: { source, value: String(override) } });
    return override === "auto" ? systemLanguage : override;
  }
  const preference = await readPreferences(dataHome(typeof options.home === "string" ? options.home : environment.AGENT_MANOR_HOME));
  return preference.language === "auto" ? systemLanguage : preference.language;
}
