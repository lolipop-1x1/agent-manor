import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { CaretDown, Check, MagnifyingGlass } from "@phosphor-icons/react";
import type { FilterOption } from "./FilterSelect";
import "./filter-controls.css";
import { useI18n } from "./i18n";

export function ProjectPicker({ value, options, onChange, label, placeholder, container }: {
  value: string; options: FilterOption[]; onChange: (value: string) => void;
  label?: string; placeholder?: string; container?: HTMLElement | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);
  const displayLabel = label ?? t("common.project.filter");
  const menuLabel = label ? t("common.picker.menu", { label }) : t("common.project.menu");
  const searchLabel = label ? t("common.picker.search", { label }) : t("common.project.search");
  const optionsLabel = label ? t("common.picker.options", { label }) : t("common.project.options");
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="filter-trigger" aria-label={displayLabel} title={selected?.description ?? selected?.label}>
      <span>{selected?.label ?? (label ?? t("common.project.all"))}</span><CaretDown size={14} aria-hidden="true" />
    </Popover.Trigger>
    <Popover.Portal container={container}><Popover.Content className="filter-menu project-picker-menu" align="start" sideOffset={6} collisionPadding={12} aria-label={menuLabel} onEscapeKeyDown={event => event.stopPropagation()}>
      <Command label={searchLabel} defaultValue={value} loop>
        <div className="project-picker-search"><MagnifyingGlass size={15} aria-hidden="true" />
          <Command.Input aria-label={searchLabel} placeholder={placeholder ?? t("common.project.searchPlaceholder")} />
        </div>
        <Command.List className="project-picker-options" label={optionsLabel}>
          <Command.Empty className="project-picker-empty">{t(label ? "common.picker.empty" : "common.project.empty")}</Command.Empty>
          {options.map(option => <Command.Item key={option.value} value={option.value} keywords={[option.label, option.description ?? ""]}
            className="filter-option project-picker-option" data-checked={option.value === value} onSelect={() => { onChange(option.value); setOpen(false); }}>
            <span className="project-picker-copy"><span>{option.label}</span>{option.description && <small>{option.description}</small>}</span>
            {option.value === value && <Check size={14} className="filter-check" aria-hidden="true" />}
          </Command.Item>)}
        </Command.List>
      </Command>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
