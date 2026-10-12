import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowClockwise, ArrowRight, WarningCircle } from "@phosphor-icons/react";
import type { WeeklyReview as Review, WeeklyReviewDetailKind, WeeklyReviewDetailQuery, WeeklyReviewRank } from "../../../src/overview-contracts";
import { CLIENTS, type Client } from "../../../src/clients";
import { clientLabel, useI18n } from "../../shared/i18n";
import { errorMessage, isAborted, request } from "../../shared/api";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import type { OverviewSessionTarget } from "./Investigation";
import { overviewCalendarDate } from "./model";
import { weeklyReviewDuration, weeklyReviewParameters, weeklyReviewRecordTitle, weeklyReviewFreshLabel, weeklyReviewCacheShareLabel } from "./review-model";
import { WeeklyReviewDetails } from "./WeeklyReviewDetails";
import "./weekly-review.css";

export function WeeklyReview({ active, clients, projects, revision, onSession }: {
  active: boolean; clients?: string[]; projects?: string[]; revision: number; onSession: (target: OverviewSessionTarget) => void;
}) {
  const { t, number, percent, date, time, language } = useI18n();
  const [result, setResult] = useState<{ key: string; review: Review } | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState<Error | null>(null), [retry, setRetry] = useState(0);
  const [selection, setSelection] = useState<WeeklyReviewDetailQuery | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const parameters = weeklyReviewParameters({ clients, projects });
  const key = `${parameters}:${revision}:${retry}`;
  const pending = loading || Boolean(result && result.key !== key);
  const review = result?.review;
  useEffect(() => { setSelection(null); }, [key]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); setLoading(true); setError(null);
    void request<Review>(`/overview/review?${parameters}`, { signal: controller.signal }).then(review => {
      if (!controller.signal.aborted) setResult({ key, review });
    }).catch(value => {
      if (!controller.signal.aborted && !isAborted(value)) setError(value instanceof Error ? value : new Error(String(value)));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, key]);
  const open = (kind: WeeklyReviewDetailKind, sort?: WeeklyReviewDetailQuery["sort"], filter?: WeeklyReviewDetailQuery["filter"]) => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelection({ kind, sort, filter: filter ?? (kind === "rounds" ? "explicit" : undefined) });
  };
  const n = (value: number | null | undefined) => value == null ? "—" : number(value, { maximumFractionDigits: 1 });
  const money = (value: number | null) => value == null ? "—" : number(value, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const duration = (value: number | null | undefined) => {
    const display = weeklyReviewDuration(value); return display ? t(display.key, { value: number(display.value, { maximumFractionDigits: 1 }) }) : "—";
  };
  const client = (value: string) => CLIENTS.some(item => item.id === value) ? clientLabel(value as Client) : value;
  const rank = (rows: WeeklyReviewRank[], kind: "agents" | "models" | "reasoning") => {
    const row = rows.find(item => item.key !== "unknown") ?? rows[0];
    return row ? <span className="weekly-review-preference"><span title={row.name}>{kind === "agents" ? client(row.name) : row.key === "unknown" ? t("overview.review.unknown") : row.name}</span><span>{t("overview.review.rankCount", { count: n(row.count), share: row.share == null ? "—" : percent(row.share) })}</span></span> : "—";
  };
  const metric = (name: string, value: ReactNode, kind: WeeklyReviewDetailKind, sort?: WeeklyReviewDetailQuery["sort"]) => <button type="button" className="weekly-review-metric" key={name} onClick={() => open(kind, sort, name === "zero" ? "zero" : undefined)}><span>{t(`overview.review.${name}`)}</span><strong>{value}</strong></button>;
  const peak = review?.preferences.busiestHour;
  const peakLabel = peak == null ? "—" : t("overview.review.hourRange", { from: time(new Date(2000, 0, 1, peak), { hour: "2-digit", minute: "2-digit" }), to: time(new Date(2000, 0, 1, peak + 1), { hour: "2-digit", minute: "2-digit" }) });
  return <section className="overview-section weekly-review" aria-busy={pending} aria-labelledby="weekly-review-title">
    <div className="overview-section-heading"><div><h2 id="weekly-review-title">{t("overview.review.title")}</h2><HelpPopover label={t("overview.review.help")} iconOnly><p>{t("overview.review.help.global")}</p><p>{t("overview.review.help.rounds")}</p><p>{t("overview.review.help.cache")}</p></HelpPopover></div><div><span className="weekly-review-range">{review ? t("overview.review.range", { from: date(overviewCalendarDate(review.range.from)), to: date(overviewCalendarDate(review.range.to)) }) : null}</span><span className="overview-progress" role="status" aria-label={pending ? t("overview.loading") : undefined}>{pending && <ArrowClockwise size={16} className="is-spinning" />}</span></div></div>
    {error && <div className="overview-error" role="alert"><WarningCircle size={17} /><span>{errorMessage(error)}</span><button className="text-button" onClick={() => setRetry(value => value + 1)}>{t("overview.retry")}</button></div>}
    {!review && !error && <div className="weekly-review-skeleton" aria-label={t("overview.loading")} role="status">{Array.from({ length: 4 }, (_, index) => <div key={index}>{Array.from({ length: 5 }, (_, row) => <i key={row} />)}</div>)}</div>}
    {review && <div inert={pending}>
      <div className="weekly-review-groups">
        <div className="weekly-review-group"><h3>{t("overview.review.group.sessions")}</h3>{metric("active", n(review.sessions.active), "sessions")}{metric("completed", n(review.rounds.completed), "rounds")}{metric("compressionSessions", n(review.sessions.compressionSessions), "compressions")}{metric("compressions", n(review.sessions.compressions), "compressions")}</div>
        <div className="weekly-review-group"><h3>{t("overview.review.group.rounds")}</h3>{metric("steps", n(review.rounds.steps.average), "rounds", "steps")}{metric("toolCalls", n(review.rounds.toolCalls.average), "rounds")}{metric("tokens", n(review.rounds.tokens.average), "rounds", "tokens")}{metric("duration", duration(review.rounds.durationMs.average), "rounds", "duration")}</div>
        <div className="weekly-review-group"><h3>{t("overview.review.group.cache")}</h3>{metric("zero", n(review.cache.zero), "cache")}{metric(weeklyReviewCacheShareLabel(review.cache), review.cache.readShare == null ? "—" : percent(review.cache.readShare), "cache")}{metric(weeklyReviewFreshLabel(review.cache), n(review.cache.freshInputTokens), "cache", "fresh")}{metric(review.cache.premiumMissing ? "premiumSubtotal" : "premium", money(review.cache.hypotheticalPremium), "cache", "fresh")}{metric("uncompressed", n(review.sessions.uncompressedPeakInput.average), "uncompressed")}</div>
        <div className="weekly-review-group"><h3>{t("overview.review.group.preferences")}</h3>{metric("agents", rank(review.preferences.agents, "agents"), "agents")}{metric("models", rank(review.preferences.models, "models"), "models")}{metric("reasoning", rank(review.preferences.reasoning, "reasoning"), "reasoning")}{metric("promptCharacters", n(review.preferences.promptCharacters.average), "prompts")}{metric("activity", peakLabel, "activity")}</div>
      </div>
      <div className="weekly-review-highlights">
        <button className="weekly-review-highlight" onClick={() => open("rounds", "duration")}><span>{t("overview.review.longest")}</span><strong>{weeklyReviewRecordTitle(review.rounds.longest[0], language)}</strong><span>{duration(review.rounds.longest[0]?.durationMs)}</span><ArrowRight size={14} /></button>
        <button className="weekly-review-highlight" onClick={() => open("rounds", "tokens")}><span>{t("overview.review.highestTokens")}</span><strong>{weeklyReviewRecordTitle(review.rounds.highestTokens[0], language)}</strong><span>{n(review.rounds.highestTokens[0]?.tokens)}</span><ArrowRight size={14} /></button>
      </div>
      <div className="weekly-review-actions">{([['largeInputs', 'cache', 'fresh'], ['projects', 'projects'], ['delegation', 'delegation'], ['tools', 'tools']] as const).map(([name, kind, sort]) => <button key={name} className="text-button" onClick={() => open(kind, sort)}>{t(`overview.review.${name}`)}<ArrowRight size={14} /></button>)}</div>
    </div>}
    {review && <WeeklyReviewDetails active={active} review={review} selection={selection} pending={pending} returnFocus={trigger} onSelect={setSelection} onClose={() => setSelection(null)} onReload={() => setRetry(value => value + 1)} onSession={onSession} />}
  </section>;
}
