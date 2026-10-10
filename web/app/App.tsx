import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { SessionSummary } from "../../src/session-contracts";
import { request } from "../shared/api";
import { useCodeMapPage } from "../features/code-map/CodeMapPage";
import { useVisiblePolling } from "../shared/refresh/useVisiblePolling";
import { AutoRefreshControl } from "../shared/ui/AutoRefreshControl";
import Sessions from "../features/sessions/Sessions";
import Resources from "../features/resources/Resources";
import { LanguageMenu, LanguageNotice, t, useI18n } from "../shared/i18n";
import { useTheme } from "../shared/theme";
import { AppearanceMenu } from "../shared/ui/AppearanceMenu";
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
  type ProductView = "map" | "sessions" | "resources";
  const hashView = (): ProductView => location.hash.startsWith("#sessions") ? "sessions" : location.hash.startsWith("#resources") ? "resources" : "map";
  const [view, setView] = useState<ProductView>(hashView);
  const viewScroll = useRef({ map: 0, sessions: 0, resources: 0 });
  const sessionAddress = useRef(location.hash.startsWith("#sessions") ? location.hash : "#sessions");
  const resourceAddress = useRef(location.hash.startsWith("#resources") ? location.hash : "#resources");
  const activeView = useRef(view);
  const activateView = useCallback((next: ProductView) => {
    if (activeView.current !== next) viewScroll.current[activeView.current] = globalThis.scrollY;
    activeView.current = next;
    setView(next);
  }, []);
  useLayoutEffect(() => { globalThis.scrollTo(0, viewScroll.current[view]); }, [view]);
  useEffect(() => { document.title = `AgentManor · ${t({ map: "codeMap.title", sessions: "codeMap.navigation.sessions", resources: "codeMap.navigation.resources" }[view])}`; }, [view, language]);
  const [sessionTarget, setSessionTarget] = useState<{ sessionId: string; messageId?: string; mode?: "brief" | "full" | "trace"; page?: number; turnPosition?: number; branch?: string }>();
  useEffect(() => {
    const navigate = () => {
      activateView(hashView());
      if (!location.hash.startsWith("#sessions")) return;
      const params = new URLSearchParams(location.hash.split("?")[1]);
      const sessionId = params.get("id");
      const mode = params.get("mode");
      const positive = (name: string) => { const value = Number(params.get(name)); return Number.isSafeInteger(value) && value > 0 ? value : undefined; };
      if (sessionId) { const next = { sessionId, messageId: params.get("message") ?? undefined,
        mode: mode === "brief" || mode === "full" || mode === "trace" ? mode as "brief" | "full" | "trace" : undefined, page: positive("page"), turnPosition: positive("turn"), branch: params.get("branch") ?? undefined };
        setSessionTarget(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
      }
    };
    navigate();
    globalThis.addEventListener("hashchange", navigate);
    return () => globalThis.removeEventListener("hashchange", navigate);
  }, [activateView]);
  const switchView = (next: ProductView) => {
    if (location.hash.startsWith("#resources")) resourceAddress.current = location.hash;
    if (location.hash.startsWith("#sessions")) sessionAddress.current = location.hash;
    activateView(next); location.hash = next === "resources" ? resourceAddress.current : next === "sessions" ? sessionAddress.current : next;
  };
  const openResourceSession = (target: { sessionId: string; messageId: string }) => {
    resourceAddress.current = location.hash;
    setSessionTarget({ ...target, mode: "trace", branch: "all" }); activateView("sessions");
    location.hash = `sessions?${new URLSearchParams({ id: target.sessionId, message: target.messageId, mode: "trace", branch: "all" })}`;
  };
  const theme = useTheme(appearance);
  const [autoRefreshError, setAutoRefreshError] = useState<Error | null>(null);
  useEffect(() => { if (!sessionsAutoRefreshInterval) setAutoRefreshError(null); }, [sessionsAutoRefreshInterval]);
  useVisiblePolling(view === "sessions" && sessionsAutoRefreshInterval > 0, sessionsAutoRefreshInterval, async signal => {
    await request("/sessions/auto-refresh", { method: "POST", body: {}, signal });
    if (!signal.aborted) setAutoRefreshError(null);
  }, error => setAutoRefreshError(error instanceof Error ? error : new Error(String(error))));
  const openMapSession = (target: { sessionId: string; messageId?: string }) => {
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
  return <Tooltip.Provider delayDuration={350}>
    <div ref={headerFrame}>
    <header className="app-header"><a className="brand" href="/" aria-label={t("codeMap.navigation.home")}><svg width="30" height="20" viewBox="8 16 48 32" fill="currentColor" aria-hidden="true" focusable="false"><path d="M14 18a3 3 0 0 0-4 2.8v22.4a3 3 0 0 0 4 2.8l10-6a2 2 0 0 0 1-1.8V25.8a2 2 0 0 0-1-1.8z" /><rect x="28" y="27" width="8" height="10" rx="2" /><path d="M14 18a3 3 0 0 0-4 2.8v22.4a3 3 0 0 0 4 2.8l10-6a2 2 0 0 0 1-1.8V25.8a2 2 0 0 0-1-1.8z" transform="translate(64 0) scale(-1 1)" /></svg><span>Agent<strong>Manor</strong></span></a><span className="header-divider" /><nav className="product-nav" aria-label={t("codeMap.navigation.title")}><button aria-current={view === "map" ? "page" : undefined} onClick={() => switchView("map")}>{t("codeMap.navigation.map")}</button><button aria-current={view === "sessions" ? "page" : undefined} onClick={() => switchView("sessions")}>{t("codeMap.navigation.sessions")}</button><button aria-current={view === "resources" ? "page" : undefined} onClick={() => switchView("resources")}>{t("codeMap.navigation.resources")}</button></nav>
      <div className="header-actions">{map.sourceAction}
        {view !== "resources" && <AutoRefreshControl scope={view === "sessions" ? "sessions" : "map"} />}
        <LanguageMenu />
        <AppearanceMenu />
        {map.refreshAction}
      </div>
    </header>
    <LanguageNotice />
    {map.maintenanceNotice}
    </div>
    {map.page}
    <section className="product-view" hidden={view !== "sessions"} aria-label={t("codeMap.view.sessions")}><Sessions active={view === "sessions"} target={sessionTarget} onMap={openMap} autoRefreshError={autoRefreshError} /></section>
    <section className="product-view" hidden={view !== "resources"} aria-label={t("codeMap.view.resources")}><Resources active={view === "resources"} onSession={openResourceSession} /></section>
  </Tooltip.Provider>;
}
