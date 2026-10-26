import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { GithubLogo } from "@phosphor-icons/react";
import type { SessionSummary } from "../../src/session-contracts";
import { inactiveClientIds } from "../../src/clients";
import { errorMessage } from "../shared/api";
import { useCodeMapPage } from "../features/code-map/CodeMapPage";
import { useHistoryRefresh } from "../shared/refresh/useHistoryRefresh";
import { HistoryRefreshControl } from "../features/sessions/SessionRefresh";
import Sessions from "../features/sessions/Sessions";
import { sessionNavigationAddress, type SessionEvidenceTarget, type SessionNavigationTarget } from "../features/sessions/session-address";
import Resources from "../features/resources/Resources";
import Overview from "../features/overview/Overview";
import type { OverviewMapTarget, OverviewSessionTarget } from "../features/overview/Investigation";
import Usage from "../features/usage/Usage";
import Knowledge from "../features/knowledge/Knowledge";
import { SoftwareUpdates } from "../features/updates/SoftwareUpdates";
import { LanguageMenu, LanguageNotice, messageText, t, useI18n } from "../shared/i18n";
import { useTheme } from "../shared/theme";
import { AppearanceMenu } from "../shared/ui/AppearanceMenu";
import { AutoRefreshControl } from "../shared/ui/AutoRefreshControl";
import { Hint } from "../shared/ui/Hint";
import { SelectionIndicator } from "../shared/ui/SelectionIndicator";
import { animateSurface } from "../shared/motion";
import "./navigation.css";

export function App() {
  const { language, appearance } = useI18n();
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
  type ProductView = "overview" | "map" | "sessions" | "resources" | "usage" | "knowledge";
  const hashView = (): ProductView => location.hash.startsWith("#knowledge") ? "knowledge" : location.hash.startsWith("#sessions") ? "sessions" : location.hash.startsWith("#resources") ? "resources" : location.hash.startsWith("#usage") ? "usage" : location.hash.startsWith("#map") ? "map" : "overview";
  const [view, setView] = useState<ProductView>(hashView);
  const viewScroll = useRef({ overview: 0, map: 0, sessions: 0, resources: 0, usage: 0, knowledge: 0 });
  const overviewAddress = useRef(location.hash.startsWith("#overview") ? location.hash : "#overview");
  const mapAddress = useRef(location.hash.startsWith("#map") ? location.hash : "#map");
  const sessionAddress = useRef(location.hash.startsWith("#sessions") ? location.hash : "#sessions");
  const resourceAddress = useRef(location.hash.startsWith("#resources") ? location.hash : "#resources");
  const knowledgeAddress = useRef(location.hash.startsWith("#knowledge") ? location.hash : "#knowledge");
  const usageAddress = useRef(location.hash.startsWith("#usage") ? location.hash : "#usage");
  const activeView = useRef(view);
  const activateView = useCallback((next: ProductView) => {
    if (activeView.current !== next) viewScroll.current[activeView.current] = globalThis.scrollY;
    activeView.current = next;
    setView(next);
  }, []);
  const previousView = useRef(view);
  useLayoutEffect(() => {
    globalThis.scrollTo(0, viewScroll.current[view]);
    if (previousView.current === view) return;
    previousView.current = view;
    const content = document.querySelector<HTMLElement>(".product-view:not([hidden])");
    if (!content) return;
    // 仅主动切页做轻微明度衔接，不改变固定面板参照，也不等待数据或动画再交互。
    const motion = animateSurface(content, [{ opacity: .78 }, { opacity: 1 }], "--motion-view");
    if (!motion) return;
    const stop = () => motion.cancel();
    const inputs = ["pointerdown", "keydown", "wheel"] as const;
    for (const input of inputs) content.addEventListener(input, stop, { capture: true, passive: true });
    const clean = () => { for (const input of inputs) content.removeEventListener(input, stop, true); };
    void motion.finished.then(clean, clean);
    return () => { clean(); motion.cancel(); };
  }, [view]);
  useEffect(() => { document.title = `AgentManor · ${t({ overview: "overview.title", map: "codeMap.title", sessions: "codeMap.navigation.sessions", resources: "codeMap.navigation.resources", usage: "usage.title", knowledge: "knowledge.title" }[view])}`; }, [view, language]);
  const [sessionTarget, setSessionTarget] = useState<{ sessionId: string; messageId?: string; version?: string; mode?: "brief" | "full" | "trace"; page?: number; turnPosition?: number; branch?: string }>();
  useEffect(() => {
    const navigate = () => {
      activateView(hashView());
      if (!location.hash.startsWith("#sessions")) return;
      const params = new URLSearchParams(location.hash.split("?")[1]);
      const sessionId = params.get("id");
      if (sessionId && inactiveClientIds.some(client => sessionId.startsWith(`${client}:`))) {
        for (const name of ["id", "message", "version", "mode", "page", "turn", "branch"]) params.delete(name);
        if (inactiveClientIds.some(client => params.get("client") === client)) params.delete("client");
        setSessionTarget(undefined);
        location.hash = params.size ? `#sessions?${params}` : "#sessions";
        return;
      }
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
    if (location.hash.startsWith("#map")) mapAddress.current = location.hash;
    if (location.hash.startsWith("#overview")) overviewAddress.current = location.hash;
    if (location.hash.startsWith("#resources")) resourceAddress.current = location.hash;
    if (location.hash.startsWith("#sessions")) sessionAddress.current = location.hash;
    if (location.hash.startsWith("#usage")) usageAddress.current = location.hash;
    if (location.hash.startsWith("#knowledge")) knowledgeAddress.current = location.hash;
    activateView(next); location.hash = next === "knowledge" ? knowledgeAddress.current : next === "overview" ? overviewAddress.current : next === "resources" ? resourceAddress.current : next === "sessions" ? sessionAddress.current : next === "usage" ? usageAddress.current : next === "map" ? mapAddress.current : next;
  };
  const openResourceSession = (target: SessionEvidenceTarget) => {
    resourceAddress.current = location.hash;
    setSessionTarget({ ...target, mode: "trace", branch: "all" }); activateView("sessions");
    location.hash = sessionNavigationAddress({ ...target, mode: "trace", branch: "all" });
  };
  const openOverviewSession = (target: OverviewSessionTarget) => {
    overviewAddress.current = location.hash;
    setSessionTarget({ ...target, mode: "trace", branch: "all" }); activateView("sessions");
    location.hash = sessionNavigationAddress({ ...target, mode: "trace", branch: "all" });
  };
  const openOverviewUsage = (hash: string) => { overviewAddress.current = location.hash; activateView("usage"); location.hash = hash; };
  const theme = useTheme(appearance);
  const history = useHistoryRefresh();
  const openMapSession = (target: SessionNavigationTarget) => {
    if (location.hash.startsWith("#usage")) usageAddress.current = location.hash;
    if (location.hash.startsWith("#map")) mapAddress.current = location.hash;
    setSessionTarget(target); activateView("sessions");
    location.hash = sessionNavigationAddress(target);
  };
  const map = useCodeMapPage({ active: view === "map", theme, onSession: openMapSession });
  const openMap = (path?: string, project?: string, session?: SessionSummary) => {
    if (location.hash.startsWith("#sessions")) sessionAddress.current = location.hash;
    map.openMap(path, project, session);
    activateView("map"); location.hash = "map";
  };
  const openReplay = (session: SessionSummary) => {
    if (location.hash.startsWith("#sessions")) sessionAddress.current = location.hash;
    const destination = map.openReplay(session);
    mapAddress.current = destination;
    activateView("map"); location.hash = destination;
  };
  const openOverviewMap = (target: OverviewMapTarget) => {
    overviewAddress.current = location.hash;
    map.openMap(target.path, target.project, undefined, target);
    activateView("map"); location.hash = "map";
  };
  return <Tooltip.Provider delayDuration={350}>
    <div ref={headerFrame}>
    <header className="app-header"><a className="brand" href="/" aria-label={t("codeMap.navigation.home")}><svg width="30" height="20" viewBox="8 16 48 32" fill="currentColor" aria-hidden="true" focusable="false"><path d="M14 18a3 3 0 0 0-4 2.8v22.4a3 3 0 0 0 4 2.8l10-6a2 2 0 0 0 1-1.8V25.8a2 2 0 0 0-1-1.8z" /><rect x="28" y="27" width="8" height="10" rx="2" /><path d="M14 18a3 3 0 0 0-4 2.8v22.4a3 3 0 0 0 4 2.8l10-6a2 2 0 0 0 1-1.8V25.8a2 2 0 0 0-1-1.8z" transform="translate(64 0) scale(-1 1)" /></svg><span>Agent<strong>Manor</strong></span></a><span className="header-divider" /><nav className="product-nav" aria-label={t("codeMap.navigation.title")}><SelectionIndicator value={view} selector='[aria-current="page"]' /><button aria-current={view === "overview" ? "page" : undefined} onClick={() => switchView("overview")}>{t("overview.title")}</button><button aria-current={view === "sessions" ? "page" : undefined} onClick={() => switchView("sessions")}>{t("codeMap.navigation.sessions")}</button><button className="knowledge-nav-button" aria-label={t("knowledge.title")} aria-description={t("knowledge.betaDescription")} aria-current={view === "knowledge" ? "page" : undefined} onClick={() => switchView("knowledge")}>{t("knowledge.title")}<span className="product-nav-beta" aria-hidden="true" title={t("knowledge.betaDescription")}>Beta</span></button><button aria-current={view === "map" ? "page" : undefined} onClick={() => switchView("map")}>{t("codeMap.navigation.map")}</button><button aria-current={view === "usage" ? "page" : undefined} onClick={() => switchView("usage")}>{t("usage.title")}</button><button aria-current={view === "resources" ? "page" : undefined} onClick={() => switchView("resources")}>{t("codeMap.navigation.resources")}</button></nav>
      <div className="header-actions">
        <AutoRefreshControl scope="sessions" />
        <HistoryRefreshControl busy={history.updating} starting={history.starting} onRetry={history.retry}
          job={history.job} autoSync={history.status?.autoSync} error={history.error} onRefresh={options => void history.refresh(options)} />
        <div className="header-display-actions">
          <SoftwareUpdates />
          <LanguageMenu />
          <AppearanceMenu />
          <Hint label={t("common.github.project")}><a className="icon-button header-github" href="https://github.com/lolipop-1x1/agent-manor" target="_blank" rel="noreferrer" aria-label={t("common.github.project")}><GithubLogo size={19} aria-hidden="true" /></a></Hint>
        </div>
      </div>
    </header>
    <LanguageNotice />
    {(history.error || !history.starting && (history.status?.autoSync?.error || history.job?.status === "failed")) && <div className="history-error" role="alert"><span>{history.error ? t("common.history.errorDetail", { operation: t(`common.history.operation.${history.errorOperation}`), detail: errorMessage(history.error) }) : history.status?.autoSync?.error ? messageText(history.status.autoSync.errorDescriptor, history.status.autoSync.error) : messageText(history.job?.errorDescriptor, history.job?.error ?? t("common.history.failed"))}</span><button className="text-button" onClick={history.retry}>{t("common.retry")}</button></div>}
    {map.maintenanceNotice}
    </div>
    <section className="product-view" hidden={view !== "overview"} aria-label={t("overview.title")}><Overview historyRevision={history.revision} active={view === "overview"} onSession={openOverviewSession} onUsage={openOverviewUsage} onMap={openOverviewMap} /></section>
    <section className="product-view" hidden={view !== "knowledge"} aria-label={t("knowledge.title")}><Knowledge active={view === "knowledge"} /></section>
    {map.page}
    <section className="product-view" hidden={view !== "sessions"} aria-label={t("codeMap.view.sessions")}><Sessions historyRevision={history.revision} historyUpdating={history.updating} onHistoryRefresh={options => void history.refresh(options)} active={view === "sessions"} target={sessionTarget} onMap={openMap} onReplay={openReplay} /></section>
    <section className="product-view" hidden={view !== "resources"} aria-label={t("codeMap.view.resources")}><Resources historyRevision={history.revision} active={view === "resources"} onSession={openResourceSession} /></section>
    <section className="product-view" hidden={view !== "usage"} aria-label={t("usage.title")}><Usage historyRevision={history.revision} active={view === "usage"} onSession={openMapSession} /></section>
  </Tooltip.Provider>;
}
