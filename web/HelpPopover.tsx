import type { ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Question, X } from "@phosphor-icons/react";
import "./filter-controls.css";
import { useI18n } from "./i18n";

export function HelpPopover({ label, children, container, iconOnly = false }: { label: string; children: ReactNode; container?: HTMLElement | null; iconOnly?: boolean }) {
  const { t } = useI18n();
  return <Popover.Root>
    <Popover.Trigger className={`help-trigger${iconOnly ? " is-icon-only" : ""}`} type="button" aria-label={label}><Question size={iconOnly ? 17 : 14} aria-hidden="true" />{!iconOnly && label}</Popover.Trigger>
    <Popover.Portal container={container}><Popover.Content className="filter-menu help-popover" align="end" sideOffset={6} collisionPadding={12} aria-label={label}
      onEscapeKeyDown={event => event.stopPropagation()}>
      <header><strong>{label}</strong><Popover.Close className="icon-button" aria-label={t("common.closeNamed", { label })}><X size={15} aria-hidden="true" /></Popover.Close></header>
      <div className="help-popover-body">{children}</div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
