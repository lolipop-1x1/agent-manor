import type { SessionMessage } from "../session-contracts.js";

type Context = Required<Pick<SessionMessage, "contextSource" | "contextEvidence">>;
const contentSources = new Map<string, Context["contextSource"]>([
  ["agents_md.instructions", "agents_md"],
  ["environments.environment_context", "environment"],
  ["additional_content.codex_apps_open_page", "client"],
  ["skills.selected_skill_instructions", "client"],
]);

/** 优先采用客户端明确分类；旧日志仅从完整独立的包格式推断，混合请求仍为用户消息。 */
export function codexContext(body: string, contentKinds?: unknown): Context | undefined {
  if (contentKinds !== undefined) {
    if (!Array.isArray(contentKinds) || !contentKinds.length) return undefined;
    const sources = contentKinds.map(kind => typeof kind === "string" ? contentSources.get(kind) : undefined);
    if (sources.some(source => !source)) return undefined;
    return { contextSource: sources.includes("agents_md") ? "agents_md" : sources.includes("environment") ? "environment" : "client", contextEvidence: "client_metadata" };
  }
  let rest = body.trim();
  let source: SessionMessage["contextSource"];
  if (/^# AGENTS\.md instructions(?: for [^\n]+)?\s*\n/.test(rest)) {
    rest = rest.slice(rest.indexOf("\n") + 1).trimStart();
    if (!rest.startsWith("<INSTRUCTIONS>")) return undefined;
    source = "agents_md";
  }
  while (rest) {
    const tag = /^<(INSTRUCTIONS|environment_context|in-app-browser-context|skill|recommended_plugins|turn_aborted|external_codex_apps_open_page|codex_apps_client_time_context)(?:\s[^>]*)?>/.exec(rest);
    if (!tag) return undefined;
    const close = `</${tag[1]}>`, end = rest.indexOf(close, tag[0].length);
    if (end < 0) return undefined;
    source ??= tag[1] === "INSTRUCTIONS" ? "agents_md" : tag[1] === "environment_context" ? "environment" : "client";
    rest = rest.slice(end + close.length).trim();
  }
  return source ? { contextSource: source, contextEvidence: "wrapper" } : undefined;
}
