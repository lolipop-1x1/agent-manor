import { createHash } from "node:crypto";
import type { KnowledgeConversation, KnowledgeExtractionScope, KnowledgeInputMessage, KnowledgeSource, KnowledgeSourceReader, KnowledgeTarget } from "../knowledge-contracts.js";
import type { SessionMessage, SessionSearchScope } from "../session-contracts.js";
import { SessionStore } from "../sessions/store.js";
import { knowledgeLimitations } from "./diagnostics.js";

export const knowledgeMessageHash = (message: SessionMessage): string => createHash("sha256").update(JSON.stringify({
  id: message.id, turnId: message.turnId, kind: message.kind, text: message.text,
  callId: message.callId, tool: message.tool, status: message.status,
})).digest("hex");

/** 通过完整过程读取正文；界面摘要、问题预览和模型压缩窗口均不代替历史记录。 */
export class SessionKnowledgeReader implements KnowledgeSourceReader {
  constructor(private readonly sessions: SessionStore) {}

  private conversation(sessionId: string, version: string, branch: string): KnowledgeConversation {
    const messages: KnowledgeInputMessage[] = [];
    let page = 1;
    let session: KnowledgeConversation["session"] | undefined;
    for (;;) {
      let offset = 0;
      let lastPage = true;
      for (;;) {
        const result = this.sessions.messages(sessionId, { version, mode: "full", branch, pageUnit: "turn", page,
          pageSize: 20, messageLimit: 500, messageOffset: offset });
        session = result.session;
        const positions = new Map(result.turns?.map(turn => [turn.id, turn.position]));
        for (const message of result.messages) {
          if (message.textTruncated) throw new Error("Knowledge input is truncated; preview must be rebuilt");
          messages.push({ ...message, turnPosition: positions.get(message.turnId) ?? 0, hash: knowledgeMessageHash(message), target: true });
        }
        lastPage = page * 20 >= (result.totalTurns ?? 0);
        if (!result.hasMoreMessages) break;
        if (!result.messages.length) throw new Error("Incomplete knowledge input page");
        offset += result.messages.length;
      }
      if (lastPage) break;
      page += 1;
    }
    const limitationDetails = knowledgeLimitations([], session!.gaps.map(gap => ({ message: gap.message, messageDescriptor: gap.messageDescriptor })));
    if (messages.some(message => message.kind === "compression") && !messages.some(message => message.kind === "user" && !message.contextSource)) {
      limitationDetails.push({ message: "Only compressed context is available; original actions cannot be verified.", messageDescriptor: { key: "knowledge.limitation.compressedOnly" } });
    }
    return { session: session!, version, branch, messages, limitations: limitationDetails.map(detail => detail.message), limitationDetails };
  }

  async plan(scope: KnowledgeExtractionScope): Promise<KnowledgeTarget[]> {
    const version = this.sessions.currentVersion();
    if (!version) return [];
    const from = scope.from ?? (scope.timeRange === "recent" ? new Date(Date.now() - scope.recentDays * 86_400_000).toISOString() : undefined);
    const until = scope.to;
    const queryScope: SessionSearchScope = { ...scope, branch: scope.branch === "all" ? "all" : "current", from, to: until };
    const targets: KnowledgeTarget[] = [];
    const selected = scope.sessionIds?.length ? new Set(scope.sessionIds) : undefined;
    for (let page = 1; ; page += 1) {
      const result = this.sessions.list({ version, scope: queryScope, page, pageSize: 100 });
      for (const session of result.sessions) {
        if (selected && !selected.has(session.id)) continue;
        const branches = scope.branch === "all" && session.branches?.length
          ? session.branches.map(branch => branch.id) : [scope.branch ?? "current"];
        const sharedEvents = new Set<string>();
        for (const branch of branches) {
          const input = this.conversation(session.id, version, branch);
          const turnTimes = new Map<string, string>();
          for (const message of input.messages) if (message.occurredAt && !turnTimes.has(message.turnId)) turnTimes.set(message.turnId, message.occurredAt);
          const selectedMessages = input.messages.filter(message => {
            if (message.copied || message.contextSource || message.turnPosition === 0) return false;
            if (scope.turnStart !== undefined && message.turnPosition < scope.turnStart) return false;
            if (scope.turnEnd !== undefined && message.turnPosition > scope.turnEnd) return false;
            const time = message.occurredAt ?? turnTimes.get(message.turnId);
            if ((from || until) && (!time || !Number.isFinite(Date.parse(time)))) return false;
            return (!from || Date.parse(time!) >= Date.parse(from)) && (!until || Date.parse(time!) <= Date.parse(until));
          }).filter(message => {
            if (scope.branch !== "all") return true;
            const identity = `${message.id}:${message.hash}`;
            if (sharedEvents.has(identity)) return false;
            sharedEvents.add(identity);
            return true;
          });
          if (!selectedMessages.length) continue;
          const lastOrdinal = selectedMessages.reduce((maximum, message) => Math.max(maximum, message.ordinal), -Infinity);
          const selectedIds = new Set(selectedMessages.map(message => message.id));
          const context = input.messages.filter(message => message.ordinal <= lastOrdinal && !selectedIds.has(message.id));
          const limitations = [...input.limitations];
          const limitationDetails = [...(input.limitationDetails ?? [])];
          const activity = [session.updatedAt, ...input.messages.flatMap(message => [message.occurredAt, message.finishedAt, message.finalAt])]
            .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)))
            .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
          if ((from || until) && input.messages.some(message => !message.occurredAt && !turnTimes.has(message.turnId))) {
            const message = "Messages without recorded time were not included in the selected time window.";
            limitations.push(message); limitationDetails.push({ message, messageDescriptor: { key: "knowledge.limitation.missingTime" } });
          }
          targets.push({ sessionId: session.id, title: session.title, client: session.client, project: session.project, updatedAt: activity, version, branch,
            messageIds: selectedMessages.map(message => message.id), hashes: selectedMessages.map(message => message.hash),
            turnCount: new Set(selectedMessages.map(message => message.turnId)).size,
            inputTokens: selectedMessages.reduce((sum, message) => sum + Buffer.byteLength(message.text, "utf8"), 0),
            contextTokens: context.reduce((sum, message) => sum + Buffer.byteLength(message.text, "utf8"), 0), limitations, limitationDetails });
        }
      }
      if (page * result.pageSize >= result.total) break;
    }
    if (selected && [...selected].some(id => !targets.some(target => target.sessionId === id))) {
      // 空目标可以是没有窗口内消息；不扩张为整会话处理。
      return targets;
    }
    return targets;
  }

  async read(target: KnowledgeTarget): Promise<KnowledgeConversation> {
    const input = this.conversation(target.sessionId, target.version, target.branch);
    const byId = new Map(input.messages.map(message => [message.id, message]));
    for (const [index, id] of target.messageIds.entries()) {
      if (!byId.has(id) || byId.get(id)!.hash !== target.hashes[index]) throw new Error("Knowledge source changed; preview must be rebuilt");
    }
    const selected = new Set(target.messageIds);
    const end = target.messageIds.reduce((maximum, id) => Math.max(maximum, byId.get(id)!.ordinal), -Infinity);
    input.messages = input.messages.filter(message => message.ordinal <= end).map(message => ({ ...message, target: selected.has(message.id) }));
    input.limitations = [...new Set([...input.limitations, ...target.limitations])];
    input.limitationDetails = knowledgeLimitations(input.limitations, [...(input.limitationDetails ?? []), ...(target.limitationDetails ?? [])]);
    return input;
  }

  async verify(source: KnowledgeSource): Promise<KnowledgeSource> {
    if (!source.sessionId || !source.messageId) return source;
    const versions = [...new Set([source.sourceVersion, this.sessions.currentVersion()].filter((version): version is string => Boolean(version)))];
    for (const version of versions) {
      try {
        const result = this.sessions.messages(source.sessionId, { version, mode: "full", branch: source.branch ?? "current", messageId: source.messageId, pageSize: 1 });
        const message = result.messages.find(item => item.id === source.messageId);
        if (!message) continue;
        return { ...source, status: source.hash && knowledgeMessageHash(message) === source.hash ? "available" : "changed",
          currentVersion: version };
      } catch { /* 原发布版本可被清理，继续按消息身份和内容哈希核验当前版本。 */ }
    }
    return { ...source, status: "missing" };
  }
}
