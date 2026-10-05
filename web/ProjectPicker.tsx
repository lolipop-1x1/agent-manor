import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { CaretDown, Check, MagnifyingGlass } from "@phosphor-icons/react";
import type { FilterOption } from "./FilterSelect";
import "./filter-controls.css";

export function ProjectPicker({ value, options, onChange }: {
  value: string; options: FilterOption[]; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="filter-trigger" aria-label="筛选项目" title={selected?.description ?? selected?.label}>
      <span>{selected?.label ?? "全部项目"}</span><CaretDown size={14} aria-hidden="true" />
    </Popover.Trigger>
    <Popover.Portal><Popover.Content className="filter-menu project-picker-menu" align="start" sideOffset={6} collisionPadding={12} aria-label="项目选择">
      <Command label="搜索项目" defaultValue={value} loop>
        <div className="project-picker-search"><MagnifyingGlass size={15} aria-hidden="true" />
          <Command.Input placeholder="搜索项目名或路径…" />
        </div>
        <Command.List className="project-picker-options" label="项目选项">
          <Command.Empty className="project-picker-empty">没有匹配的项目</Command.Empty>
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
