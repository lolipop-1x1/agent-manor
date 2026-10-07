import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { CaretDown, Check, MagnifyingGlass } from "@phosphor-icons/react";
import type { FilterOption } from "./FilterSelect";
import "./filter-controls.css";

export function ProjectPicker({ value, options, onChange, label = "筛选项目", placeholder = "搜索项目名或路径…", container }: {
  value: string; options: FilterOption[]; onChange: (value: string) => void;
  label?: string; placeholder?: string; container?: HTMLElement | null;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);
  const menuLabel = label === "筛选项目" ? "项目选择" : `${label}选择`;
  const searchLabel = label === "筛选项目" ? "搜索项目" : `${label}搜索`;
  const optionsLabel = label === "筛选项目" ? "项目选项" : `${label}选项`;
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="filter-trigger" aria-label={label} title={selected?.description ?? selected?.label}>
      <span>{selected?.label ?? (label === "筛选项目" ? "全部项目" : label)}</span><CaretDown size={14} aria-hidden="true" />
    </Popover.Trigger>
    <Popover.Portal container={container}><Popover.Content className="filter-menu project-picker-menu" align="start" sideOffset={6} collisionPadding={12} aria-label={menuLabel} onEscapeKeyDown={event => event.stopPropagation()}>
      <Command label={searchLabel} defaultValue={value} loop>
        <div className="project-picker-search"><MagnifyingGlass size={15} aria-hidden="true" />
          <Command.Input aria-label={searchLabel} placeholder={placeholder} />
        </div>
        <Command.List className="project-picker-options" label={optionsLabel}>
          <Command.Empty className="project-picker-empty">{label === "筛选项目" ? "没有匹配的项目" : "没有匹配结果"}</Command.Empty>
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
