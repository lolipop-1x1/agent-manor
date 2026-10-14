import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ArrowClockwise, ArrowSquareOut, CaretDown, Funnel, WarningCircle, X } from "@phosphor-icons/react";
import type { SessionIndexSummary } from "../../../src/session-contracts";
import type { PricingStatus, UsageGroup, UsageInterval, UsageMetric, UsagePreparationStatus, UsageQuery, UsageReport, UsageRequestPage } from "../../../src/usage-contracts";
import { CLIENTS } from "../../../src/clients";
import { usageDimensionValue } from "../../../src/usage/dimensions";
import { ApiError, errorMessage, isAborted, request } from "../../shared/api";
import { clientLabel, useI18n } from "../../shared/i18n";
import { DatePicker } from "../../shared/ui/DatePicker";
import { FilterSelect } from "../../shared/ui/FilterSelect";
import { availableClientOptions } from "../../shared/ui/client-options";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { MultiFilterPicker } from "../../shared/ui/MultiFilterPicker";
import { ResourcePagination } from "../../shared/ui/ResourcePagination";
import { sessionDisplayTitle } from "../sessions/session-model";
import { activeFilterCount, defaultRoute, incomingUsageRoute, readUsageRoute, speedSelectionToSync, usageAddress, usageParameters, usageQuery, type DateWindow, type UsageRoute } from "./model";
import { UsageMetrics } from "./UsageMetrics";
import { TokenAmount } from "./TokenAmount";
import { PricingManager } from "./PricingManager";
import { UsageRequestDialog } from "./UsageRequestDialog";
import { groupLabel, UsageCharts } from "./UsageCharts";
import "./usage.css";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import { useHistoryRevision } from "../../shared/refresh/useHistoryRefresh";

export default function Usage({ active, onSession, historyRevision = 0 }: { historyRevision?: number; active: boolean; onSession: (target: { sessionId: string; messageId?: string }) => void }) {
  const { t, number, date, dateTime, message, language } = useI18n();
  const [route, setRoute] = useState(() => readUsageRoute(location.hash));
  const lastAddress = useRef(location.hash), adoptingAddress = useRef(false);
  const [revision, setRevision] = useState(0);
  const [completedAt, setCompletedAt] = useState<string>();
  const [versions, setVersions] = useState<{ index: string; price: string } | null>(null);
  const [pricing, setPricing] = useState<PricingStatus | null>(null);
  const [report, setReport] = useState<UsageReport | null>(null);
  const loadedQuery = useRef("");
  const synchronizedQuery = useRef("");
  const [facets, setFacets] = useState<UsageReport["facets"]>({ clients: [], projects: [], models: [] });
  const [error, setError] = useState<Error | null>(null); const [loading, setLoading] = useState(false);
  const [preparation, setPreparation] = useState<{ queryKey: string; status: UsagePreparationStatus } | null>(null);
  const [requests, setRequests] = useState<UsageRequestPage | null>(null); const [requestError, setRequestError] = useState<Error | null>(null); const [requestLoading, setRequestLoading] = useState(false);
  const [pricesOpen, setPricesOpen] = useState(false);
  const [requestRevision, setRequestRevision] = useState(0);
  const requestTrigger = useRef<HTMLElement | null>(null);
  const patch = (value: Partial<UsageRoute>, reset = true) => setRoute(current => ({ ...current, ...(reset ? { page: 1, selectedSession: undefined, requestPage: 1 } : {}), ...value }));
  const refresh = () => { patch({ version: undefined, priceVersion: undefined }, false); setRevision(current => current + 1); };
  useHistoryRevision(active, historyRevision, refresh);
  useEffect(() => {
    const navigate = () => { if (location.hash.startsWith("#usage")) setRoute(readUsageRoute(location.hash)); };
    globalThis.addEventListener("hashchange", navigate); return () => globalThis.removeEventListener("hashchange", navigate);
  }, []);
  useEffect(() => {
    if (!active || !location.hash.startsWith("#usage")) return;
    const incoming = incomingUsageRoute(location.hash, lastAddress.current, route);
    lastAddress.current = location.hash; adoptingAddress.current = incoming !== null;
    if (incoming) { setRoute(incoming); return; }
    const address = usageAddress(route); lastAddress.current = address;
    history.replaceState(null, "", address);
  }, [active, route]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); setLoading(true); setError(null);
    void Promise.all([request<SessionIndexSummary>("/sessions/status?summary=true", { signal: controller.signal }), request<PricingStatus>("/usage/pricing", { signal: controller.signal })]).then(([index, prices]) => {
      if (controller.signal.aborted) return;
      setPricing(prices);
      if (!index.version) { setReport(null); setVersions(null); setError(new ApiError("INDEX_NOT_READY", "", { key: "usage.notReady" })); setLoading(false); return; }
      setVersions({ index: index.version, price: prices.version });
    }).catch(failure => { if (!isAborted(failure)) { setError(failure instanceof Error ? failure : new ApiError("QUERY_FAILED", "", { key: "common.error.query" })); setLoading(false); } });
    return () => controller.abort();
    // 语言切换只重绘文案，不重复统计查询。
  }, [active, revision]);
  const query = useMemo(() => versions ? usageQuery(route, versions.index, versions.price) : null, [route, versions]);
  const queryKey = query ? usageParameters(query) : "";
  const invalid = route.minTokens !== undefined && route.maxTokens !== undefined && route.minTokens > route.maxTokens
    || route.minCost !== undefined && route.maxCost !== undefined && route.minCost > route.maxCost
    || route.window === "custom" && !!route.from && !!route.to && route.from > route.to;
  useEffect(() => {
    setPreparation(null);
    if (invalid) { setLoading(false); return; }
    if (!active || !queryKey || adoptingAddress.current) return;
    if (synchronizedQuery.current === queryKey) { synchronizedQuery.current = ""; return; }
    const controller = new AbortController(); setLoading(true); setError(null);
    const statusController = new AbortController();
    const parameters = new URLSearchParams(queryKey);
    const identity = new URLSearchParams();
    for (const key of ["version", "priceVersion", "timezone"]) { const value = parameters.get(key); if (value) identity.set(key, value); }
    let pending = true;
    let timer: ReturnType<typeof globalThis.setTimeout>;
    const stopPreparation = () => { pending = false; globalThis.clearTimeout(timer); statusController.abort(); };
    const fail = (failure: unknown) => {
      if (controller.signal.aborted || isAborted(failure)) return;
      stopPreparation(); setPreparation(null);
      setError(failure instanceof Error ? failure : new ApiError("QUERY_FAILED", "", { key: "common.error.query" })); setLoading(false);
      controller.abort();
    };
    const pollPreparation = async () => {
      try {
        const status = await request<UsagePreparationStatus>(`/usage/status?${identity}`, { signal: statusController.signal });
        if (!pending || statusController.signal.aborted) return;
        const matches = status.version === identity.get("version") && status.priceVersion === identity.get("priceVersion") && status.timezone === identity.get("timezone");
        if (matches && status.state === "failed") { fail(new ApiError("USAGE_PREPARATION_FAILED", "", { key: "usage.preparing.failed" })); return; }
        setPreparation(matches && status.state === "preparing" ? { queryKey, status } : null);
        if (matches && status.state === "ready") { stopPreparation(); return; }
        timer = globalThis.setTimeout(() => { void pollPreparation(); }, 1000);
      } catch (failure) { if (pending) fail(failure); }
    };
    // 轻量查询不轮询；报告仍在等待时才检查相同版本的后台准备状态。
    timer = globalThis.setTimeout(() => { void pollPreparation(); }, 1000);
    void request<UsageReport>(`/usage?${queryKey}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      stopPreparation(); setPreparation(null);
      loadedQuery.current = queryKey;
      const speedGroups = query?.includeSpeed && result.speed ? speedSelectionToSync(query.speedGroups, result.speed.selectedGroups) : undefined;
      if (query && speedGroups) {
        // 服务端回退的分组与完整报告一起采纳，地址同步不再重复查询。
        loadedQuery.current = usageParameters({ ...query, speedGroups });
        synchronizedQuery.current = loadedQuery.current;
        setRoute(current => versions && usageParameters(usageQuery(current, versions.index, versions.price)) === queryKey ? { ...current, speedGroups, speedGroup: undefined } : current);
      }
      setReport(result); setCompletedAt(new Date().toISOString()); setFacets(result.facets); setLoading(false);
    }).catch(fail);
    return () => { controller.abort(); stopPreparation(); };
  }, [active, queryKey, invalid, revision]);
  useEffect(() => {
    if (!active || !pricing?.refreshing) return;
    const controller = new AbortController(); const timer = globalThis.setTimeout(() => {
      void request<PricingStatus>("/usage/pricing", { signal: controller.signal }).then(value => { if (controller.signal.aborted) return; setPricing(value); setVersions(current => current && value.version !== current.price ? { ...current, price: value.version } : current); }).catch(() => { /* 统计仍使用已确认价格，显式更新可重试。 */ });
    }, 1000);
    return () => { globalThis.clearTimeout(timer); controller.abort(); };
  }, [active, pricing]);
  const requestQueryKey = route.selectedSession && report ? usageParameters({ ...report.query, sessionId: route.selectedSession, requestPage: route.requestPage ?? 1, requestPageSize: 20 }) : "";
  useEffect(() => {
    setRequests(null); setRequestError(null);
    if (!active || !requestQueryKey) { setRequestLoading(false); return; }
    const controller = new AbortController(); setRequestLoading(true);
    void request<UsageRequestPage>(`/usage/requests?${requestQueryKey}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setRequests(result); setRequestLoading(false); } }).catch(failure => { if (!isAborted(failure)) { setRequestError(failure instanceof Error ? failure : new ApiError("QUERY_FAILED", "", { key: "common.error.query" })); setRequestLoading(false); } });
    return () => controller.abort();
  }, [active, requestQueryKey, requestRevision]);
  const updatePrice = useCallback((value: PricingStatus) => { setPricing(value); setVersions(current => current ? { ...current, price: value.version } : current); }, []);
  const value = (amount: number | null | undefined, cost = false) => amount == null ? "—" : number(amount, cost ? { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: 2 } : {});
  const metric = report?.query.metric ?? route.metric ?? "tokens";
  const group = report?.query.groupBy ?? route.groupBy ?? "model";
  const speed = report?.query.includeSpeed === true;
  const labels = (values: string[], kind: UsageGroup) => values.map(item => { const original = usageDimensionValue(item); return { value: item, label: kind === "project" && original !== undefined ? original.split(/[\\/]/).filter(Boolean).at(-1) ?? original : groupLabel(item, kind, t("usage.unknown")), ...(kind === "project" && original !== undefined ? { description: original } : {}) }; });
  useEffect(() => {
    if (!active || !report || loading || loadedQuery.current !== queryKey) return;
    const clients = route.clients?.filter(value => facets.clients.includes(value)), excludeClients = route.excludeClients?.filter(value => facets.clients.includes(value));
    if (clients?.length !== route.clients?.length || excludeClients?.length !== route.excludeClients?.length) patch({ clients: clients?.length ? clients : undefined, excludeClients: excludeClients?.length ? excludeClients : undefined });
  }, [active, report, queryKey, loading, facets.clients, route.clients, route.excludeClients]);
  const filterDefinitions = [
    { include: "clients", exclude: "excludeClients", kind: "client", label: "usage.filter.clients", options: availableClientOptions(facets.clients) },
    { include: "projects", exclude: "excludeProjects", kind: "project", label: "usage.filter.projects", options: labels([...new Set([...facets.projects, ...(route.projects ?? []), ...(route.excludeProjects ?? [])])], "project") },
    { include: "models", exclude: "excludeModels", kind: "model", label: "usage.filter.models", options: labels([...new Set([...facets.models, ...(route.models ?? []), ...(route.excludeModels ?? [])])], "model") },
  ] as const;
  const moreFilters: { key: "relationship" | "sessionType" | "coverage" | "pricing"; options: string[] }[] = [{ key: "relationship", options: ["all", "main", "child"] }, { key: "sessionType", options: ["all", "interactive", "automation", "fork"] }, { key: "coverage", options: ["all", "complete", "partial", "missing"] }, { key: "pricing", options: ["all", "complete", "partial", "missing"] }];
  const numberFilters = ["minTokens", "maxTokens", "minCost", "maxCost"] as const;
  const moreCount = moreFilters.filter(item => route[item.key] && route[item.key] !== "all").length + numberFilters.filter(key => route[key] !== undefined).length;
  const filterGroup = (key: string) => { const include = group === "model" ? "models" : group === "project" ? "projects" : "clients"; const exclude = group === "model" ? "excludeModels" : group === "project" ? "excludeProjects" : "excludeClients"; patch({ [include]: [key], [exclude]: [] }); };
  const openSession = (sessionId: string, messageId?: string) => onSession({ sessionId, ...(messageId ? { messageId } : {}) });
  const selectedSession = report?.sessions.find(row => row.session.id === route.selectedSession);
  const rangeFrom = report?.query.from ?? report?.days[0]?.key;
  const rangeTo = report?.query.to ?? report?.days.at(-1)?.key;
  const rangeLabel = (value?: string) => value ? value.includes("T") ? dateTime(value, { timeZone: report!.timezone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : date(`${value}T00:00:00`) : t("common.timeUnknown");
  const priceHistory = report && loadedQuery.current === queryKey ? report.pricing.history : pricing?.history;
  const pending = loading || loadedQuery.current !== queryKey || invalid;
  const preparing = preparation?.queryKey === queryKey ? preparation.status : null;
  const inspectSession = (sessionId: string, trigger: HTMLElement) => { requestTrigger.current = trigger; patch({ selectedSession: sessionId, requestPage: 1 }, false); };
  const coverageIndicator = (row: UsageReport["sessions"][number], cost = false) => {
    const totals = row.totals;
    const affected = cost ? totals.partiallyPricedRequests + totals.unpricedRequests : totals.partialTokenRequests + totals.missingTokenRequests;
    if (!affected) return null;
    const label = t(cost ? totals.estimatedCost === null ? "usage.chart.unpriced" : "usage.chart.partialCost" : totals.tokens === null ? "usage.chart.missingTokens" : "usage.chart.partialTokens");
    return <HelpPopover label={label} trigger={<button className="usage-state-trigger" aria-label={label}><WarningCircle size={16} /></button>}>
      <p>{t(cost ? "usage.coverage.cost" : "usage.coverage.tokens", { complete: cost ? totals.pricedRequests : totals.completeTokenRequests, partial: cost ? totals.partiallyPricedRequests : totals.partialTokenRequests, missing: cost ? totals.unpricedRequests : totals.missingTokenRequests })}</p>
    </HelpPopover>;
  };
  return <main className="usage-page">
    <div className="usage-page-heading"><h1>{t("usage.title")}</h1><div>
      <HelpPopover label={t("usage.help.title")}><p>{t("usage.help.tokens")}</p><p>{t("usage.help.cost")}</p><p>{t("usage.help.cache")}</p><p>{t("usage.help.summary")}</p><p>{t("usage.help.millions")}</p>
        {report && <><h3>{t("usage.coverage.title")}</h3><p>{t("usage.coverage.tokens", { complete: report.totals.completeTokenRequests, partial: report.totals.partialTokenRequests, missing: report.totals.missingTokenRequests })}</p><p>{t("usage.coverage.cost", { complete: report.totals.pricedRequests, partial: report.totals.partiallyPricedRequests, missing: report.totals.unpricedRequests })}</p><p>{t("usage.coverage.priceBasis", { historical: report.totals.historicalPricedRequests, snapshot: report.totals.currentSnapshotPricedRequests, manual: report.totals.manualPricedRequests })}</p><p>{t("usage.coverage.cache", { count: report.totals.cacheReadRatioRequests, requests: report.totals.requests })}</p><p>{t("usage.coverage.noUsage", { count: report.missingUsageSessions })}</p>{report.undated.requests > 0 && <><p>{t("usage.coverage.undated", { count: report.undated.requests, tokens: value(report.undated.tokens), cost: value(report.undated.estimatedCost, true) })}</p><p>{t(report.query.from || report.query.to ? "usage.coverage.undatedExcluded" : "usage.coverage.undatedIncluded")}</p><p>{t("usage.coverage.tokens", { complete: report.undated.completeTokenRequests, partial: report.undated.partialTokenRequests, missing: report.undated.missingTokenRequests })}</p><p>{t("usage.coverage.cost", { complete: report.undated.pricedRequests, partial: report.undated.partiallyPricedRequests, missing: report.undated.unpricedRequests })}</p></>}</>}
        {pricing && <><h3>{t("usage.pricing.help")}</h3><p>{t("usage.pricing.automaticBasis")}</p><p>{t(`usage.pricing.${pricing.source}`)}{pricing.fetchedAt && <> · {t("usage.pricing.updated", { time: dateTime(pricing.fetchedAt) })}</>}</p>{pricing.error && <p className="usage-warning">{message(pricing.errorDescriptor, pricing.error)}</p>}</>}
        {priceHistory && <p>{t("usage.pricing.history")}{priceHistory.fetchedAt && <> · {t("usage.pricing.updated", { time: dateTime(priceHistory.fetchedAt) })}</>}{priceHistory.error && <> · {message(priceHistory.errorDescriptor, priceHistory.error)}</>}</p>}
        {report && <details><summary>{t("usage.help.diagnostics")}</summary><p>{t("usage.help.version", { version: report.version, priceVersion: report.priceVersion })}</p></details>}
      </HelpPopover><button onClick={() => setPricesOpen(true)} disabled={!pricing}>{t("usage.pricing.open")}</button><RefreshControl label={t("usage.refresh")} onRefresh={refresh} busy={loading} error={!!error} completedAt={completedAt} details={<p>{t("common.refresh.pageScope")}</p>} />
    </div></div>
    <div className="usage-filters"><div className="usage-date-controls"><FilterSelect label={t("usage.filter.date")} value={route.window} options={["today", "yesterday", "7", "14", "30", "90", "all", "custom"].map(item => ({ value: item, label: t(`usage.window.${item}`) }))} onChange={window => patch({ window: window as DateWindow, timeFrom: undefined, timeTo: undefined })} />{route.window === "custom" && <><DatePicker label={t("usage.filter.from")} value={route.from ?? ""} onChange={from => patch({ from: from || undefined, timeFrom: undefined, timeTo: undefined })} /><span>–</span><DatePicker label={t("usage.filter.to")} value={route.to ?? ""} onChange={to => patch({ to: to || undefined, timeFrom: undefined, timeTo: undefined })} /></>}</div>
      {filterDefinitions.map(filter => <MultiFilterPicker key={filter.include} label={t(filter.label)} options={filter.options} included={route[filter.include] ?? []} excluded={route[filter.exclude] ?? []} onChange={(included, excluded) => patch({ [filter.include]: included, [filter.exclude]: excluded })} />)}
      <Popover.Root><Popover.Trigger className="usage-more-trigger"><Funnel size={15} />{t("usage.filter.more", { count: moreCount })}<CaretDown size={14} /></Popover.Trigger><Popover.Portal><Popover.Content className="filter-menu usage-more-menu" align="end" sideOffset={6} collisionPadding={12} aria-label={t("usage.filter.more", { count: moreCount })}>
        {moreFilters.map(filter => <label key={filter.key}><span>{t(`usage.filter.${filter.key}`)}</span><FilterSelect label={t(`usage.filter.${filter.key}`)} value={route[filter.key] ?? "all"} options={filter.options.map(item => ({ value: item, label: t(`usage.${item}`), ...(filter.key === "coverage" || filter.key === "pricing" ? { description: t(`usage.filter.${filter.key}.${item}.help`) } : {}) }))} onChange={value => patch({ [filter.key]: value })} /></label>)}
        {numberFilters.map(key => <label key={key}><span>{t(`usage.filter.${key}`)}</span><input type="number" min="0" step={key.includes("Cost") ? "any" : "1"} value={route[key] ?? ""} onChange={event => patch({ [key]: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>)}
      </Popover.Content></Popover.Portal></Popover.Root>
    </div>
    {(activeFilterCount(route) > 0 || route.window === "custom") && <div className="usage-filter-chips">{filterDefinitions.flatMap(filter => ([filter.include, filter.exclude] as const).flatMap(key => (route[key] ?? []).map(item => <button key={`${key}:${item}`} aria-label={t("usage.filter.remove", { label: groupLabel(item, filter.kind, t("usage.unknown")) })} onClick={() => patch({ [key]: route[key]?.filter(value => value !== item) })}>{key === filter.exclude ? t("usage.filter.excluded", { label: groupLabel(item, filter.kind, t("usage.unknown")) }) : groupLabel(item, filter.kind, t("usage.unknown"))}<X size={12} /></button>)))}{moreFilters.filter(filter => route[filter.key] && route[filter.key] !== "all").map(filter => <button key={filter.key} onClick={() => patch({ [filter.key]: "all" })}>{t(`usage.filter.${filter.key}`)}: {t(`usage.${route[filter.key]}`)}<X size={12} /></button>)}{numberFilters.filter(key => route[key] !== undefined).map(key => <button key={key} onClick={() => patch({ [key]: undefined })}>{t(`usage.filter.${key}`)}: {value(route[key], key.includes("Cost"))}<X size={12} /></button>)}{route.timeFrom && route.timeTo && <button onClick={() => patch({ timeFrom: undefined, timeTo: undefined })}>{dateTime(route.timeFrom)} – {dateTime(route.timeTo)}<X size={12} /></button>}<button className="text-button" onClick={() => setRoute(defaultRoute())}>{t("usage.filter.clearAll")}</button></div>}
    {invalid && <div className="usage-notice danger" role="alert">{t("usage.filter.invalidRange")}</div>}
    {(pricing?.refreshing || pricing?.error || priceHistory?.error || priceHistory && !priceHistory.fetchedAt) && <div className="usage-pricing-state" role="status">
      {pricing?.refreshing && <span>{t("usage.pricing.refreshing")}</span>}
      {pricing?.error && <span className="usage-warning">{t("usage.pricing.sourceFallback")}</span>}
      {(priceHistory?.error || priceHistory && !priceHistory.fetchedAt) && <span className="usage-warning">{t(priceHistory?.fetchedAt ? "usage.pricing.historyFallbackShort" : "usage.pricing.historyUnavailableShort")}</span>}
    </div>}
    {error && <div className="usage-notice danger" role="alert">{errorMessage(error)}<button onClick={() => setRevision(current => current + 1)}>{t("usage.retry")}</button></div>}
    {loading && !invalid && <div className={report ? "usage-update-status" : "usage-loading"} role="status"><span>{t(preparing ? "usage.preparing" : "usage.loading")}</span>{preparing && preparing.totalSessions > 0 && <div className="usage-preparation-progress"><progress aria-label={t("usage.preparing")} value={Math.min(preparing.preparedSessions, preparing.totalSessions)} max={preparing.totalSessions} /><span>{t("usage.preparing.progress", { prepared: preparing.preparedSessions, total: preparing.totalSessions })}</span></div>}</div>}
    {report && <div className="usage-results" aria-busy={pending} data-updating={pending && !error && !invalid}>
      <div className="usage-range"><span>{t("usage.chart.range", { from: rangeLabel(rangeFrom), to: rangeLabel(rangeTo), timezone: report.timezone })}</span><span className="usage-query-feedback" role="status" aria-label={pending && !error && !invalid ? t("usage.updating") : undefined}>{pending && !error && !invalid && <ArrowClockwise size={16} className="is-spinning" aria-hidden="true" />}</span></div>
      <UsageMetrics report={report} />
      <div className="usage-chart-controls" aria-busy={pending}><div className="usage-metric-switch"><div role="group" aria-label={t("usage.chart.metric")} className="usage-segmented">{(["tokens", "cost", "requests", "speed"] as const).map(item => <button key={item} aria-pressed={speed ? item === "speed" : metric === item} onClick={() => patch(item === "speed" ? { trendMetric: "speed" } : { metric: item, trendMetric: undefined }, false)}>{t(`usage.metric.${item}`)}</button>)}</div><span className="usage-query-feedback" aria-hidden="true">{pending && !error && !invalid && <ArrowClockwise size={16} className="is-spinning" />}</span></div><div><div className="usage-group-switch"><FilterSelect label={t("usage.group.label")} value={group} options={["model", "project", "client"].map(item => ({ value: item, label: t(`usage.group.${item}`) }))} onChange={groupBy => patch({ groupBy: groupBy as UsageGroup }, false)} /><span className="usage-query-feedback" aria-hidden="true">{pending && !error && !invalid && <ArrowClockwise size={16} className="is-spinning" />}</span></div><FilterSelect label={t("usage.interval.label")} value={report.query.interval ?? "day"} options={["hour", "day", "week", "month"].map(item => ({ value: item, label: t(`usage.interval.${item}`) }))} onChange={interval => patch({ interval: interval as UsageInterval }, false)} />{!speed && <div className="usage-segmented" role="group" aria-label={t("usage.chart.type")}><button aria-pressed={route.chart === "bar"} onClick={() => patch({ chart: "bar" }, false)}>{t("usage.chart.bar")}</button><button aria-pressed={route.chart === "line"} onClick={() => patch({ chart: "line" }, false)}>{t("usage.chart.line")}</button></div>}</div></div>
      <div className="usage-report-body" inert={pending}><UsageCharts report={report} metric={report.query.metric ?? "tokens"} group={report.query.groupBy ?? "model"} chart={route.chart} attribution={route.attribution} speed={speed} interactive={!pending && active} onSpeedGroups={speedGroups => patch({ speedGroups, speedGroup: undefined }, false)} onAttribution={attribution => patch({ attribution }, false)} onGroup={filterGroup} />
      <section className="usage-session-section" aria-labelledby="usage-session-title"><div className="usage-section-title"><h2 id="usage-session-title">{t("usage.sessions.title")}</h2><div><FilterSelect label={t("usage.sessions.sort")} value={route.sort ?? "tokens"} options={["tokens", "cost", "requests", "recent"].map(item => ({ value: item, label: t(item === "recent" ? "usage.sessions.recent" : `usage.metric.${item}`) }))} onChange={sort => patch({ sort: sort as UsageQuery["sort"] })} /><FilterSelect label={t("usage.sessions.direction")} value={route.direction ?? "desc"} options={["desc", "asc"].map(item => ({ value: item, label: t(`usage.sessions.${item}`) }))} onChange={direction => patch({ direction: direction as "asc" | "desc" })} /></div></div>
        <div className="usage-table-scroll"><table className="usage-table usage-session-table"><thead><tr><th>{t("usage.sessions.name")}</th><th>{t("usage.sessions.project")}</th><th>{t("usage.metric.tokens")}</th><th>{t("usage.metric.cost")}</th><th>{t("usage.metric.requests")}</th><th>{t("usage.sessions.time")}</th><th aria-label={t("usage.sessions.actions")} /></tr></thead><tbody>{report.sessions.map(row => <tr key={row.session.id} data-selected={route.selectedSession === row.session.id}
          onClick={event => { if (!(event.target as HTMLElement).closest("button, a, input, summary")) { const trigger = event.currentTarget.querySelector<HTMLButtonElement>(".usage-session-name"); if (trigger) inspectSession(row.session.id, trigger); } }}>
          <td><button className="usage-session-name" onClick={event => inspectSession(row.session.id, event.currentTarget)}>{sessionDisplayTitle(row.session, language)}</button>{row.session.relationship && <small>{t(row.session.relationship === "child" ? "usage.sessions.child" : "usage.sessions.fork")}</small>}{row.session.parentSessionId && <button className="text-button" onClick={() => openSession(row.session.parentSessionId!)}>{t("usage.sessions.parent")}</button>}</td>
          <td><span title={row.session.project}>{row.session.project?.split(/[\\/]/).filter(Boolean).at(-1) ?? t("usage.unknown")}</span><small>{CLIENTS.some(client => client.id === row.session.client) ? clientLabel(row.session.client) : row.session.client}</small></td>
          <td className="usage-number"><div className="usage-value-state"><TokenAmount value={row.totals.tokens} />{coverageIndicator(row)}</div></td><td className="usage-number"><div className="usage-value-state">{value(row.totals.estimatedCost, true)}{coverageIndicator(row, true)}</div></td>
          <td className="usage-number">{value(row.totals.requests)}</td><td>{row.lastOccurredAt ? dateTime(row.lastOccurredAt) : t(row.requestsTotal === 0 ? "usage.sessions.noUsage" : "common.timeUnknown")}</td>
          <td><div className="usage-session-actions"><button className="text-button" aria-haspopup="dialog" aria-expanded={route.selectedSession === row.session.id} onClick={event => inspectSession(row.session.id, event.currentTarget)}>{t("usage.sessions.inspect")}</button><button className="text-button" onClick={() => openSession(row.session.id)}><ArrowSquareOut size={14} />{t("usage.sessions.open")}</button></div></td>
        </tr>)}</tbody></table></div>
        {!report.sessions.length && <div className="usage-empty">{t("usage.empty")}</div>}
        <ResourcePagination label={t("usage.sessions.title")} page={report.page} total={report.totalSessions} pageSize={report.pageSize} onChange={page => patch({ page, selectedSession: undefined }, false)} onPageSizeChange={pageSize => patch({ pageSize })} />
      </section></div>

    </div>}
    <UsageRequestDialog active={active} session={selectedSession} requests={requests} loading={requestLoading} error={requestError} returnFocus={requestTrigger}
      onClose={() => patch({ selectedSession: undefined }, false)} onPage={requestPage => patch({ requestPage }, false)} onRetry={() => setRequestRevision(current => current + 1)} onSession={openSession} />
    {pricing && <PricingManager status={pricing} models={facets.models.flatMap(model => { const original = usageDimensionValue(model); return original === undefined ? [] : [original]; })} onChange={updatePrice} open={pricesOpen} onOpenChange={setPricesOpen} />}
  </main>;
}
