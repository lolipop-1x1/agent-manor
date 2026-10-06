import { memo, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Clock, MapTrifold } from "@phosphor-icons/react";
import type { MessageKind, SessionMessage } from "../src/session-contracts";
import { displayRecorded } from "./session-model";

export const kindLabels: Record<MessageKind, string> = {
  user: "用户", assistant: "AI", thinking: "思考", tool_call: "工具请求", tool_result: "工具响应", system: "系统", context: "上下文", compression: "压缩",
};
export const resourceLabels = { mcp: "MCP 证据", skill_call: "Skill 调用", skill_read: "Skill 读取" } as const;
const statusLabels = { success: "成功", failure: "失败", unknown: "未知" } as const;
const PREVIEW_LENGTH = 6000;

export function MessageBody({ message, focused, project, onMap, flat = false }: {
  message: SessionMessage; focused: boolean; project?: string; onMap: (path?: string, project?: string) => void; flat?: boolean;
}) {
  const isProcess = !["user", "assistant"].includes(message.kind);
  const [open, setOpen] = useState(focused);
  const [full, setFull] = useState(false);
  useEffect(() => { if (focused) { setOpen(true); setFull(true); } }, [focused]);
  const text = message.text || "（该记录没有可显示的正文）";
  const shown = full ? text : text.slice(0, PREVIEW_LENGTH);
  const more = text.length > PREVIEW_LENGTH && <button className="text-button session-text-expand" onClick={() => setFull(value => !value)}>{full ? "收起长内容" : `展开全部内容 · ${text.length.toLocaleString("zh-CN")} 字符`}</button>;
  if (isProcess && flat) return <div className="trace-payload"><pre>{shown}</pre>{more}</div>;
  if (isProcess) return <details className="session-message-detail" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{kindLabels[message.kind]}内容 · {text.length.toLocaleString("zh-CN")} 字符</summary>
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
      img: ({ alt }) => <span className="muted">[图片：{alt || "未命名"}]</span>,
      pre: ({ children }) => <div className="session-code-block"><pre>{children}</pre></div>,
    }}>{shown}</Markdown>{more}
  </div>;
}

export const MessageCard = memo(function MessageCard({ message, mode, focused, project, onMap }: {
  message: SessionMessage; mode: "brief" | "full" | "trace"; focused: boolean; project?: string; onMap: (path?: string, project?: string) => void;
}) {
  const isTool = message.kind === "tool_call" || message.kind === "tool_result";
  return <article id={`session-message-${message.id}`} className={`session-message kind-${message.kind}${focused ? " is-focused" : ""}`}>
    <div className="session-message-marker" aria-hidden="true" />
    <header className="session-message-head">
      <span className={`session-kind kind-${message.kind}`}>{kindLabels[message.kind]}</span>
      <strong>{isTool ? message.tool ?? "工具" : message.kind === "assistant" ? message.model ?? "AI 回复" : kindLabels[message.kind]}</strong>
      {message.final && <span className={`session-final is-${message.final}`}>{message.final === "explicit" ? "明确最终回答" : "推断最终回答"}</span>}
      {message.copied && <span className="session-evidence-label">已识别复制记录</span>}
      {message.contextSource && <span className="session-evidence-label">{message.contextSource === "agents_md" ? "AGENTS.md 注入" : "客户端注入包"}</span>}
      {message.status && <span className={`session-status is-${message.status}`}>{statusLabels[message.status]}</span>}
      {message.durationMs !== undefined && <span className="session-duration"><Clock size={12} />{displayRecorded(message.durationMs)} ms</span>}
      <time>{message.occurredAt ? new Date(message.occurredAt).toLocaleString("zh-CN", { hour12: false }) : "时间未记录"}</time>
    </header>
    {(message.callId || message.resource || mode === "trace") && <details className="session-message-metadata"><summary>记录信息</summary>
      {message.resource && <div>{resourceLabels[message.resource.kind]} · {message.resource.server ? `${message.resource.server} / ` : ""}{message.resource.name}</div>}
      {message.callId && <div>调用 {message.callId}</div>}{mode === "trace" && <div>轮次 {message.turnId} · 记录 {message.recordLine}</div>}
    </details>}
    <MessageBody message={message} focused={focused} project={project} onMap={onMap} />
    {!!message.filePaths?.length && <details className="session-file-links"><summary>关联文件 · {message.filePaths.length}</summary><div>
      {message.filePaths.map(path => <button key={path} className="session-file-link" onClick={() => onMap(path, project)}>{path} <MapTrifold size={13} aria-hidden="true" /></button>)}
    </div></details>}
  </article>;
});
