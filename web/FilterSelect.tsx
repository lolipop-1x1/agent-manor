import * as Select from "@radix-ui/react-select";
import { CaretDown, CaretUp, Check } from "@phosphor-icons/react";
import "./filter-controls.css";

export interface FilterOption { value: string; label: string; description?: string }

export function FilterSelect({ label, value, options, onChange, container }: {
  label: string; value: string; options: FilterOption[]; onChange: (value: string) => void; container?: HTMLElement | null;
}) {
  return <Select.Root value={value} onValueChange={onChange}>
    <Select.Trigger className="filter-trigger" aria-label={label}>
      <Select.Value /><Select.Icon><CaretDown size={14} aria-hidden="true" /></Select.Icon>
    </Select.Trigger>
    <Select.Portal container={container}><Select.Content className="filter-menu" position="popper" align="start" sideOffset={6} collisionPadding={12} onEscapeKeyDown={event => event.stopPropagation()}>
      <Select.ScrollUpButton className="filter-scroll"><CaretUp size={14} aria-hidden="true" /></Select.ScrollUpButton>
      <Select.Viewport className="filter-options">
        {options.map(option => <Select.Item key={option.value} value={option.value} className="filter-option" textValue={option.label}>
          <Select.ItemText>{option.label}</Select.ItemText>
          <Select.ItemIndicator className="filter-check"><Check size={14} aria-hidden="true" /></Select.ItemIndicator>
        </Select.Item>)}
      </Select.Viewport>
      <Select.ScrollDownButton className="filter-scroll"><CaretDown size={14} aria-hidden="true" /></Select.ScrollDownButton>
    </Select.Content></Select.Portal>
  </Select.Root>;
}
