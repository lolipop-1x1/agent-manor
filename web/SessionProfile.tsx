import { clientLabel, getLanguage, isMessageDescriptorKnown, messageText, t, useI18n } from "./i18n";
import { formatDateTime, formatNumber, formatPercent } from "../src/i18n";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import type { SessionProfile, SessionSummary } from "../src/session-contracts";
import { sessionDisplayTitle, displayRecorded, sessionResourceName, usageAxis, usageIndexAt, usageSegments, type EvidenceTarget } from "./session-model";
import { kindLabels, resourceLabels } from "./SessionMessage";
import { Notice, Pager, SessionDiagnostic, SessionError } from "./SessionControls";
import { HelpPopover } from "./HelpPopover";
import { gapNames } from "./model";

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
    return { ...axis, curves: usageSeries.map(([key]) => ({ key, segments: usageSegments(profile.steps, key, axis.max) })) };
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
  const x = (index: number) => profile.steps.length <= 1 ? 50 : index / (profile.steps.length - 1) * 100;
  const requestAt = (clientX: number, target: SVGRectElement) => {
    const bounds = target.getBoundingClientRect();
    // 视口两端各有 2 个单位的绘图留白，先还原到实际横轴再定位请求。
    return usageIndexAt(((clientX - bounds.left) / bounds.width * 104 - 2) / 100, profile.steps.length);
  };
  return <div className="session-usage-chart">
    <div className="session-chart-legend">{usageSeries.map(([key, label]) => <span key={key}><i className={`series-${key}`} />{t(label)}</span>)}</div>
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
            aria-label={t("sessions.profile.chartSelect")} aria-orientation="horizontal" aria-valuemin={1} aria-valuemax={profile.steps.length} aria-valuenow={currentRequest + 1}
            aria-valuetext={t(controlStep.messageId ? "sessions.profile.chartValueLinked" : "sessions.profile.chartValue", { number: formatCount(currentRequest + 1), input: displayRecorded(controlStep.inputTokens), output: displayRecorded(controlStep.outputTokens), cache: displayRecorded(controlStep.cachedInputTokens) })}
            aria-describedby={active ? tooltipId : undefined}
            onPointerMove={event => setHovered(requestAt(event.clientX, event.currentTarget))}
            onPointerDown={event => setHovered(requestAt(event.clientX, event.currentTarget))}
            onFocus={() => setFocused(value => value ?? hovered ?? lastFocused.current)}
            onClick={() => {
              const index = currentRequest;
              setFocused(index);
              const step = profile.steps[index]!;
              if (step.messageId) onFocusStep(step);
            }}
            onKeyDown={event => {
              if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                setHovered(undefined);
                const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
                setFocused(event.key === "Home" ? 0 : event.key === "End" ? profile.steps.length - 1 : Math.max(0, Math.min(profile.steps.length - 1, currentRequest + direction)));
              } else if (controlStep.messageId && ["Enter", " "].includes(event.key)) {
                event.preventDefault(); onFocusStep(controlStep);
              }
            }} />
        </svg>
        {active && selected !== undefined && <div id={tooltipId} role="tooltip" className="session-chart-tooltip" style={x(selected) < 50 ? { right: 8 } : { left: 8 }}>
          <strong>{t(active.sessionId !== profile.sessionIds[0] ? "sessions.profile.childRequestNumber" : "sessions.profile.requestNumber", { number: formatCount(selected + 1) })}</strong>
          <span className="session-chart-tooltip-model">{active.model ?? t("sessions.trace.modelMissing")}</span>
          <dl>{usageSeries.map(([key, label]) => <div key={key}><dt><i className={`series-${key}`} />{t(label)}</dt><dd>{displayRecorded(active[key])}{active[key] === undefined ? "" : " Token"}</dd></div>)}</dl>
          <small>{dateLabel(active.occurredAt)}</small>
        </div>}
      </div>
      <span /><div className="session-chart-axis"><span>1</span><span>{t("sessions.profile.chartRequestIndex")}</span><span>{profile.steps.length > 1 ? formatCount(profile.steps.length) : ""}</span></div>
    </div>
  </div>;
}

export function SessionProfilePane({ profile, loading, error, includeChildren, setIncludeChildren, collapsed, setCollapsed, onRetry, onSelectChild, onFocusStep, onFind }: {
  profile: SessionProfile | null; loading: boolean; error: Error | null; includeChildren: boolean; setIncludeChildren: (value: boolean) => void;
  collapsed: boolean; setCollapsed: (value: boolean) => void; onRetry: () => void;
  onSelectChild: (session: SessionSummary) => void; onFocusStep: (step: SessionProfile["steps"][number]) => void; onFind: (target: EvidenceTarget) => void;
}) {
  useI18n();
  const [tab, setTab] = useState<"overview" | "calls" | "usage">("overview");
  const [stepPage, setStepPage] = useState(1);
  useEffect(() => { setStepPage(1); }, [profile?.sessionIds[0], profile?.scope, profile?.version]);
  return <aside className={`evidence-pane session-profile${collapsed ? " panel-collapsed" : ""}`} aria-label={t("sessions.profile.title")}>
    <div className="pane-heading"><span>{t("sessions.profile.title")}</span><div className="session-profile-heading-actions"><div className="session-profile-scope" role="group" aria-label={t("sessions.profile.scope")} hidden={collapsed}>
      <button aria-pressed={!includeChildren} className={!includeChildren ? "is-selected" : ""} onClick={() => setIncludeChildren(false)}>{t("sessions.profile.self")}</button>
      <button aria-pressed={includeChildren} className={includeChildren ? "is-selected" : ""} onClick={() => setIncludeChildren(true)}>{t("sessions.profile.withChildren")}</button>
    </div><button className="icon-button panel-toggle" aria-label={collapsed ? t("sessions.profile.expand") : t("sessions.profile.collapse")} aria-expanded={!collapsed} aria-controls="session-profile-content" onClick={() => setCollapsed(!collapsed)}>{collapsed ? <CaretRight size={16} /> : <CaretLeft size={16} />}</button></div></div>
    <div className="session-profile-tabs" role="tablist" aria-label={t("sessions.profile.categories")} hidden={collapsed}>
      {([ ["overview", t("sessions.profile.overview")], ["calls", t("sessions.profile.calls")], ["usage", t("sessions.profile.usage")] ] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} aria-controls="session-profile-content" onClick={() => setTab(value)}>{label}</button>)}
    </div>
    <div id="session-profile-content" className="session-profile-content" hidden={collapsed}>
      {loading && <p className="muted" role="status">{t("sessions.profile.loading")}</p>}
      {error && <Notice danger action={<button className="text-button" onClick={onRetry}>{t("common.retry")}</button>}><SessionError error={error} /></Notice>}
      {!loading && !error && !profile && <div className="session-profile-empty"><h3>{t("sessions.profile.select")}</h3></div>}
      {profile && <>
        {profile.missingChildren > 0 && <Notice>{t("sessions.profile.missingChildren", { count: profile.missingChildren })}</Notice>}
        <section className="session-profile-section" hidden={tab !== "overview"}><div className="session-section-heading"><h3>{t("sessions.profile.models")}</h3><span>{t("sessions.profile.modelCount", { count: profile.models.length })}</span></div>
          {profile.models.length ? profile.models.map(item => <ProfileBar key={item.model} label={item.model} count={item.count} max={Math.max(...profile.models.map(model => model.count))} unit="records" />) : <p className="muted small">{t("sessions.trace.modelMissing")}</p>}
        </section>
        <section className="session-profile-section" hidden={tab === "calls"}><div className="session-section-heading"><h3>{t("sessions.trace.usageRequest")}</h3><div className="section-actions"><span>{t("sessions.profile.requestCount", { count: profile.usage.requests })}</span><HelpPopover label={t("sessions.profile.statsHelp")}>
          <dl><div><dt>{t("sessions.profile.cacheRatio")}</dt><dd>{t("sessions.profile.cacheHelp")}</dd></div>
            <div><dt>{t("sessions.profile.usageCoverage")}</dt><dd>{t("sessions.profile.coverageHelp", { input: formatCount(profile.usage.inputRecordedRequests), requests: formatCount(profile.usage.requests), cache: formatCount(profile.usage.cacheRecordedRequests) })}</dd></div>
            <div><dt>{t("sessions.profile.estimate")}</dt><dd>{isMessageDescriptorKnown(profile.estimate.methodDescriptor) ? messageText(profile.estimate.methodDescriptor, profile.estimate.method) : t("common.originalDetail", { detail: profile.estimate.method })}</dd></div>
            <div><dt>{t("sessions.profile.scopeHelpTitle")}</dt><dd>{t("sessions.profile.scopeHelp", { scope: profile.scope === "tree" ? t("sessions.profile.selfTree") : t("sessions.profile.currentSelf") })}</dd></div></dl>
        </HelpPopover></div></div>
          <div className="session-usage-grid">
            <div><strong>{displayRecorded(profile.usage.inputTokens)}</strong><span>{t("sessions.profile.totalInput")}</span></div>
            <div><strong>{displayRecorded(profile.usage.outputTokens)}</strong><span>{t("sessions.profile.outputTokens")}</span></div>
            <div hidden={tab !== "usage"}><strong>{displayRecorded(profile.usage.cachedInputTokens)}</strong><span>{t("sessions.profile.cachedTokens")}</span></div>
            <div hidden={tab !== "usage"}><strong>{displayRecorded(profile.usage.cacheWriteTokens)}</strong><span>{t("sessions.profile.cacheWriteTokens")}</span></div>
            <div hidden={tab !== "usage"}><strong>{displayRecorded(profile.usage.reasoningOutputTokens)}</strong><span>{t("sessions.profile.reasoningTokens")}</span></div>
            <div hidden={tab !== "usage"}><strong>{displayRecorded(profile.usage.peakInputTokens)}</strong><span>{t("sessions.profile.maxInput")}</span></div>
            <div hidden={tab !== "usage"}><strong>{displayRecorded(profile.usage.peakContextTokens)}</strong><span>{t("sessions.profile.peakContext")}</span></div>
          </div>
          <div className="session-cache-ratio"><div><span>{t("sessions.profile.cacheRatio")}</span><strong>{normalizedRatio(profile.usage.cacheReadRatio)}</strong></div>
            {profile.usage.cacheReadRatio !== null && (profile.usage.inputRecordedRequests < profile.usage.requests || profile.usage.cacheRecordedRequests < profile.usage.inputRecordedRequests) && <span className="session-partial-badge">{t("sessions.profile.partial")}</span>}
          </div>
        </section>
        <section className="session-profile-section" hidden={tab !== "overview"}><div className="session-section-heading"><h3>{t("sessions.profile.content")}</h3><span>{profile.scope === "tree" ? t("sessions.profile.selfLinked") : t("sessions.profile.self")}</span></div>
          <div className="session-usage-grid compact"><div><strong>{formatCount(profile.messageCount)}</strong><span>{t("sessions.profile.messages")}</span></div><div><strong>{formatCount(profile.turnCount)}</strong><span>{t("sessions.timeline.turn")}</span></div>
            <div><strong>{formatCount(profile.estimate.total)}</strong><span>{t("sessions.profile.estimateTokens")}</span></div><div><strong>{formatCount(profile.compressions)}</strong><span>{t("sessions.profile.compressions")}</span></div></div>
          <details className="session-stat-details"><summary>{t("sessions.profile.estimateKinds")}</summary>{profile.estimate.byKind.map(item => <ProfileBar key={item.kind} label={t(kindLabels[item.kind])} count={item.tokens} max={Math.max(1, ...profile.estimate.byKind.map(value => value.tokens))} unit="tokens" />)}</details>
        </section>
        <section className="session-profile-section" hidden={tab !== "calls"}><div className="session-section-heading"><h3>{t("sessions.profile.tools")}</h3><span>{t("sessions.profile.callCount", { count: profile.tools.reduce((total, item) => total + item.calls, 0) })}</span></div>
          {profile.tools.length ? profile.tools.map(item => <div className="session-tool-stat" key={item.name}>
            <div className="session-tool-title"><button className="session-stat-link" title={t("sessions.profile.locateCall")} onClick={() => onFind({ toolName: item.name })}>{item.name}</button><span>{t("sessions.profile.callStatuses", { success: formatCount(item.success), failure: formatCount(item.failure), unknown: formatCount(item.unknown) })}</span></div>
            <ProfileBar label={t("sessions.profile.calls")} count={item.calls} max={Math.max(1, ...profile.tools.map(tool => tool.calls))} />
            <small>{t("sessions.profile.duration", { duration: item.durationMs === null ? t("common.notRecorded") : `${displayRecorded(item.durationMs)} ms` })}</small>
          </div>) : <p className="muted small">{t("sessions.profile.noTools")}</p>}
        </section>
        <section className="session-profile-section" hidden={tab !== "calls"}><div className="session-section-heading"><h3>{t("sessions.profile.resources")}</h3><span>{t("sessions.profile.resourceCount", { count: profile.resources.reduce((total, item) => total + item.count, 0) })}</span></div>
          {profile.resources.length ? profile.resources.map(item => <div className="session-resource-stat" key={`${item.kind}-${item.server ?? ""}-${item.name}-${item.nameDescriptor?.key ?? ""}`}>
            <span className={`session-resource-kind is-${item.kind}`}>{t(resourceLabels[item.kind])}</span><button className="session-stat-link" title={t("sessions.profile.locateResource")} onClick={() => onFind({ resourceKind: item.kind, resourceName: item.name, resourceServer: item.server })}>{item.server ? `${item.server} / ` : ""}{sessionResourceName(item)}</button><b>{formatCount(item.count)}</b>
          </div>) : <p className="muted small">{t("sessions.profile.noResources")}</p>}
        </section>
        <section className="session-profile-section" hidden={tab !== "usage"}><div className="session-section-heading"><h3>{t("sessions.profile.trend")}</h3><div className="section-actions"><span>{t("sessions.profile.resourceCount", { count: profile.steps.length })}</span><HelpPopover label={t("sessions.profile.chartHelp")}>
          <dl><div><dt>{t("sessions.profile.chartCoordinates")}</dt><dd>{t("sessions.profile.chartCoordinatesHelp")}</dd></div>
            <div><dt>{t("sessions.profile.chartLocate")}</dt><dd>{t("sessions.profile.chartLocateHelp")}</dd></div></dl>
        </HelpPopover></div></div>
          {tab === "usage" && (profile.steps.length ? <>
            <UsageChart profile={profile} onFocusStep={onFocusStep} />
            <div className="session-step-table"><table><thead><tr><th>{t("sessions.profile.request")}</th><th>{t("sessions.usage.input")}</th><th>{t("sessions.usage.output")}</th><th>{t("sessions.usage.cachedInput")}</th></tr></thead><tbody>
              {profile.steps.slice((stepPage - 1) * 12, stepPage * 12).map((step, index) => <tr key={step.id}>
                <td>{step.messageId ? <button onClick={() => onFocusStep(step)} title={`${step.model ?? t("sessions.trace.modelMissing")} · ${dateLabel(step.occurredAt)}`}>{t(step.sessionId !== profile.sessionIds[0] ? "sessions.profile.childStep" : "sessions.profile.step", { number: formatCount((stepPage - 1) * 12 + index + 1) })}</button> : <span>#{formatCount((stepPage - 1) * 12 + index + 1)}</span>}</td>
                <td>{displayRecorded(step.inputTokens)}</td><td>{displayRecorded(step.outputTokens)}</td><td>{displayRecorded(step.cachedInputTokens)}</td>
              </tr>)}
            </tbody></table></div>
            <Pager page={stepPage} pageSize={12} total={profile.steps.length} onChange={setStepPage} label={t("sessions.profile.requestPagination")} showEnds />
          </> : <p className="muted small">{t("sessions.profile.noSteps")}</p>)}
        </section>
        {profile.children.length > 0 && <section className="session-profile-section" hidden={tab !== "overview"}><div className="session-section-heading"><h3>{t("sessions.profile.children")}</h3><span>{t("sessions.profile.childCount", { count: profile.children.length })}</span></div>
          {profile.children.map(child => <button className="session-child" key={child.id} onClick={() => onSelectChild(child)}><strong>{sessionDisplayTitle(child)}</strong><small>{clientLabel(child.client)} · {shortProject(child.project)} · {child.relationship === "fork" ? t("sessions.relationship.forkShort") : t("sessions.relationship.child")}</small></button>)}
        </section>}
        {profile.gaps.length > 0 && <details className="session-gaps"><summary>{t("sessions.profile.gapCount", { count: profile.gaps.length })}</summary>{profile.gaps.map((gap, index) => <div key={`${gap.kind}-${gap.sourceId ?? index}`}><strong>{gapNames[gap.kind]}{gap.count === undefined ? "" : ` · ${formatCount(gap.count)}`}</strong><SessionDiagnostic gap={gap} /></div>)}</details>}
      </>}
    </div>
  </aside>;
}
