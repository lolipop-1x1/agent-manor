import { clientLabel, getLanguage, isMessageDescriptorKnown, messageText, t, useI18n } from "../../shared/i18n";
import { formatDateTime, formatNumber, formatPercent } from "../../../src/i18n";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowClockwise, CaretLeft, CaretRight, Crosshair } from "@phosphor-icons/react";
import type { SessionProfile, SessionSummary, SessionTimelineEvent } from "../../../src/session-contracts";
import type { SessionCostSummary } from "../../../src/usage-contracts";
import { sessionDisplayTitle, displayRecorded, sessionResourceName, sessionParams, usageAxis, usageIndexAt, usageSegments, type EvidenceTarget } from "./session-model";
import { kindLabels, resourceLabels } from "./SessionMessage";
import { Notice, Pager, SessionDiagnostic, SessionError } from "./SessionControls";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { SessionEvidence } from "./SessionEvidence";
import { summarizeRequestSpeed } from "../../../src/session-speed";
import { AverageSpeedMetric, RequestSpeedBadge, SpeedAlgorithmHelp, SpeedColumnHeader } from "./SessionSpeed";
import { usageCoverage } from "./session-usage-coverage";
import { requestLocation } from "./session-speed-model";
import { NativeUsageReports } from "./NativeUsageReports";
import { ChartTooltip } from "../../shared/charts/ChartTooltip";
import { isAborted, request } from "../../shared/api";

const formatCount = (value: number) => formatNumber(getLanguage(), value);
const dateLabel = (value?: string) => value ? formatDateTime(getLanguage(), value) : t("sessions.message.timeMissing");
const shortProject = (value?: string) => value ? value.split(/[\\/]/).filter(Boolean).at(-1) ?? value : t("sessions.noProject");
const normalizedRatio = (value: number | null) => value === null ? t("common.notRecorded") : formatPercent(getLanguage(), value, { minimumFractionDigits: 1 });
const usageSeries = [["inputTokens", "sessions.usage.input"], ["cachedInputTokens", "sessions.usage.cachedInput"], ["outputTokens", "sessions.usage.output"]] as const;

function ProfileBar({ label, count, max, unit }: { label: string; count: number; max: number; unit?: "records" | "tokens" }) {
  useI18n();
  const width = max > 0 ? Math.max(2, count / max * 100) : 0;
  return <div className="session-bar-row"><span>{label}</span><span className="session-bar-track"><i style={{ width: `${width}%` }} /></span><strong>{unit === "records" ? t("sessions.recordCount", { count }) : unit === "tokens" ? t("sessions.profile.tokens", { value: formatCount(count) }) : formatCount(count)}</strong></div>;
}

function UsageChart({ profile, onFocusStep }: { profile: SessionProfile; onFocusStep: (step: SessionProfile["steps"][number]) => void }) {
  useI18n();
  const { max, ticks, curves } = useMemo(() => {
    const maximum = profile.steps.reduce((value, step) => Math.max(value, step.inputTokens ?? 0, step.cachedInputTokens ?? 0, step.outputTokens ?? 0), 0);
    const axis = usageAxis(maximum);
    return { ...axis, curves: usageSeries.filter(([key]) => profile.steps.some(step => step[key] !== undefined)).map(([key]) => ({ key, segments: usageSegments(profile.steps, key, axis.max) })) };
  }, [profile.steps]);
  const [hovered, setHovered] = useState<number>();
  const [focused, setFocused] = useState<number>();
  const lastFocused = useRef(0);
  useEffect(() => { setHovered(undefined); setFocused(undefined); lastFocused.current = 0; }, [profile.steps]);
  useEffect(() => { if (focused !== undefined) lastFocused.current = focused; }, [focused]);
  const tooltipId = useId();
  const selected = hovered ?? focused;
  const active = selected === undefined ? undefined : profile.steps[selected];
  const currentRequest = Math.min(profile.steps.length - 1, selected ?? lastFocused.current);
  const controlStep = profile.steps[currentRequest]!;
  const offset = profile.stepsOffset ?? 0;
  const x = (index: number) => profile.steps.length <= 1 ? 50 : index / (profile.steps.length - 1) * 100;
  const requestAt = (clientX: number, target: SVGRectElement) => {
    const bounds = target.getBoundingClientRect();
    // 视口两端各有 2 个单位的绘图留白，先还原到实际横轴再定位请求。
    return usageIndexAt(((clientX - bounds.left) / bounds.width * 104 - 2) / 100, profile.steps.length);
  };
  return <div className="session-usage-chart">
    <div className="session-chart-legend">{usageSeries.filter(([key]) => profile.steps.some(step => step[key] !== undefined)).map(([key, label]) => <span key={key}><i className={`series-${key}`} />{t(label)}</span>)}</div>
    <div className="session-chart-unit">Token</div>
    <div className="session-chart-body">
      <div className="session-chart-y-axis" aria-label={t("sessions.profile.chartYAxis")}>{ticks.map(value => <span key={value} style={{ top: `${100 - value / max * 100}%` }} title={`${formatCount(value)} Token`}>
        {formatNumber(getLanguage(), value, { notation: "compact", maximumFractionDigits: 1 })}
      </span>)}</div>
      <div className="session-chart-plot">
        <svg viewBox="-2 0 104 100" preserveAspectRatio="none" aria-label={t("sessions.profile.chartTrend")}
          onPointerLeave={() => setHovered(undefined)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined); }}>
          {ticks.map(value => <line key={value} x1="0" x2="100" y1={100 - value / max * 100} y2={100 - value / max * 100} className="session-chart-grid" vectorEffect="non-scaling-stroke" />)}
          {curves.flatMap(({ key, segments }) => segments.map((points, index) => points.includes(" ")
            ? <polyline key={`${key}-${index}`} points={points} className={`series-${key}`} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            : <circle key={`${key}-${index}`} cx={points.split(",")[0]} cy={points.split(",")[1]} r="1" className={`series-${key}`} />))}
          {active && selected !== undefined && <g className="session-chart-reference">
            <line x1={x(selected)} x2={x(selected)} y1="0" y2="100" vectorEffect="non-scaling-stroke" />
            {usageSeries.map(([key]) => active[key] === undefined ? null : <circle key={key} cx={x(selected)} cy={100 - active[key] / max * 100} r="1.2" className={`series-${key}`} />)}
          </g>}
          <rect x="-2" y="0" width="104" height="100" className="session-chart-hit" role="slider" tabIndex={0}
            aria-label={t("sessions.profile.chartSelect")} aria-orientation="horizontal" aria-valuemin={offset + 1} aria-valuemax={offset + profile.steps.length} aria-valuenow={offset + currentRequest + 1}
            aria-valuetext={t(requestLocation(controlStep) ? "sessions.profile.chartValueLinked" : "sessions.profile.chartValue", { number: formatCount(offset + currentRequest + 1), input: displayRecorded(controlStep.inputTokens), output: displayRecorded(controlStep.outputTokens), cache: displayRecorded(controlStep.cachedInputTokens) })}
            aria-describedby={active ? tooltipId : undefined}
            onPointerMove={event => setHovered(requestAt(event.clientX, event.currentTarget))}
            onPointerDown={event => setHovered(requestAt(event.clientX, event.currentTarget))}
            onFocus={() => setFocused(value => value ?? hovered ?? lastFocused.current)}
            onClick={() => {
              const index = currentRequest;
              setFocused(index);
              const step = profile.steps[index]!;
              if (requestLocation(step)) onFocusStep(step);
            }}
            onKeyDown={event => {
              if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                setHovered(undefined);
                const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
                setFocused(event.key === "Home" ? 0 : event.key === "End" ? profile.steps.length - 1 : Math.max(0, Math.min(profile.steps.length - 1, currentRequest + direction)));
              } else if (requestLocation(controlStep) && ["Enter", " "].includes(event.key)) {
                event.preventDefault(); onFocusStep(controlStep);
              }
            }} />
        </svg>
        {active && selected !== undefined && <ChartTooltip id={tooltipId} className="session-chart-tooltip" position={x(selected) / 100}>
          <strong>{t(active.sessionId !== profile.sessionIds[0] ? "sessions.profile.childRequestNumber" : "sessions.profile.requestNumber", { number: formatCount(offset + selected + 1) })}</strong>
          {active.model && <span className="session-chart-tooltip-model">{active.model}</span>}
          <dl>{usageSeries.filter(([key]) => active[key] !== undefined).map(([key, label]) => <div key={key}><dt><i className={`series-${key}`} />{t(label)}</dt><dd>{displayRecorded(active[key])}{active[key] === undefined ? "" : " Token"}</dd></div>)}</dl>
          <RequestSpeedBadge usage={active} interactive={false} />
          {active.occurredAt && <small>{dateLabel(active.occurredAt)}</small>}
        </ChartTooltip>}
      </div>
      <span /><div className="session-chart-axis"><span>{formatCount(offset + 1)}</span><span>{t("sessions.profile.chartRequestIndex")}</span><span>{profile.steps.length > 1 ? formatCount(offset + profile.steps.length) : ""}</span></div>
    </div>
  </div>;
}

const metrics = [
  ["inputTokens", "sessions.profile.totalInput"], ["outputTokens", "sessions.profile.outputTokens"],
  ["cachedInputTokens", "sessions.profile.cachedTokens"], ["cacheWriteTokens", "sessions.profile.cacheWriteTokens"],
  ["reasoningOutputTokens", "sessions.profile.reasoningTokens"], ["peakInputTokens", "sessions.profile.maxInput"], ["peakContextTokens", "sessions.profile.peakContext"],
] as const;

export function SessionProfilePane({ active, profile, loading, error, includeChildren, setIncludeChildren, collapsed, setCollapsed, onRetry, onSelectChild, onFocusStep, onFind, onFocusEvent }: {
  active: boolean;
  profile: SessionProfile | null; loading: boolean; error: Error | null; includeChildren: boolean; setIncludeChildren: (value: boolean) => void;
  collapsed: boolean; setCollapsed: (value: boolean) => void; onRetry: () => void;
  onSelectChild: (session: SessionSummary) => void; onFocusStep: (step: SessionProfile["steps"][number]) => void; onFind: (target: EvidenceTarget) => void;
  onFocusEvent: (event: SessionTimelineEvent) => void;
}) {
  const { number } = useI18n();
  const [tab, setTab] = useState<"overview" | "calls" | "usage">("overview");
  const [stepPage, setStepPage] = useState(1);
  const [usageDetails, setUsageDetails] = useState<SessionProfile>();
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<Error>();
  const [usageRetry, setUsageRetry] = useState(0);
  const [costState, setCostState] = useState<{ key: string; loading: boolean; value?: SessionCostSummary; error?: Error }>();
  const [costRetry, setCostRetry] = useState(0);
  const hasCalls = !!profile && (profile.tools.length > 0 || profile.resources.length > 0);
  const visibleMetrics = profile ? metrics.filter(([key]) => profile.usage[key] !== null) : [];
  const hasUsage = visibleMetrics.length > 0 || !!profile?.usage.requests || !!profile?.usageReports?.length;
  const hasNativeCost = (usageDetails ?? profile)?.steps.some(step => step.nativeReportedCostUsd !== undefined);
  const speedSummary = useMemo(() => profile?.outputSpeed ?? (profile ? summarizeRequestSpeed(profile.steps) : undefined), [profile]);
  const hasSpeed = !!speedSummary?.requests;
  const visibleTab = tab === "calls" && !hasCalls || tab === "usage" && !hasUsage ? "overview" : tab;
  const primaryMetrics = visibleMetrics.filter(([key]) => key === "inputTokens" || key === "outputTokens");
  const extraMetrics = visibleMetrics.filter(([key]) => visibleTab === "usage" && !["inputTokens", "outputTokens", "peakInputTokens"].includes(key));
  const requestedScope = includeChildren ? "tree" : "self";
  const costKey = JSON.stringify([profile?.version, profile?.sessionIds[0], requestedScope]);
  useEffect(() => {
    if (!profile || !active || collapsed || !profile.usage.requests || profile.scope !== requestedScope) { setCostState(undefined); return; }
    const controller = new AbortController(); setCostState({ key: costKey, loading: true });
    void request<SessionCostSummary>(`/sessions/${encodeURIComponent(profile.sessionIds[0]!)}/cost${sessionParams({ version: profile.version, includeChildren: profile.scope === "tree" })}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setCostState({ key: costKey, loading: false, value: result }); })
      .catch(failure => { if (!controller.signal.aborted && !isAborted(failure)) setCostState({ key: costKey, loading: false, error: failure instanceof Error ? failure : new Error(String(failure)) }); });
    return () => controller.abort();
  }, [active, costKey, requestedScope, profile?.scope, profile?.usage.requests, collapsed, costRetry]);
  const currentCost = costState?.key === costKey ? costState : undefined;
  const costLoading = loading || !!currentCost?.loading;
  const costError = currentCost?.error;
  const cost = currentCost?.value;
  const visibleCost = profile?.scope === requestedScope && cost?.version === profile?.version && cost?.scope === requestedScope && cost?.sessionIds[0] === profile?.sessionIds[0] ? cost : undefined;
  const incompleteCost = !!visibleCost && (visibleCost.totals.partiallyPricedRequests > 0 || visibleCost.totals.unpricedRequests > 0);
  const costLabel = incompleteCost && visibleCost?.totals.estimatedCost !== null ? "usage.metric.costSubtotal" : "usage.metric.cost";
  useEffect(() => { setStepPage(1); }, [profile?.sessionIds[0], profile?.scope]);
  useEffect(() => { setStepPage(page => Math.min(page, Math.max(1, Math.ceil((profile?.usage.requests ?? 0) / 12)))); }, [profile?.usage.requests]);
  useEffect(() => {
    if (!profile || visibleTab !== "usage" || collapsed) return;
    const controller = new AbortController(); setUsageLoading(true); setUsageError(undefined);
    void request<SessionProfile>(`/sessions/${encodeURIComponent(profile.sessionIds[0]!)}/profile${sessionParams({ version: profile.version, includeChildren: profile.scope === "tree" })}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setUsageDetails(result); })
      .catch(error => { if (!isAborted(error)) setUsageError(error instanceof Error ? error : new Error(String(error))); })
      .finally(() => { if (!controller.signal.aborted) setUsageLoading(false); });
    return () => controller.abort();
  }, [profile?.version, profile?.sessionIds[0], profile?.scope, visibleTab, collapsed, usageRetry]);
  const visibleUsage = usageDetails?.version === profile?.version && usageDetails?.scope === profile?.scope && usageDetails?.sessionIds[0] === profile?.sessionIds[0] ? usageDetails : undefined;
  const stepOffset = (stepPage - 1) * 12;
  const visibleSteps = visibleUsage?.steps.slice(stepOffset, stepOffset + 12) ?? [];
  const failureCount = profile?.tools.reduce((total, item) => total + item.failure, 0) ?? 0;
  const rounds = profile?.roundMetrics;
  const roundDuration = rounds?.averageDurationMs;
  const durationUnit = roundDuration != null && roundDuration >= 3_600_000 ? "hour" : roundDuration != null && roundDuration >= 60_000 ? "minute" : "second";
  const durationDivisor = durationUnit === "hour" ? 3_600_000 : durationUnit === "minute" ? 60_000 : 1000;
  const peak = profile?.peakInputRequest ?? profile?.steps.find(step => step.inputTokens === profile.usage.peakInputTokens && !!step.messageId);
  const coverage = profile ? usageCoverage(profile.usage, [...primaryMetrics, ...(profile.usage.peakInputTokens !== null ? [metrics[5]] : []), ...extraMetrics]) : [];
  const metric = ([key, label]: typeof metrics[number]) => {
    if (!profile) return null;
    const partial = coverage.some(group => group.labels.includes(label));
    const name = !partial ? t(label) : key === "peakInputTokens" ? t("sessions.profile.maxRecordedInput") : t("sessions.profile.recordedSubtotal", { label: t(label) });
    return <div key={key}><strong>{key === "peakInputTokens" && peak ? <button className="session-stat-link session-peak-link" aria-label={t("sessions.evidence.peak", { value: formatCount(profile.usage.peakInputTokens!) })} onClick={() => onFocusStep(peak)}>{displayRecorded(profile.usage[key])}<Crosshair size={13} aria-hidden="true" /></button> : displayRecorded(profile.usage[key])}</strong><span>{name}</span>
      </div>;
  };
  return <aside className={`evidence-pane session-profile${collapsed ? " panel-collapsed" : ""}`} aria-label={t("sessions.profile.title")}>
    <div className="pane-heading"><span className="session-pane-label">{t("sessions.profile.title")}<span className="session-pane-progress" role={(loading || usageLoading) && profile ? "status" : undefined} aria-label={(loading || usageLoading) && profile ? t("sessions.profile.loading") : undefined}>{(loading || usageLoading) && profile && <ArrowClockwise size={14} className="is-spinning" aria-hidden="true" />}</span></span><div className="session-profile-heading-actions">
      <div className="session-profile-scope" role="group" aria-label={t("sessions.profile.scope")} hidden={collapsed}>
        <button aria-pressed={!includeChildren} className={!includeChildren ? "is-selected" : ""} onClick={() => setIncludeChildren(false)}>{t("sessions.profile.self")}</button>
        <button aria-pressed={includeChildren} className={includeChildren ? "is-selected" : ""} onClick={() => setIncludeChildren(true)}>{t("sessions.profile.withChildren")}</button>
      </div>
      <button className="icon-button panel-toggle" aria-label={collapsed ? t("sessions.profile.expand") : t("sessions.profile.collapse")} aria-expanded={!collapsed} aria-controls="session-profile-content" onClick={() => setCollapsed(!collapsed)}>{collapsed ? <CaretLeft size={16} /> : <CaretRight size={16} />}</button>
    </div></div>
    <div className="session-profile-tabs" role="tablist" aria-label={t("sessions.profile.categories")} hidden={collapsed}>
      {([["overview", "sessions.profile.overview"], ...(hasCalls ? [["calls", "sessions.profile.calls"]] : []), ...(hasUsage ? [["usage", "sessions.profile.usage"]] : [])] as ["overview" | "calls" | "usage", string][]).map(([value, label]) => <button key={value} role="tab" aria-selected={visibleTab === value} aria-controls="session-profile-content" onClick={() => setTab(value)}>{t(label)}</button>)}
    </div>
    <div id="session-profile-content" className="session-profile-content" data-version={profile?.version} hidden={collapsed}>
      {loading && !profile && <p className="muted" role="status">{t("sessions.profile.loading")}</p>}
      {error && <Notice danger action={<button className="text-button" onClick={onRetry}>{t("common.retry")}</button>}><SessionError error={error} /></Notice>}
      {!loading && !error && !profile && <div className="session-profile-empty"><h3>{t("sessions.profile.select")}</h3></div>}
      {profile && <>
        {profile.missingChildren > 0 && <Notice>{t("sessions.profile.missingChildren", { count: profile.missingChildren })}</Notice>}
        {visibleTab === "overview" && <section className="session-profile-section"><div className="session-section-heading"><h3>{t("sessions.profile.content")}</h3><div className="section-actions">
          {failureCount > 0 ? <SessionEvidence kind="failure" profile={profile} onSelect={onFocusEvent}><button className="text-button">{t("sessions.evidence.failureCount", { count: failureCount })}</button></SessionEvidence> : <span>{profile.scope === "tree" ? t("sessions.profile.selfLinked") : t("sessions.profile.self")}</span>}
          {rounds && <HelpPopover iconOnly label={t("sessions.profile.roundHelp")}>
            <p>{t("sessions.profile.roundScopeHelp")}</p>
            <p>{t("sessions.profile.roundInferredHelp", { count: rounds.inferredTurns ?? 0 })}</p>
            <p>{t("sessions.profile.roundStepsHelp", { total: rounds.userTurns, ended: rounds.completedTurns, count: rounds.stepTurns })}</p>
            <p>{t("sessions.profile.roundDurationHelp", { count: rounds.timedTurns, ended: rounds.completedTurns })}</p>
            <p>{t("sessions.profile.promptLengthHelp", { count: rounds.promptInputs })}</p>
          </HelpPopover>}
        </div></div>
          <div className="session-usage-grid compact"><div><strong>{formatCount(profile.messageCount)}</strong><span>{t("sessions.profile.messages")}</span></div><div><strong>{formatCount(profile.turnCount)}</strong><span>{t("sessions.timeline.turn")}</span></div>
            <div><strong>{formatCount(profile.estimate.total)}</strong><span>{t("sessions.profile.estimateTokens")}</span></div><div><strong>{profile.compressions > 0 ? <SessionEvidence kind="compression" profile={profile} onSelect={onFocusEvent}><button className="session-stat-link" aria-label={t("sessions.evidence.compressionCount", { count: profile.compressions })}>{formatCount(profile.compressions)}</button></SessionEvidence> : formatCount(profile.compressions)}</strong><span>{t("sessions.profile.compressions")}</span></div>
            {rounds && <><div><strong>{rounds.averageSteps === null ? "—" : `${(rounds.inferredStepTurns ?? 0) > 0 ? "≈ " : ""}${number(rounds.averageSteps, { maximumFractionDigits: 1 })}`}</strong><span>{t("sessions.profile.averageSteps")}</span></div>
              <div><strong>{roundDuration == null ? "—" : `${(rounds.inferredTimedTurns ?? 0) > 0 ? "≈ " : ""}${number(roundDuration / durationDivisor, { style: "unit", unit: durationUnit, unitDisplay: "short", maximumFractionDigits: 1 })}`}</strong><span>{t("sessions.profile.averageRoundDuration")}</span></div>
              <div><strong>{rounds.averagePromptCharacters === null ? "—" : number(rounds.averagePromptCharacters, { maximumFractionDigits: 1 })}</strong><span>{t("sessions.profile.averagePromptCharacters")}</span></div></>}
          </div>
          <details className="session-stat-details"><summary>{t("sessions.profile.estimateKinds")}</summary>
            <p>{isMessageDescriptorKnown(profile.estimate.methodDescriptor) ? messageText(profile.estimate.methodDescriptor, profile.estimate.method) : profile.estimate.method}</p>
            {profile.estimate.byKind.filter(item => item.tokens > 0).map(item => <ProfileBar key={item.kind} label={t(kindLabels[item.kind])} count={item.tokens} max={Math.max(1, ...profile.estimate.byKind.map(value => value.tokens))} unit="tokens" />)}
          </details>
        </section>}
        {visibleTab === "overview" && profile.models.length > 0 && <section className="session-profile-section"><div className="session-section-heading"><h3>{t("sessions.profile.models")}</h3><span>{t("sessions.profile.modelCount", { count: profile.models.length })}</span></div>
          {profile.models.map(item => <ProfileBar key={item.model} label={item.model} count={item.count} max={Math.max(...profile.models.map(model => model.count))} unit="records" />)}
        </section>}
        {visibleTab !== "calls" && hasUsage && <>
          <section className="session-profile-section"><div className="session-section-heading"><h3>{t("sessions.trace.usageRequest")}</h3><div className="section-actions"><span>{t("sessions.profile.requestCount", { count: profile.usage.requests })}</span><HelpPopover iconOnly label={t("sessions.profile.statsHelp")}>
            <p>{t("sessions.profile.cacheHelp")}</p><p>{t("sessions.profile.scopeHelp", { scope: profile.scope === "tree" ? t("sessions.profile.selfTree") : t("sessions.profile.currentSelf") })}</p>
            <p>{t("sessions.profile.coverageHelp", { input: profile.usage.inputRecordedRequests, requests: profile.usage.requests, cache: profile.usage.cacheRecordedRequests })}</p>
            {coverage.map(group => <p key={group.count}>{t("sessions.profile.fieldCoverage", { fields: group.labels.map(label => t(label)).join(" · "), count: group.count, total: group.total })}</p>)}
            <p>{t("sessions.profile.costHelp")}</p><p>{t("usage.help.cost")}</p>
            {visibleCost && <><p>{t("usage.coverage.cost", { complete: visibleCost.totals.pricedRequests, partial: visibleCost.totals.partiallyPricedRequests, missing: visibleCost.totals.unpricedRequests })}</p><p>{t("usage.coverage.priceBasis", { historical: visibleCost.totals.historicalPricedRequests, snapshot: visibleCost.totals.currentSnapshotPricedRequests, manual: visibleCost.totals.manualPricedRequests })}</p></>}
            <p>{isMessageDescriptorKnown(profile.estimate.methodDescriptor) ? messageText(profile.estimate.methodDescriptor, profile.estimate.method) : profile.estimate.method}</p>
            {hasNativeCost && <p>{t("sessions.nativeUsage.costHelp")}</p>}<SpeedAlgorithmHelp />
          </HelpPopover></div></div>
            <div className="session-usage-grid">{primaryMetrics.map(metric)}<AverageSpeedMetric summary={speedSummary} />
              {profile.usage.peakInputTokens !== null && metric(["peakInputTokens", "sessions.profile.maxInput"])}{extraMetrics.map(metric)}</div>
            <div className="session-cost" role="group" aria-label={t(costLabel)} data-price-version={visibleCost?.priceVersion}>
              <div className="session-cost-heading"><span>{t(costLabel)}</span>{costLoading ? <span role="status">{t("common.loading")}</span> : <strong><span className="session-cost-value">{visibleCost?.totals.estimatedCost == null ? "—" : number(visibleCost.totals.estimatedCost, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></strong>}</div>
              {costError && <Notice danger action={<button className="text-button" onClick={() => setCostRetry(value => value + 1)}>{t("common.retry")}</button>}><SessionError error={costError} /></Notice>}
            </div>
            {profile.usage.cacheReadRatio !== null && <div className="session-cache-ratio"><div className="session-cost-heading"><span>{t(profile.usage.inputRecordedRequests === profile.usage.requests && profile.usage.cacheRecordedRequests === profile.usage.requests ? "sessions.profile.cacheRatio" : "sessions.profile.cacheRatioRecorded")}</span><strong>{normalizedRatio(profile.usage.cacheReadRatio)}</strong></div></div>}
          </section>
        </>}
        {visibleTab === "usage" && profile.usage.requests > 0 && <section className="session-profile-section"><div className="session-section-heading"><h3>{t("sessions.profile.trend")}</h3><HelpPopover label={t("sessions.profile.chartHelp")}>
          <p>{t("sessions.profile.chartCoordinatesHelp")}</p><p>{t("sessions.profile.chartLocateHelp")}</p>
        </HelpPopover></div>
          {usageLoading && !visibleUsage && <p role="status">{t("sessions.profile.loading")}</p>}
          {usageError && <Notice danger action={<button className="text-button" onClick={() => setUsageRetry(value => value + 1)}>{t("common.retry")}</button>}><SessionError error={usageError} /></Notice>}
          {visibleUsage && <>
          {visibleUsage.steps.filter(step => usageSeries.some(([key]) => step[key] !== undefined)).length > 1 && <UsageChart profile={visibleUsage} onFocusStep={onFocusStep} />}
            <div className="session-step-table"><table><thead><tr><th>{t("sessions.profile.request")}</th>{usageSeries.filter(([key]) => profile.usage.recordedRequests?.[key] || profile.steps.some(step => step[key] !== undefined)).map(([key, label]) => <th key={key}>{t(label)}</th>)}{hasNativeCost && <th>{t("sessions.nativeUsage.reportedCost")}</th>}{hasSpeed && <th aria-label={t("sessions.speed.label")}><SpeedColumnHeader /></th>}</tr></thead><tbody>
              {visibleSteps.map((step, index) => <tr key={`${step.sessionId}:${step.id}`}><td>{requestLocation(step) ? <button aria-label={t("sessions.profile.requestNumber", { number: formatCount(stepOffset + index + 1) })} onClick={() => onFocusStep(step)}>#{formatCount(stepOffset + index + 1)}</button> : <span>#{formatCount(stepOffset + index + 1)}</span>}</td>
                {usageSeries.filter(([key]) => profile.usage.recordedRequests?.[key] || profile.steps.some(item => item[key] !== undefined)).map(([key]) => <td key={key}>{step[key] === undefined ? "—" : displayRecorded(step[key])}</td>)}{hasNativeCost && <td>{step.nativeReportedCostUsd === undefined ? "—" : number(step.nativeReportedCostUsd, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", maximumFractionDigits: 4 })}</td>}{hasSpeed && <td><RequestSpeedBadge usage={step} compact onLocate={messageId => onFocusStep({ ...step, messageId })} /></td>}</tr>)}
            </tbody></table></div>
            {(visibleUsage.stepsTotal ?? profile.usage.requests) > 12 && <Pager page={stepPage} pageSize={12} total={visibleUsage.stepsTotal ?? profile.usage.requests} onChange={setStepPage} label={t("sessions.profile.requestPagination")} showEnds />}</>}
        </section>}
        {(visibleTab === "usage" || visibleTab === "overview" && !profile.usage.requests) && !!profile.usageReports?.length && <NativeUsageReports reports={profile.usageReports} />}
        {visibleTab === "calls" && <>
          {profile.tools.length > 0 && <section className="session-profile-section"><div className="session-section-heading"><h3>{t("sessions.profile.tools")}</h3><span>{t("sessions.profile.callCount", { count: profile.tools.reduce((total, item) => total + item.calls, 0) })}</span></div>
            {profile.tools.map(item => <div className="session-tool-stat" key={item.name}><div className="session-tool-title"><button className="session-stat-link" title={t("sessions.profile.locateCall")} onClick={() => onFind({ toolName: item.name })}>{item.name}</button><span>{t("sessions.profile.callCount", { count: item.calls })}</span></div>
              <div className="session-tool-outcomes">{item.success > 0 && <span>{t("sessions.calls.successCount", { count: item.success })}</span>}{item.failure > 0 && <span>{t("sessions.calls.failureCount", { count: item.failure })}</span>}{item.unknown > 0 && <span>{t("sessions.calls.missingCount", { count: item.unknown })}</span>}{item.durationMs !== null && <span>{t("sessions.profile.duration", { duration: `${displayRecorded(item.durationMs)} ms` })}</span>}</div>
              <ProfileBar label={t("sessions.profile.calls")} count={item.calls} max={Math.max(1, ...profile.tools.map(tool => tool.calls))} />
            </div>)}
          </section>}
          {profile.resources.length > 0 && <section className="session-profile-section"><div className="session-section-heading"><h3>{t("sessions.profile.resources")}</h3><span>{t("sessions.profile.resourceCount", { count: profile.resources.reduce((total, item) => total + item.count, 0) })}</span></div>{profile.resources.map(item => <div className="session-resource-stat" key={`${item.kind}-${item.server ?? ""}-${item.name}`}>
            <span className={`session-resource-kind is-${item.kind}`}>{t(resourceLabels[item.kind])}</span><button className="session-stat-link" title={t("sessions.profile.locateResource")} onClick={() => onFind({ resourceKind: item.kind, resourceName: item.name, resourceServer: item.server })}>{item.server ? `${item.server} / ` : ""}{sessionResourceName(item)}</button><b>{formatCount(item.count)}</b>
          </div>)}</section>}
        </>}
        {visibleTab === "overview" && profile.children.length > 0 && <section className="session-profile-section"><div className="session-section-heading"><h3>{t("sessions.profile.children")}</h3><span>{t("sessions.profile.childCount", { count: profile.children.length })}</span></div>
          {profile.children.map(child => <button className="session-child" key={child.id} onClick={() => onSelectChild(child)}><strong>{sessionDisplayTitle(child)}</strong><small>{clientLabel(child.client)} · {shortProject(child.project)} · {child.relationship === "fork" ? t("sessions.relationship.forkShort") : t("sessions.relationship.child")}</small></button>)}
        </section>}
        {profile.gaps.length > 0 && <details className="session-gaps"><summary>{t("sessions.details.import")}</summary>{profile.gaps.filter((gap, index, all) => all.findIndex(item => item.kind === gap.kind && item.message === gap.message) === index).map((gap, index) => <SessionDiagnostic key={`${gap.kind}-${index}`} gap={gap} />)}</details>}
      </>}
    </div>
  </aside>;
}
