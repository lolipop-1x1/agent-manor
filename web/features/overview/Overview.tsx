import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowSquareOut, ArrowRight, WarningCircle } from "@phosphor-icons/react";
import type { OverviewCountRow, OverviewEvidenceQuery, OverviewPanel, OverviewReport, OverviewViewReport, OverviewResourceRow } from "../../../src/overview-contracts";
import { usageDimensionKey } from "../../../src/usage/dimensions";
import { CLIENTS, type Client } from "../../../src/clients";
import { ApiError, errorMessage, isAborted, request } from "../../shared/api";
import { clientLabel, useI18n } from "../../shared/i18n";
import { DatePicker } from "../../shared/ui/DatePicker";
import { FilterSelect } from "../../shared/ui/FilterSelect";
import { ProjectPicker } from "../../shared/ui/ProjectPicker";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { TokenAmount } from "../usage/TokenAmount";
import { composition } from "../usage/model";
import { ActivityCalendar, ActivityDistributions } from "./charts";
import { UsageTrend } from "./UsageTrend";
import { Investigation, type InvestigationSelection, type OverviewMapTarget, type OverviewSessionTarget } from "./Investigation";
import { defaultOverviewRoute, incomingOverviewRoute, overviewAddress, overviewParameters, overviewModelOptions, overviewQuery, readOverviewRoute, shortName, streakRange, validOverviewRange, type OverviewRoute, type OverviewWindow } from "./model";
import { loadOverviewPanels, loadOverviewPanel, visibleOverviewBatch, replaceOverviewPanel, selectOverviewDimension, visibleOverviewDistribution, OverviewSnapshotMismatch, type OverviewDistributionView, type OverviewPanelBatch } from "./loading";
import { CostAmount } from "./CostAmount";
import { WeeklyReview } from "./WeeklyReview";
import "./overview.css";

export default function Overview({ active, onSession, onUsage, onMap }: { active: boolean; onSession: (target: OverviewSessionTarget) => void; onUsage: (hash: string) => void; onMap: (target: OverviewMapTarget) => void }) {
  const { t, number, percent, message, date } = useI18n();
  const [route, setRoute] = useState(() => readOverviewRoute(location.hash));
  const lastAddress = useRef(location.hash), adoptingAddress = useRef(false);
  const [batch, setBatch] = useState<OverviewPanelBatch | null>(null);
  const distributionRoute = useRef(route.distribution); distributionRoute.current = route.distribution;
  const distributionListeners = useRef(new Set<() => void>());
  useEffect(() => { for (const listener of distributionListeners.current) listener(); }, [route.distribution]);
  const globalRequest = useRef<AbortController | null>(null);
  const [distributionView, setDistributionView] = useState<OverviewDistributionView | null>(null);
  const [distributionLoading, setDistributionLoading] = useState(false);
  const [distributionError, setDistributionError] = useState<Error | null>(null);
  const distributionFailureDimension = useRef<OverviewRoute["distribution"] | null>(null);
  const [distributionRetry, setDistributionRetry] = useState(0);
  const panelRetries = useRef(new Map<OverviewPanel, AbortController>());
  const [retrying, setRetrying] = useState<Partial<Record<OverviewPanel, boolean>>>({});
  const [panelErrors, setPanelErrors] = useState<Partial<Record<OverviewPanel, Error>>>({});
  const report = batch ? { ...batch.snapshot, ...Object.assign({}, ...Object.values(batch.panels).map(value => value?.data)) } as OverviewViewReport : null;
  const summary = report?.summary;
  const activity = report?.activity;
  const modelOptions = overviewModelOptions(report?.facets?.models, report?.usage?.facets.models, t("overview.unknown"));
  const counts = Object.assign({}, ...Object.values(batch?.panels ?? {}).map(value => value?.counts));
  const displayedDistribution = visibleOverviewDistribution(distributionView, batch, route.distribution);
  const distributionPending = !displayedDistribution || displayedDistribution.dimension !== route.distribution;
  useEffect(() => { if (displayedDistribution && !distributionPending) setDistributionView(displayedDistribution); }, [batch, route.distribution]);
  const ready = (panel: OverviewPanel) => Boolean(batch?.panels[panel]);
  const [queryDate, setQueryDate] = useState(() => new Date());
  const reportScope = useRef(""); const newSnapshot = useRef(true);
  const [loading, setLoading] = useState(false); const [error, setError] = useState<Error | null>(null); const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<InvestigationSelection | null>(null);
  const trigger = useRef<HTMLElement | null>(null);

  const query = overviewQuery(route, undefined, undefined, queryDate);
  const scopeKey = overviewParameters({ ...query, models: undefined });
  const key = overviewParameters(query); const invalid = !validOverviewRange(route); const busy = loading || Object.values(retrying).some(Boolean); const pending = invalid || Boolean(batch && (batch.key !== key || batch.complete && busy));
  useEffect(() => { setSelection(null); }, [key]);
  useEffect(() => { setRetrying({}); return () => { for (const controller of panelRetries.current.values()) controller.abort(); panelRetries.current.clear(); }; }, [key, revision, active]);
  useEffect(() => { if (batch?.complete && batch.key === key) { reportScope.current = scopeKey; newSnapshot.current = false; setError(null); } }, [batch]);
  const patch = (value: Partial<OverviewRoute>) => { if (["window", "from", "to", "clients", "projects"].some(field => field in value)) { newSnapshot.current = true; setQueryDate(new Date()); } setRoute(current => ({ ...current, ...value })); };
  useEffect(() => { const read = () => { if (location.hash.startsWith("#overview")) setRoute(readOverviewRoute(location.hash)); }; globalThis.addEventListener("hashchange", read); return () => globalThis.removeEventListener("hashchange", read); }, []);
  useEffect(() => {
    if (!active) return;
    if (location.hash && location.hash !== "#" && !location.hash.startsWith("#overview")) return;
    const incoming = incomingOverviewRoute(location.hash, lastAddress.current, route);
    lastAddress.current = location.hash; adoptingAddress.current = incoming !== null;
    if (incoming) { newSnapshot.current = true; setQueryDate(new Date()); setRoute(incoming); return; }
    const address = overviewAddress(route); lastAddress.current = address;
    history.replaceState(null, "", address);
  }, [active, route]);
  useEffect(() => {
    if (!active || invalid || adoptingAddress.current) return;
    setDistributionRetry(0); distributionFailureDimension.current = null;
    const controller = new AbortController(); globalRequest.current = controller; setLoading(true); setError(null); setPanelErrors({});
    const requestQuery = report && reportScope.current === scopeKey && !newSnapshot.current ? { ...query, anchorDay: report.query.anchorDay, version: report.version, priceVersion: report.priceVersion } : query;
    const failure = (value: unknown) => value instanceof OverviewSnapshotMismatch ? new ApiError("VERSION_MISMATCH", "", { key: "overview.evidence.versionExpired" }) : value instanceof Error ? value : new Error(String(value));
    void loadOverviewPanels(requestQuery, key, (path, signal) => request(path, { signal }), controller.signal,
      next => { if (!controller.signal.aborted) setBatch(current => visibleOverviewBatch(current, next)); },
      next => { if (!controller.signal.aborted) setBatch(current => visibleOverviewBatch(current, next)); },
      (panel, value) => { if (!controller.signal.aborted) { if (panel === "distribution") distributionFailureDimension.current = distributionRoute.current; setPanelErrors(current => ({ ...current, [panel]: failure(value) })); } },
      () => distributionRoute.current,
      listener => { distributionListeners.current.add(listener); return () => { distributionListeners.current.delete(listener); }; },
    ).then(result => { if (!controller.signal.aborted) { setBatch(result); reportScope.current = scopeKey; newSnapshot.current = false; } }).catch(value => { if (!controller.signal.aborted && !isAborted(value)) setError(failure(value)); }).finally(() => { if (!controller.signal.aborted) { globalRequest.current = null; setLoading(false); } });
    return () => { controller.abort(); if (globalRequest.current === controller) globalRequest.current = null; };
  }, [active, key, revision, invalid]);
  const inspect = useCallback((next: InvestigationSelection, origin?: HTMLElement) => { trigger.current = origin ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null); setSelection(next); }, []);
  const evidence = (value: OverviewEvidenceQuery, title: string) => inspect({ view: "evidence", title, evidence: value });
  const refresh = () => { newSnapshot.current = true; setQueryDate(new Date()); setSelection(null); setRevision(value => value + 1); };
  const retryPanel = (panel: OverviewPanel) => {
    if (!batch || batch.complete || batch.key !== key) { refresh(); return; }
    panelRetries.current.get(panel)?.abort();
    const controller = new AbortController(), snapshot = batch.snapshot;
    panelRetries.current.set(panel, controller); setRetrying(current => ({ ...current, [panel]: true }));
    setPanelErrors(current => { const next = { ...current }; delete next[panel]; return next; });
    void loadOverviewPanel(snapshot, panel, (path, signal) => request(path, { signal }), controller.signal, panel === "distribution" && batch.dimension !== "tool" ? batch.dimension : undefined).then(result => {
      if (controller.signal.aborted) return;
      setBatch(current => current?.key === batch.key ? replaceOverviewPanel(current, snapshot, result) : current);
    }).catch(value => { if (!controller.signal.aborted && !isAborted(value)) { const failure = value instanceof OverviewSnapshotMismatch ? new ApiError("VERSION_MISMATCH", "", { key: "overview.evidence.versionExpired" }) : value instanceof Error ? value : new Error(String(value)); setPanelErrors(current => ({ ...current, [panel]: failure })); setError(failure); } }).finally(() => { if (!controller.signal.aborted) { panelRetries.current.delete(panel); setRetrying(current => ({ ...current, [panel]: false })); } });
  };
  useEffect(() => {
    setDistributionError(null);
    if (!active || !batch || batch.key !== key || globalRequest.current || loading) { setDistributionLoading(false); return; }
    if (!batch.complete && batch.dimension !== route.distribution) setBatch(current => current === batch ? selectOverviewDimension(current, route.distribution) : current);
    if (route.distribution === "tool" || batch.distributions[route.distribution]) { setDistributionLoading(false); return; }
    if (panelErrors.distribution && !distributionRetry && route.distribution === distributionFailureDimension.current) { setDistributionLoading(false); setDistributionError(panelErrors.distribution); return; }
    const controller = new AbortController(), snapshot = batch.snapshot, dimension = route.distribution;
    setDistributionLoading(true);
    void loadOverviewPanel(snapshot, "distribution", (path, signal) => request(path, { signal }), controller.signal, dimension).then(result => {
      if (!controller.signal.aborted) setBatch(current => current?.key === key ? replaceOverviewPanel({ ...current, dimension }, snapshot, result) : current);
    }).catch(value => { if (!controller.signal.aborted && !isAborted(value)) setDistributionError(value instanceof OverviewSnapshotMismatch ? new ApiError("VERSION_MISMATCH", "", { key: "overview.evidence.versionExpired" }) : value instanceof Error ? value : new Error(String(value))); }).finally(() => { if (!controller.signal.aborted) setDistributionLoading(false); });
    return () => controller.abort();
  }, [active, key, revision, batch?.snapshot, route.distribution, loading, distributionRetry]);
  const n = (value: number | null | undefined) => value == null ? "—" : number(value);
  const cost = (value: number | null | undefined) => value == null ? "—" : number(value, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", maximumFractionDigits: 2 });
  const client = (value: string) => CLIENTS.some(item => item.id === value) ? clientLabel(value as Client) : value;
  const help = (kind: string) => <HelpPopover label={t(`overview.${kind}.title`)} iconOnly><p>{t(`overview.help.${kind === "skill" || kind === "mcp" ? "resources" : kind === "distribution" ? "usage" : kind}`)}</p></HelpPopover>;
  const sectionTitle = (kind: string, actions?: React.ReactNode) => <div className="overview-section-heading"><div><h2>{t(`overview.${kind}.title`)}</h2>{help(kind)}</div>{actions}</div>;
  const resourceName = (row: OverviewResourceRow) => message(row.nameDescriptor, row.name);
  const waiting = (panel: OverviewPanel, kind: string) => <section className="overview-section">{sectionTitle(kind)}{panelErrors[panel] ? <div className="overview-error" role="alert"><span>{errorMessage(panelErrors[panel])}</span><button className="text-button" disabled={loading} onClick={() => retryPanel(panel)}>{t("overview.retry")}</button></div> : <div className="overview-panel-placeholder" role="status" aria-label={t("overview.loading")}><ArrowClockwise size={16} className="is-spinning" /></div>}</section>;
  const resourceTable = (kind: "skill" | "mcp", resources: OverviewReport["resources"], range: OverviewReport["range"]) => {
    const rows = kind === "skill" ? resources.skills : resources.mcp;
    return <section className="overview-section">{sectionTitle(kind, <div className="overview-section-actions"><button className="text-button" onClick={() => inspect({ view: "resources", title: t(`overview.${kind}.title`), kind })}>{t("overview.viewAll")}</button></div>)}<div className="overview-table-scroll"><table className="overview-table overview-resource-table"><thead><tr><th>{t("overview.resource.name")}</th><th>{t("overview.metric.count")}</th><th>{t("overview.metric.sessionCount")}</th><th>{t("overview.resource.trend")}</th></tr></thead><tbody>{rows.slice(0, 5).map(row => <tr key={row.id}><td><button className="text-button" title={resourceName(row)} onClick={() => inspect({ view: "resource", title: resourceName(row), resource: row })}>{resourceName(row)}</button></td><td className="overview-number"><button className="text-button" onClick={() => evidence({ kind: "resources", resourceId: row.id }, resourceName(row))}>{n(row.uses)}</button></td><td className="overview-number">{n(row.sessions)}</td><td>{row.days.length ? <ResourceTrend days={row.days} from={range.from} to={range.to} /> : "—"}</td></tr>)}</tbody></table></div>{!rows.length && <div className="overview-empty">{t("overview.empty.section")}</div>}</section>;
  };
  const shownDimension = displayedDistribution?.dimension ?? route.distribution;
  const groups = displayedDistribution?.rows ?? [];
  const distributionValue = (row: OverviewCountRow) => shownDimension === "tool" ? row.count : route.metric === "tokens" ? row.tokens : route.metric === "cost" ? row.estimatedCost : row.requests ?? row.count;
  const ranking = [...groups].sort((a, b) => (distributionValue(b) ?? -1) - (distributionValue(a) ?? -1));
  const rankMax = Math.max(1, ...ranking.map(row => distributionValue(row) ?? 0));
  const openUsage = () => { if (!report) return; onUsage(`#usage?${overviewParameters({ window: "custom", from: report.range.from, to: report.range.to, clients: report.query.clients, projects: report.query.projects, models: report.query.models, metric: route.metric, groupBy: route.distribution === "tool" ? "model" : route.distribution, version: report.version, priceVersion: report.priceVersion })}`); };
  return <main className="overview-page">
    <div className="overview-page-heading"><h1>{t("overview.title")}</h1><div><HelpPopover label={t("overview.help")}><p>{t("overview.help.global")}</p>{report && <><p>{t("overview.help.versions", { version: report.version, priceVersion: report.priceVersion, timezone: report.timezone })}</p>{report.totals && <p>{t("overview.help.coverage", { complete: report.totals.completeTokenRequests, partial: report.totals.partialTokenRequests, missing: report.totals.missingTokenRequests, priced: report.totals.pricedRequests, partiallyPriced: report.totals.partiallyPricedRequests, unpriced: report.totals.unpricedRequests })}</p>}</>}</HelpPopover><button className="overview-refresh" onClick={refresh} disabled={busy} aria-label={t("overview.refresh")}><ArrowClockwise size={17} className={busy ? "is-spinning" : undefined} /><span>{t("overview.refresh")}</span></button></div></div>
    <div className="overview-filters"><div className="overview-date-controls"><FilterSelect label={t("overview.filter.date")} value={route.window} options={["365", "7", "30", "90", "year", "all", "custom"].map(value => ({ value, label: t(`overview.window.${value}`) }))} onChange={value => patch({ window: value as OverviewWindow })} />{route.window === "custom" && <><DatePicker label={t("overview.filter.from")} value={route.from ?? ""} onChange={from => patch({ from: from || undefined })} /><span>–</span><DatePicker label={t("overview.filter.to")} value={route.to ?? ""} onChange={to => patch({ to: to || undefined })} /></>}</div><FilterSelect label={t("overview.filter.client")} value={route.clients?.[0] ?? "__all__"} options={[{ value: "__all__", label: t("overview.filter.allClients") }, ...(report?.facets?.clients ?? CLIENTS.map(item => item.id)).map(value => ({ value, label: client(value) }))]} onChange={value => patch({ clients: value === "__all__" ? undefined : [value] })} /><ProjectPicker label={t("overview.filter.project")} value={route.projects?.[0] ?? "__all__"} options={[{ value: "__all__", label: t("common.project.all") }, ...(report?.facets?.projects ?? []).map(value => ({ value: usageDimensionKey(value), label: shortName(value), description: value }))]} onChange={value => patch({ projects: value === "__all__" ? undefined : [value] })} />{(route.clients?.length || route.projects?.length) ? <button className="text-button" onClick={() => patch({ clients: undefined, projects: undefined })}>{t("overview.clear")}</button> : null}</div>
    {invalid && <div className="overview-error" role="alert">{t("overview.filter.invalidRange")}</div>}{error && <div className="overview-error" role="alert"><WarningCircle size={17} /><span>{errorMessage(error)}</span><button className="text-button" onClick={refresh}>{t("overview.retry")}</button></div>}
    {!report && !error && <div className="overview-loading" role="status" aria-label={t("overview.loading")}><div className="overview-skeleton-metrics">{Array.from({ length: 6 }, (_, index) => <div key={index}><i /><i /></div>)}</div><div className="overview-skeleton-chart" /><span>{t("overview.loading")}</span></div>}
    {report && <div className="overview-results" aria-busy={pending}><div className="overview-range"><span>{date(new Date(`${report.range.from}T12:00:00`))} – {date(new Date(`${report.range.to}T12:00:00`))}</span><span className="overview-progress" role="status" aria-label={busy ? t("overview.loading") : undefined}>{busy && <ArrowClockwise size={16} className="is-spinning" />}</span></div><div className="overview-report-body" inert={pending}>
      {summary && activity ? <div className="overview-metrics">{[
        { label: "overview.metric.sessions", value: n(summary.sessions), query: { kind: "sessions" } },
        { label: "overview.metric.requests", value: n(summary.requests), query: { kind: "requests", scope: "global" } },
        { label: summary.tokenCoverage === "partial" ? "overview.metric.tokenSubtotal" : "overview.metric.tokens", value: <TokenAmount value={summary.tokens} />, query: { kind: "requests", scope: "global", sort: "tokens" } },
        { label: summary.costCoverage === "partial" ? "overview.metric.costSubtotal" : "overview.metric.cost", value: cost(summary.estimatedCost), query: { kind: "requests", scope: "global" } },
        { label: "overview.metric.activeDays", value: n(summary.activeDays), query: { kind: "activity" } },
        { label: report.range.includesToday ? "overview.metric.currentStreak" : "overview.metric.rangeStreak", value: n(summary.currentStreak), query: { kind: "activity", ...streakRange(activity.days, report.range) } },
      ].map(item => <button key={item.label} onClick={() => evidence(item.query as OverviewEvidenceQuery, t(item.label))}><span>{t(item.label)}</span><strong>{item.value}</strong></button>)}</div> : <div className="overview-skeleton-metrics" aria-hidden={Boolean(panelErrors.core)} aria-label={panelErrors.core ? undefined : t("overview.loading")} role={panelErrors.core ? undefined : "status"}>{Array.from({ length: 6 }, (_, index) => <div key={index}><i /><i /></div>)}</div>}
      {summary && !summary.sessions && <div className="overview-empty overview-empty-range"><span>{t("overview.empty")}</span><button className="text-button" onClick={() => setRoute(defaultOverviewRoute())}>{t("overview.empty.adjust")}</button></div>}
    </div></div>}
    <WeeklyReview active={active} clients={route.clients} projects={route.projects} revision={revision} onSession={onSession} />
    {report && <div className="overview-report-body" inert={pending}>
      <div className="overview-main-row overview-activity-row">{activity ? <section className="overview-section overview-activity">{sectionTitle("activity", <FilterSelect label={t("overview.activity.metric")} value={route.activity} options={["sessions", "requests", "tokens", "tools"].map(value => ({ value, label: t(`overview.metric.${value}`) }))} onChange={activity => patch({ activity: activity as OverviewRoute["activity"] })} />)}<ActivityCalendar report={{ range: report.range, activity }} metric={route.activity} onDay={day => evidence({ kind: "activity", day }, t("overview.activity.dayDetails"))} onRange={day => patch({ window: "custom", from: day, to: day })} /><ActivityDistributions report={{ activity }} /></section> : waiting("core", "activity")}
      </div>
      <div className="overview-analysis-row">{report.usage ? <section className="overview-section">{sectionTitle("usage", <button className="text-button" onClick={openUsage}><ArrowSquareOut size={14} />{t("overview.openUsage")}</button>)}<div className="overview-local-controls"><FilterSelect label={t("overview.usage.metric")} value={route.metric} options={["tokens", "cost", "requests"].map(value => ({ value, label: t(`overview.metric.${value}`) }))} onChange={metric => patch({ metric: metric as OverviewRoute["metric"] })} /><FilterSelect label={t("overview.usage.interval")} value={route.interval} options={["day", "week", "month"].map(value => ({ value, label: t(`overview.usage.${value}`) }))} onChange={interval => patch({ interval: interval as OverviewRoute["interval"] })} /><ProjectPicker label={t("overview.filter.model")} value={route.models?.[0] ?? "__all__"} options={[{ value: "__all__", label: t("overview.all") }, ...modelOptions]} onChange={value => patch({ models: value === "__all__" ? undefined : [value] })} /></div><UsageTrend disabled={pending} report={{ range: report.range, usage: report.usage }} route={route} onBucket={(from, to) => evidence({ kind: "requests", scope: "usage", from, to }, t("overview.usage.title"))} /><div className="overview-composition"><div className="overview-composition-bar" aria-label={t("overview.usage.composition")}>{composition(report.usage.totals).map((item, index) => <span key={item.key} style={{ flexGrow: item.value ?? 0, background: `var(--overview-series-${index})` }} />)}</div><dl>{composition(report.usage.totals).map((item, index) => <div key={item.key}><dt><i style={{ background: `var(--overview-series-${index})` }} />{t(`usage.composition.${item.key}`)}</dt><dd><TokenAmount value={item.value} /></dd></div>)}<div><dt>{t("overview.usage.cacheRatio")}</dt><dd>{report.usage.totals.cacheReadRatio == null ? "—" : percent(report.usage.totals.cacheReadRatio)}</dd></div></dl></div></section> : waiting("usage", "usage")}
      <section className="overview-section" aria-busy={distributionPending || distributionLoading}>{sectionTitle("distribution", <button className="text-button" disabled={distributionPending || distributionLoading} onClick={() => inspect({ view: "ranking", title: t("overview.distribution.all"), dimension: route.distribution, metric: route.metric })}>{t("overview.viewAll")}</button>)}<div className="overview-local-controls"><FilterSelect label={t("overview.distribution.dimension")} value={route.distribution} options={["project", "client", "model", "tool"].map(value => ({ value, label: t(`overview.distribution.${value}`) }))} onChange={distribution => patch({ distribution: distribution as OverviewRoute["distribution"] })} /><span className="overview-progress" role="status" aria-label={distributionPending && !distributionError ? t("overview.loading") : undefined}>{distributionPending && !distributionError && <ArrowClockwise size={16} className="is-spinning" />}</span></div>
      {distributionError && <div className="overview-error" role="alert"><span>{errorMessage(distributionError)}</span><button className="text-button" onClick={() => setDistributionRetry(value => value + 1)}>{t("overview.retry")}</button></div>}
      <div inert={distributionPending || distributionLoading}><div className="overview-ranking">{ranking.slice(0, 8).map(row => {
        const name = message(row.nameDescriptor, row.name);
        const investigate = () => evidence({ kind: shownDimension === "tool" ? "tools" : "requests", scope: shownDimension === "tool" ? "global" : "usage", ...(shownDimension === "project" ? { project: row.key } : shownDimension === "client" ? { client: row.key } : shownDimension === "model" ? { model: row.key } : { toolId: row.key }) }, name);
        const value = shownDimension !== "tool" && route.metric === "tokens" ? <TokenAmount value={row.tokens} /> : n(distributionValue(row));
        const content = <><span className="overview-rank-name" title={name}>{shownDimension === "project" ? shortName(name) : shownDimension === "client" ? client(row.name) : name}</span><span className="overview-rank-bar"><i style={{ width: `${(distributionValue(row) ?? 0) / rankMax * 100}%` }} /></span></>;
        return shownDimension !== "tool" && route.metric === "cost" ? <div className="overview-rank-row" key={row.key} role="group" aria-label={name}><button className="overview-rank-investigate" onClick={investigate}>{content}</button><span className="overview-number"><CostAmount value={row.estimatedCost} coverage={row.costCoverage} onInspect={investigate} /></span></div> : <button key={row.key} onClick={investigate}>{content}<span className="overview-number">{value}</span></button>;
      })}</div>{displayedDistribution && !ranking.length && <div className="overview-empty">{t("overview.empty.section")}</div>}{!displayedDistribution && <div className="overview-panel-placeholder" />}</div></section></div>
      <div className="overview-analysis-row">{report.resources ? resourceTable("skill", report.resources, report.range) : waiting("resources", "skill")}{report.resources ? resourceTable("mcp", report.resources, report.range) : waiting("resources", "mcp")}</div>
      <div className="overview-resource-actions" inert={!ready("resources")}><button className="text-button" onClick={() => inspect({ view: "observations", title: t("overview.resource.observations") })}>{t("overview.resource.observations")}<ArrowRight size={14} /></button><button className="text-button" onClick={() => inspect({ view: "combinations", title: t("overview.resource.combinations"), unit: route.combinationUnit })}>{t("overview.resource.combinations")}<ArrowRight size={14} /></button></div>
      <div className="overview-analysis-row">{report.process ? <section className="overview-section">{sectionTitle("process", <FilterSelect label={t("overview.process.kind")} value={route.process} options={["failures", "compressions", "timing"].map(value => ({ value, label: t(`overview.process.${value}`) }))} onChange={process => patch({ process: process as OverviewRoute["process"] })} />)}
      {route.process === "failures" && <><dl className="overview-detail-metrics"><div><dt>{t("overview.process.failures")}</dt><dd><button className="text-button" onClick={() => evidence({ kind: "failures" }, t("overview.process.failures"))}>{n(report.process.failures)}</button></dd></div><div><dt>{t("overview.process.knownRate")}</dt><dd>{report.process.results.failureRate == null ? "—" : percent(report.process.results.failureRate)}</dd></div><div><dt>{t("overview.process.resultCoverage")}</dt><dd>{report.process.results.coverage == null ? "—" : percent(report.process.results.coverage)}</dd></div></dl><div className="overview-process-list">{[...report.process.tools].filter(tool => tool.results.failure > 0).sort((a, b) => b.results.failure - a.results.failure).slice(0, 5).map(tool => <button key={tool.key} onClick={() => evidence({ kind: "failures", toolId: tool.key }, tool.name)}><span>{tool.name}</span><span className="overview-failure-count">{n(tool.results.failure)}</span><ArrowRight size={14} /></button>)}</div><button className="text-button" onClick={() => evidence({ kind: "sequence", sort: "ordinal" }, t("overview.process.followups"))}>{t("overview.process.followups")}</button></>}
      {route.process === "compressions" && <><dl className="overview-detail-metrics"><div><dt>{t("overview.process.compressions")}</dt><dd>{n(report.process.compressions)}</dd></div><div><dt>{t("overview.metric.sessionCount")}</dt><dd>{n(report.process.compressionSessions)}</dd></div></dl><button className="text-button" onClick={() => evidence({ kind: "compressions" }, t("overview.process.compressions"))}>{t("overview.records")}</button></>}
      {route.process === "timing" && <button className="text-button" onClick={() => inspect({ view: "timings", title: t("overview.process.timing") })}>{t("overview.timing.distribution")}<ArrowRight size={14} /></button>}</section> : waiting("process", "process")}

      {summary && activity ? <section className="overview-section">{sectionTitle("profile")}<dl className="overview-profile">{[
        ["projects", summary.projectCount, { kind: "sessions" }], ["models", summary.modelCount, { kind: "requests", scope: "global" }], ["longestStreak", summary.longestStreak, { kind: "activity", ...streakRange(activity.days, report.range, true) }], ["peakTokens", summary.peak?.tokens ?? null, { kind: "requests", scope: "global", sort: "tokens", requestId: summary.peak?.requestId, sessionId: summary.peak?.sessionId }], ["skillKinds", counts.skills, { kind: "resources", resourceKind: "skill" }], ["mcpKinds", counts.mcp, { kind: "resources", resourceKind: "mcp" }], ["crossDay", activity.crossDaySessions, { kind: "sessions", rule: "13" }], ["delegation", report.delegationSummary?.withChildActivity, { kind: "delegation" }],
      ].map(([name, value, query]) => <div key={name as string}><dt>{t(`overview.profile.${name}`)}</dt><dd><button className="text-button" disabled={value === undefined} onClick={() => name === "projects" ? inspect({ view: "ranking", title: t(`overview.profile.${name}`), dimension: "project" }) : evidence(query as OverviewEvidenceQuery, t(`overview.profile.${name}`))}>{name === "peakTokens" ? <TokenAmount value={value as number | null} /> : n(value as number)}</button></dd></div>)}</dl></section> : waiting("core", "profile")}</div>
      {report.repositories ? <section className="overview-section overview-repositories">{sectionTitle("repositories")}<div className="overview-table-scroll"><table className="overview-table overview-repository-table"><thead><tr><th>{t("overview.repositories.name")}</th><th>{t("overview.repositories.read")}</th><th>{t("overview.repositories.edit")}</th><th>{t("overview.repositories.coverage")}</th><th>{t("overview.repositories.hotspots")}</th><th aria-label={t("overview.openMap")} /></tr></thead><tbody>{report.repositories.map(row => <tr key={row.repository.id}><td><button className="text-button" onClick={() => inspect({ view: "repository", title: row.repository.name, repository: row })}>{row.repository.name}</button>{row.state !== "ready" || row.repository.stale ? <span className="overview-repository-state">{t(row.state !== "ready" ? "overview.repositories.unready" : "overview.repositories.stale")}</span> : null}</td><td className="overview-number">{n(row.activity?.read)}</td><td className="overview-number">{n(row.activity?.edit)}</td><td className="overview-number">{row.summary ? `${n(row.readCoveredFiles)} / ${n(row.summary.fileCount)}` : "—"}</td><td><button className="text-button" disabled={row.state !== "ready"} onClick={() => inspect({ view: "repository", title: row.repository.name, repository: row })}>{t("overview.inspect")}</button></td><td><button className="text-button" onClick={() => onMap({ repositoryId: row.repository.id, project: row.repository.path, version: row.version, from: report.range.from, to: report.range.to, clients: report.query.clients })}><ArrowSquareOut size={14} />{t("overview.openMap")}</button></td></tr>)}</tbody></table></div>{!report.repositories.length && <div className="overview-empty">{t("overview.repositories.empty")}</div>}</section> : waiting("repositories", "repositories")}
    </div>}
    {report && <Investigation active={active} report={report} selection={selection} pending={pending} returnFocus={trigger} onSelect={setSelection} onClose={() => setSelection(null)} onReload={refresh} onSession={onSession} onMap={onMap} />}
  </main>;
}
function ResourceTrend({ days, from, to }: { days: { day: string; uses: number }[]; from: string; to: string }) {
  const start = Date.parse(`${from}T00:00:00Z`); const span = Math.max(1, Date.parse(`${to}T00:00:00Z`) - start + 86_400_000);
  const buckets = Array.from({ length: 12 }, () => 0);
  for (const day of days) { const index = Math.max(0, Math.min(11, Math.floor((Date.parse(`${day.day}T00:00:00Z`) - start) / span * 12))); buckets[index] = (buckets[index] ?? 0) + day.uses; }
  const max = Math.max(1, ...buckets);
  return <span className="overview-resource-trend" aria-hidden="true">{buckets.map((value, index) => <i key={index} style={{ height: `${value / max * 20}px` }} />)}</span>;
}
