import { useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CaretDown, CaretLeft, CaretRight } from "@phosphor-icons/react";
import { useI18n } from "../../shared/i18n";
import { SessionJump } from "./SessionJump";

export function SessionTurnNavigation({ sessionId, version, branch, mode, current, total, onJump }: {
  sessionId: string; version: string; branch?: string; mode: "brief" | "full" | "trace";
  current: number; total: number; onJump: (position: number) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(String(current || 1));
  const input = useRef<HTMLInputElement>(null);
  const jump = (position: number) => { onJump(position); setOpen(false); };
  const label = current === 0 ? t("sessions.turn.initial") : t("sessions.turn.position", { position: current, total });
  return <nav className="session-turn-navigation" aria-label={t("sessions.turn.navigation")}>
    <button className="icon-button" aria-label={t("sessions.turn.previous")} disabled={current <= 1} onClick={() => onJump(current - 1)}><CaretLeft size={14} /></button>
    <Popover.Root open={open} onOpenChange={value => { if (value) setDraft(String(current || 1)); setOpen(value); }}>
      <Popover.Trigger className="session-turn-position" data-turn={current} disabled={!total} aria-label={label}>{label}<CaretDown size={12} aria-hidden="true" /></Popover.Trigger>
      <Popover.Portal><Popover.Content className="filter-menu session-turn-menu" align="end" sideOffset={6} collisionPadding={12} aria-label={t("sessions.turn.navigation")}
        onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); input.current?.select(); }}>
        <form onSubmit={event => { event.preventDefault(); if (draft) jump(Number(draft)); }}>
          <label htmlFor="session-turn-jump">{t("sessions.turn.jumpInput")}</label>
          <div><input ref={input} id="session-turn-jump" type="number" required min="1" max={total || 1} step="1" value={draft} onChange={event => setDraft(event.target.value)} /><button className="button" type="submit">{t("sessions.turn.jump")}</button></div>
        </form>
        <div className="session-turn-ends"><button className="button subtle" disabled={current === 1} onClick={() => jump(1)}>{t("sessions.turn.first")}</button><button className="button subtle" disabled={current >= total} onClick={() => jump(total)}>{t("sessions.turn.last")}</button></div>
      </Popover.Content></Popover.Portal>
    </Popover.Root>
    <button className="icon-button" aria-label={t("sessions.turn.next")} disabled={current >= total} onClick={() => onJump(current + 1)}><CaretRight size={14} /></button>
    <SessionJump sessionId={sessionId} version={version} branch={branch} mode={mode} onJump={onJump} />
  </nav>;
}
