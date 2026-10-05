import type { ReactNode } from "react";
import { CaretLeft, CaretRight, WarningCircle } from "@phosphor-icons/react";

export function Notice({ children, danger = false, action }: { children: ReactNode; danger?: boolean; action?: ReactNode }) {
  return <div className={`session-notice${danger ? " is-danger" : ""}`} role={danger ? "alert" : "status"}>
    <WarningCircle size={16} aria-hidden="true" /><div>{children}</div>{action}
  </div>;
}

export function Pager({ page, pageSize, total, onChange, label }: { page: number; pageSize: number; total: number; onChange: (page: number) => void; label: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <nav className="session-pager" aria-label={label}>
    <button className="icon-button" aria-label="上一页" disabled={page <= 1} onClick={() => onChange(page - 1)}><CaretLeft size={15} /></button>
    <span>{page.toLocaleString("zh-CN")} / {pages.toLocaleString("zh-CN")} · {total.toLocaleString("zh-CN")}</span>
    <button className="icon-button" aria-label="下一页" disabled={page >= pages} onClick={() => onChange(page + 1)}><CaretRight size={15} /></button>
  </nav>;
}
