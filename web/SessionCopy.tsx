import { Children, isValidElement, type ReactNode, useState } from "react";
import { Copy, Check } from "@phosphor-icons/react";
import { t, useI18n } from "./i18n";

export function CopyButton({ text, label }: { text: string; label: string }) {
  useI18n();
  const [status, setStatus] = useState<"idle" | "done" | "error">("idle");
  return <span className="session-copy-control"><button type="button" className="icon-button" aria-label={label} title={label} onClick={async event => {
    event.preventDefault(); event.stopPropagation();
    try { await navigator.clipboard.writeText(text); setStatus("done"); } catch { setStatus("error"); }
  }}>{status === "done" ? <Check size={14} /> : <Copy size={14} />}</button>
    <span className={status === "error" ? "session-copy-error" : "sr-only"} role="status">{status === "idle" ? "" : t(status === "done" ? "sessions.copy.done" : "sessions.copy.error")}</span></span>;
}

function plainText(node: ReactNode): string {
  return Children.toArray(node).map(child => typeof child === "string" || typeof child === "number" ? String(child)
    : isValidElement<{ children?: ReactNode; text?: string }>(child) ? child.props.text ?? plainText(child.props.children) : "").join("");
}
export function CopyCodeBlock({ children, text }: { children: ReactNode; text?: string }) {
  useI18n();
  return <div className="session-code-block"><CopyButton text={text ?? plainText(children)} label={t("sessions.copy.code")} /><pre>{children}</pre></div>;
}
