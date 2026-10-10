import { RequestSpeedBadge } from "./SessionSpeed";
import { getLanguage, t, useI18n } from "../../shared/i18n";
import { formatDateTime, formatNumber } from "../../../src/i18n";
import { Children, cloneElement, isValidElement, memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { completeCodeBlocks } from "./session-code";
import { CopyButton, CopyCodeBlock } from "./SessionCopy";
import { Highlight } from "./SessionSearchGroups";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Clock, Info, MapTrifold } from "@phosphor-icons/react";
import type { MessageKind, SessionMessage, SessionUsage } from "../../../src/session-contracts";
import { displayRecorded, sessionResourceName, sessionMessageText } from "./session-model";
import { completeMessage } from "./session-message-content";
import { isAborted } from "../../shared/api";
import { SessionError } from "./SessionControls";
import { HelpPopover } from "../../shared/ui/HelpPopover";

export const kindLabels: Record<MessageKind, string> = {
  user: "sessions.kind.user", assistant: "sessions.kind.assistant", thinking: "sessions.kind.thinking", tool_call: "sessions.kind.toolCall", tool_result: "sessions.kind.toolResult", system: "sessions.kind.system", context: "sessions.kind.context", compression: "sessions.kind.compression",
};
export const resourceLabels = { mcp: "sessions.resource.mcp", skill_call: "sessions.resource.skillCall", skill_read: "sessions.resource.skillRead" } as const;
const statusLabels = { success: "sessions.status.success", failure: "sessions.status.failure", unknown: "sessions.status.unknown" } as const;
const PREVIEW_LENGTH = 6000;

function marked(children: ReactNode, query: string): ReactNode {
  return Children.map(children, child => typeof child === "string" ? <Highlight text={child} query={query} />
    : isValidElement<{ children?: ReactNode }>(child) && child.props.children ? cloneElement(child, {}, marked(child.props.children, query)) : child);
}

export function MessageBody({ message, focused, project, onMap, flat = false, query = "", version }: {
  message: SessionMessage; focused: boolean; project?: string; onMap: (path?: string, project?: string) => void; flat?: boolean; query?: string; version?: string;
}) {
  useI18n();
  const isProcess = !["user", "assistant"].includes(message.kind);
  const [open, setOpen] = useState(focused);
  const [full, setFull] = useState(false);
  const [content, setContent] = useState<{ version?: string; message: SessionMessage }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error>();
  const [retry, setRetry] = useState(0);
  useEffect(() => { if (focused) { setOpen(true); setFull(true); } }, [focused]);
  useEffect(() => {
    if (!full || !message.textTruncated || content?.version === version && content?.message.id === message.id) return;
    const controller = new AbortController(); setLoading(true); setError(undefined);
    void completeMessage(message, version, controller.signal).then(value => { if (!controller.signal.aborted) setContent({ version, message: value }); })
      .catch(error => { if (!isAborted(error)) setError(error instanceof Error ? error : new Error(String(error))); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [full, message, version, retry]);
  const complete = content?.version === version && content?.message.id === message.id ? content.message : undefined;
  const text = sessionMessageText(complete ?? message);
  const textLength = complete ? text.length : message.textLength ?? text.length;
  const completeCodes = useMemo(() => text.length > PREVIEW_LENGTH ? completeCodeBlocks(text) : undefined, [text]);
  const shown = full ? text : text.slice(0, PREVIEW_LENGTH);
  const more = <>{textLength > PREVIEW_LENGTH && <button className="text-button session-text-expand" disabled={loading} onClick={() => { if (error) setRetry(value => value + 1); setFull(value => error ? true : !value); }}>{loading ? t("sessions.body.loading") : error ? t("common.retry") : full ? t("sessions.body.collapse") : t("sessions.body.expand", { count: textLength })}</button>}{error && <p role="alert"><SessionError error={error} /></p>}</>;
  if (isProcess && flat) return <div className="trace-payload"><pre><Highlight text={shown} query={query} /></pre>{more}</div>;
  if (isProcess) return <details className="session-message-detail" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("sessions.body.detail", { kind: t(kindLabels[message.kind]), count: textLength })}</summary>
    {open && <><pre><Highlight text={shown} query={query} /></pre>{more}</>}
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
      pre: ({ children, node }) => <CopyCodeBlock text={node?.position?.start.offset === undefined ? undefined : completeCodes?.get(node.position.start.offset)} getText={!complete && message.textTruncated && node?.position?.start.offset !== undefined ? async () => {
        const original = sessionMessageText(await completeMessage(message, version));
        return completeCodeBlocks(original).get(node.position!.start.offset!) ?? "";
      } : undefined}>{children}</CopyCodeBlock>,
      p: ({ children }) => <p>{marked(children, query)}</p>,
      h1: ({ children }) => <h1>{marked(children, query)}</h1>,
      h2: ({ children }) => <h2>{marked(children, query)}</h2>,
      h3: ({ children }) => <h3>{marked(children, query)}</h3>,
      td: ({ children }) => <td>{marked(children, query)}</td>,
      li: ({ children }) => <li>{marked(children, query)}</li>,
      code: ({ children, className }) => <code className={className}>{marked(children, query)}</code>,
    }}>{shown}</Markdown>{more}
  </div>;
}

export const MessageCard = memo(function MessageCard({ message, mode, focused, project, onMap, query, usage, version }: {
  message: SessionMessage; mode: "brief" | "full" | "trace"; focused: boolean; query?: string; project?: string; onMap: (path?: string, project?: string) => void; usage?: SessionUsage; version?: string;
}) {
  useI18n();
  const isTool = message.kind === "tool_call" || message.kind === "tool_result";
  return <article id={`session-message-${message.id}`} className={`session-message kind-${message.kind}${focused ? " is-focused" : ""}`}>
    <div className="session-message-marker" aria-hidden="true" />
    <header className="session-message-head">
      {isTool && <span className={`session-kind kind-${message.kind}`}>{t(kindLabels[message.kind])}</span>}
      <strong>{isTool ? message.tool ?? t("sessions.message.tool") : message.kind === "assistant" ? message.model ? t("sessions.message.aiModel", { model: message.model }) : t("sessions.message.aiReply") : t(kindLabels[message.kind])}</strong>
      {usage && <RequestSpeedBadge usage={usage} />}
      {message.final && mode !== "brief" && <span className={`session-final is-${message.final}`}>{message.final === "explicit" ? t("sessions.message.finalExplicit") : t("sessions.message.finalInferred")}</span>}
      {message.currentBranch === false && <span className="session-evidence-label">{t("sessions.message.otherBranch")}</span>}
      {message.copied && <span className="session-evidence-label">{t("sessions.message.copied")}</span>}
      {message.contextSource && <span className="session-evidence-label">{message.contextSource === "hook" ? t("sessions.context.hook") : message.contextSource === "agents_md" ? t("sessions.context.agents") : t("sessions.context.clientBundle")}</span>}
      {message.status && <span className={`session-status is-${message.status}`}>{t(statusLabels[message.status])}</span>}
      {message.durationMs !== undefined && <span className="session-duration"><Clock size={12} />{displayRecorded(message.durationMs)} ms</span>}
      {message.occurredAt && <time>{formatDateTime(getLanguage(), message.occurredAt)}</time>}
      {message.kind === "assistant" && <div className="session-message-actions">
        {message.unconfirmed && <HelpPopover label={t("sessions.message.replyDetails")} trigger={<button className="icon-button" aria-label={t("sessions.message.replyDetails")}><Info size={15} aria-hidden="true" /></button>}><p>{t("sessions.message.unconfirmedHelp")}</p></HelpPopover>}
        <CopyButton text={message.text} getText={() => completeMessage(message, version).then(value => value.text)} label={t("sessions.copy.reply")} />
      </div>}
    </header>
    {(message.callId || message.resource || mode === "trace") && <details className="session-message-metadata"><summary>{t("sessions.message.metadata")}</summary>
      {message.resource && <div>{t(resourceLabels[message.resource.kind])} · {message.resource.server ? `${message.resource.server} / ` : ""}{sessionResourceName(message.resource)}</div>}
      {message.callId && <div>{t("sessions.message.callId", { id: message.callId })}</div>}{mode === "trace" && <div>{t("sessions.message.recordMeta", { turn: message.turnId, record: formatNumber(getLanguage(), message.recordLine) })}</div>}
    </details>}
    <MessageBody message={message} focused={focused} query={query} project={project} onMap={onMap} version={version} />
    {!!message.filePaths?.length && <details className="session-file-links"><summary>{t("sessions.message.fileCount", { count: message.filePaths.length })}</summary><div>
      {message.filePaths.map(path => <button key={path} className="session-file-link" onClick={() => onMap(path, project)}>{path} <MapTrifold size={13} aria-hidden="true" /></button>)}
    </div></details>}
  </article>;
});
