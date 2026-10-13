import enCommon from "./locales/en/common.js";
import enCodeMap from "./locales/en/codeMap.js";
import enSessions from "./locales/en/sessions.js";
import enResources from "./locales/en/resources.js";
import enDiagnostics from "./locales/en/diagnostics.js";
import enCli from "./locales/en/cli.js";
import enOverview from "./locales/en/overview.js";
import enUsage from "./locales/en/usage.js";
import enSite from "./locales/en/site.js";
import zhCommon from "./locales/zh-CN/common.js";
import zhCodeMap from "./locales/zh-CN/codeMap.js";
import zhSessions from "./locales/zh-CN/sessions.js";
import zhResources from "./locales/zh-CN/resources.js";
import zhDiagnostics from "./locales/zh-CN/diagnostics.js";
import zhCli from "./locales/zh-CN/cli.js";
import zhOverview from "./locales/zh-CN/overview.js";
import zhUsage from "./locales/zh-CN/usage.js";
import zhSite from "./locales/zh-CN/site.js";
import type { LanguageCatalogs } from "./types.js";

export const catalogs: LanguageCatalogs = {
  en: { common: enCommon, codeMap: enCodeMap, sessions: enSessions, resources: enResources, usage: enUsage, overview: enOverview, diagnostics: enDiagnostics, cli: enCli, site: enSite },
  "zh-CN": { common: zhCommon, codeMap: zhCodeMap, sessions: zhSessions, resources: zhResources, usage: zhUsage, overview: zhOverview, diagnostics: zhDiagnostics, cli: zhCli, site: zhSite },
};
