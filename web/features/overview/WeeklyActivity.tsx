import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { WeeklyReview } from "../../../src/overview-contracts";
import { useI18n } from "../../shared/i18n";
import { FilterSelect } from "../../shared/ui/FilterSelect";

export function WeeklyActivity({ preferences, container }: { preferences: WeeklyReview["preferences"]; container: HTMLElement | null }) {
  const { t, number, time } = useI18n();
  const [view, setView] = useState("hours"), [selected, setSelected] = useState(0);
  const cells = useRef(new Map<number, HTMLSpanElement>());
  const weekdays = [1, 2, 3, 4, 5, 6, 0];
  const hour = (value: number) => time(new Date(2000, 0, 1, value), { hour: "2-digit", minute: "2-digit" });
  const maxHour = Math.max(1, ...preferences.hours.map(item => item.messages));
  const maxWeek = Math.max(1, ...preferences.weekdays.map(item => item.messages));
  const maxCell = Math.max(1, ...preferences.weekdayHours.map(item => item.messages));
  const navigate = (event: KeyboardEvent, index: number) => {
    const length = view === "hours" ? 24 : view === "weekdays" ? 7 : 168;
    const step = view === "heatmap" ? 24 : 1;
    const next = event.key === "Home" ? 0 : event.key === "End" ? length - 1 : index + ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: step, ArrowUp: -step }[event.key] ?? 0);
    if (!["Home", "End", "ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault(); cells.current.get(Math.min(length - 1, Math.max(0, next)))?.focus();
  };
  const cell = (index: number, label: string, content: ReactNode, className?: string) => <Tooltip.Root key={index}><Tooltip.Trigger asChild><span ref={element => { if (element) cells.current.set(index, element); else cells.current.delete(index); }} className={className} tabIndex={index === selected ? 0 : -1} aria-label={label} onFocus={() => setSelected(index)} onKeyDown={event => navigate(event, index)}>{content}</span></Tooltip.Trigger><Tooltip.Portal container={container}><Tooltip.Content className="tooltip" sideOffset={6}>{label}<Tooltip.Arrow /></Tooltip.Content></Tooltip.Portal></Tooltip.Root>;
  return <section className="weekly-review-activity" aria-label={t("overview.review.activity")}>
    <div className="overview-section-heading"><strong>{t("overview.review.messageCount", { count: preferences.userMessages })}</strong><FilterSelect label={t("overview.review.activityView")} value={view} options={["hours", "weekdays", "heatmap"].map(value => ({ value, label: t(`overview.review.${value}`) }))} container={container} onChange={value => { setSelected(0); setView(value); }} /></div>
    {view === "hours" && <div className="weekly-review-hour-bars">{preferences.hours.map(item => cell(item.hour, t("overview.review.hourMessages", { hour: hour(item.hour), count: item.messages }), <><i style={{ height: `${item.messages / maxHour * 180}px` }} /><span>{number(item.hour)}</span></>))}</div>}
    {view === "weekdays" && <div className="weekly-review-week-bars">{weekdays.map((weekday, index) => { const count = preferences.weekdays.find(item => item.weekday === weekday)?.messages ?? 0; return cell(index, t("overview.review.weekdayMessages", { weekday: t(`overview.review.weekday.${weekday}`), count }), <><span>{t(`overview.review.weekday.${weekday}`)}</span><span className="weekly-review-week-track"><i style={{ width: `${count / maxWeek * 100}%` }} /></span><strong>{number(count)}</strong></>); })}</div>}
    {view === "heatmap" && <div className="weekly-review-heatmap-scroll"><div className="weekly-review-heatmap"><span />{Array.from({ length: 24 }, (_, value) => <span key={value}>{number(value)}</span>)}{weekdays.map((weekday, row) => <div className="weekly-review-heatmap-row" key={weekday}><span>{t(`overview.review.weekday.${weekday}`)}</span>{Array.from({ length: 24 }, (_, value) => { const count = preferences.weekdayHours.find(item => item.weekday === weekday && item.hour === value)?.messages ?? 0; return cell(row * 24 + value, t("overview.review.cellMessages", { weekday: t(`overview.review.weekday.${weekday}`), hour: hour(value), count }), null, `level-${count === 0 ? 0 : Math.min(4, Math.ceil(count / maxCell * 4))}`); })}</div>)}</div></div>}
  </section>;
}
