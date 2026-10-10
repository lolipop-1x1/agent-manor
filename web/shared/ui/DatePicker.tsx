import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CalendarBlank } from "@phosphor-icons/react";
import { DayPicker } from "react-day-picker";
import { enUS, zhCN } from "react-day-picker/locale";
import "react-day-picker/style.css";
import "./filter-controls.css";
import { languageRegistry } from "../../../src/i18n";
import { useI18n } from "../i18n";

function dateValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function DatePicker({ label, value, onChange }: {
  label: string; value: string; onChange: (value: string) => void;
}) {
  const { t, language, date } = useI18n();
  const [open, setOpen] = useState(false);
  const selected = value ? new Date(`${value}T00:00:00`) : undefined;
  const select = (date: Date | undefined) => { onChange(date ? dateValue(date) : ""); setOpen(false); };
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="filter-trigger date-picker-trigger" aria-label={label}>
      <span className={value ? undefined : "date-picker-placeholder"}>{value ? date(selected!, { year: "numeric", month: "short", day: "numeric" }) : t("common.date.choose")}</span><CalendarBlank size={15} aria-hidden="true" />
    </Popover.Trigger>
    <Popover.Portal><Popover.Content className="filter-menu date-picker-menu" align="start" sideOffset={6} collisionPadding={12} aria-label={t("common.date.calendar", { label })}>
      <DayPicker mode="single" selected={selected} defaultMonth={selected} onSelect={select} locale={language === "zh-CN" ? zhCN : enUS} weekStartsOn={languageRegistry[language].weekStartsOn} autoFocus showOutsideDays fixedWeeks
        labels={{ labelPrevious: () => t("common.date.previousMonth"), labelNext: () => t("common.date.nextMonth"), labelNav: () => t("common.date.navigation"),
          labelGrid: value => date(value, { year: "numeric", month: "long" }) }} />
      <div className="date-picker-actions"><button type="button" onClick={() => select(new Date())}>{t("common.date.today")}</button><button type="button" disabled={!value} onClick={() => select(undefined)}>{t("common.date.clear")}</button></div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
