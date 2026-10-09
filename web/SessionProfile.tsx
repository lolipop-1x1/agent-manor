import { clientLabel, getLanguage, isMessageDescriptorKnown, messageText, t, useI18n } from "./i18n";
import { formatDateTime, formatNumber, formatPercent } from "../src/i18n";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CaretLeft, CaretRight, Crosshair } from "@phosphor-icons/react";
import type { SessionProfile, SessionSummary, SessionTimelineEvent } from "../src/session-contracts";
import { sessionDisplayTitle, displayRecorded, sessionResourceName, sessionParams, usageAxis, usageIndexAt, usageSegments, type EvidenceTarget } from "./session-model";
import { kindLabels, resourceLabels } from "./SessionMessage";
import { Notice, Pager, SessionDiagnostic, SessionError } from "./SessionControls";
import { HelpPopover } from "./HelpPopover";
import { SessionEvidence } from "./SessionEvidence";
import { summarizeRequestSpeed } from "../src/session-speed";
import { AverageSpeedMetric, RequestSpeedBadge, SpeedAlgorithmHelp, SpeedColumnHeader } from "./SessionSpeed";
import { requestLocation } from "./session-speed-model";
import { isAborted, request } from "./api";

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
        {active && selected !== undefined && <div id={tooltipId} role="tooltip" className="session-chart-tooltip" style={x(selected) < 50 ? { right: 8 } : { left: 8 }}>
          <strong>{t(active.sessionId !== profile.sessionIds[0] ? "sessions.profile.childRequestNumber" : "sessions.profile.requestNumber", { number: formatCount(offset + selected + 1) })}</strong>
          {active.model && <span className="session-chart-tooltip-model">{active.model}</span>}
          <dl>{usageSeries.filter(([key]) => active[key] !== undefined).map(([key, label]) => <div key={key}><dt><i className={`series-${key}`} />{t(label)}</dt><dd>{displayRecorded(active[key])}{active[key] === undefined ? "" : " Token"}</dd></div>)}</dl>
          <RequestSpeedBadge usage={active} interactive={false} />
          {active.occurredAt && <small>{dateLabel(active.occurredAt)}</small>}
        </div>}
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

export function SessionProfilePane({ profile, loading, error, includeChildren, setIncludeChildren, collapsed, setCollapsed, onRetry, onSelectChild, onFocusStep, onFind, onFocusEvent }: {
  profile: SessionProfile | null; loading: boolean; error: Error | null; includeChildren: boolean; setIncludeChildren: (value: boolean) => void;
  collapsed: boolean; setCollapsed: (value: boolean) => void; onRetry: () => void;
  onSelectChild: (session: SessionSummary) => void; onFocusStep: (step: SessionProfile["steps"][number]) => void; onFind: (target: EvidenceTarget) => void;
  onFocusEvent: (event: SessionTimelineEvent) => void;
}) {
  useI18n();
  const [tab, setTab] = useState<"overview" | "calls" | "usage">("overview");
  const [stepPage, setStepPage] = useState(1);
  const [usageDetails, setUsageDetails] = useState<SessionProfile>();
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<Error>();
  const [usageRetry, setUsageRetry] = useState(0);
  const hasCalls = !!profile && (profile.tools.length > 0 || profile.resources.length > 0);
  const visibleMetrics = profile ? metrics.filter(([key]) => profile.usage[key] !== null) : [];
  const hasUsage = visibleMetrics.length > 0 || !!profile?.usage.requests;
  const speedSummary = useMemo(() => profile?.outputSpeed ?? (profile ? summarizeRequestSpeed(profile.steps) : undefined), [profile]);
  const hasSpeed = !!speedSummary?.requests;
  const visibleTab = tab === "calls" && !hasCalls || tab === "usage" && !hasUsage ? "overview" : tab;
  const primaryMetrics = visibleMetrics.filter(([key]) => key === "inputTokens" || key === "outputTokens");
  const extraMetrics = visibleMetrics.filter(([key]) => visibleTab === "usage" && !["inputTokens", "outputTokens", "peakInputTokens"].includes(key));
  useEffect(() => { setStepPage(1); }, [profile?.sessionIds[0], profile?.scope]);
  useEffect(() => { setStepPage(page => Math.min(page, Math.max(1, Math.ceil((profile?.usage.requests ?? 0) / 12)))); }, [profile?.usage.requests]);
  useEffect(() => {
    if (!profile || visibleTab !== "usage" || collapsed) return;
    const controller = new AbortController(); setUsageLoading(true); setUsageError(undefined);
    void request<SessionProfile>(`/sessions/${encodeURIComponent(profile.sessionIds[0]!)}/profile${sessionParams({ version: profile.version, includeChildren: profile.scope === "tree", stepOffset: (stepPage - 1) * 12, stepLimit: 12 })}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setUsageDetails(result); })
      .catch(error => { if (!isAborted(error)) setUsageError(error instanceof Error ? error : new Error(String(error))); })
      .finally(() => { if (!controller.signal.aborted) setUsageLoading(false); });
    return () => controller.abort();
  }, [profile?.version, profile?.sessionIds[0], profile?.scope, visibleTab, collapsed, stepPage, usageRetry]);
  const visibleUsage = usageDetails?.version === profile?.version && usageDetails?.scope === profile?.scope && usageDetails?.sessionIds[0] === profile?.sessionIds[0] ? usageDetails : undefined;
  const failureCount = profile?.tools.reduce((total, item) => total + item.failure, 0) ?? 0;
  const peak = profile?.peakInputRequest ?? profile?.steps.find(step => step.inputTokens === profile.usage.peakInputTokens && !!step.messageId);
  const metric = ([key, label]: typeof metrics[number]) => {
    if (!profile) return null;
    const field = key === "peakInputTokens" ? "inputTokens" : key === "peakContextTokens" ? "contextTokens" : key;
    const recorded = field === "inputTokens" ? profile.usage.inputRecordedRequests : field === "cachedInputTokens" ? profile.usage.cacheRecordedRequests
      : field === "contextTokens" ? undefined : profile.usage.recordedRequests?.[field];
    return <div key={key}><strong>{key === "peakInputTokens" && peak ? <button className="session-stat-link session-peak-link" aria-label={t("sessions.evidence.peak", { value: formatCount(profile.usage.peakInputTokens!) })} onClick={() => onFocusStep(peak)}>{displayRecorded(profile.usage[key])}<Crosshair size={13} aria-hidden="true" /></button> : displayRecorded(profile.usage[key])}</strong><span>{t(label)}</span>
      {recorded !== undefined && recorded < profile.usage.requests && <small className="session-partial-badge">{t("sessions.usage.recordedRange", { count: recorded, total: profile.usage.requests })}</small>}</div>;
  };
  return <aside className={`evidence-pane session-profile${collapsed ? " panel-collapsed" : ""}`} aria-label={t("sessions.profile.title")}>
    <div className="pane-heading"><span>{t("sessions.profile.title")}</span><div className="session-profile-heading-actions">
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
      {loading && <p className="muted" role="status">{t("sessions.profile.loading")}</p>}
      {error && <Notice danger action={<button className="text-button" onClick={onRetry}>{t("common.retry")}</button>}><SessionError error={error} /></Notice>}
      {!loading && !error && !profile && <div className="session-profile-empty"><h3>{t("sessions.profile.select")}</h3></div>}
      {profile && <>
        {profile.missingChildren > 0 && <Notice>{t("sessions.profile.missingChildren", { count: profile.missingChildren })}</Notice>}
        {visibleTab === "overview" && profile.models.length > 0 && <section className="session-profile-section"><div className="session-section-heading"><h3>{t("sessions.profile.models")}</h3><span>{t("sessions.profile.modelCount", { count: profile.models.length })}</span></div>
          {profile.models.map(item => <ProfileBar key={item.model} label={item.model} count={item.count} max={Math.max(...profile.models.map(model => model.count))} unit="records" />)}
        </section>}
        {visibleTab !== "calls" && hasUsage && <>
          <section className="session-profile-section"><div className="session-section-heading"><h3>{t("sessions.trace.usageRequest")}</h3><div className="section-actions"><span>{t("sessions.profile.requestCount", { count: profile.usage.requests })}</span><HelpPopover iconOnly label={t("sessions.profile.statsHelp")}>
            <p>{t("sessions.profile.cacheHelp")}</p><p>{t("sessions.profile.scopeHelp", { scope: profile.scope === "tree" ? t("sessions.profile.selfTree") : t("sessions.profile.currentSelf") })}</p>
            <p>{isMessageDescriptorKnown(profile.estimate.methodDescriptor) ? messageText(profile.estimate.methodDescriptor, profile.estimate.method) : profile.estimate.method}</p><SpeedAlgorithmHelp />
          </HelpPopover></div></div>
            <div className="session-usage-grid">{primaryMetrics.map(metric)}<AverageSpeedMetric summary={speedSummary} />
              {profile.usage.peakInputTokens !== null && metric(["peakInputTokens", "sessions.profile.maxInput"])}{extraMetrics.map(metric)}</div>
            {profile.usage.cacheReadRatio !== null && profile.usage.inputRecordedRequests === profile.usage.requests && profile.usage.cacheRecordedRequests === profile.usage.requests && <div className="session-cache-ratio"><div><span>{t("sessions.profile.cacheRatio")}</span><strong>{normalizedRatio(profile.usage.cacheReadRatio)}</strong></div></div>}
          </section>
        </>}
        {visibleTab === "overview" && <section className="session-profile-section"><div className="session-section-heading"><h3>{t("sessions.profile.content")}</h3><div className="section-actions">
          {failureCount > 0 ? <SessionEvidence kind="failure" profile={profile} onSelect={onFocusEvent}><button className="text-button">{t("sessions.evidence.failureCount", { count: failureCount })}</button></SessionEvidence> : <span>{profile.scope === "tree" ? t("sessions.profile.selfLinked") : t("sessions.profile.self")}</span>}
        </div></div>
          <div className="session-usage-grid compact"><div><strong>{formatCount(profile.messageCount)}</strong><span>{t("sessions.profile.messages")}</span></div><div><strong>{formatCount(profile.turnCount)}</strong><span>{t("sessions.timeline.turn")}</span></div>
            <div><strong>{formatCount(profile.estimate.total)}</strong><span>{t("sessions.profile.estimateTokens")}</span></div><div><strong>{profile.compressions > 0 ? <SessionEvidence kind="compression" profile={profile} onSelect={onFocusEvent}><button className="session-stat-link" aria-label={t("sessions.evidence.compressionCount", { count: profile.compressions })}>{formatCount(profile.compressions)}</button></SessionEvidence> : formatCount(profile.compressions)}</strong><span>{t("sessions.profile.compressions")}</span></div></div>
          <details className="session-stat-details"><summary>{t("sessions.profile.estimateKinds")}</summary>
            <p>{isMessageDescriptorKnown(profile.estimate.methodDescriptor) ? messageText(profile.estimate.methodDescriptor, profile.estimate.method) : profile.estimate.method}</p>
            {profile.estimate.byKind.filter(item => item.tokens > 0).map(item => <ProfileBar key={item.kind} label={t(kindLabels[item.kind])} count={item.tokens} max={Math.max(1, ...profile.estimate.byKind.map(value => value.tokens))} unit="tokens" />)}
          </details>
        </section>}
        {visibleTab === "usage" && profile.usage.requests > 0 && <section className="session-profile-section"><div className="session-section-heading"><h3>{t("sessions.profile.trend")}</h3><HelpPopover label={t("sessions.profile.chartHelp")}>
          <p>{t("sessions.profile.chartCoordinatesHelp")}</p><p>{t("sessions.profile.chartLocateHelp")}</p>
        </HelpPopover></div>
          {usageLoading && <p role="status">{t("sessions.profile.loading")}</p>}
          {usageError && <Notice danger action={<button className="text-button" onClick={() => setUsageRetry(value => value + 1)}>{t("common.retry")}</button>}><SessionError error={usageError} /></Notice>}
          {visibleUsage && <><p className="session-request-range">{t("sessions.profile.requestRange", { from: (visibleUsage.stepsOffset ?? 0) + 1, to: (visibleUsage.stepsOffset ?? 0) + visibleUsage.steps.length, total: visibleUsage.stepsTotal ?? profile.usage.requests })}</p>
          {visibleUsage.steps.filter(step => usageSeries.some(([key]) => step[key] !== undefined)).length > 1 && <UsageChart profile={visibleUsage} onFocusStep={onFocusStep} />}
            <div className="session-step-table"><table><thead><tr><th>{t("sessions.profile.request")}</th>{usageSeries.filter(([key]) => profile.usage.recordedRequests?.[key] || profile.steps.some(step => step[key] !== undefined)).map(([key, label]) => <th key={key}>{t(label)}</th>)}{hasSpeed && <th aria-label={t("sessions.speed.label")}><SpeedColumnHeader /></th>}</tr></thead><tbody>
              {visibleUsage.steps.map((step, index) => <tr key={`${step.sessionId}:${step.id}`}><td>{requestLocation(step) ? <button aria-label={t("sessions.profile.requestNumber", { number: formatCount((visibleUsage.stepsOffset ?? 0) + index + 1) })} onClick={() => onFocusStep(step)}>#{formatCount((visibleUsage.stepsOffset ?? 0) + index + 1)}</button> : <span>#{formatCount((visibleUsage.stepsOffset ?? 0) + index + 1)}</span>}</td>
                {usageSeries.filter(([key]) => profile.usage.recordedRequests?.[key] || profile.steps.some(item => item[key] !== undefined)).map(([key]) => <td key={key}>{step[key] === undefined ? "—" : displayRecorded(step[key])}</td>)}{hasSpeed && <td><RequestSpeedBadge usage={step} compact onLocate={messageId => onFocusStep({ ...step, messageId })} /></td>}</tr>)}
            </tbody></table></div>
            {(visibleUsage.stepsTotal ?? profile.usage.requests) > 12 && <Pager page={stepPage} pageSize={12} total={visibleUsage.stepsTotal ?? profile.usage.requests} onChange={setStepPage} label={t("sessions.profile.requestPagination")} showEnds />}</>}
        </section>}
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
