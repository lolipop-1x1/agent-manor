import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { CaretDown, Check, MagnifyingGlass } from "@phosphor-icons/react";
import type { FilterOption } from "./FilterSelect";
import { useI18n } from "../i18n";
import "./filter-controls.css";

/** 多选筛选沿用现有搜索浮层，包含与排除始终互斥。 */
export function MultiFilterPicker({ label, options, included, excluded, onChange }: {
  label: string; options: FilterOption[]; included: string[]; excluded: string[];
  onChange: (included: string[], excluded: string[]) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"include" | "exclude">("include");
  const selected = mode === "include" ? included : excluded;
  const toggle = (value: string) => {
    const values = selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value];
    onChange(mode === "include" ? values : included.filter(item => item !== value), mode === "exclude" ? values : excluded.filter(item => item !== value));
  };
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="filter-trigger" aria-label={label}>
      <span>{included.length + excluded.length ? t("usage.filter.selected", { label, included: included.length, excluded: excluded.length }) : label}</span><CaretDown size={14} aria-hidden="true" />
    </Popover.Trigger>
    <Popover.Portal><Popover.Content className="filter-menu project-picker-menu multi-filter-menu" align="start" sideOffset={6} collisionPadding={12} aria-label={t("common.picker.menu", { label })} onEscapeKeyDown={event => event.stopPropagation()}>
      <div className="multi-filter-toolbar"><div role="group" aria-label={t("usage.filter.mode")}>
        <button type="button" aria-pressed={mode === "include"} onClick={() => setMode("include")}>{t("usage.filter.include")}</button>
        <button type="button" aria-pressed={mode === "exclude"} onClick={() => setMode("exclude")}>{t("usage.filter.exclude")}</button>
      </div><button type="button" onClick={() => onChange([], [])} disabled={!included.length && !excluded.length}>{t("common.date.clear")}</button></div>
      <Command label={t("common.picker.search", { label })} loop>
        <div className="project-picker-search"><MagnifyingGlass size={15} aria-hidden="true" /><Command.Input aria-label={t("common.picker.search", { label })} placeholder={t("usage.filter.search")} /></div>
        <Command.List className="project-picker-options" label={t("common.picker.options", { label })}>
          <Command.Empty className="project-picker-empty">{t("common.picker.empty")}</Command.Empty>
          {options.map(option => <Command.Item key={option.value} value={option.value} keywords={[option.label, option.description ?? ""]} className="filter-option project-picker-option" data-checked={selected.includes(option.value)} onSelect={() => toggle(option.value)}>
            <span className="project-picker-copy"><span>{option.label}</span>{option.description && <small>{option.description}</small>}</span>
            {selected.includes(option.value) && <Check size={14} className="filter-check" aria-hidden="true" />}
          </Command.Item>)}
        </Command.List>
      </Command>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
