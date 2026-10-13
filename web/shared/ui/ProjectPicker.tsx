import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { CaretDown, Check, MagnifyingGlass } from "@phosphor-icons/react";
import type { FilterOption } from "./FilterSelect";
import "./filter-controls.css";
import { formatList, useI18n } from "../i18n";

type ProjectPickerProps = {
  options: FilterOption[];
  label?: string; placeholder?: string; container?: HTMLElement | null; modal?: boolean;
} & ({ multiple?: false; value: string; onChange: (value: string) => void }
  | { multiple: true; value: string[]; onChange: (value: string[]) => void });

export function ProjectPicker(props: ProjectPickerProps) {
  const { options, label, placeholder, container, modal = false } = props;
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const selected = options.find(option => option.value === props.value);
  const selectedOptions = props.multiple ? options.filter(option => props.value.includes(option.value)) : [];
  const displayLabel = label ?? t("common.project.filter");
  const menuLabel = label ? t("common.picker.menu", { label }) : t("common.project.menu");
  const searchLabel = label ? t("common.picker.search", { label }) : t("common.project.search");
  const optionsLabel = label ? t("common.picker.options", { label }) : t("common.project.options");
  return <Popover.Root open={open} onOpenChange={next => { if (next && props.multiple) setDraft([...props.value]); setOpen(next); }} modal={modal}>
    <Popover.Trigger className="filter-trigger" aria-label={displayLabel} title={props.multiple ? formatList(selectedOptions.map(option => option.label)) : selected?.description ?? selected?.label}>
      <span>{props.multiple ? t("common.picker.selected", { label: displayLabel, count: props.value.length }) : selected?.label ?? (label ?? t("common.project.all"))}</span><CaretDown size={14} aria-hidden="true" />
    </Popover.Trigger>
    <Popover.Portal container={container}><Popover.Content className="filter-menu project-picker-menu" align="start" sideOffset={6} collisionPadding={12} aria-label={menuLabel} onEscapeKeyDown={event => event.stopPropagation()}>
      <Command label={searchLabel} defaultValue={props.multiple ? undefined : props.value} loop>
        <div className="project-picker-search"><MagnifyingGlass size={15} aria-hidden="true" />
          <Command.Input aria-label={searchLabel} placeholder={placeholder ?? t("common.project.searchPlaceholder")} />
        </div>
        <Command.List className="project-picker-options" label={optionsLabel} aria-multiselectable={props.multiple || undefined} style={props.multiple ? { maxHeight: "min(280px, calc(var(--radix-popover-content-available-height) - 96px))" } : undefined}>
          <Command.Empty className="project-picker-empty">{t(label ? "common.picker.empty" : "common.project.empty")}</Command.Empty>
          {options.map(option => <Command.Item key={option.value} value={option.value} keywords={[option.label, option.description ?? ""]}
            className="filter-option project-picker-option" data-checked={props.multiple ? draft.includes(option.value) : option.value === props.value} aria-checked={props.multiple ? draft.includes(option.value) : undefined}
            onSelect={() => { if (props.multiple) setDraft(current => current.includes(option.value) ? current.filter(value => value !== option.value) : [...current, option.value]); else { props.onChange(option.value); setOpen(false); } }}>
            <span className="project-picker-copy"><span>{option.label}</span>{option.description && <small>{option.description}</small>}</span>
            {(props.multiple ? draft.includes(option.value) : option.value === props.value) && <Check size={14} className="filter-check" aria-hidden="true" />}
          </Command.Item>)}
        </Command.List>
      </Command>
      {props.multiple && <div className="date-picker-actions" style={{ margin: "0 8px", padding: "8px 0" }}>
        <button type="button" disabled={draft.length === options.length} onClick={() => setDraft(options.map(option => option.value))}>{t("common.picker.all")}</button>
        <button type="button" disabled={!draft.length} onClick={() => setDraft([])}>{t("common.picker.clear")}</button>
        <button type="button" onClick={() => { props.onChange(draft); setOpen(false); }}>{t("common.picker.apply")}</button>
      </div>}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
