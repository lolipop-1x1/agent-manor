import { useEffect, useState } from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { clientName } from "../src/clients";
import type { SessionProfile, SessionSummary } from "../src/session-contracts";
import { displayRecorded, usageSegments, type EvidenceTarget } from "./session-model";
import { kindLabels, resourceLabels } from "./SessionMessage";
import { Notice, Pager } from "./SessionControls";

const formatCount = (value: number) => value.toLocaleString("zh-CN");
const dateLabel = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "时间未记录";
const shortProject = (value?: string) => value ? value.split(/[\\/]/).filter(Boolean).at(-1) ?? value : "无项目";
const normalizedRatio = (value: number | null) => value === null ? "未记录" : `${(value * 100).toFixed(1)}%`;

function ProfileBar({ label, count, max, suffix = "" }: { label: string; count: number; max: number; suffix?: string }) {
  const width = max > 0 ? Math.max(2, count / max * 100) : 0;
  return <div className="session-bar-row"><span>{label}</span><span className="session-bar-track"><i style={{ width: `${width}%` }} /></span><strong>{formatCount(count)}{suffix}</strong></div>;
}

function UsageChart({ profile, onFocusStep }: { profile: SessionProfile; onFocusStep: (step: SessionProfile["steps"][number]) => void }) {
  const series = [["inputTokens", "输入"], ["cachedInputTokens", "缓存读取"], ["outputTokens", "输出"]] as const;
  const max = Math.max(1, ...profile.steps.flatMap(step => series.map(([key]) => step[key] ?? 0)));
  return <div className="session-usage-chart">
    <div className="session-chart-legend">{series.map(([key, label]) => <span key={key}><i className={`series-${key}`} />{label}</span>)}</div>
    <small>{formatCount(max)} Token</small>
    <svg viewBox="-2 -2 104 106" preserveAspectRatio="none" aria-label="输入、缓存读取和输出 Token 的请求趋势">
      {[0, 50, 100].map(y => <line key={y} x1="0" x2="100" y1={y} y2={y} className="session-chart-grid" vectorEffect="non-scaling-stroke" />)}
      {series.flatMap(([key]) => usageSegments(profile.steps, key, max).map((points, index) => points.includes(" ")
        ? <polyline key={`${key}-${index}`} points={points} className={`series-${key}`} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        : <circle key={`${key}-${index}`} cx={points.split(",")[0]} cy={points.split(",")[1]} r="1" className={`series-${key}`} />))}
      {profile.steps.map((step, index) => <rect key={step.id} x={index / profile.steps.length * 100} y="0" width={100 / profile.steps.length} height="100" className="session-chart-hit"
        role={step.messageId ? "button" : undefined} tabIndex={step.messageId ? 0 : undefined}
        aria-label={`请求 ${index + 1}，输入 ${displayRecorded(step.inputTokens)}，输出 ${displayRecorded(step.outputTokens)}，缓存读取 ${displayRecorded(step.cachedInputTokens)}${step.messageId ? "，定位记录" : ""}`}
        onClick={() => step.messageId && onFocusStep(step)} onKeyDown={event => { if (step.messageId && ["Enter", " "].includes(event.key)) { event.preventDefault(); onFocusStep(step); } }}>
        <title>{step.model ?? "模型未记录"} · {dateLabel(step.occurredAt)} · 输入 {displayRecorded(step.inputTokens)} · 输出 {displayRecorded(step.outputTokens)} · 缓存读取 {displayRecorded(step.cachedInputTokens)}</title>
      </rect>)}
    </svg><div className="session-chart-axis"><span>请求 1</span><span>请求 {profile.steps.length}</span></div>
  </div>;
}

export function SessionProfilePane({ profile, loading, error, includeChildren, setIncludeChildren, collapsed, setCollapsed, onRetry, onSelectChild, onFocusStep, onFind }: {
  profile: SessionProfile | null; loading: boolean; error: string | null; includeChildren: boolean; setIncludeChildren: (value: boolean) => void;
  collapsed: boolean; setCollapsed: (value: boolean) => void; onRetry: () => void;
  onSelectChild: (session: SessionSummary) => void; onFocusStep: (step: SessionProfile["steps"][number]) => void; onFind: (target: EvidenceTarget) => void;
}) {
  const [tab, setTab] = useState<"overview" | "calls" | "usage">("overview");
  const [stepPage, setStepPage] = useState(1);
  useEffect(() => { setStepPage(1); }, [profile?.sessionIds[0], profile?.scope, profile?.version]);
  return <aside className={`evidence-pane session-profile${collapsed ? " panel-collapsed" : ""}`} aria-label="会话画像">
    <div className="pane-heading"><span>会话画像</span><div className="session-profile-heading-actions"><div className="session-profile-scope" role="group" aria-label="画像范围" hidden={collapsed}>
      <button aria-pressed={!includeChildren} className={!includeChildren ? "is-selected" : ""} onClick={() => setIncludeChildren(false)}>自身</button>
      <button aria-pressed={includeChildren} className={includeChildren ? "is-selected" : ""} onClick={() => setIncludeChildren(true)}>包含子会话</button>
    </div><button className="icon-button panel-toggle" aria-label={collapsed ? "展开会话画像" : "收起会话画像"} aria-expanded={!collapsed} aria-controls="session-profile-content" onClick={() => setCollapsed(!collapsed)}>{collapsed ? <CaretRight size={16} /> : <CaretLeft size={16} />}</button></div></div>
    <div className="session-profile-tabs" role="tablist" aria-label="会话统计分类" hidden={collapsed}>
      {([ ["overview", "概览"], ["calls", "调用"], ["usage", "用量"] ] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} aria-controls="session-profile-content" onClick={() => setTab(value)}>{label}</button>)}
    </div>
    <div id="session-profile-content" className="session-profile-content" hidden={collapsed}>
      {loading && <p className="muted" role="status">正在计算画像…</p>}
      {error && <Notice danger action={<button className="text-button" onClick={onRetry}>重试</button>}>{error}</Notice>}
      {!loading && !error && !profile && <div className="session-profile-empty"><h3>选择会话查看画像</h3><p className="muted">画像只展示索引中有记录的模型、用量与工具证据。</p></div>}
      {profile && <>
        {profile.missingChildren > 0 && <Notice>{profile.missingChildren} 个关联子会话缺少可用记录，未计入当前画像。</Notice>}
        <section className="session-profile-section" hidden={tab !== "overview"}><div className="session-section-heading"><h3>模型记录</h3><span>{profile.models.length} 种</span></div>
          {profile.models.length ? profile.models.map(item => <ProfileBar key={item.model} label={item.model} count={item.count} max={Math.max(...profile.models.map(model => model.count))} suffix=" 条记录" />) : <p className="muted small">模型未记录</p>}
        </section>
        <section className="session-profile-section" hidden={tab === "calls"}><div className="session-section-heading"><h3>请求用量</h3><span>用量记录请求 {displayRecorded(profile.usage.requests)} 条</span></div>
          <div className="session-usage-grid">
            <div><strong>{displayRecorded(profile.usage.inputTokens)}</strong><span>总输入 Token</span></div>
            <div><strong>{displayRecorded(profile.usage.outputTokens)}</strong><span>输出 Token</span></div>
            <div hidden={tab !== "usage"}><strong>{displayRecorded(profile.usage.cachedInputTokens)}</strong><span>缓存读取 Token</span></div>
            <div hidden={tab !== "usage"}><strong>{displayRecorded(profile.usage.cacheWriteTokens)}</strong><span>缓存写入 Token</span></div>
            <div hidden={tab !== "usage"}><strong>{displayRecorded(profile.usage.reasoningOutputTokens)}</strong><span>推理输出 Token</span></div>
            <div hidden={tab !== "usage"}><strong>{displayRecorded(profile.usage.peakInputTokens)}</strong><span>最大单次输入 Token</span></div>
            <div hidden={tab !== "usage"}><strong>{displayRecorded(profile.usage.peakContextTokens)}</strong><span>峰值上下文 Token</span></div>
          </div>
          <div className="session-cache-ratio"><div><span>缓存读取占比</span><strong>{normalizedRatio(profile.usage.cacheReadRatio)}</strong></div>
            <small>只按同批可确认的缓存读取与总输入计算；输出与推理字段不相加。</small>
            <small>输入记录覆盖 {formatCount(profile.usage.inputRecordedRequests)} / {formatCount(profile.usage.requests)} 个用量记录请求 · 可确认缓存读取 {formatCount(profile.usage.cacheRecordedRequests)} / {formatCount(profile.usage.inputRecordedRequests)} 个输入记录请求</small>
          </div>
        </section>
        <section className="session-profile-section" hidden={tab !== "overview"}><div className="session-section-heading"><h3>会话内容</h3><span>{profile.scope === "tree" ? "自身与关联子会话" : "自身"}</span></div>
          <div className="session-usage-grid compact"><div><strong>{formatCount(profile.messageCount)}</strong><span>消息</span></div><div><strong>{formatCount(profile.turnCount)}</strong><span>轮次</span></div>
            <div><strong>{formatCount(profile.estimate.total)}</strong><span>留存内容估算 Token</span></div><div><strong>{formatCount(profile.compressions)}</strong><span>压缩事件</span></div></div>
          <small className="session-estimate-note">估算方法：{profile.estimate.method}。这是留存文本估算，与模型请求计费用量分开。</small>
          <details className="session-stat-details"><summary>按记录类型查看估算</summary>{profile.estimate.byKind.map(item => <ProfileBar key={item.kind} label={kindLabels[item.kind]} count={item.tokens} max={Math.max(1, ...profile.estimate.byKind.map(value => value.tokens))} suffix=" Token" />)}</details>
        </section>
        <section className="session-profile-section" hidden={tab !== "calls"}><div className="session-section-heading"><h3>工具调用</h3><span>{formatCount(profile.tools.reduce((total, item) => total + item.calls, 0))} 次</span></div>
          {profile.tools.length ? profile.tools.map(item => <div className="session-tool-stat" key={item.name}>
            <div className="session-tool-title"><button className="session-stat-link" title="定位首条调用证据" onClick={() => onFind({ toolName: item.name })}>{item.name}</button><span>{formatCount(item.success)} 成功 · {formatCount(item.failure)} 失败 · {formatCount(item.unknown)} 未知</span></div>
            <ProfileBar label="调用" count={item.calls} max={Math.max(1, ...profile.tools.map(tool => tool.calls))} />
            <small>已记录耗时：{item.durationMs === null ? "未记录" : `${displayRecorded(item.durationMs)} ms`}</small>
          </div>) : <p className="muted small">没有工具调用记录。</p>}
        </section>
        <section className="session-profile-section" hidden={tab !== "calls"}><div className="session-section-heading"><h3>Skill 与 MCP 证据</h3><span>{formatCount(profile.resources.reduce((total, item) => total + item.count, 0))} 条</span></div>
          {profile.resources.length ? profile.resources.map(item => <div className="session-resource-stat" key={`${item.kind}-${item.server ?? ""}-${item.name}`}>
            <span className={`session-resource-kind is-${item.kind}`}>{resourceLabels[item.kind]}</span><button className="session-stat-link" title="定位首条资源证据" onClick={() => onFind({ resourceKind: item.kind, resourceName: item.name, resourceServer: item.server })}>{item.server ? `${item.server} / ` : ""}{item.name}</button><b>{formatCount(item.count)}</b>
          </div>) : <p className="muted small">没有明确的 Skill 或 MCP 事件证据。</p>}
        </section>
        <section className="session-profile-section" hidden={tab !== "usage"}><div className="session-section-heading"><h3>请求用量趋势</h3><span>{profile.steps.length} 条明细</span></div>
          {profile.steps.length ? <>
            <UsageChart profile={profile} onFocusStep={onFocusStep} />
            <p className="session-estimate-note">横轴为返回明细的请求顺序；缺失值留空。点击图表或请求编号定位记录。</p>
            <div className="session-step-table"><table><thead><tr><th>请求</th><th>输入</th><th>输出</th><th>缓存读取</th></tr></thead><tbody>
              {profile.steps.slice((stepPage - 1) * 12, stepPage * 12).map((step, index) => <tr key={step.id}>
                <td>{step.messageId ? <button onClick={() => onFocusStep(step)} title={`${step.model ?? "模型未记录"} · ${dateLabel(step.occurredAt)}`}>#{(stepPage - 1) * 12 + index + 1}{step.sessionId !== profile.sessionIds[0] ? " 子" : ""}</button> : <span>#{(stepPage - 1) * 12 + index + 1}</span>}</td>
                <td>{displayRecorded(step.inputTokens)}</td><td>{displayRecorded(step.outputTokens)}</td><td>{displayRecorded(step.cachedInputTokens)}</td>
              </tr>)}
            </tbody></table></div>
            <Pager page={stepPage} pageSize={12} total={profile.steps.length} onChange={setStepPage} label="请求明细分页" />
          </> : <p className="muted small">逐步用量未记录。</p>}
        </section>
        {profile.children.length > 0 && <section className="session-profile-section" hidden={tab !== "overview"}><div className="session-section-heading"><h3>关联子会话</h3><span>{profile.children.length} 个</span></div>
          {profile.children.map(child => <button className="session-child" key={child.id} onClick={() => onSelectChild(child)}><strong>{child.title}</strong><small>{clientName(child.client)} · {shortProject(child.project)} · {child.relationship === "fork" ? "分叉" : "子会话"}</small></button>)}
        </section>}
        {profile.gaps.length > 0 && <details className="session-gaps"><summary>数据缺口与范围限制 · {profile.gaps.length}</summary>{profile.gaps.map((gap, index) => <div key={`${gap.kind}-${gap.sourceId ?? index}`}><strong>{gap.kind}{gap.count === undefined ? "" : ` · ${formatCount(gap.count)}`}</strong><p>{gap.message}</p></div>)}</details>}
      </>}
    </div>
  </aside>;
}
