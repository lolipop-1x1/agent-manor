import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CalendarBlank } from "@phosphor-icons/react";
import { DayPicker } from "react-day-picker";
import { zhCN } from "react-day-picker/locale";
import "react-day-picker/style.css";
import "./filter-controls.css";

function dateValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function DatePicker({ label, value, onChange }: {
  label: string; value: string; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = value ? new Date(`${value}T00:00:00`) : undefined;
  const select = (date: Date | undefined) => { onChange(date ? dateValue(date) : ""); setOpen(false); };
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="filter-trigger date-picker-trigger" aria-label={label}>
      <span className={value ? undefined : "date-picker-placeholder"}>{value ? value.replaceAll("-", " / ") : "选择日期"}</span><CalendarBlank size={15} aria-hidden="true" />
    </Popover.Trigger>
    <Popover.Portal><Popover.Content className="filter-menu date-picker-menu" align="start" sideOffset={6} collisionPadding={12} aria-label={`${label}日历`}>
      <DayPicker mode="single" selected={selected} defaultMonth={selected} onSelect={select} locale={zhCN} autoFocus showOutsideDays fixedWeeks
        labels={{ labelPrevious: () => "上一月", labelNext: () => "下一月", labelNav: () => "日历月份导航",
          labelGrid: date => `${date.getFullYear()}年${date.getMonth() + 1}月`, labelDayButton: date => dateValue(date) }} />
      <div className="date-picker-actions"><button type="button" onClick={() => select(new Date())}>今天</button><button type="button" disabled={!value} onClick={() => select(undefined)}>清空</button></div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
