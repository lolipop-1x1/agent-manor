import { isAbsolute } from "node:path";
import type { Gap } from "../../contracts.js";
import { DiagnosticError } from "../../i18n/diagnostics.js";
import type { SourceLocation } from "../types.js";
import { object, string } from "../extraction.js";
import { normalizeHistoryPath } from "./common.js";
import { readDoubaoWorkCache } from "./doubao-work-store.js";
import type { NormalizedEvent, NormalizedSessionMetadata, NormalizedSnapshot, RawHistoryRecord } from "./normalized.js";
import { createNormalizedAdapter, normalizedHash, normalizedRecord, normalizedSessionKey, normalizedSnapshot } from "./normalized.js";

export const DOUBAO_WORK_FORMAT = "doubao-work-indexeddb";
type CacheRecord = { account: string; value: Record<string, unknown> };
type Conversation = { account: string; value: Record<string, unknown>; selector: string };

const descriptor = (key: string) => ({ key: `diagnostics.history.adapters.doubaoWork.${key}` });
const invalid = () => new DiagnosticError("豆包工作会话缓存结构不完整或尚未适配，未发布空来源", descriptor("invalidCache"));
const missing = () => Object.assign(new DiagnosticError("豆包工作会话已不在当前本机缓存中", descriptor("missingConversation")), { code: "ENOENT" });
const identity = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value
  : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : undefined;
const index = (value: unknown): bigint | undefined => {
  const raw = identity(value);
  return raw && /^\d+$/.test(raw) ? BigInt(raw) : undefined;
};
const timestamp = (value: unknown): string | undefined => {
  const raw = identity(value);
  return raw && /^\d{10}$/.test(raw) ? new Date(Number(raw) * 1_000).toISOString() : undefined;
};

/** 每个值都是聚合响应；未知响应不能当作一份有效的空目录。 */
function conversations(records: CacheRecord[]): Conversation[] {
  const found = new Map<string, Conversation>();
  for (const record of records) {
    if (!record.account) throw invalid();
    const body = object(object(record.value.downlink_body).pull_recent_conv_chain_downlink_body);
    if (!Array.isArray(body.cells)) throw invalid();
    for (const cellValue of body.cells) {
      const value = object(object(cellValue).conversation);
      const id = identity(value.conversation_id);
      if (!id || value.messages !== undefined && !Array.isArray(value.messages)) throw invalid();
      const selector = JSON.stringify([record.account, id]);
      const previous = found.get(selector);
      if (previous && JSON.stringify(previous.value) !== JSON.stringify(value)) throw invalid();
      found.set(selector, { account: record.account, value, selector });
    }
  }
  return [...found.values()];
}

function sourceLocation(location: SourceLocation, conversation: Conversation): SourceLocation {
  const { adapterGap: _adapterGap, sourceCompleteness: _sourceCompleteness, ...base } = location;
  return { ...base, format: DOUBAO_WORK_FORMAT, selector: conversation.selector, sessionId: conversation.selector,
    sourceId: normalizedSessionKey(location.client, conversation.selector) };
}

async function discoverFile(location: SourceLocation): Promise<SourceLocation[]> {
  const cache = await readDoubaoWorkCache(location.path);
  return conversations(cache.records).map(conversation => {
    const messages = conversation.value.messages as unknown[] | undefined;
    return { ...sourceLocation(location, conversation), sourceCompleteness: {
      // 这里只比较投影中的消息数量，不表示已确认完整的远端历史。
      version: messages?.length ?? 0, supported: true, complete: Boolean(messages?.length),
      fingerprint: normalizedHash(JSON.stringify(conversation.value)),
    } };
  });
}

function selectSources(locations: SourceLocation[]): SourceLocation[] {
  const selected = new Map<string, SourceLocation>();
  for (const location of locations) {
    if (location.format !== DOUBAO_WORK_FORMAT) continue;
    const key = location.sourceId ?? JSON.stringify([location.client, location.selector]);
    const previous = selected.get(key);
    if (!previous) { selected.set(key, location); continue; }
    const count = (source: SourceLocation) => source.sourceCompleteness?.version ?? 0;
    const preferred = count(location) > count(previous) || count(location) === count(previous) && location.path.localeCompare(previous.path) < 0
      ? location : previous;
    const differentMessages = count(previous) > 0 && count(location) > 0
      && previous.sourceCompleteness?.fingerprint !== location.sourceCompleteness?.fingerprint;
    if (differentMessages || previous.adapterGap || location.adapterGap) preferred.adapterGap = {
      kind: "ambiguous", message: "豆包工作同会话缓存投影不同，选择消息较多的单一来源，未拼接不一致快照",
      messageDescriptor: descriptor("projectionConflict"),
    };
    selected.set(key, preferred);
  }
  return locations.filter(location => location.format !== DOUBAO_WORK_FORMAT).concat([...selected.values()]);
}

function addGap(gaps: Gap[], key: string, message: string, kind: Gap["kind"] = "unsupported_format"): void {
  if (!gaps.some(gap => gap.messageDescriptor?.key === descriptor(key).key)) gaps.push({ kind, message, messageDescriptor: descriptor(key) });
}

function messageRecords(conversation: Conversation, meta: NormalizedSessionMetadata): { records: RawHistoryRecord[]; cwd?: string } {
  const gaps = meta.gaps ?? (meta.gaps = []);
  const original = (conversation.value.messages as unknown[] | undefined) ?? [];
  const byId = new Map<string, Record<string, unknown>>();
  const ordered = original.map((value, position) => {
    const message = object(value);
    const id = identity(message.message_id);
    if (!id) throw invalid();
    if (byId.has(id)) throw invalid();
    byId.set(id, message);
    return { message, id, position, index: index(message.index_in_conv) };
  });
  const indices = new Set(ordered.map(value => value.index));
  if (ordered.some(value => value.index === undefined) || indices.size !== ordered.length) {
    addGap(gaps, "messageOrder", "豆包工作消息缺少唯一原生顺序，保留缓存排列并标记顺序缺口", "ambiguous");
  } else ordered.sort((left, right) => left.index! < right.index! ? -1 : left.index! > right.index! ? 1 : 0);

  const { messages: _messages, ...conversationMetadata } = conversation.value;
  const records: RawHistoryRecord[] = [];
  const workspaces = new Set<string>();
  for (const [messagePosition, item] of ordered.entries()) {
    const message = item.message;
    const ext = object(message.ext);
    const clientOption = object(object(ext.general_task_param).client_option);
    const workspace = normalizeHistoryPath(string(clientOption.workspace));
    if (workspace && isAbsolute(workspace)) workspaces.add(workspace);
    const raw = JSON.stringify({ conversation: conversationMetadata, message });
    const line = messagePosition + 1;
    const occurredAt = timestamp(message.create_time);
    const isUser = message.user_type === 1;
    const isAssistant = message.user_type === 2;
    const reply = identity(message.bot_reply_message_id);
    const target = reply ? byId.get(reply) : undefined;
    const linked = isAssistant && target?.user_type === 1 && index(target.index_in_conv) !== undefined && item.index !== undefined
      && index(target.index_in_conv)! < item.index;
    const turnKey = isUser ? item.id : linked ? reply : undefined;
    if (isAssistant && !linked) addGap(gaps, "replyMissing", "豆包工作回复缺少可核验的用户消息关联，未推定完整轮次", "ambiguous");
    if (!isUser && !isAssistant) addGap(gaps, "unknownRole", "豆包工作包含尚未适配的消息角色，按上下文保留");
    if (ext.context_window_usage !== undefined || ext.commerce_model_data_v1 !== undefined || ext.commerce_usage_data_v1 !== undefined
      || ext.tea_tags_time_cost !== undefined || ext.perf_mark !== undefined) {
      addGap(gaps, "measurementUnknown", "豆包工作上下文占用、显示计量及首包字段未核验为请求用量或首 Token，未计入请求统计");
    }
    const blocks = Array.isArray(message.content_block) ? message.content_block.map(object) : [];
    const blockById = new Map<string, Record<string, unknown>>();
    for (const block of blocks) {
      const id = identity(block.block_id);
      if (!id || blockById.has(id)) throw invalid();
      blockById.set(id, block);
    }
    const underThinking = (block: Record<string, unknown>): boolean => {
      const seen = new Set<string>();
      let parent = identity(block.parent_id);
      let thinking = false;
      while (parent && parent !== "0") {
        if (seen.has(parent) || !blockById.has(parent)) {
          addGap(gaps, "blockParent", "豆包工作内容块父关系缺失或成环，未猜测过程层级", "ambiguous");
          return false;
        }
        seen.add(parent);
        const value = blockById.get(parent)!;
        if (value.block_type === 10040) thinking = true;
        parent = identity(value.parent_id);
      }
      return thinking;
    };
    const emit = (suffix: string, event: Omit<NormalizedEvent, "key">) => records.push(normalizedRecord({
      key: `${item.id}:${suffix}`, occurredAt, turnKey, allowInferredFinal: false,
      nativeOrdinal: item.index !== undefined && item.index <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(item.index) : undefined,
      nativeIdentityHash: normalizedHash(JSON.stringify([item.id, suffix])), ...event,
    }, raw, line));
    for (const block of blocks) {
      const id = identity(block.block_id)!;
      const content = object(block.content);
      const text = string(object(content.text_block).text);
      const thinking = underThinking(block);
      if (block.block_type === 10000 && text !== undefined) {
        emit(id, { kind: isUser ? "user" : isAssistant ? thinking ? "thinking" : "assistant" : "context", text });
      } else if (block.block_type === 10040 && content.thinking_block !== undefined) {
        const container = object(content.thinking_block);
        emit(id, { kind: "context", text: string(container.finish_title) ?? string(container.streaming_title) ?? "" });
      } else if (block.block_type === 10019 && content.file_operation_block !== undefined) {
        const card = object(content.file_operation_block);
        const header = object(card.header);
        const path = string(card.path);
        emit(id, { kind: "context", text: [string(header.summary) ?? string(header.name), path, string(card.content)]
          .filter(value => value !== undefined && value !== "").join("\n"), filePaths: path && isAbsolute(path) ? [path] : undefined });
        addGap(gaps, "fileCardUnknown", "豆包工作文件卡片缺少已核验的工具身份、成功状态和范围，未计为成功调用或精确代码覆盖");
      } else if (block.block_type === 10063 && content.local_file_block !== undefined) {
        const file = object(content.local_file_block);
        const path = string(file.path);
        emit(id, { kind: isUser ? "user" : "context", text: [string(file.name), path ?? string(file.uri)].filter(Boolean).join("\n"),
          filePaths: path && isAbsolute(path) ? [path] : undefined });
      } else {
        emit(id, { kind: "context", text: JSON.stringify(block, null, 2) });
        addGap(gaps, "unknownBlock", "豆包工作存在尚未适配的内容块，保留原始结构供查看");
      }
    }
    if (!blocks.length) {
      const content = string(message.content);
      emit("message", { kind: isUser ? "user" : isAssistant ? "assistant" : "context", text: content ?? "" });
      addGap(gaps, "messageWithoutBlocks", "豆包工作消息缺少已核验的内容块，保留原始内容并标记格式缺口");
    }
  }
  if (workspaces.size > 1) addGap(gaps, "workspaceConflict", "豆包工作缓存记录多个工作目录，未选择单一项目归属", "ambiguous");
  return { records, cwd: workspaces.size === 1 ? [...workspaces][0] : undefined };
}

async function readSnapshot(location: SourceLocation): Promise<NormalizedSnapshot> {
  if (!location.selector) throw new DiagnosticError("豆包工作来源缺少账号与会话选择器", descriptor("missingSelector"));
  try {
    const selected: unknown = JSON.parse(location.selector);
    if (!Array.isArray(selected) || selected.length !== 2 || selected.some(value => typeof value !== "string" || !value)) throw invalid();
  } catch { throw new DiagnosticError("豆包工作来源选择器无效", descriptor("invalidSelector")); }
  const cache = await readDoubaoWorkCache(location.path);
  const conversation = conversations(cache.records).find(value => value.selector === location.selector);
  if (!conversation) throw missing();
  const meta: NormalizedSessionMetadata = { title: string(conversation.value.name), gaps: [{ kind: "unsupported_format",
    message: "豆包工作来源为本机会话缓存，未保证完整历史或新增任务持续落盘", messageDescriptor: descriptor("cacheOnly") }] };
  if (location.adapterGap) meta.gaps!.push(location.adapterGap);
  const built = messageRecords(conversation, meta);
  const source = { ...sourceLocation(location, conversation), cwd: built.cwd };
  return normalizedSnapshot(source, built.records, meta, JSON.stringify(conversation.value));
}

export const doubaoWorkAdapter = createNormalizedAdapter({ id: DOUBAO_WORK_FORMAT, discoverFile, selectSources, readSnapshot });
