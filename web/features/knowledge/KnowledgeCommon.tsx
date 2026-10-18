import { useId, useRef, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowClockwise, X } from "@phosphor-icons/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { errorMessage } from "../../shared/api";
import { isMessageDescriptorKnown, messageText, useI18n } from "../../shared/i18n";
import { SelectionIndicator } from "../../shared/ui/SelectionIndicator";
import type { KnowledgeLimitation } from "../../../src/knowledge-contracts";
import type { MessageDescriptor } from "../../../src/i18n/types";
import { restoreKnowledgeFocus } from "./knowledge-model";

export function KnowledgeDiagnostic({ original, descriptor }: { original: string; descriptor?: MessageDescriptor }) {
  const { t } = useI18n(), recognized = isMessageDescriptorKnown(descriptor);
  return <div className="knowledge-diagnostic">{recognized && <span>{messageText(descriptor, original)}</span>}<details className="knowledge-details"><summary>{t("common.originalDetails")}</summary><p>{original}</p></details></div>;
}
export function KnowledgeLimitations({ originals = [], details = [] }: { originals?: string[]; details?: KnowledgeLimitation[] }) {
  const seen = new Set(details.map(detail => detail.message)), items: KnowledgeLimitation[] = [...details, ...originals.filter(message => !seen.has(message)).map(message => ({ message }))];
  return <>{items.map((item, index) => <KnowledgeDiagnostic key={index} descriptor={item.messageDescriptor} original={item.message} />)}</>;
}

export function KnowledgeError({ error, retry }: { error: unknown; retry?: () => void }) {
  const { t } = useI18n();
  return error ? <div className="knowledge-error" role="alert"><span>{errorMessage(error)}</span>{retry && <button className="text-button" onClick={retry}>{t("knowledge.retry")}</button>}</div> : null;
}
export function KnowledgeBusy({ busy }: { busy: boolean }) {
  const { t } = useI18n();
  return <span className="knowledge-busy" role={busy ? "status" : undefined} aria-label={busy ? t("knowledge.loading") : undefined}>{busy && <ArrowClockwise size={15} className="is-spinning" aria-hidden="true" />}</span>;
}
export function KnowledgeTabs({ value, options, onChange, label, panelId }: { panelId?: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; label: string }) {
  return <div className="knowledge-tabs" role="tablist" aria-label={label}><SelectionIndicator value={value} selector='[aria-selected="true"]' line />{options.map((option, index) => <button key={option.value} role="tab" id={panelId ? `${panelId}-${option.value}-tab` : undefined} aria-controls={panelId} aria-selected={option.value === value} tabIndex={option.value === value ? 0 : -1} onClick={() => onChange(option.value)} onKeyDown={event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + options.length) % options.length;
    onChange(options[next]!.value); (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus();
  }}>{option.label}</button>)}</div>;
}
export function KnowledgeMarkdown({ body }: { body: string }) {
  return <div className="knowledge-markdown"><Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{body}</Markdown></div>;
}
export function KnowledgeDialog({ title, children, open, onClose, footer, wide = false, description }: { title: string; children: ReactNode; open: boolean; onClose: () => void; footer?: ReactNode; wide?: boolean; description?: string }) {
  const { t } = useI18n();
  const descriptionId = useId(), returnFocus = useRef<HTMLElement | null>(null), content = useRef<HTMLDivElement | null>(null);
  return <Dialog.Root open={open} onOpenChange={next => { if (!next) onClose(); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content ref={content} data-knowledge-dialog className={`knowledge-dialog dialog-content${wide ? " is-wide" : ""}`} aria-describedby={description ? descriptionId : undefined} onPointerDownOutside={event => event.preventDefault()}
    onEscapeKeyDown={event => { event.stopImmediatePropagation(); }}
    onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
    onCloseAutoFocus={event => {
      event.preventDefault();
      const parent = [...document.querySelectorAll<HTMLElement>('[data-knowledge-dialog][data-state="open"]')].reverse().find(element => element !== content.current);
      restoreKnowledgeFocus([returnFocus.current, parent?.querySelector<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled)'), parent, document.querySelector<HTMLElement>("[data-knowledge-focus-fallback]")]);
    }}>
    <header><Dialog.Title>{title}</Dialog.Title><Dialog.Close className="icon-button" aria-label={t("knowledge.close")}><X size={18} /></Dialog.Close></header>
    {description && <Dialog.Description id={descriptionId} className="knowledge-dialog-description">{description}</Dialog.Description>}
    <div className="knowledge-dialog-body">{children}</div>{footer && <footer>{footer}</footer>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
