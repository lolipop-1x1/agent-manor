import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ArrowClockwise, ArrowSquareOut, CaretDown, Funnel, X } from "@phosphor-icons/react";
import type { SessionIndexSummary } from "../../../src/session-contracts";
import type { PricingStatus, UsageGroup, UsageInterval, UsageMetric, UsagePreparationStatus, UsageQuery, UsageReport, UsageRequestPage, UsageTimeBucket } from "../../../src/usage-contracts";
import { CLIENTS } from "../../../src/clients";
import { usageDimensionValue } from "../../../src/usage/dimensions";
import { ApiError, errorMessage, isAborted, request } from "../../shared/api";
import { clientLabel, useI18n } from "../../shared/i18n";
import { DatePicker } from "../../shared/ui/DatePicker";
import { FilterSelect } from "../../shared/ui/FilterSelect";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { MultiFilterPicker } from "../../shared/ui/MultiFilterPicker";
import { ResourcePagination } from "../../shared/ui/ResourcePagination";
import { sessionDisplayTitle } from "../sessions/session-model";
import { activeFilterCount, defaultRoute, localDay, readUsageRoute, usageAddress, usageParameters, usageQuery, type DateWindow, type UsageRoute } from "./model";
import { PricingManager } from "./PricingManager";
import { PriceDetails } from "./PriceDetails";
import { groupLabel, UsageCharts } from "./UsageCharts";
import "./usage.css";

export default function Usage({ active, onSession }: { active: boolean; onSession: (target: { sessionId: string; messageId?: string }) => void }) {
  const { t, number, date, dateTime, percent, message, language } = useI18n();
  const [route, setRoute] = useState(() => readUsageRoute(location.hash));
  const [revision, setRevision] = useState(0);
  const [versions, setVersions] = useState<{ index: string; price: string } | null>(null);
  const [pricing, setPricing] = useState<PricingStatus | null>(null);
  const [report, setReport] = useState<UsageReport | null>(null);
  const loadedQuery = useRef("");
  const [facets, setFacets] = useState<UsageReport["facets"]>({ clients: [], projects: [], models: [] });
  const [error, setError] = useState<Error | null>(null); const [loading, setLoading] = useState(false);
  const [preparation, setPreparation] = useState<{ queryKey: string; status: UsagePreparationStatus } | null>(null);
  const [requests, setRequests] = useState<UsageRequestPage | null>(null); const [requestError, setRequestError] = useState<Error | null>(null); const [requestLoading, setRequestLoading] = useState(false);
  const [pricesOpen, setPricesOpen] = useState(false);
  const patch = (value: Partial<UsageRoute>, reset = true) => setRoute(current => ({ ...current, ...(reset ? { page: 1, selectedSession: undefined, requestPage: 1 } : {}), ...value }));
  useEffect(() => {
    const navigate = () => { if (location.hash.startsWith("#usage")) setRoute(readUsageRoute(location.hash)); };
    globalThis.addEventListener("hashchange", navigate); return () => globalThis.removeEventListener("hashchange", navigate);
  }, []);
  useEffect(() => { if (active && location.hash.startsWith("#usage")) history.replaceState(null, "", usageAddress(route)); }, [active, route]);
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
    if (!active || !queryKey) return;
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
    if (loadedQuery.current !== queryKey) setReport(null);
    void request<UsageReport>(`/usage?${queryKey}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      stopPreparation(); setPreparation(null);
      loadedQuery.current = queryKey; setReport(result); setFacets(result.facets); setLoading(false);
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
  }, [active, requestQueryKey]);
  const updatePrice = useCallback((value: PricingStatus) => { setPricing(value); setVersions(current => current ? { ...current, price: value.version } : current); }, []);
  const value = (amount: number | null | undefined, cost = false) => amount == null ? "—" : number(amount, cost ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {});
  const metric = route.metric ?? "tokens"; const group = route.groupBy ?? "model";
  const labels = (values: string[], kind: UsageGroup) => values.map(item => { const original = usageDimensionValue(item); return { value: item, label: kind === "project" && original !== undefined ? original.split(/[\\/]/).filter(Boolean).at(-1) ?? original : groupLabel(item, kind, t("usage.unknown")), ...(kind === "project" && original !== undefined ? { description: original } : {}) }; });
  const filterDefinitions = [
    { include: "clients", exclude: "excludeClients", kind: "client", label: "usage.filter.clients", options: labels([...new Set([...facets.clients, ...(route.clients ?? []), ...(route.excludeClients ?? [])])], "client") },
    { include: "projects", exclude: "excludeProjects", kind: "project", label: "usage.filter.projects", options: labels([...new Set([...facets.projects, ...(route.projects ?? []), ...(route.excludeProjects ?? [])])], "project") },
    { include: "models", exclude: "excludeModels", kind: "model", label: "usage.filter.models", options: labels([...new Set([...facets.models, ...(route.models ?? []), ...(route.excludeModels ?? [])])], "model") },
  ] as const;
  const moreFilters: { key: "relationship" | "sessionType" | "coverage" | "pricing"; options: string[] }[] = [{ key: "relationship", options: ["all", "main", "child"] }, { key: "sessionType", options: ["all", "interactive", "automation", "fork"] }, { key: "coverage", options: ["all", "complete", "partial", "missing"] }, { key: "pricing", options: ["all", "complete", "partial", "missing"] }];
  const numberFilters = ["minTokens", "maxTokens", "minCost", "maxCost"] as const;
  const moreCount = moreFilters.filter(item => route[item.key] && route[item.key] !== "all").length + numberFilters.filter(key => route[key] !== undefined).length;
  const filterGroup = (key: string) => { const include = group === "model" ? "models" : group === "project" ? "projects" : "clients"; const exclude = group === "model" ? "excludeModels" : group === "project" ? "excludeProjects" : "excludeClients"; patch({ [include]: [key], [exclude]: [] }); };
  const filterBucket = (bucket: UsageTimeBucket, day = false) => {
    if (!day && route.interval === "hour") {
      const start = new Date(Math.max(Date.parse(bucket.key), report?.query.from?.includes("T") ? Date.parse(report.query.from) : -Infinity));
      const end = new Date(Math.min(Date.parse(bucket.key) + 3600000, report?.query.to?.includes("T") ? Date.parse(report.query.to) : Infinity));
      patch({ window: "custom", timeFrom: start.toISOString(), timeTo: end.toISOString(), from: localDay(start), to: localDay(start) }); return;
    }
    const start = new Date(`${bucket.key}T00:00:00`); const end = new Date(start);
    if (!day && route.interval === "week") end.setDate(end.getDate() + 6);
    if (!day && route.interval === "month") { end.setMonth(end.getMonth() + 1); end.setDate(0); }
    if (report?.query.from?.includes("T") && report.query.to?.includes("T")) {
      const endExclusive = new Date(end); endExclusive.setDate(endExclusive.getDate() + 1);
      const from = new Date(Math.max(start.getTime(), Date.parse(report.query.from))); const to = new Date(Math.min(endExclusive.getTime(), Date.parse(report.query.to)));
      patch({ window: "custom", timeFrom: from.toISOString(), timeTo: to.toISOString(), from: localDay(from), to: localDay(from) }); return;
    }
    if (report?.query.from && localDay(start) < report.query.from) start.setTime(new Date(`${report.query.from}T00:00:00`).getTime());
    if (report?.query.to && localDay(end) > report.query.to) end.setTime(new Date(`${report.query.to}T00:00:00`).getTime());
    patch({ window: "custom", from: localDay(start), to: localDay(end), timeFrom: undefined, timeTo: undefined });
  };
  const openSession = (sessionId: string, messageId?: string) => onSession({ sessionId, ...(messageId ? { messageId } : {}) });
  const selectedSession = report?.sessions.find(row => row.session.id === route.selectedSession);
  const priceHistory = report && loadedQuery.current === queryKey ? report.pricing.history : pricing?.history;
  const preparing = preparation?.queryKey === queryKey ? preparation.status : null;
  return <main className="usage-page">
    <div className="usage-page-heading"><h1>{t("usage.title")}</h1><div><HelpPopover label={t("usage.help.title")}><p>{t("usage.help.tokens")}</p><p>{t("usage.help.cost")}</p><p>{t("usage.help.cache")}</p>{report && <p>{t("usage.help.version", { version: report.version, priceVersion: report.priceVersion })}</p>}</HelpPopover><button onClick={() => setPricesOpen(true)} disabled={!pricing}>{t("usage.pricing.open")}</button><button className="icon-button" onClick={() => setRevision(current => current + 1)} aria-label={t("usage.refresh")} disabled={loading}><ArrowClockwise size={18} /></button></div></div>
    <div className="usage-filters"><div className="usage-date-controls"><FilterSelect label={t("usage.filter.date")} value={route.window} options={["today", "yesterday", "7", "14", "30", "90", "all", "custom"].map(item => ({ value: item, label: t(`usage.window.${item}`) }))} onChange={window => patch({ window: window as DateWindow, timeFrom: undefined, timeTo: undefined })} />{route.window === "custom" && <><DatePicker label={t("usage.filter.from")} value={route.from ?? ""} onChange={from => patch({ from: from || undefined, timeFrom: undefined, timeTo: undefined })} /><span>–</span><DatePicker label={t("usage.filter.to")} value={route.to ?? ""} onChange={to => patch({ to: to || undefined, timeFrom: undefined, timeTo: undefined })} /></>}</div>
      {filterDefinitions.map(filter => <MultiFilterPicker key={filter.include} label={t(filter.label)} options={filter.options} included={route[filter.include] ?? []} excluded={route[filter.exclude] ?? []} onChange={(included, excluded) => patch({ [filter.include]: included, [filter.exclude]: excluded })} />)}
      <Popover.Root><Popover.Trigger className="usage-more-trigger"><Funnel size={15} />{t("usage.filter.more", { count: moreCount })}<CaretDown size={14} /></Popover.Trigger><Popover.Portal><Popover.Content className="filter-menu usage-more-menu" align="end" sideOffset={6} collisionPadding={12} aria-label={t("usage.filter.more", { count: moreCount })}>
        {moreFilters.map(filter => <label key={filter.key}><span>{t(`usage.filter.${filter.key}`)}</span><FilterSelect label={t(`usage.filter.${filter.key}`)} value={route[filter.key] ?? "all"} options={filter.options.map(item => ({ value: item, label: t(`usage.${item}`) }))} onChange={value => patch({ [filter.key]: value })} /></label>)}
        {numberFilters.map(key => <label key={key}><span>{t(`usage.filter.${key}`)}</span><input type="number" min="0" step={key.includes("Cost") ? "any" : "1"} value={route[key] ?? ""} onChange={event => patch({ [key]: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>)}
      </Popover.Content></Popover.Portal></Popover.Root>
    </div>
    {(activeFilterCount(route) > 0 || route.window === "custom") && <div className="usage-filter-chips">{filterDefinitions.flatMap(filter => ([filter.include, filter.exclude] as const).flatMap(key => (route[key] ?? []).map(item => <button key={`${key}:${item}`} aria-label={t("usage.filter.remove", { label: groupLabel(item, filter.kind, t("usage.unknown")) })} onClick={() => patch({ [key]: route[key]?.filter(value => value !== item) })}>{key === filter.exclude ? t("usage.filter.excluded", { label: groupLabel(item, filter.kind, t("usage.unknown")) }) : groupLabel(item, filter.kind, t("usage.unknown"))}<X size={12} /></button>)))}{moreFilters.filter(filter => route[filter.key] && route[filter.key] !== "all").map(filter => <button key={filter.key} onClick={() => patch({ [filter.key]: "all" })}>{t(`usage.filter.${filter.key}`)}: {t(`usage.${route[filter.key]}`)}<X size={12} /></button>)}{numberFilters.filter(key => route[key] !== undefined).map(key => <button key={key} onClick={() => patch({ [key]: undefined })}>{t(`usage.filter.${key}`)}: {value(route[key])}<X size={12} /></button>)}{route.timeFrom && route.timeTo && <button onClick={() => patch({ timeFrom: undefined, timeTo: undefined })}>{dateTime(route.timeFrom)} – {dateTime(route.timeTo)}<X size={12} /></button>}<button className="text-button" onClick={() => setRoute(defaultRoute())}>{t("usage.filter.clearAll")}</button></div>}
    {invalid && <div className="usage-notice danger" role="alert">{t("usage.filter.invalidRange")}</div>}
    {pricing && <div className="usage-pricing-state"><span>{t(`usage.pricing.${pricing.source}`)}</span><span>{t("usage.pricing.automaticSummary")}</span>{pricing.fetchedAt && <span>{t("usage.pricing.updated", { time: dateTime(pricing.fetchedAt) })}</span>}{pricing.refreshing && <span role="status">{t("usage.pricing.refreshing")}</span>}{pricing.error && <span className="usage-warning">{t("usage.pricing.fallback")} {message(pricing.errorDescriptor, pricing.error)}</span>}</div>}
    {priceHistory && <div className="usage-pricing-state"><span>{t("usage.pricing.history")}</span>{priceHistory.fetchedAt ? <span>{t("usage.pricing.updated", { time: dateTime(priceHistory.fetchedAt) })}</span> : <span className="usage-warning">{t("usage.pricing.historyUnavailable")}</span>}{priceHistory.error && <span className="usage-warning">{t(priceHistory.fetchedAt ? "usage.pricing.historyFallback" : "usage.pricing.historyUnavailable")} {message(priceHistory.errorDescriptor, priceHistory.error)}</span>}</div>}
    {error && <div className="usage-notice danger" role="alert">{errorMessage(error)}<button onClick={() => setRevision(current => current + 1)}>{t("usage.retry")}</button></div>}
    {loading && !invalid && <div className="usage-loading" role="status"><span>{t(preparing ? "usage.preparing" : "usage.loading")}</span>{preparing && preparing.totalSessions > 0 && <div className="usage-preparation-progress"><progress aria-label={t("usage.preparing")} value={Math.min(preparing.preparedSessions, preparing.totalSessions)} max={preparing.totalSessions} /><span>{t("usage.preparing.progress", { prepared: preparing.preparedSessions, total: preparing.totalSessions })}</span></div>}</div>}
    {report && loadedQuery.current === queryKey && !invalid && <>
      <div className="usage-range">{t("usage.chart.range", { from: report.query.from ? date(report.query.from.includes("T") ? report.query.from : `${report.query.from}T00:00:00`) : t("usage.window.all"), to: report.query.to ? date(report.query.to.includes("T") ? report.query.to : `${report.query.to}T00:00:00`) : t("usage.window.all"), timezone: report.timezone })}</div>
      <div className="usage-metrics">{[{ key: "tokens", display: value(report.totals.tokens), unit: t("usage.unit.tokens") }, { key: "cost", display: value(report.totals.estimatedCost, true), unit: "USD" }, { key: "requests", display: value(report.totals.requests), unit: "" }, { key: "sessions", display: value(report.totals.sessions), unit: "" }, { key: "cacheRatio", display: report.totals.cacheReadRatio === null ? "—" : percent(report.totals.cacheReadRatio), unit: "" }].map(item => <div key={item.key}><span>{t(`usage.metric.${item.key}`)}</span><strong>{item.display}<small>{item.unit}</small></strong></div>)}</div>
      <div className="usage-coverage"><span className={report.totals.partialTokenRequests + report.totals.missingTokenRequests > 0 ? "usage-warning" : ""}>{t("usage.coverage.tokens", { complete: report.totals.completeTokenRequests, partial: report.totals.partialTokenRequests, missing: report.totals.missingTokenRequests })}</span><button className={report.totals.partiallyPricedRequests + report.totals.unpricedRequests > 0 ? "usage-warning" : ""} onClick={() => patch({ pricing: "missing" })}>{t("usage.coverage.cost", { complete: report.totals.pricedRequests, partial: report.totals.partiallyPricedRequests, missing: report.totals.unpricedRequests })}</button><span>{t("usage.coverage.priceBasis", { historical: report.totals.historicalPricedRequests, snapshot: report.totals.currentSnapshotPricedRequests, manual: report.totals.manualPricedRequests })}</span><span>{t("usage.coverage.cache", { count: report.totals.cacheReadRatioRequests, requests: report.totals.requests })}</span>{report.missingUsageSessions > 0 && <button onClick={() => patch({ coverage: "missing" })}>{t("usage.coverage.noUsage", { count: report.missingUsageSessions })}</button>}</div>
      {report.undated.requests > 0 && <div className="usage-notice"><span>{t("usage.coverage.undated", { count: report.undated.requests, tokens: value(report.undated.tokens), cost: value(report.undated.estimatedCost, true) })}</span><span>{t(route.window === "all" ? "usage.coverage.undatedIncluded" : "usage.coverage.undatedExcluded")}</span>{report.undated.partialTokenRequests + report.undated.missingTokenRequests > 0 && <span className="usage-warning">{t("usage.coverage.tokens", { complete: report.undated.completeTokenRequests, partial: report.undated.partialTokenRequests, missing: report.undated.missingTokenRequests })}</span>}{report.undated.partiallyPricedRequests + report.undated.unpricedRequests > 0 && <span className="usage-warning">{t("usage.coverage.cost", { complete: report.undated.pricedRequests, partial: report.undated.partiallyPricedRequests, missing: report.undated.unpricedRequests })}</span>}</div>}
      <div className="usage-chart-controls"><div role="group" aria-label={t("usage.chart.metric")} className="usage-segmented">{(["tokens", "cost", "requests"] as const).map(item => <button key={item} aria-pressed={metric === item} onClick={() => patch({ metric: item }, false)}>{t(`usage.metric.${item}`)}</button>)}</div><div><FilterSelect label={t("usage.group.label")} value={group} options={["model", "project", "client"].map(item => ({ value: item, label: t(`usage.group.${item}`) }))} onChange={groupBy => patch({ groupBy: groupBy as UsageGroup }, false)} /><FilterSelect label={t("usage.interval.label")} value={route.interval ?? "day"} options={["hour", "day", "week", "month"].map(item => ({ value: item, label: t(`usage.interval.${item}`) }))} onChange={interval => patch({ interval: interval as UsageInterval }, false)} /><div className="usage-segmented" role="group" aria-label={t("usage.chart.type")}><button aria-pressed={route.chart === "bar"} onClick={() => patch({ chart: "bar" }, false)}>{t("usage.chart.bar")}</button><button aria-pressed={route.chart === "line"} onClick={() => patch({ chart: "line" }, false)}>{t("usage.chart.line")}</button></div></div></div>
      <UsageCharts report={report} metric={metric} group={group} chart={route.chart} onBucket={filterBucket} onGroup={filterGroup} />
      <section className="usage-session-section" aria-labelledby="usage-session-title"><div className="usage-section-title"><h2 id="usage-session-title">{t("usage.sessions.title")}</h2><div><FilterSelect label={t("usage.sessions.sort")} value={route.sort ?? "tokens"} options={["tokens", "cost", "requests", "recent"].map(item => ({ value: item, label: t(item === "recent" ? "usage.sessions.recent" : `usage.metric.${item}`) }))} onChange={sort => patch({ sort: sort as UsageQuery["sort"] })} /><FilterSelect label={t("usage.sessions.direction")} value={route.direction ?? "desc"} options={["desc", "asc"].map(item => ({ value: item, label: t(`usage.sessions.${item}`) }))} onChange={direction => patch({ direction: direction as "asc" | "desc" })} /></div></div>
        <div className="usage-table-scroll"><table className="usage-table"><thead><tr><th>{t("usage.sessions.name")}</th><th>{t("usage.sessions.project")}</th><th>{t("usage.metric.tokens")}</th><th>{t("usage.metric.cost")} · USD</th><th>{t("usage.metric.requests")}</th><th>{t("usage.sessions.time")}</th><th /></tr></thead><tbody>{report.sessions.map(row => <tr key={row.session.id} data-selected={route.selectedSession === row.session.id}><td><button className="usage-session-name" onClick={() => patch({ selectedSession: route.selectedSession === row.session.id ? undefined : row.session.id, requestPage: 1 }, false)}>{sessionDisplayTitle(row.session, language)}</button>{row.session.relationship && <small>{t(row.session.relationship === "child" ? "usage.sessions.child" : "usage.sessions.fork")}</small>}{row.session.parentSessionId && <button className="text-button" onClick={() => openSession(row.session.parentSessionId!)}>{t("usage.sessions.parent")}</button>}</td><td><span title={row.session.project}>{row.session.project?.split(/[\\/]/).filter(Boolean).at(-1) ?? t("usage.unknown")}</span><small>{CLIENTS.some(client => client.id === row.session.client) ? clientLabel(row.session.client) : row.session.client}</small></td><td className="usage-number">{value(row.totals.tokens)}{(row.totals.partialTokenRequests + row.totals.missingTokenRequests > 0 || row.totals.tokens === null) && <small className="usage-warning">{t(row.totals.tokens === null ? "usage.missing" : "usage.partial")}</small>}</td><td className="usage-number">{value(row.totals.estimatedCost, true)}{row.totals.partiallyPricedRequests + row.totals.unpricedRequests > 0 && <small className="usage-warning">{t(row.totals.pricedRequests === 0 && row.totals.partiallyPricedRequests === 0 ? "usage.pricing.unpriced" : "usage.partial")}</small>}</td><td className="usage-number">{value(row.totals.requests)}</td><td>{row.lastOccurredAt ? dateTime(row.lastOccurredAt) : t("common.timeUnknown")}</td><td><button className="text-button" onClick={() => openSession(row.session.id)}><ArrowSquareOut size={14} />{t("usage.sessions.open")}</button><button className="text-button" aria-expanded={route.selectedSession === row.session.id} onClick={() => patch({ selectedSession: row.session.id, requestPage: 1 }, false)}>{t("usage.sessions.inspect")}</button></td></tr>)}</tbody></table></div>
        {!report.sessions.length && <div className="usage-empty">{t("usage.empty")}</div>}
        <ResourcePagination label={t("usage.sessions.title")} page={report.page} total={report.totalSessions} pageSize={report.pageSize} onChange={page => patch({ page, selectedSession: undefined }, false)} onPageSizeChange={pageSize => patch({ pageSize })} />
      </section>
      {selectedSession && <section className="usage-request-section"><div className="usage-section-title"><h2>{t("usage.sessions.requests")} · {sessionDisplayTitle(selectedSession.session, language)}</h2><button className="icon-button" aria-label={t("common.closeNamed", { label: t("usage.sessions.requests") })} onClick={() => patch({ selectedSession: undefined }, false)}><X size={17} /></button></div>{requestLoading && <div role="status" className="usage-loading">{t("usage.loading")}</div>}{requestError && <div role="alert" className="usage-notice danger">{errorMessage(requestError)}</div>}{requests && <><div className="usage-table-scroll"><table className="usage-table"><thead><tr><th>{t("usage.sessions.time")}</th><th>{t("usage.sessions.model")}</th><th>{t("usage.tokens.input")}</th><th>{t("usage.tokens.output")}</th><th>{t("usage.composition.cacheRead")}</th><th>{t("usage.composition.cacheWrite")}</th><th>{t("usage.metric.cost")} · USD</th><th>{t("usage.pricing.effective")}</th><th /></tr></thead><tbody>{requests.requests.map(item => <tr key={item.usage.id}><td>{item.usage.occurredAt ? dateTime(item.usage.occurredAt) : t("common.timeUnknown")}</td><td>{item.usage.model ?? t("usage.unknown")}</td><td className="usage-number">{value(item.usage.inputTokens)}</td><td className="usage-number">{value(item.usage.outputTokens)}</td><td className="usage-number">{value(item.usage.cachedInputTokens)}</td><td className="usage-number">{value(item.usage.cacheWriteTokens)}</td><td className="usage-number">{value(item.cost.amount, true)}{item.cost.coverage !== "complete" && <small className="usage-warning">{item.cost.reason ? t(`usage.reason.${item.cost.reason}`) : t(`usage.${item.cost.coverage}`)}</small>}</td><td>{item.cost.price ? <><span>{(item.cost.priceProvider ?? item.cost.price.provider) === "manual" ? t("usage.pricing.globalScope") : item.cost.priceProvider ?? item.cost.price.provider} / {item.cost.price.model}</span><small>{t(`usage.pricing.${item.cost.price.source}`)}</small><PriceDetails price={item.cost.price} cost={item.cost} threshold={item.cost.appliedContextThreshold} /></> : "—"}</td><td><button className="text-button" onClick={() => openSession(selectedSession.session.id, item.usage.messageId ?? item.usage.requestMessageIds?.[0])}>{t("usage.sessions.open")}</button>{!item.usage.messageId && !item.usage.requestMessageIds?.length && <small>{t("usage.sessions.noLocator")}</small>}</td></tr>)}</tbody></table></div><ResourcePagination label={t("usage.sessions.requests")} page={requests.page} total={requests.total} pageSize={requests.pageSize} onChange={requestPage => patch({ requestPage }, false)} /></>}</section>}
    </>}
    {pricing && <PricingManager status={pricing} models={facets.models.flatMap(model => { const original = usageDimensionValue(model); return original === undefined ? [] : [original]; })} onChange={updatePrice} open={pricesOpen} onOpenChange={setPricesOpen} />}
  </main>;
}
