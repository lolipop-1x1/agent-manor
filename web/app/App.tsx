import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { GithubLogo } from "@phosphor-icons/react";
import type { SessionJob, SessionSummary } from "../../src/session-contracts";
import { errorMessage, request } from "../shared/api";
import { useCodeMapPage } from "../features/code-map/CodeMapPage";
import { useVisiblePolling } from "../shared/refresh/useVisiblePolling";
import type { Client } from "../../src/clients";
import { useHistoryRefresh } from "../shared/refresh/useHistoryRefresh";
import { HistoryRefreshControl } from "../features/sessions/SessionRefresh";
import Sessions from "../features/sessions/Sessions";
import Resources from "../features/resources/Resources";
import Overview from "../features/overview/Overview";
import type { OverviewMapTarget, OverviewSessionTarget } from "../features/overview/Investigation";
import Usage from "../features/usage/Usage";
import { LanguageMenu, LanguageNotice, messageText, t, useI18n } from "../shared/i18n";
import { useTheme } from "../shared/theme";
import { AppearanceMenu } from "../shared/ui/AppearanceMenu";
import { Hint } from "../shared/ui/Hint";
import "./navigation.css";

export function App() {
  const { language, appearance, refreshIntervals: { sessions: sessionsAutoRefreshInterval } } = useI18n();
  const headerFrame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const frame = headerFrame.current;
    if (!frame) return;
    // 页头可能随语言、视口和错误提示换行，工作区使用实际剩余高度。
    const updateHeight = () => document.documentElement.style.setProperty("--app-header-height", `${frame.offsetHeight}px`);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(frame);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty("--app-header-height"); };
  }, []);
  type ProductView = "overview" | "map" | "sessions" | "resources" | "usage";
  const hashView = (): ProductView => location.hash.startsWith("#sessions") ? "sessions" : location.hash.startsWith("#resources") ? "resources" : location.hash.startsWith("#usage") ? "usage" : location.hash.startsWith("#map") ? "map" : "overview";
  const [view, setView] = useState<ProductView>(hashView);
  const viewScroll = useRef({ overview: 0, map: 0, sessions: 0, resources: 0, usage: 0 });
  const overviewAddress = useRef(location.hash.startsWith("#overview") ? location.hash : "#overview");
  const sessionAddress = useRef(location.hash.startsWith("#sessions") ? location.hash : "#sessions");
  const resourceAddress = useRef(location.hash.startsWith("#resources") ? location.hash : "#resources");
  const usageAddress = useRef(location.hash.startsWith("#usage") ? location.hash : "#usage");
  const activeView = useRef(view);
  const activateView = useCallback((next: ProductView) => {
    if (activeView.current !== next) viewScroll.current[activeView.current] = globalThis.scrollY;
    activeView.current = next;
    setView(next);
  }, []);
  useLayoutEffect(() => { globalThis.scrollTo(0, viewScroll.current[view]); }, [view]);
  useEffect(() => { document.title = `AgentManor · ${t({ overview: "overview.title", map: "codeMap.title", sessions: "codeMap.navigation.sessions", resources: "codeMap.navigation.resources", usage: "usage.title" }[view])}`; }, [view, language]);
  const [sessionTarget, setSessionTarget] = useState<{ sessionId: string; messageId?: string; version?: string; mode?: "brief" | "full" | "trace"; page?: number; turnPosition?: number; branch?: string }>();
  useEffect(() => {
    const navigate = () => {
      activateView(hashView());
      if (!location.hash.startsWith("#sessions")) return;
      const params = new URLSearchParams(location.hash.split("?")[1]);
      const sessionId = params.get("id");
      const mode = params.get("mode");
      const positive = (name: string) => { const value = Number(params.get(name)); return Number.isSafeInteger(value) && value > 0 ? value : undefined; };
      if (sessionId) { const next = { sessionId, messageId: params.get("message") ?? undefined, version: params.get("version") ?? undefined,
        mode: mode === "brief" || mode === "full" || mode === "trace" ? mode as "brief" | "full" | "trace" : undefined, page: positive("page"), turnPosition: positive("turn"), branch: params.get("branch") ?? undefined };
        setSessionTarget(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
      }
    };
    navigate();
    globalThis.addEventListener("hashchange", navigate);
    return () => globalThis.removeEventListener("hashchange", navigate);
  }, [activateView]);
  const switchView = (next: ProductView) => {
    if (location.hash.startsWith("#overview")) overviewAddress.current = location.hash;
    if (location.hash.startsWith("#resources")) resourceAddress.current = location.hash;
    if (location.hash.startsWith("#sessions")) sessionAddress.current = location.hash;
    if (location.hash.startsWith("#usage")) usageAddress.current = location.hash;
    activateView(next); location.hash = next === "overview" ? overviewAddress.current : next === "resources" ? resourceAddress.current : next === "sessions" ? sessionAddress.current : next === "usage" ? usageAddress.current : next;
  };
  const openResourceSession = (target: { sessionId: string; messageId: string }) => {
    resourceAddress.current = location.hash;
    setSessionTarget({ ...target, mode: "trace", branch: "all" }); activateView("sessions");
    location.hash = `sessions?${new URLSearchParams({ id: target.sessionId, message: target.messageId, mode: "trace", branch: "all" })}`;
  };
  const openOverviewSession = (target: OverviewSessionTarget) => {
    overviewAddress.current = location.hash;
    setSessionTarget({ ...target, mode: "trace", branch: "all" }); activateView("sessions");
    const params = new URLSearchParams({ id: target.sessionId, version: target.version, mode: "trace", branch: "all" });
    if (target.messageId) params.set("message", target.messageId);
    location.hash = `sessions?${params}`;
  };
  const openOverviewUsage = (hash: string) => { overviewAddress.current = location.hash; activateView("usage"); location.hash = hash; };
  const theme = useTheme(appearance);
  const history = useHistoryRefresh();
  const [sessionClient, setSessionClient] = useState<Client>();
  const [autoRefreshError, setAutoRefreshError] = useState<Error | null>(null);
  useEffect(() => { if (!sessionsAutoRefreshInterval) setAutoRefreshError(null); }, [sessionsAutoRefreshInterval]);
  useVisiblePolling(view === "sessions" && sessionsAutoRefreshInterval > 0, sessionsAutoRefreshInterval, async signal => {
    const result = await request<{ job?: SessionJob }>("/sessions/auto-refresh", { method: "POST", body: {}, signal });
    if (!signal.aborted && result.job) history.observeJob(result.job);
    if (!signal.aborted) setAutoRefreshError(null);
  }, error => setAutoRefreshError(error instanceof Error ? error : new Error(String(error))));
  const openMapSession = (target: { sessionId: string; messageId?: string }) => {
    if (location.hash.startsWith("#usage")) usageAddress.current = location.hash;
    setSessionTarget(target); activateView("sessions");
    const destination = new URLSearchParams({ id: target.sessionId });
    if (target.messageId) destination.set("message", target.messageId);
    location.hash = `sessions?${destination}`;
  };
  const map = useCodeMapPage({ active: view === "map", theme, onSession: openMapSession });
  const openMap = (path?: string, project?: string, session?: SessionSummary) => {
    if (location.hash.startsWith("#sessions")) sessionAddress.current = location.hash;
    map.openMap(path, project, session);
    activateView("map"); location.hash = "map";
  };
  const openOverviewMap = (target: OverviewMapTarget) => {
    overviewAddress.current = location.hash;
    map.openMap(target.path, target.project, undefined, target);
    activateView("map"); location.hash = "map";
  };
  return <Tooltip.Provider delayDuration={350}>
    <div ref={headerFrame}>
    <header className="app-header"><a className="brand" href="/" aria-label={t("codeMap.navigation.home")}><svg width="30" height="20" viewBox="8 16 48 32" fill="currentColor" aria-hidden="true" focusable="false"><path d="M14 18a3 3 0 0 0-4 2.8v22.4a3 3 0 0 0 4 2.8l10-6a2 2 0 0 0 1-1.8V25.8a2 2 0 0 0-1-1.8z" /><rect x="28" y="27" width="8" height="10" rx="2" /><path d="M14 18a3 3 0 0 0-4 2.8v22.4a3 3 0 0 0 4 2.8l10-6a2 2 0 0 0 1-1.8V25.8a2 2 0 0 0-1-1.8z" transform="translate(64 0) scale(-1 1)" /></svg><span>Agent<strong>Manor</strong></span></a><span className="header-divider" /><nav className="product-nav" aria-label={t("codeMap.navigation.title")}><button aria-current={view === "overview" ? "page" : undefined} onClick={() => switchView("overview")}>{t("overview.title")}</button><button aria-current={view === "sessions" ? "page" : undefined} onClick={() => switchView("sessions")}>{t("codeMap.navigation.sessions")}</button><button aria-current={view === "map" ? "page" : undefined} onClick={() => switchView("map")}>{t("codeMap.navigation.map")}</button><button aria-current={view === "usage" ? "page" : undefined} onClick={() => switchView("usage")}>{t("usage.title")}</button><button aria-current={view === "resources" ? "page" : undefined} onClick={() => switchView("resources")}>{t("codeMap.navigation.resources")}</button></nav>
      <div className="header-actions">
        <HistoryRefreshControl client={view === "sessions" ? sessionClient : undefined} disabled={history.updating}
          job={history.job} error={history.error} onRefresh={options => void history.refresh(options)} />
        <LanguageMenu />
        <AppearanceMenu />
        <Hint label={t("common.github.project")}><a className="icon-button header-github" href="https://github.com/lolipop-1x1/agent-manor" target="_blank" rel="noreferrer" aria-label={t("common.github.project")}><GithubLogo size={19} aria-hidden="true" /></a></Hint>
      </div>
    </header>
    <LanguageNotice />
    {(history.error || !history.starting && history.job?.status === "failed") && <div className="history-error" role="alert"><span>{history.error ? t("common.history.errorDetail", { operation: t(`common.history.operation.${history.errorOperation}`), detail: errorMessage(history.error) }) : messageText(history.job?.errorDescriptor, history.job?.error ?? t("common.history.failed"))}</span><button className="text-button" onClick={history.retry}>{t("common.retry")}</button></div>}
    {map.maintenanceNotice}
    </div>
    <section className="product-view" hidden={view !== "overview"} aria-label={t("overview.title")}><Overview historyRevision={history.revision} active={view === "overview"} onSession={openOverviewSession} onUsage={openOverviewUsage} onMap={openOverviewMap} /></section>
    {map.page}
    <section className="product-view" hidden={view !== "sessions"} aria-label={t("codeMap.view.sessions")}><Sessions historyRevision={history.revision} historyUpdating={history.updating} onHistoryRefresh={options => void history.refresh(options)} onHistoryStatus={history.observeStatus} onClientFilterChange={setSessionClient} active={view === "sessions"} target={sessionTarget} onMap={openMap} autoRefreshError={autoRefreshError} /></section>
    <section className="product-view" hidden={view !== "resources"} aria-label={t("codeMap.view.resources")}><Resources historyRevision={history.revision} active={view === "resources"} onSession={openResourceSession} /></section>
    <section className="product-view" hidden={view !== "usage"} aria-label={t("usage.title")}><Usage historyRevision={history.revision} active={view === "usage"} onSession={openMapSession} /></section>
  </Tooltip.Provider>;
}
