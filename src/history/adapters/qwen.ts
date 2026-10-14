import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { Gap } from "../../contracts.js";
import { changedFragments, object, physicalLines, shellEvidence, string, toolEvidence, unifiedFragments, type ToolEvidence } from "../extraction.js";
import type { SourceLocation } from "../types.js";
import { absoluteDirectory, addGap, eventTime, readJsonlRows, sourceFor, textOf, tokenValue } from "./native-jsonl.js";
import { createNormalizedAdapter, normalizedHash, normalizedRecord, normalizedSnapshot, type NormalizedEvent, type NormalizedSnapshot, type RawHistoryRecord } from "./normalized.js";

const FORMAT = "qwen-jsonl";

export function qwenHistoryRoots(home: string, environment: NodeJS.ProcessEnv): string[] {
  const expand = (value: string) => value === "~" ? home : value.startsWith("~/") || value.startsWith("~\\") ? join(home, ...value.slice(2).split(/[/\\]/)) : resolve(value);
  const nativeHome = environment.QWEN_HOME ? expand(environment.QWEN_HOME) : join(home, ".qwen");
  if (environment.QWEN_RUNTIME_DIR) return [join(expand(environment.QWEN_RUNTIME_DIR), "projects")];
  let runtime: string | undefined;
  try {
    const path = join(nativeHome, "settings.json"); const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024) {
      const errors: ParseError[] = []; const settings = object(parseJsonc(readFileSync(path, "utf8"), errors, { allowTrailingComma: true }));
      const configured = string(object(settings.advanced).runtimeOutputDir);
      // 相对配置由客户端当时的 cwd 解释；本产品缺少该上下文时只接受明确 roots。
      if (!errors.length && configured && (isAbsolute(configured) || configured === "~" || /^~[/\\]/.test(configured))) runtime = expand(configured);
    }
  } catch { /* 缺少用户配置时沿用原生默认目录；不把当前工作区当作客户端 cwd。 */ }
  return [join(runtime ?? nativeHome, "projects")];
}

export const acceptsQwenHistoryFile = (path: string): boolean => path.endsWith(".jsonl") && path.split(/[\\/]/).includes("chats");
const nonConversation = new Set(["session_sources_snapshot", "session_artifact_event", "session_artifact_snapshot"]);
const knownSystems = new Set(["slash_command", "ui_telemetry", "at_command", "attribution_snapshot", "notification", "background_task_completed", "cron", "custom_title", "parent_session", "session_source", "session_model", "session_approval_mode", "rewind", "agent_bootstrap", "agent_launch_prompt", "agent_retry", "agent_session_ready", "file_history_snapshot", "user_text_elements", "branch_checkpoint", "goal_state", "goal_runtime", "goal_turn_end", "turn_result", "session_execution_engine", "omni_recall", ...nonConversation]);

function gap(gaps: Gap[], kind: Gap["kind"], message: string, key: string): void {
  addGap(gaps, kind, message, { key: `diagnostics.history.adapters.qwen.${key}` });
}

function nativeParts(record: Record<string, unknown>): Record<string, unknown>[] {
  const parts = object(record.message).parts;
  return Array.isArray(parts) ? parts.map(object) : [];
}

function resultText(response: unknown): string {
  const value = object(response);
  return string(value.output) ?? string(value.error) ?? textOf(value.content) ?? "";
}

function usage(value: unknown, auth: string | undefined, gaps: Gap[]): NormalizedEvent["usage"] {
  const tokens = object(value);
  if (!Object.keys(tokens).length) return undefined;
  const input = tokenValue(tokens.promptTokenCount); const candidates = tokenValue(tokens.candidatesTokenCount);
  const thoughts = tokenValue(tokens.thoughtsTokenCount); const cached = tokenValue(tokens.cachedContentTokenCount);
  const separateThoughts = auth === "gemini" || auth === "vertex-ai";
  const includedThoughts = ["openai", "openai-responses", "qwen-oauth", "anthropic"].includes(auth ?? "");
  const output = thoughts === undefined || thoughts === 0 ? candidates
    : separateThoughts && candidates !== undefined ? candidates + thoughts : includedThoughts ? candidates : undefined;
  if (thoughts !== undefined && thoughts > 0 && !separateThoughts && !includedThoughts) gap(gaps, "ambiguous", "Qwen 未记录用量 provider 协议，输出与推理包含关系未知", "m001");
  if (cached !== undefined && input !== undefined && cached > input) gap(gaps, "ambiguous", "Qwen 缓存用量大于总输入，缓存比例未确认", "m002");
  gap(gaps, "ambiguous", "Qwen 留存响应流不能还原实际请求覆盖；缓存零值及推理估算来源未完整序列化", "m003");
  return { inputTokens: input, outputTokens: output, cachedInputTokens: cached !== undefined && (input === undefined || cached <= input) ? cached : undefined,
    reasoningOutputTokens: thoughts };
}

function unavailable(kind: ToolEvidence["kind"], path: string | undefined): ToolEvidence[] {
  return [{ kind, path, fragments: [], reason: "range_unknown: Qwen 返回缺少可确认完整内容或实际位置", reasonDescriptor: { key: "diagnostics.history.adapters.qwen.m004" } }];
}

function extract(tool: string, inputValue: unknown, resultValue: unknown, visible: string): ToolEvidence[] {
  const input = object(inputValue); const result = object(resultValue); const display = object(result.resultDisplay); const path = string(input.file_path);
  if (tool === "read_file") {
    if (result.status !== "success" || !path || !visible || /\.\.\. \[truncated\]|^Output too large\.|\[.*(?:cached|unchanged|previously read).*\]|^Binary content |^Cannot display content|^<untrusted_content>/mi.test(visible)) return unavailable("read", path);
    let start = (tokenValue(input.offset) ?? 0) + 1; let body = visible;
    const wrapper = /^Showing lines (\d+)-(\d+) of (?:at least )?\d+ total lines\.\n\n---\n\n([\s\S]*)$/.exec(body);
    if (wrapper) {
      start = Number(wrapper[1]); body = wrapper[3]!;
      if (physicalLines(body).length > Number(wrapper[2]) - start + 1) return unavailable("read", path);
    }
    if (!Number.isSafeInteger(start) || start < 1 || /--- Newly Discovered Project Context ---|<system-reminder>|^Showing lines /m.test(body)) return unavailable("read", path);
    const limit = tokenValue(input.limit);
    if (limit !== undefined && physicalLines(body).length > limit) return unavailable("read", path);
    return [{ kind: "read", path, fragments: body ? [{ kind: "read", content: body, historicalStart: start, completeLines: true }] : [],
      ...(wrapper ? { reason: "range_unknown: Qwen read_file 只保留返回窗口", reasonDescriptor: { key: "diagnostics.history.adapters.qwen.m005" } } : {}) }];
  }
  if (tool === "edit" || tool === "write_file") {
    if (result.status !== "success" || !path || display.truncatedForSession === true || display.fileDiffTruncated === true) return unavailable("edit", path);
    const patch = string(display.fileDiff);
    if (patch && /^@@ /m.test(patch) && !/Saved session preview only|Full diff omitted from saved session history/.test(patch)) return [{ kind: "edit", path, fragments: unifiedFragments(patch, path) }];
    const before = string(display.originalContent); const after = string(display.newContent);
    if (display.originalContentTruncated === true || display.newContentTruncated === true) return unavailable("edit", path);
    if (before !== undefined && after !== undefined) return [{ kind: "edit", path, fragments: changedFragments(before, after, path) }];
    if (display.originalContent === null && after !== undefined) return [{ kind: "edit", path, fragments: after ? [{ kind: "added", content: after, historicalStart: 1, completeLines: true }] : [] }];
    return unavailable("edit", path);
  }
  if (tool === "run_shell_command") {
    if (result.status !== "success" || display.type !== "shell_result" || display.version !== 1 || display.exitCode !== 0
      || display.outcome !== "completed" || display.truncated === true || typeof display.output !== "string") return unavailable("other", undefined);
    return shellEvidence(string(input.command) ?? "", display.output);
  }
  return toolEvidence(tool, input, result, visible);
}

async function snapshot(location: SourceLocation): Promise<NormalizedSnapshot> {
  const gaps: Gap[] = []; const allRows = await readJsonlRows(location.path, gaps);
  if (location.adapterGap) gaps.push(location.adapterGap);
  const sessionIds = [...new Set(allRows.map(row => string(row.record.sessionId)).filter((id): id is string => Boolean(id)))];
  const sessionId = sessionIds.length === 1 ? sessionIds[0] : undefined;
  const agent = location.selector?.startsWith("agent:") ? location.selector.slice(6) : undefined;
  if (!sessionId) gap(gaps, "unsupported_format", "Qwen 来源缺少唯一原生会话身份", "m006");
  const agentIds = [...new Set(allRows.filter(row => row.record.isSidechain === true).map(row => string(row.record.agentId)).filter((id): id is string => Boolean(id)))];
  const rows = allRows.filter(row => agent ? row.record.isSidechain === true && row.record.agentId === agent : row.record.isSidechain !== true);
  if (allRows.some(row => row.record.isSidechain === true && !string(row.record.agentId))) gap(gaps, "source_missing", "Qwen sidechain 缺少 Agent 身份，未猜测归属", "m007");
  const projectPaths = [...new Set(rows.map(row => absoluteDirectory(row.record.cwd)).filter((path): path is string => Boolean(path)))];
  if (projectPaths.length > 1) gap(gaps, "ambiguous", "Qwen 会话工作目录发生变化，保留最新明确 cwd", "m008");
  const id = agent && sessionId ? `${sessionId}:agent:${agent}` : sessionId;
  const source = sourceFor(location, "qwen", FORMAT, id, projectPaths.at(-1));
  const groups = new Map<string, RawHistoryRecord[]>(); const unknown: RawHistoryRecord[] = [];
  for (const row of rows) {
    const uuid = string(row.record.uuid);
    if (!uuid || !["user", "assistant", "tool_result", "system"].includes(string(row.record.type) ?? "")) {
      unknown.push(row); gap(gaps, "unsupported_format", "Qwen 来源包含未适配记录，保留原始内容", "m009"); continue;
    }
    if (nonConversation.has(string(row.record.subtype) ?? "")) { unknown.push(row); continue; }
    const group = groups.get(uuid) ?? [];
    if (group.length && group[0]!.record.parentUuid !== row.record.parentUuid) gap(gaps, "ambiguous", "Qwen 同 UUID 片段父链冲突，沿首次父身份保留原始片段", "m010");
    group.push(row); groups.set(uuid, group);
  }
  const children = new Set([...groups.values()].map(group => string(group[0]!.record.parentUuid)).filter((uuid): uuid is string => Boolean(uuid)));
  const currentLeaf = [...groups.keys()].at(-1);
  const leaves = [...groups.keys()].filter(uuid => !children.has(uuid));
  if (currentLeaf && !leaves.includes(currentLeaf)) leaves.push(currentLeaf);
  const paths = new Map<string, string[]>(); const membership = new Map<string, string[]>(); const turns = new Map<string, string>(); const auths = new Map<string, string | undefined>();
  for (const leaf of leaves) {
    const chain: string[] = []; const seen = new Set<string>(); let current: string | undefined = leaf;
    while (current) {
      if (seen.has(current)) { gap(gaps, "parse_error", "Qwen UUID 父链包含循环", "m011"); break; }
      seen.add(current); const group = groups.get(current);
      if (!group) { gap(gaps, "source_missing", "Qwen UUID 父链指向缺少的原生记录", "m012"); break; }
      chain.push(current); current = string(group[0]!.record.parentUuid);
    }
    chain.reverse(); paths.set(leaf, chain); let turn: string | undefined; let auth: string | undefined;
    for (const uuid of chain) {
      const record = groups.get(uuid)![0]!.record;
      membership.set(uuid, [...(membership.get(uuid) ?? []), leaf]);
      if (isUser(record, agent)) { turn = uuid; auth = string(object(record.executionContext).authType); }
      if (turn) turns.set(uuid, turn); auths.set(uuid, auth);
    }
  }
  const currentPath = new Set(paths.get(currentLeaf ?? "") ?? []);
  let title: string | undefined; let parentSessionId = agent ? sessionId : undefined; let relationship: "child" | "fork" | undefined = agent ? "child" : undefined;
  const forkParents = new Set<string>();
  const promptTurns = new Map<string, string>();
  for (const [uuid, fragments] of groups) {
    const record = fragments[0]!.record;
    if (isUser(record, agent) && string(record.promptId)) promptTurns.set(string(record.promptId)!, uuid);
    for (const row of fragments) {
      const payload = object(row.record.systemPayload);
      if (row.record.subtype === "custom_title") title = string(payload.customTitle)?.trim() || title;
      if (row.record.subtype === "parent_session" && typeof payload.parentSessionId === "string") { parentSessionId = payload.parentSessionId; relationship = "child"; }
      const fork = object(row.record.forkedFrom);
      if (string(fork.sessionId) && fork.messageUuid === uuid) forkParents.add(string(fork.sessionId)!);
    }
  }
  if (forkParents.size === 1 && !parentSessionId) { parentSessionId = [...forkParents][0]; relationship = "fork"; }
  if (forkParents.size > 1) gap(gaps, "ambiguous", "Qwen 分叉记录声明多个父会话，未合并跨会话关系", "m013");
  const records: RawHistoryRecord[] = []; const assistantByTurn = new Map<string, NormalizedEvent>();
  const copiedIds: string[] = [];
  for (const [uuid, fragments] of groups) {
    const first = fragments[0]!.record; const turnKey = turns.get(uuid);
    const copied = relationship === "fork" && object(first.forkedFrom).sessionId === parentSessionId && object(first.forkedFrom).messageUuid === uuid;
    if (copied) copiedIds.push(normalizedHash(uuid));
    const common = { branchIds: membership.get(uuid), currentBranch: currentPath.has(uuid), turnKey, copied, nativeIdentityHash: normalizedHash(uuid) };
    const usageRow = fragments.filter(row => Object.keys(object(row.record.usageMetadata)).length).at(-1);
    const model = fragments.map(row => string(row.record.model)).find(Boolean);
    const normalizedUsage = usageRow ? usage(usageRow.record.usageMetadata, auths.get(uuid), gaps) : undefined;
    const add = (event: NormalizedEvent, row: RawHistoryRecord, suffix: string) => {
      const value = { ...common, occurredAt: eventTime(row.record.timestamp), model, ...event, key: `${uuid}:${suffix}` };
      records.push(normalizedRecord(value, row.raw, row.line));
      if (event.kind === "assistant" && turnKey) assistantByTurn.set(turnKey, value);
      return value;
    };
    if (first.type === "user") {
      const role = isUser(first, agent) ? "user" : "context";
      const text = fragments.map(row => {
        const payload = object(row.record.systemPayload);
        return typeof payload.displayText === "string" ? payload.displayText : textOf(object(row.record.message).parts);
      }).filter(Boolean).join("\n");
      add({ key: "", kind: role, text }, fragments[0]!, "user");
    } else if (first.type === "assistant") {
      const visible = fragments.flatMap(row => nativeParts(row.record)).filter(part => part.thought !== true).map(part => string(part.text) ?? "").filter(Boolean).join("\n");
      const thinking = fragments.flatMap(row => nativeParts(row.record)).filter(part => part.thought === true).map(part => string(part.text) ?? "").filter(Boolean).join("\n");
      add({ key: "", kind: "assistant", text: visible, allowInferredFinal: false }, fragments[0]!, "assistant");
      if (thinking) add({ key: "", kind: "thinking", text: thinking }, fragments[0]!, "thinking");
      for (const row of fragments) {
        const parts = nativeParts(row.record);
        for (const [index, part] of parts.entries()) if (part.functionCall) {
          const call = object(part.functionCall); const callId = string(call.id);
          if (!callId) { gap(gaps, "unpaired_call", "Qwen 工具请求缺少原生 functionCall.id", "m014"); continue; }
          add({ key: "", kind: "tool_call", callId, tool: string(call.name), input: call.args }, row, `call:${callId}:${index}`);
        }
      }
      if (normalizedUsage && usageRow) add({ key: "", kind: "context", text: "", usageKey: `${uuid}:usage`, usageMessageKey: `${uuid}:assistant`, usage: normalizedUsage }, usageRow, "usage");
    } else if (first.type === "tool_result") {
      for (const row of fragments) {
        const info = object(row.record.toolCallResult);
        const responses = nativeParts(row.record).filter(part => part.functionResponse).map(part => object(part.functionResponse));
        for (const [index, response] of responses.entries()) {
          const callId = string(response.id) ?? (responses.length === 1 ? string(info.callId) : undefined);
          if (!callId) { gap(gaps, "unpaired_call", "Qwen 工具结果缺少原生调用身份", "m015"); continue; }
          const cancelled = info.status === "cancelled"; const hasError = info.error !== undefined && info.error !== null || object(response.response).error !== undefined;
          const status = info.status === "error" || hasError ? "failure" : info.status === "success" ? "success" : "unknown";
          add({ key: "", kind: "tool_result", callId, tool: string(response.name), text: resultText(response.response), result: { ...info, response: response.response }, status, interrupted: cancelled }, row, `result:${callId}:${index}`);
        }
        if (!responses.length) gap(gaps, "unpaired_call", "Qwen 工具结果缺少 functionResponse，保留原始记录", "m015");
      }
    } else {
      for (const row of fragments) {
        const subtype = string(row.record.subtype); const payload = object(row.record.systemPayload);
        if (subtype === "turn_result") {
          const ownedTurn = promptTurns.get(string(payload.promptId) ?? ""); const candidate = ownedTurn ? assistantByTurn.get(ownedTurn) : undefined;
          if (candidate && payload.state === "completed" && payload.stopReason === "end_turn") {
            candidate.final = "explicit"; candidate.finalEvidence = "turn_terminal"; candidate.finalAt = eventTime(payload.endedAt);
          }
          add({ key: "", kind: "context", text: JSON.stringify(payload), turnKey: ownedTurn ?? turnKey,
            interrupted: payload.state === "cancelled" || payload.state === "error" }, row, `system:${row.line}`);
        } else add({ key: "", kind: subtype === "chat_compression" ? "compression" : "context", text: textOf(object(row.record.message).parts) || JSON.stringify(payload) }, row, `system:${row.line}`);
        if (subtype !== "chat_compression" && !knownSystems.has(subtype ?? "")) gap(gaps, "unsupported_format", "Qwen system 记录含未适配 subtype，保留原始内容", "m009");
      }
    }
  }
  for (const row of unknown) records.push(normalizedRecord({ key: `raw:${row.line}`, kind: "context", text: row.raw }, row.raw, row.line));
  const evidenceLines = new Set(records.map(row => row.line));
  for (const row of rows) if (!evidenceLines.has(row.line)) records.push({ raw: row.raw, line: row.line, record: {} });
  source.parentSessionId = parentSessionId;
  const branches = leaves.map((leaf, index) => ({ id: leaf, label: leaf === currentLeaf ? "当前分支" : `分支 ${index + 1}`,
    labelDescriptor: { key: leaf === currentLeaf ? "sessions.branch.current" : "sessions.branch.number", params: { number: index + 1 } }, current: leaf === currentLeaf }));
  const result = normalizedSnapshot(source, records, { title, parentSessionId, relationship, branches,
    childSessionIds: !agent && sessionId ? agentIds.map(agentId => `${sessionId}:agent:${agentId}`) : undefined,
    relationships: parentSessionId && relationship ? [{ kind: relationship === "fork" ? "fork" : "subagent", parentSessionId, agentId: agent,
      ...(copiedIds.length ? { copiedRecordIdentityHashes: copiedIds } : {}) }] : undefined, gaps }, JSON.stringify(allRows.map(row => row.raw)));
  result.source.sourceCompleteness = { version: allRows.length, supported: Boolean(id), complete: !gaps.some(gap => ["parse_error", "incomplete_record", "budget_exceeded"].includes(gap.kind)), fingerprint: result.hash };
  return result;
}

function isUser(record: Record<string, unknown>, agent?: string): boolean {
  return record.type === "user" && !agent && !record.backgroundTurn && !["agent_mention", "agent_message", "notification", "cron", "agent_launch_prompt", "goal_runtime"].includes(string(record.subtype) ?? "")
    && (record.provenance === undefined || record.provenance === "real_user");
}

export const qwenAdapter = createNormalizedAdapter({ id: FORMAT, readSnapshot: snapshot, extract,
  discoverFile: async location => {
    const main = await snapshot(location);
    if (!main.source.sessionId) return [];
    const sources = [main.source];
    for (const child of main.meta.childSessionIds ?? []) {
      const agent = child.slice(`${main.source.sessionId}:agent:`.length);
      sources.push((await snapshot({ ...location, selector: `agent:${agent}` })).source);
    }
    return sources;
  },
  selectSources: locations => {
    const own = locations.filter(location => location.client === "qwen" && location.format === FORMAT);
    const others = locations.filter(location => location.client !== "qwen" || location.format !== FORMAT);
    const selected = new Map<string, SourceLocation>();
    for (const location of own) {
      const key = location.sessionId ?? JSON.stringify([location.path, location.selector]); const previous = selected.get(key);
      if (!previous) { selected.set(key, location); continue; }
      const archive = /[/\\](?:archive|archived)[/\\]/;
      const preferred = archive.test(previous.path) && !archive.test(location.path) ? location
        : archive.test(location.path) && !archive.test(previous.path) ? previous
          : (location.sourceCompleteness?.version ?? 0) > (previous.sourceCompleteness?.version ?? 0) ? location : previous;
      if (previous.sourceCompleteness?.fingerprint !== location.sourceCompleteness?.fingerprint) preferred.adapterGap = { kind: "ambiguous", message: "Qwen 同会话来源副本不同，优先当前目录并保留覆盖缺口", messageDescriptor: { key: "diagnostics.history.adapters.qwen.m016" } };
      selected.set(key, preferred);
    }
    return [...others, ...selected.values()];
  } });
