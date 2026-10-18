import { useId, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { FilterSelect } from "../../shared/ui/FilterSelect";
import { useI18n } from "../../shared/i18n";
import { validReplaySpeed } from "./replay-model";

const speeds = [.25, .5, 1, 2, 4, 8, 16, 32, 64, 128];

export function ReplaySpeed({ value, onChange, container, disabled }: {
  value: number; onChange(value: number): void; container?: HTMLElement | null; disabled: boolean;
}) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const inputId = useId(), errorId = useId();
  const number = new Intl.NumberFormat(language);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Anchor className="replay-speed" ref={anchor}>
      <FilterSelect label={t("replay.speed")} value={String(value)} container={container} disabled={disabled}
        options={[...new Set([...speeds, value])].sort((a, b) => a - b).map(speed => ({ value: String(speed), label: `${number.format(speed)}×` })).concat({ value: "custom", label: t("replay.customSpeed") })}
        onChange={next => { if (next === "custom") { setDraft(String(value)); setInvalid(false); setTimeout(() => setOpen(true), 0); } else onChange(Number(next)); }} />
    </Popover.Anchor>
    <Popover.Portal container={container}><Popover.Content className="filter-menu replay-speed-menu" side="top" align="start" sideOffset={6} collisionPadding={12}
      aria-label={t("replay.customSpeed")} onEscapeKeyDown={event => event.stopPropagation()} onCloseAutoFocus={event => { event.preventDefault(); anchor.current?.querySelector<HTMLButtonElement>("button")?.focus(); }}>
      <form noValidate onSubmit={event => { event.preventDefault(); const next = Number(draft); if (!validReplaySpeed(next) || !draft.trim()) { setInvalid(true); return; } onChange(next); setOpen(false); }}>
        <label htmlFor={inputId}>{t("replay.customSpeed")}</label>
        <div><input id={inputId} type="number" inputMode="decimal" min="0.25" max="256" step="any" value={draft} aria-label={t("replay.speedValue")} aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined} onChange={event => { setDraft(event.target.value); setInvalid(false); }} />
          <button className="button" type="submit">{t("replay.applySpeed")}</button></div>
        {invalid && <p id={errorId} role="alert">{t("replay.speedRange")}</p>}
      </form>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
