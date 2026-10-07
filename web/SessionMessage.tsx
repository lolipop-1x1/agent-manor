import { getLanguage, t, useI18n } from "./i18n";
import { formatDateTime, formatNumber } from "../src/i18n";
import { memo, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Clock, MapTrifold } from "@phosphor-icons/react";
import type { MessageKind, SessionMessage } from "../src/session-contracts";
import { displayRecorded, sessionResourceName, sessionMessageText } from "./session-model";

export const kindLabels: Record<MessageKind, string> = {
  user: "sessions.kind.user", assistant: "sessions.kind.assistant", thinking: "sessions.kind.thinking", tool_call: "sessions.kind.toolCall", tool_result: "sessions.kind.toolResult", system: "sessions.kind.system", context: "sessions.kind.context", compression: "sessions.kind.compression",
};
export const resourceLabels = { mcp: "sessions.resource.mcp", skill_call: "sessions.resource.skillCall", skill_read: "sessions.resource.skillRead" } as const;
const statusLabels = { success: "sessions.status.success", failure: "sessions.status.failure", unknown: "sessions.status.unknown" } as const;
const PREVIEW_LENGTH = 6000;

export function MessageBody({ message, focused, project, onMap, flat = false }: {
  message: SessionMessage; focused: boolean; project?: string; onMap: (path?: string, project?: string) => void; flat?: boolean;
}) {
  useI18n();
  const isProcess = !["user", "assistant"].includes(message.kind);
  const [open, setOpen] = useState(focused);
  const [full, setFull] = useState(false);
  useEffect(() => { if (focused) { setOpen(true); setFull(true); } }, [focused]);
  const text = sessionMessageText(message);
  const shown = full ? text : text.slice(0, PREVIEW_LENGTH);
  const more = text.length > PREVIEW_LENGTH && <button className="text-button session-text-expand" onClick={() => setFull(value => !value)}>{full ? t("sessions.body.collapse") : t("sessions.body.expand", { count: text.length })}</button>;
  if (isProcess && flat) return <div className="trace-payload"><pre>{shown}</pre>{more}</div>;
  if (isProcess) return <details className="session-message-detail" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("sessions.body.detail", { kind: t(kindLabels[message.kind]), count: text.length })}</summary>
    {open && <><pre>{shown}</pre>{more}</>}
  </details>;
  return <div className="session-message-text">
    <Markdown remarkPlugins={[remarkGfm]} components={{
      a: ({ href, children }) => {
        if (href && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) {
          return <button className="session-inline-file" onClick={() => onMap(href.replace(/:\d+(?::\d+)?$/, ""), project)}>{children}</button>;
        }
        return href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>;
      },
      img: ({ alt }) => <span className="muted">{t("sessions.image.label", { alt: alt || t("sessions.image.unnamed") })}</span>,
      pre: ({ children }) => <div className="session-code-block"><pre>{children}</pre></div>,
    }}>{shown}</Markdown>{more}
  </div>;
}

export const MessageCard = memo(function MessageCard({ message, mode, focused, project, onMap }: {
  message: SessionMessage; mode: "brief" | "full" | "trace"; focused: boolean; project?: string; onMap: (path?: string, project?: string) => void;
}) {
  useI18n();
  const isTool = message.kind === "tool_call" || message.kind === "tool_result";
  return <article id={`session-message-${message.id}`} className={`session-message kind-${message.kind}${focused ? " is-focused" : ""}`}>
    <div className="session-message-marker" aria-hidden="true" />
    <header className="session-message-head">
      <span className={`session-kind kind-${message.kind}`}>{t(kindLabels[message.kind])}</span>
      <strong>{isTool ? message.tool ?? t("sessions.message.tool") : message.kind === "assistant" ? message.model ?? t("sessions.message.aiReply") : t(kindLabels[message.kind])}</strong>
      {message.final && <span className={`session-final is-${message.final}`}>{message.final === "explicit" ? t("sessions.message.finalExplicit") : t("sessions.message.finalInferred")}</span>}
      {message.currentBranch === false && <span className="session-evidence-label">{t("sessions.message.otherBranch")}</span>}
      {message.copied && <span className="session-evidence-label">{t("sessions.message.copied")}</span>}
      {message.contextSource && <span className="session-evidence-label">{message.contextSource === "hook" ? t("sessions.context.hook") : message.contextSource === "agents_md" ? t("sessions.context.agents") : t("sessions.context.clientBundle")}</span>}
      {message.status && <span className={`session-status is-${message.status}`}>{t(statusLabels[message.status])}</span>}
      {message.durationMs !== undefined && <span className="session-duration"><Clock size={12} />{displayRecorded(message.durationMs)} ms</span>}
      <time>{message.occurredAt ? formatDateTime(getLanguage(), message.occurredAt) : t("sessions.message.timeMissing")}</time>
    </header>
    {(message.callId || message.resource || mode === "trace") && <details className="session-message-metadata"><summary>{t("sessions.message.metadata")}</summary>
      {message.resource && <div>{t(resourceLabels[message.resource.kind])} · {message.resource.server ? `${message.resource.server} / ` : ""}{sessionResourceName(message.resource)}</div>}
      {message.callId && <div>{t("sessions.message.callId", { id: message.callId })}</div>}{mode === "trace" && <div>{t("sessions.message.recordMeta", { turn: message.turnId, record: formatNumber(getLanguage(), message.recordLine) })}</div>}
    </details>}
    <MessageBody message={message} focused={focused} project={project} onMap={onMap} />
    {!!message.filePaths?.length && <details className="session-file-links"><summary>{t("sessions.message.fileCount", { count: message.filePaths.length })}</summary><div>
      {message.filePaths.map(path => <button key={path} className="session-file-link" onClick={() => onMap(path, project)}>{path} <MapTrifold size={13} aria-hidden="true" /></button>)}
    </div></details>}
  </article>;
});
