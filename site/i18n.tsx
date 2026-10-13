import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createInstance } from "i18next";
import en from "../src/i18n/locales/en/site";
import zh from "../src/i18n/locales/zh-CN/site";
import type { Language, MessageParams } from "../src/i18n/types";

const preferenceKey = "agent-manor-site-language";
const instance = createInstance();
void instance.init({
  resources: { en: { translation: en }, "zh-CN": { translation: zh } },
  lng: "zh-CN", supportedLngs: ["zh-CN", "en"], fallbackLng: "en", load: "currentOnly",
  initAsync: false, keySeparator: false, nsSeparator: false,
  interpolation: { escapeValue: false }, returnNull: false, returnEmptyString: false,
});

interface SiteLanguage {
  language: Language;
  setLanguage(language: Language): void;
  t(key: string, params?: MessageParams): string;
}

const LanguageContext = createContext<SiteLanguage | null>(null);

function readLanguage(): Language {
  try {
    const value = localStorage.getItem(preferenceKey);
    if (value === "en" || value === "zh-CN") return value;
  } catch { /* 浏览器禁用存储时，官网仍保留本次语言状态。 */ }
  return "zh-CN";
}

export function SiteLanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(readLanguage);
  const value = useMemo<SiteLanguage>(() => ({
    language,
    setLanguage,
    t: (key, params) => instance.t(key, {
      ...params, lng: language, defaultValue: instance.t("site.translationUnavailable", { lng: language }),
    }),
  }), [language]);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = value.t("site.pageTitle");
    try { localStorage.setItem(preferenceKey, language); } catch { /* 无持久化权限时不影响语言切换。 */ }
  }, [language, value]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useSiteLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("SiteLanguageProvider 未挂载");
  return context;
}
