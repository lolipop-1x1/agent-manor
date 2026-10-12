import { useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as Select from "@radix-ui/react-select";
import { CaretDown, CaretUp, Check, Info } from "@phosphor-icons/react";
import { useI18n } from "../i18n";
import { HelpPopover } from "./HelpPopover";
import "./filter-controls.css";

export interface FilterOption { value: string; label: string; description?: string; group?: string }

export function FilterSelect({ label, value, options, onChange, container, disabled }: {
  label: string; value: string; options: FilterOption[]; onChange: (value: string) => void; container?: HTMLElement | null; disabled?: boolean;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<HTMLDivElement | null>(null);
  const item = (option: FilterOption) => <Select.Item value={option.value} className="filter-option" textValue={option.label} aria-description={option.description}>
    <Select.ItemText>{option.label}</Select.ItemText>
    <Select.ItemIndicator className="filter-check"><Check size={14} aria-hidden="true" /></Select.ItemIndicator>
  </Select.Item>;
  return <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
    <Select.Trigger className="filter-trigger" aria-label={label}>
      <Select.Value /><Select.Icon><CaretDown size={14} aria-hidden="true" /></Select.Icon>
    </Select.Trigger>
    <Select.Portal container={container}><Select.Content ref={setMenu} className="filter-menu" position="popper" align="start" sideOffset={6} collisionPadding={12} onEscapeKeyDown={event => event.stopPropagation()}>
      <Select.ScrollUpButton className="filter-scroll"><CaretUp size={14} aria-hidden="true" /></Select.ScrollUpButton>
      <Select.Viewport className="filter-options">
        {Array.from(new Set(options.map(option => option.group))).map(group => <Select.Group key={group ?? "ungrouped"}>{group && <Select.Label className="filter-group-label">{group}</Select.Label>}{options.filter(option => option.group === group).map(option => option.description ? <div key={option.value} className="filter-option-with-help">
          <Tooltip.Root><Tooltip.Trigger asChild><div className="filter-option-tooltip-target">{item(option)}</div></Tooltip.Trigger><Tooltip.Portal container={menu}><Tooltip.Content className="tooltip filter-option-tooltip" style={{ pointerEvents: "none" }} side="left" sideOffset={6}>{option.description}<Tooltip.Arrow /></Tooltip.Content></Tooltip.Portal></Tooltip.Root>
          <HelpPopover label={option.label} container={menu} trigger={<button type="button" className="help-trigger is-icon-only" tabIndex={-1} aria-label={t("common.optionHelp", { filter: label, option: option.label })}><Info size={16} aria-hidden="true" /></button>}><p>{option.description}</p></HelpPopover>
        </div> : <Select.Item key={option.value} value={option.value} className="filter-option" textValue={option.label}>
          <Select.ItemText>{option.label}</Select.ItemText><Select.ItemIndicator className="filter-check"><Check size={14} aria-hidden="true" /></Select.ItemIndicator>
        </Select.Item>)}</Select.Group>)}
      </Select.Viewport>
      <Select.ScrollDownButton className="filter-scroll"><CaretDown size={14} aria-hidden="true" /></Select.ScrollDownButton>
    </Select.Content></Select.Portal>
  </Select.Root>;
}
