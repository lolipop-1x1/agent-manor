import { defaultAppearance, isAppearance, type Appearance } from "../../src/appearance";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Check, Translate, WarningCircle } from "@phosphor-icons/react";
import { CLIENTS, type Client } from "../../src/clients";
import { isAutoRefreshInterval, type AutoRefreshInterval, type RefreshScope } from "../../src/refresh-preferences";
import { detectLanguage, formatDate, formatDateTime, formatNumber, formatPercent, formatTime, isLanguagePreference, languageRegistry, supportedLanguages, translate, translateMessageOrOriginal, type Language, type LanguagePreference, type MessageDescriptor, type MessageParams, type PreferencesResponse } from "../../src/i18n";

export { isMessageDescriptorKnown } from "../../src/i18n";

let currentLanguage: Language = "en";
export const getLanguage = () => currentLanguage;
/** 非 React 格式函数按当前语言求值；组件通过 useI18n 订阅更新。 */
export const t = (key: string, params?: MessageParams) => translate(currentLanguage, key, params);
export const messageText = (descriptor: MessageDescriptor | undefined, original: string | undefined): string => translateMessageOrOriginal(currentLanguage, descriptor, original);
export const clientLabel = (client: Client): string => client === "codeflicker-desktop" ? t("common.client.codeflickerDesktop")
  : client === "doubao-work" ? t("common.client.doubaoWork") : CLIENTS.find(item => item.id === client)!.name;
export const formatList = (values: string[]): string => new Intl.ListFormat(currentLanguage, { style: "short", type: "unit" }).format(values);

interface I18nContextValue {
  appearance: Appearance;
  setAppearance: (patch: Partial<Appearance>) => Promise<void>;
  language: Language;
  preference: LanguagePreference;
  setPreference: (preference: LanguagePreference) => Promise<void>;
  refreshIntervals: Record<RefreshScope, AutoRefreshInterval>;
  setAutoRefreshInterval: (scope: RefreshScope, interval: AutoRefreshInterval) => Promise<void>;
  beginSessionIntervalObservation: () => (interval: number) => void;
  saving: boolean;
  error: "read" | "save" | null;
}
const I18nContext = createContext<I18nContextValue | null>(null);
const browserLanguage = () => detectLanguage(navigator.languages.length ? navigator.languages : [navigator.language]);

function validatePreferences(body: PreferencesResponse): PreferencesResponse {
  if (!isLanguagePreference(body.language) || !isAutoRefreshInterval(body.sessionsAutoRefreshInterval) || !isAutoRefreshInterval(body.mapAutoRefreshInterval)) throw new Error("INVALID_PREFERENCE");
  if (body.appearance !== undefined && !isAppearance(body.appearance)) throw new Error("INVALID_APPEARANCE");
  return body;
}

async function readPreference(signal?: AbortSignal): Promise<PreferencesResponse> {
  const response = await fetch("/api/v1/preferences", { signal });
  if (!response.ok) throw new Error(String(response.status));
  const body = await response.json() as PreferencesResponse;
  return validatePreferences(body);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [appearance, updateAppearance] = useState<Appearance>(defaultAppearance);
  const [preference, updatePreference] = useState<LanguagePreference | null>(null);
  const [refreshIntervals, updateRefreshIntervals] = useState<Record<RefreshScope, AutoRefreshInterval>>({ sessions: 0, map: 0 });
  const [error, setError] = useState<"read" | "save" | null>(null);
  const [saving, setSaving] = useState(false);
  const requestId = useRef(0);
  const sessionIntervalRevision = useRef(0);
  const pendingWrite = useRef(false);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const writeCount = useRef(0);
  const language = preference && preference !== "auto" ? preference : browserLanguage();
  currentLanguage = language;
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  useEffect(() => {
    const controller = new AbortController();
    const synchronize = () => {
      if (pendingWrite.current) return;
      const id = ++requestId.current;
      const intervalRevision = sessionIntervalRevision.current;
      void readPreference(controller.signal).then(async value => {
        if (id !== requestId.current) return;
        if (!value.appearance) {
          let legacy: string | null = null;
          try { legacy = localStorage.getItem("agent-manor-theme"); } catch { /* 浏览器禁用存储时仍使用共享偏好。 */ }
          if (legacy === "light" || legacy === "dark") {
            await savePreference({ appearance: { mode: legacy } });
            return;
          }
        }
        updateAppearance(value.appearance ?? defaultAppearance);
        updatePreference(value.language);
        updateRefreshIntervals(current => ({ sessions: intervalRevision === sessionIntervalRevision.current ? value.sessionsAutoRefreshInterval : current.sessions, map: value.mapAutoRefreshInterval }));
        setError(null);
      }).catch(() => {
        if (controller.signal.aborted || id !== requestId.current) return;
        updatePreference(value => value ?? "auto"); setError("read");
      });
    };
    synchronize();
    window.addEventListener("focus", synchronize);
    return () => { controller.abort(); window.removeEventListener("focus", synchronize); };
  }, []);
  const savePreference = useCallback((patch: Omit<Partial<PreferencesResponse>, "appearance"> & { appearance?: Partial<Appearance> }) => {
    pendingWrite.current = true;
    writeCount.current += 1;
    ++requestId.current;
    setSaving(true); setError(null);
    const operation = writeQueue.current.then(async () => {
      try {
        const response = await fetch("/api/v1/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
        if (!response.ok) throw new Error(String(response.status));
        const body = validatePreferences(await response.json() as PreferencesResponse);
        updatePreference(body.language); updateAppearance(body.appearance ?? defaultAppearance);
        updateRefreshIntervals({ sessions: body.sessionsAutoRefreshInterval, map: body.mapAutoRefreshInterval });
        if (body.appearance) { try { localStorage.removeItem("agent-manor-theme"); } catch { /* 共享偏好已经保存。 */ } }
        setError(null);
      } catch {
        updatePreference(value => value ?? "auto"); setError("save");
      } finally {
        writeCount.current -= 1;
        if (!writeCount.current) { pendingWrite.current = false; setSaving(false); }
      }
    });
    writeQueue.current = operation;
    return operation;
  }, []);
  const setAppearance = useCallback((patch: Partial<Appearance>) => savePreference({ appearance: patch }), [savePreference]);
  const setPreference = useCallback((language: LanguagePreference) => savePreference({ language }), [savePreference]);
  const setAutoRefreshInterval = useCallback((scope: RefreshScope, interval: AutoRefreshInterval) => savePreference(scope === "sessions"
    ? { sessionsAutoRefreshInterval: interval } : { mapAutoRefreshInterval: interval }), [savePreference]);
  const beginSessionIntervalObservation = useCallback(() => {
    const generation = requestId.current, writing = pendingWrite.current;
    return (interval: number) => {
      // 保存前开始或保存期间开始的旧状态读取，不能覆盖保存结果。
      if (writing || pendingWrite.current || generation !== requestId.current || !isAutoRefreshInterval(interval)) return;
      ++sessionIntervalRevision.current;
      updateRefreshIntervals(current => current.sessions === interval ? current : { ...current, sessions: interval });
    };
  }, []);
  const value = useMemo(() => ({ appearance, setAppearance, language, preference: preference ?? "auto", setPreference, refreshIntervals, setAutoRefreshInterval, beginSessionIntervalObservation, saving, error }), [appearance, setAppearance, language, preference, setPreference, refreshIntervals, setAutoRefreshInterval, beginSessionIntervalObservation, saving, error]);
  if (preference === null) return <div className="query-loading" role="status">{t("common.loading")}</div>;
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error("I18nProvider is required");
  const { language } = context;
  return { ...context,
    t: (key: string, params?: MessageParams) => translate(language, key, params),
    message: (descriptor: MessageDescriptor | undefined, original?: string) => translateMessageOrOriginal(language, descriptor, original),
    number: (value: number, options?: Intl.NumberFormatOptions) => formatNumber(language, value, options),
    percent: (value: number, options?: Intl.NumberFormatOptions) => formatPercent(language, value, { minimumFractionDigits: 1, ...options }),
    date: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => formatDate(language, value, options),
    dateTime: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => formatDateTime(language, value, options),
    time: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => formatTime(language, value, options),
  };
}

export function LanguageMenu() {
  const { preference, setPreference, saving, t } = useI18n();
  return <Dropdown.Root><Dropdown.Trigger className="icon-button" aria-label={t("common.language.menu")} title={t("common.language.menu")} disabled={saving}><Translate size={19} /></Dropdown.Trigger>
    <Dropdown.Portal><Dropdown.Content aria-label={t("common.language.menu")} className="filter-menu language-menu" align="end" sideOffset={6} collisionPadding={12}>
      <Dropdown.RadioGroup value={preference} onValueChange={value => void setPreference(value as LanguagePreference)}>
        {["auto", ...supportedLanguages].map(value => <Dropdown.RadioItem className="filter-option" key={value} value={value}>
          <Dropdown.ItemIndicator className="filter-check"><Check size={14} aria-hidden="true" /></Dropdown.ItemIndicator>
          {t(value === "auto" ? "common.language.auto" : languageRegistry[value as Language].labelKey)}
        </Dropdown.RadioItem>)}
      </Dropdown.RadioGroup>
    </Dropdown.Content></Dropdown.Portal>
  </Dropdown.Root>;
}

export function LanguageNotice() {
  const { error, t } = useI18n();
  return error ? <div className="notice danger" role="alert"><WarningCircle size={17} /><div>{t(error === "read" ? "common.preferences.readFailed" : "common.preferences.saveFailed")}</div></div> : null;
}
