import { useEffect, useState, type FormEvent } from "react";
import { CaretDoubleLeft, CaretDoubleRight, CaretLeft, CaretRight } from "@phosphor-icons/react";
import { FilterSelect } from "./FilterSelect";
import { fmt } from "../format";
import { useI18n } from "../i18n";
import "./resource-pagination.css";

export function ResourcePagination({ page, total, pageSize, onChange, onPageSizeChange, label, container, compact = false }: {
  page: number; total: number; pageSize: number; onChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void; label: string; container?: HTMLElement | null; compact?: boolean;
}) {
  const { t } = useI18n();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const [target, setTarget] = useState(String(current));
  useEffect(() => setTarget(String(current)), [current]);
  const visible = [...new Set([1, current - 1, current, current + 1, pages])].filter(value => value >= 1 && value <= pages).sort((a, b) => a - b);
  const jump = (event: FormEvent) => {
    event.preventDefault();
    const value = Number(target);
    if (Number.isSafeInteger(value) && value >= 1 && value <= pages) onChange(value);
  };
  if (compact) return <nav className="resource-pager resource-pager-compact" aria-label={label}>
    <button className="icon-button" disabled={current <= 1} aria-label={t("common.pagination.previous", { label })} onClick={() => onChange(current - 1)}><CaretLeft size={15} /></button>
    <form className="resource-page-jump" onSubmit={jump}>
      <input type="number" required min="1" max={pages} step="1" value={target} onChange={event => setTarget(event.target.value)} aria-label={t("common.pagination.jumpInput", { label })} />
      <span className="resource-page-current" aria-label={t("common.pagination.current", { page: fmt(current), pages: fmt(pages) })}>/ {fmt(pages)}</span>
      <button className="text-button" aria-label={t("common.pagination.jumpLabel", { label })}>{t("common.pagination.jump")}</button>
    </form>
    <button className="icon-button" disabled={current >= pages} aria-label={t("common.pagination.next", { label })} onClick={() => onChange(current + 1)}><CaretRight size={15} /></button>
  </nav>;
  return <nav className="resource-pager" aria-label={label}>
    <span className="resource-page-range">{t("common.pagination.range", { start: fmt(total ? (current - 1) * pageSize + 1 : 0), end: fmt(Math.min(current * pageSize, total)), count: total })}</span>
    <div className="resource-page-controls">
      <button className="icon-button" disabled={current <= 1} aria-label={t("common.pagination.first", { label })} onClick={() => onChange(1)}><CaretDoubleLeft size={15} /></button>
      <button className="icon-button" disabled={current <= 1} aria-label={t("common.pagination.previous", { label })} onClick={() => onChange(current - 1)}><CaretLeft size={15} /></button>
      {visible.map((value, index) => <span className="resource-page-number" key={value}>
        {index > 0 && value - visible[index - 1]! > 1 && <span aria-hidden="true">…</span>}
        <button className="icon-button" aria-label={t("common.pagination.page", { label, page: fmt(value) })} aria-current={value === current ? "page" : undefined} onClick={() => onChange(value)}>{fmt(value)}</button>
      </span>)}
      <button className="icon-button" disabled={current >= pages} aria-label={t("common.pagination.next", { label })} onClick={() => onChange(current + 1)}><CaretRight size={15} /></button>
      <button className="icon-button" disabled={current >= pages} aria-label={t("common.pagination.last", { label })} onClick={() => onChange(pages)}><CaretDoubleRight size={15} /></button>
    </div>
    <span className="resource-page-current">{t("common.pagination.current", { page: fmt(current), pages: fmt(pages) })}</span>
    <form className="resource-page-jump" onSubmit={jump}>
      <input type="number" min="1" max={pages} value={target} onChange={event => setTarget(event.target.value)} aria-label={t("common.pagination.jumpInput", { label })} />
      <button className="text-button" aria-label={t("common.pagination.jumpLabel", { label })}>{t("common.pagination.jump")}</button>
    </form>
    {onPageSizeChange && <FilterSelect container={container} label={t("common.pagination.pageSize", { label })} value={String(pageSize)} options={[20, 50, 100].map(value => ({ value: String(value), label: t("common.pagination.perPage", { count: value }) }))} onChange={value => onPageSizeChange(Number(value))} />}
  </nav>;
}
