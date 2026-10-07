import { useEffect, useState, type FormEvent } from "react";
import { CaretDoubleLeft, CaretDoubleRight, CaretLeft, CaretRight } from "@phosphor-icons/react";
import { FilterSelect } from "./FilterSelect";
import { fmt } from "./model";

export function ResourcePagination({ page, total, pageSize, onChange, onPageSizeChange, label }: {
  page: number; total: number; pageSize: number; onChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void; label: string;
}) {
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
  return <nav className="resource-pager" aria-label={label}>
    <span className="resource-page-range">{fmt(total ? (current - 1) * pageSize + 1 : 0)}–{fmt(Math.min(current * pageSize, total))} / {fmt(total)} 条</span>
    <div className="resource-page-controls">
      <button className="icon-button" disabled={current <= 1} aria-label={`${label}首页`} onClick={() => onChange(1)}><CaretDoubleLeft size={15} /></button>
      <button className="icon-button" disabled={current <= 1} aria-label={`${label}上一页`} onClick={() => onChange(current - 1)}><CaretLeft size={15} /></button>
      {visible.map((value, index) => <span className="resource-page-number" key={value}>
        {index > 0 && value - visible[index - 1]! > 1 && <span aria-hidden="true">…</span>}
        <button className="icon-button" aria-label={`${label}第${value}页`} aria-current={value === current ? "page" : undefined} onClick={() => onChange(value)}>{fmt(value)}</button>
      </span>)}
      <button className="icon-button" disabled={current >= pages} aria-label={`${label}下一页`} onClick={() => onChange(current + 1)}><CaretRight size={15} /></button>
      <button className="icon-button" disabled={current >= pages} aria-label={`${label}末页`} onClick={() => onChange(pages)}><CaretDoubleRight size={15} /></button>
    </div>
    <span className="resource-page-current">第 {fmt(current)} / {fmt(pages)} 页</span>
    <form className="resource-page-jump" onSubmit={jump}>
      <input type="number" min="1" max={pages} value={target} onChange={event => setTarget(event.target.value)} aria-label={`${label}跳转页码`} />
      <button className="text-button" aria-label={`${label}跳转`}>跳转</button>
    </form>
    {onPageSizeChange && <FilterSelect label={`${label}每页条数`} value={String(pageSize)} options={[20, 50, 100].map(value => ({ value: String(value), label: `${value} 条／页` }))} onChange={value => onPageSizeChange(Number(value))} />}
  </nav>;
}
