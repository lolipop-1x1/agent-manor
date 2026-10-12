import { useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { OverviewActivityDay, OverviewReport } from "../../../src/overview-contracts";
import { useI18n } from "../../shared/i18n";
import { FilterSelect } from "../../shared/ui/FilterSelect";
import { localDay } from "../usage/model";
import { formatTokenMillions } from "../usage/format";
import type { OverviewRoute } from "./model";

const dayValue = (day: OverviewActivityDay, metric: OverviewRoute["activity"]) => metric === "tools" ? day.toolCalls : day[metric];
const dayDate = (day: string) => new Date(`${day}T12:00:00`);
function sequence(from: string, to: string) {
  const days: string[] = []; const current = dayDate(from);
  while (localDay(current) <= to) { days.push(localDay(current)); current.setDate(current.getDate() + 1); }
  return days;
}
export function ActivityCalendar({ report, metric, onDay, onRange }: { report: Pick<OverviewReport, "range" | "activity">; metric: OverviewRoute["activity"]; onDay: (day: string) => void; onRange: (day: string) => void }) {
  const { t, number, date, language } = useI18n();
  const years = [...new Set(report.activity.days.map(day => day.day.slice(0, 4)))];
  const [year, setYear] = useState(report.range.to.slice(0, 4));
  const [focusDay, setFocusDay] = useState(report.range.to);
  const [selected, setSelected] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const scroll = useRef<HTMLDivElement | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => { setYear(report.range.to.slice(0, 4)); setFocusDay(report.range.to); setSelected(null); }, [report.range.from, report.range.to]);
  const yearly = report.activity.days.length > 366;
  const from = yearly ? report.range.from > `${year}-01-01` ? report.range.from : `${year}-01-01` : report.range.from;
  const to = yearly ? report.range.to < `${year}-12-31` ? report.range.to : `${year}-12-31` : report.range.to;
  const days = useMemo(() => sequence(from, to), [from, to]);
  const facts = new Map(report.activity.days.map(day => [day.day, day]));
  const max = Math.max(1, ...days.map(day => dayValue(facts.get(day) ?? { day, sessions: 0, events: 0, requests: 0, tokens: null, toolCalls: 0 }, metric) ?? 0));
  const offset = dayDate(from).getDay();
  useEffect(() => {
    const el = scroll.current; if (!el) return;
    let atEnd = true, width = el.clientWidth;
    const track = () => { if (el.clientWidth === width) atEnd = el.scrollWidth - el.clientWidth - el.scrollLeft <= 1; };
    const resize = new ResizeObserver(() => {
      width = el.clientWidth;
      if (atEnd) el.scrollLeft = el.scrollWidth;
    });
    el.scrollLeft = el.scrollWidth;
    el.addEventListener("scroll", track); resize.observe(el);
    return () => { el.removeEventListener("scroll", track); resize.disconnect(); };
  }, [from, to]);
  const current = selected ? facts.get(selected) : undefined;
  const amount = (value: number | null | undefined) => value == null ? "—" : metric === "tokens" ? formatTokenMillions(language, value) : number(value);
  const move = (day: string, step: number) => { const next = days[Math.max(0, Math.min(days.length - 1, days.indexOf(day) + step))]!; setFocusDay(next); buttons.current.get(next)?.focus(); };
  return <div className="overview-activity-calendar">
    {yearly && <div className="overview-calendar-year"><FilterSelect label={t("overview.activity.year")} value={year} options={years.map(value => ({ value, label: value }))} onChange={value => { setYear(value); setFocusDay(`${value}-12-31` > report.range.to ? report.range.to : `${value}-12-31`); }} /></div>}
    <div ref={scroll} className="overview-calendar-scroll"><div className="overview-calendar">
      <div className="overview-calendar-weekdays">{Array.from({ length: 7 }, (_, weekday) => <span key={weekday}>{weekday % 2 === 1 ? date(new Date(2024, 0, 7 + weekday), { weekday: "short" }) : ""}</span>)}</div>
      <div><div className="overview-calendar-months">{days.filter(day => day.endsWith("-01") || day === from).map(day => <span key={day} style={{ left: `${Math.floor((days.indexOf(day) + offset) / 7) * 16}px` }}>{date(dayDate(day), { month: "short" })}</span>)}</div>
        <div className="overview-calendar-grid" role="group" aria-label={t("overview.activity.title")}>{Array.from({ length: offset }, (_, index) => <span key={`offset-${index}`} />)}{days.map(day => {
          const fact = facts.get(day); const value = fact ? dayValue(fact, metric) : 0;
          const level = value == null ? "unknown" : value === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(value / max * 4)));
          const label = t("overview.activity.day", { date: date(dayDate(day)), count: amount(value), metric: t(`overview.metric.${metric}`) });
          return <Tooltip.Root key={day}><Tooltip.Trigger asChild><button ref={element => { if (element) buttons.current.set(day, element); else buttons.current.delete(day); }} className={`overview-calendar-day level-${level}`} tabIndex={day === focusDay || !days.includes(focusDay) && day === days.at(-1) ? 0 : -1} aria-label={label}
            onFocus={() => setFocusDay(day)} onClick={event => { anchor.current = event.currentTarget; setSelected(day); }}
            onKeyDown={event => { const step = { ArrowRight: 7, ArrowLeft: -7, ArrowDown: 1, ArrowUp: -1 }[event.key]; if (step !== undefined) { event.preventDefault(); move(day, step); } }} /></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={5}>{label}</Tooltip.Content></Tooltip.Portal></Tooltip.Root>;
        })}</div>
      </div></div></div>
    <div className="overview-calendar-scale" aria-label={t("overview.activity.legend")}><span>{t("overview.activity.less")}</span>{[0, 1, 2, 3, 4].map(level => <i key={level} className={`level-${level}`} />)}<span>{t("overview.activity.more")}</span></div>
    <Popover.Root open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }}><Popover.Anchor virtualRef={{ current: { getBoundingClientRect: () => anchor.current?.getBoundingClientRect() ?? new DOMRect() } }} /><Popover.Portal><Popover.Content className="filter-menu overview-day-popover" sideOffset={7} collisionPadding={12} aria-label={t("overview.activity.dayDetails")} onCloseAutoFocus={event => { event.preventDefault(); anchor.current?.focus({ preventScroll: true }); }}>
      <strong>{selected && date(dayDate(selected))}</strong><dl>{["sessions", "requests", "tokens", "tools"].map(key => <div key={key}><dt>{t(`overview.metric.${key}`)}</dt><dd>{key === "tokens" ? formatTokenMillions(language, current?.tokens) : number(key === "tools" ? current?.toolCalls ?? 0 : key === "sessions" ? current?.sessions ?? 0 : current?.requests ?? 0)}</dd></div>)}</dl>
      <div><button className="text-button" onClick={() => { if (selected) onDay(selected); setSelected(null); }}>{t("overview.activity.viewDay")}</button><button className="text-button" onClick={() => { if (selected) onRange(selected); setSelected(null); }}>{t("overview.activity.setRange")}</button></div>
    </Popover.Content></Popover.Portal></Popover.Root>
  </div>;
}

export function ActivityDistributions({ report }: { report: Pick<OverviewReport, "activity"> }) {
  const { t, number, date } = useI18n();
  const weekdayMax = Math.max(1, ...report.activity.weekdays.map(row => row.events));
  const hourMax = Math.max(1, ...report.activity.hours.map(row => row.events));
  return <div className="overview-activity-distributions"><div><h3>{t("overview.activity.weekdays")}</h3><div className="overview-weekdays">{report.activity.weekdays.map(row => <Tooltip.Root key={row.weekday}><Tooltip.Trigger asChild><div tabIndex={0}><span className="overview-mini-bar" style={{ height: `${row.events / weekdayMax * 38}px` }} /><span>{date(new Date(2024, 0, 7 + row.weekday), { weekday: "short" })}</span></div></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip">{number(row.events)} {t("overview.metric.events")}</Tooltip.Content></Tooltip.Portal></Tooltip.Root>)}</div></div><div><h3>{t("overview.activity.hours")}</h3><div className="overview-hours">{report.activity.hours.map(row => <Tooltip.Root key={row.hour}><Tooltip.Trigger asChild><div tabIndex={0} aria-label={`${number(row.hour)}:00 · ${number(row.events)} ${t("overview.metric.events")}`}><span className="overview-mini-bar" style={{ height: `${row.events / hourMax * 38}px` }} /></div></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip">{number(row.hour)}:00 · {number(row.events)} {t("overview.metric.events")}</Tooltip.Content></Tooltip.Portal></Tooltip.Root>)}</div><div className="overview-hour-labels"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div></div></div>;
}
