import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Baseline, Client, EvidenceFragment, Gap, HistoryEvent, ParsedSource, SourceReference } from "../contracts.js";
import { PARSER_RULE_VERSION } from "../version.js";
import { json, object, returnedText, string, words } from "./extraction.js";
import { normalizeHistoryPath } from "./adapters/common.js";
import { HISTORY_CLIENTS, historyAdapter, historyClient } from "./adapters/index.js";
import type { HistoryAdapterContext, HistoryClient } from "./adapters/types.js";

import type { DiscoverRoots, HistoricalWorktree, HistoryCursor, HistoryRelationship, ParsedHistorySource, PendingCall, SharedHistoryResult, SourceAssociation, SourceLocation } from "./types.js";

export { normalizeHistoryPath } from "./adapters/common.js";

export type { DiscoverRoots, HistoryRelationship, ParsedHistorySource, SharedHistoryResult, SourceAssociation, SourceLocation } from "./types.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const git = promisify(execFile);

/** 发现只读至多 64 KiB 的头部；正文留给已选来源的 parseSource。 */
export async function discoverSources(roots: DiscoverRoots = {}): Promise<SourceLocation[]> {
  const found: SourceLocation[] = [];
  const paths = new Set<string>();
  async function walk(path: string, declaration: HistoryClient): Promise<void> {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if (object(error).code === "ENOENT") return; throw error; }
    const adapter = historyAdapter(declaration.format);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child, declaration);
      else if (entry.isFile() && (declaration.acceptsFile?.(child) ?? entry.name.endsWith(".jsonl")) && !paths.has(child)) {
        paths.add(child);
        let metadata: SourceLocation = { path: child, client: declaration.client, format: declaration.format };
        if (adapter) {
          const handle = await open(child, "r");
          try {
            const buffer = Buffer.alloc(65_536);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n").slice(0, 32)) {
              try {
                const candidate = adapter.discover(object(JSON.parse(line)), metadata);
                if (candidate) { metadata = candidate.source; if (candidate.complete) break; }
              } catch { /* 发现阶段不把坏行误认为有效元数据。 */ }
            }
          } finally { await handle.close(); }
        }
        found.push(metadata);
      }
    }
  }
  for (const declaration of HISTORY_CLIENTS) {
    const environment = process.env[declaration.environmentVariable];
    const configured = roots[declaration.client] ?? (environment ? [environment] : declaration.defaultRoots.map(path => join(homedir(), path)));
    for (const root of typeof configured === "string" ? [configured] : configured) await walk(resolve(root), declaration);
  }
  return found;
}

function cursorOf(source: ParsedSource | undefined): HistoryCursor | undefined {
  const cursor = object(source?.cursor);
  if (cursor.ruleVersion !== PARSER_RULE_VERSION || typeof cursor.prefixHash !== "string" || !Array.isArray(cursor.pending)
    || !Array.isArray(cursor.recordEnds) || !Array.isArray(cursor.relationships)) return undefined;
  return cursor as unknown as HistoryCursor;
}

/** prefixHash 验证完整旧前缀后只解析追加记录；尾部不完整 JSONL 保留至下一轮。 */
export async function parseSource(path: string, client: Client, previous?: ParsedSource, format = historyClient(client).format): Promise<ParsedHistorySource> {
  const absolutePath = resolve(path);
  const adapter = historyAdapter(format);
  const bytes = await readFile(absolutePath);
  const oldCursor = cursorOf(previous);
  const appended = oldCursor && oldCursor.format === format && previous?.client === client && bytes.length >= oldCursor.completeBytes
    && hash(bytes.subarray(0, oldCursor.completeBytes)) === oldCursor.prefixHash;
  const cursor: HistoryCursor = appended ? structuredClone(oldCursor) : {
    ruleVersion: PARSER_RULE_VERSION, format, prefixHash: hash(""), completeBytes: 0, recordLine: 0,
    pending: [], seen: {}, occurrences: {}, recordEnds: [], relationships: [], parsedRecords: 0,
  };
  cursor.parsedRecords = 0;
  const source: ParsedHistorySource = appended && previous ? {
    ...structuredClone(previous), path: absolutePath, hash: hash(bytes), relationships: cursor.relationships,
    gaps: previous.gaps.filter((gap) => !["unpaired_call", "incomplete_record"].includes(gap.kind)),
  } : { sourceId: `${client}:unidentified:${hash(absolutePath).slice(0, 24)}`, client, format, path: absolutePath, hash: hash(bytes), sessionId: `unknown:${hash(absolutePath).slice(0, 16)}`, events: [], gaps: [], completeBytes: 0, relationships: [] };
  for (const event of source.events) for (const reference of event.sources) reference.path = absolutePath;
  const eventById = new Map(source.events.map((event) => [event.id, event]));
  const gap = (kind: Gap["kind"], message: string) => source.gaps.push({ kind, message, sourceId: source.sourceId });
  const reference = (recordLine: number, raw: string, callId?: string): SourceReference => ({ sourceId: source.sourceId, format, path: absolutePath, recordLine, hash: hash(raw), callId });
  const findEvent = (id: string) => eventById.get(id);
  let activeContext: HistoryAdapterContext;
  const identity = (key: string): string => {
    const occurrence = (cursor.occurrences[key] ?? 0) + 1;
    cursor.occurrences[key] = occurrence;
    return `${source.sourceId}:${hash(`${key}:${occurrence}`).slice(0, 24)}`;
  };
  function createEvent(tool: string, input: unknown, row: number, raw: string, occurredAt?: string, cwd?: string, key?: string): HistoryEvent {
    const extracted = adapter!.extract(tool, input, {}, "", activeContext)[0]!;
    const event: HistoryEvent = {
      id: identity(key ?? `${tool}:${row}:${hash(raw)}`), client, sessionId: source.sessionId, parentSessionId: source.parentSessionId,
      occurredAt, tool, kind: extracted.kind, status: "unknown", cwd: normalizeHistoryPath(cwd) ?? cursor.cwd ?? source.cwd,
      path: extracted.path, fragments: [], sources: [reference(row, raw)], input: json(input), reason: "调用结果尚未配对",
    };
    source.events.push(event);
    eventById.set(event.id, event);
    return event;
  }
  function finish(call: PendingCall, result: unknown, visible: string, status: HistoryEvent["status"], row: number, raw: string, reason?: string) {
    const event = findEvent(call.eventId);
    if (!event) return;
    const resultRef = reference(row, raw, call.callId);
    event.sources.push(resultRef);
    event.output = json({ result, visibleOutput: visible });
    event.status = status;
    if (adapter!.finalizeCall?.(activeContext, call, event, result, visible, row, raw)) return;
    const extracted = adapter!.extract(call.tool, call.input, result, visible, activeContext);
    extracted.forEach((evidence, index) => {
      const target = index === 0 ? event : { ...event, id: `${event.id}:file:${index}`, sources: [...event.sources] };
      target.kind = evidence.kind;
      target.path = evidence.path;
      target.fragments = status === "success" ? evidence.fragments : [];
      target.reason = reason ?? (status === "success" ? evidence.reason : status === "failure" ? "工具执行失败" : "未确认工具成功终态");
      if (index) source.events.push(target);
      if (target.reason?.startsWith("range_unknown:")) gap("range_unknown", target.reason);
      if (target.reason?.startsWith("unsupported_tool:")) gap("unsupported_tool", target.reason);
    });
  }
  function pair(callId: string, requestUuid?: string): PendingCall | undefined {
    const matching = cursor.pending.filter((call) => call.callId === callId && (!requestUuid || call.requestUuid === requestUuid));
    if (matching.length !== 1) {
      gap(matching.length ? "ambiguous" : "unpaired_call", matching.length ? `调用 ${callId} 有多个待配对出现位置` : `结果 ${callId} 没有请求`);
      return undefined;
    }
    const call = matching[0]!;
    cursor.pending = cursor.pending.filter((candidate) => candidate !== call);
    return call;
  }
  if (!adapter && !source.gaps.some(item => item.kind === "unsupported_format")) gap("unsupported_format", `历史格式 ${format} 尚未注册适配器`);
  let position = cursor.completeBytes;
  while (position < bytes.length) {
    const newline = bytes.indexOf(10, position);
    if (newline < 0) break;
    const raw = bytes.subarray(position, newline).toString("utf8");
    position = newline + 1;
    cursor.recordLine += 1;
    cursor.parsedRecords += 1;
    cursor.recordEnds.push(position);
    const row = cursor.recordLine;
    let record: Record<string, unknown>;
    try { record = object(JSON.parse(raw)); }
    catch { gap("parse_error", `物理记录 ${row} 不是有效 JSON`); continue; }
    if (adapter) {
      activeContext = { client, path: absolutePath, row, raw, occurredAt: string(record.timestamp), source, cursor,
        hash, gap, reference, findEvent, createEvent, finish, pair };
      adapter.processRecord(record, activeContext);
    }
  }
  cursor.completeBytes = position;
  cursor.prefixHash = hash(bytes.subarray(0, position));
  source.completeBytes = position;
  source.cursor = json(cursor);
  if (position < bytes.length) gap("incomplete_record", "末尾记录尚未以换行完成，等待下一轮补齐");
  for (const call of cursor.pending) gap("unpaired_call", `调用 ${call.callId} 的出现位置 ${call.recordLine} 尚无可确认结果`);
  return source;
}

function inside(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return candidate === "" || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate));
}

async function commonDir(path: string): Promise<string | undefined> {
  try {
    const result = await git("git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 5_000 });
    return canonicalPath(resolve(result.stdout.trim()));
  } catch { return undefined; }
}

export async function canonicalPath(path: string): Promise<string> {
  let ancestor = path;
  while (true) {
    try { return resolve(await realpath(ancestor), relative(ancestor, path)); }
    catch { const parent = dirname(ancestor); if (parent === ancestor) return resolve(path); ancestor = parent; }
  }
}

/** 只采用成功创建与完整 Git 清单交叉确认的历史关系，不执行历史命令。 */
export async function historicalWorktrees(events: HistoryEvent[], baseline: Baseline): Promise<HistoricalWorktree[]> {
  const root = await canonicalPath(baseline.repository.path);
  const repositoryCommonDir = await canonicalPath(baseline.repository.commonDir);
  const lists: { at: number; paths: string[]; event: HistoryEvent }[] = [];
  const creations: { at: number; cwd: string; path: string; event: HistoryEvent }[] = [];
  for (const event of new Map(events.map(event => [event.id, event])).values()) {
    if (event.tool !== "CommandExecution" || event.status !== "success") continue;
    const at = Date.parse(event.occurredAt ?? "");
    const cwd = normalizeHistoryPath(event.cwd);
    const command = object(event.input).command;
    const text = Array.isArray(command) && ["sh", "bash", "zsh", "dash"].includes(String(command[0]).split("/").at(-1) ?? "")
      && ["-c", "-lc"].includes(String(command.at(-2))) ? string(command.at(-1)) : undefined;
    const tokens = text ? words(text, true) : undefined;
    const output = returnedText(string(object(event.output).formatted_output) ?? "");
    if (!Number.isFinite(at) || !cwd || !isAbsolute(cwd) || !tokens?.length || output.truncated) continue;
    const parts: string[][] = [[]];
    for (const token of tokens) {
      if (token === "&&") parts.push([]);
      else parts.at(-1)!.push(token);
    }
    const commands: { cwd: string; args: string[] }[] = [];
    let valid = true;
    for (const [index, part] of parts.entries()) {
      if (index === 0 && parts.length > 1 && part[0] === "mkdir" && part[1] === "-p" && part.length > 2
        && part.slice(2).every(path => !path.startsWith("-") && path !== "|")) continue;
      if (!["git", "/usr/bin/git"].includes(part[0] ?? "")) { valid = false; break; }
      let working = cwd;
      let args = part.slice(1);
      if (args[0] === "-C" && args[1]) { working = resolve(cwd, args[1]); args = args.slice(2); }
      if (args[0] !== "worktree") { valid = false; break; }
      commands.push({ cwd: await canonicalPath(working), args: args.slice(1) });
    }
    if (!valid || !commands.length) continue;
    if (parts.length === 1 && commands[0]!.args.join(" ") === "list --porcelain" && output.content.endsWith("\n")) {
      const paths: string[] = [];
      for (const block of output.content.trim().split(/\n\n+/)) {
        const lines = block.split("\n");
        const path = lines[0]?.startsWith("worktree ") ? lines[0].slice(9) : undefined;
        if (!path || !isAbsolute(path) || !/^HEAD [a-f\d]{40}(?:[a-f\d]{24})?$/.test(lines[1] ?? "")
          || !lines.slice(2).some(line => line === "detached" || line.startsWith("branch refs/heads/"))
          || lines.slice(2).some(line => !/^(?:branch refs\/heads\/.+|detached|locked(?: .*)?|prunable(?: .*)?)$/.test(line))) { valid = false; break; }
        paths.push(await canonicalPath(path));
      }
      if (valid && paths.includes(root)) lists.push({ at, paths, event });
      continue;
    }
    const added: { cwd: string; path: string; branch: string }[] = [];
    for (const { cwd: working, args } of commands) {
      if (args[0] !== "add") { valid = false; break; }
      const operands: string[] = [];
      let branch: string | undefined;
      for (let index = 1; index < args.length; index++) {
        if (args[index] === "-b" && args[index + 1] && !branch) branch = args[++index];
        else if (args[index]!.startsWith("-") || args[index] === "|") { valid = false; break; }
        else operands.push(args[index]!);
      }
      if (!valid || !branch || !operands.length || operands.length > 2) { valid = false; break; }
      added.push({ cwd: working, path: await canonicalPath(resolve(working, operands[0]!)), branch });
    }
    const prepared = [...output.content.matchAll(/^Preparing worktree \(new branch '([^']+)'\)$/gm)].map(match => match[1]);
    const heads = [...output.content.matchAll(/^HEAD is now at [a-f\d]+ .+$/gm)];
    if (valid && prepared.length === added.length && heads.length === added.length && added.every(item => prepared.includes(item.branch))) {
      for (const item of added) creations.push({ at, cwd: item.cwd, path: item.path, event });
    }
  }
  const result: HistoricalWorktree[] = [];
  const live = new Map<string, boolean>();
  for (const creation of creations.sort((left, right) => left.at - right.at)) {
    const next = creations.find(item => item.path === creation.path && item.at > creation.at);
    const confirmation = lists.filter(list => list.at >= creation.at && (!next || list.at < next.at)
      && list.paths.includes(creation.path)).sort((left, right) => right.at - left.at)[0];
    if (!confirmation || (!inside(root, creation.cwd) && !result.some(tree => inside(tree.path, creation.cwd)
      && creation.at >= tree.from && creation.at <= tree.until))) continue;
    if (!live.has(creation.path)) {
      try {
        await lstat(creation.path);
        live.set(creation.path, await commonDir(creation.path) === repositoryCommonDir);
      } catch (error) { live.set(creation.path, object(error).code === "ENOENT"); }
    }
    if (!live.get(creation.path)) continue;
    result.push({ path: creation.path, from: creation.at, until: confirmation.at, sources: [...creation.event.sources, ...confirmation.event.sources] });
  }
  return result;
}

/** 仅映射实际属于基线的路径；历史 worktree 必须有对应时间的 Git 证据。 */
export async function associateSource(source: ParsedSource, baseline: Baseline, worktrees: HistoricalWorktree[] = []): Promise<SourceAssociation> {
  const parsed: ParsedHistorySource = { ...source, relationships: (source as ParsedHistorySource).relationships ?? cursorOf(source)?.relationships ?? [] };
  const events: HistoryEvent[] = [];
  const gaps: Gap[] = [];
  const root = await canonicalPath(resolve(baseline.repository.path));
  const repositoryCommonDir = await canonicalPath(resolve(baseline.repository.commonDir));
  const available = new Set(baseline.files.map((file) => file.path));
  const commonCache = new Map<string, string | undefined>();
  const worktreeRootCache = new Map<string, string>();
  async function relativePath(path: string | undefined, cwd: string | undefined, at: number, proof: SourceReference[]): Promise<string | undefined> {
    const normalized = normalizeHistoryPath(path);
    const working = normalizeHistoryPath(cwd);
    if (!normalized) return undefined;
    const rawAbsolute = isAbsolute(normalized) ? normalized : working && isAbsolute(working) ? resolve(working, normalized) : undefined;
    if (!rawAbsolute) return undefined;
    const absolute = await canonicalPath(rawAbsolute);
    if (inside(root, absolute)) return relative(root, absolute).split(sep).join("/");
    const historical = worktrees.find(tree => inside(tree.path, absolute) && at >= tree.from && at <= tree.until);
    if (historical) {
      proof.push(...historical.sources);
      return relative(historical.path, absolute).split(sep).join("/");
    }
    if (working && isAbsolute(working)) {
      if (!commonCache.has(working)) commonCache.set(working, await commonDir(working));
      if (commonCache.get(working) === repositoryCommonDir) {
        let worktreeRoot = worktreeRootCache.get(working);
        if (!worktreeRoot) {
          try { worktreeRoot = (await git("git", ["-C", working, "rev-parse", "--show-toplevel"], { timeout: 5_000 })).stdout.trim(); } catch { return undefined; }
          if (worktreeRoot) {
            worktreeRoot = await canonicalPath(worktreeRoot);
            worktreeRootCache.set(working, worktreeRoot);
          }
        }
        if (worktreeRoot && inside(worktreeRoot, absolute)) return relative(worktreeRoot, absolute).split(sep).join("/");
      }
    }
    return undefined;
  }
  for (const event of source.events) {
    if (!event.path) {
      const cwd = normalizeHistoryPath(event.cwd ?? source.cwd);
      if (cwd && isAbsolute(cwd) && inside(root, await canonicalPath(cwd))) events.push({ ...event, fragments: [] });
      continue;
    }
    const proof: SourceReference[] = [];
    const at = Date.parse(event.occurredAt ?? "");
    const path = await relativePath(event.path, event.cwd ?? source.cwd, at, proof);
    if (path === undefined) continue;
    const fragments: EvidenceFragment[] = [];
    for (const fragment of event.fragments) {
      const fragmentPath = fragment.path ? await relativePath(fragment.path, event.cwd ?? source.cwd, at, proof) : path;
      if (fragmentPath !== undefined) fragments.push({ ...fragment, path: fragmentPath });
    }
    const sources = [...new Map([...event.sources, ...proof].map(reference => [JSON.stringify(reference), reference])).values()];
    events.push({ ...event, path, fragments, sources });
    if (!available.has(path)) gaps.push({ kind: "range_unknown", message: `历史文件 ${path} 不在当前仓库基线中`, sourceId: source.sourceId });
  }
  const cwd = normalizeHistoryPath(source.cwd);
  const belongsByCwd = Boolean(cwd && isAbsolute(cwd) && inside(root, await canonicalPath(cwd)));
  const associated = events.length > 0 || belongsByCwd;
  if (!associated) gaps.push({ kind: "unassociated", message: "来源工作目录与逐事件路径无法可靠归属仓库", sourceId: source.sourceId });
  return { associated, source: parsed, events, gaps, reason: events.length ? "逐事件路径或 Git commonDir 确认" : belongsByCwd ? "来源 cwd 属于仓库，外部路径活动已排除" : "归属未知" };
}

/** 只有明确 fork 来源与完整父字节边界能证明共享历史；文本相同不去重。 */
export function resolveSharedHistory(sources: ParsedSource[]): SharedHistoryResult {
  const bySession = new Map<string, ParsedSource[]>();
  for (const source of sources) bySession.set(source.sessionId, [...(bySession.get(source.sessionId) ?? []), source]);
  const events = new Map<string, HistoryEvent>();
  const gaps: Gap[] = [];
  const relationships: SharedHistoryResult["relationships"] = [];
  const identities = new Map<ParsedSource, Map<string, string>>();
  function eventIdentity(source: ParsedSource, event: HistoryEvent): string | undefined {
    if (!identities.has(source)) {
      identities.set(source, new Map(Object.entries(cursorOf(source)?.seen ?? {}).filter(([key]) => key.startsWith("concrete:") || key.startsWith("request:")).map(([key, id]) => [id, key])));
    }
    return identities.get(source)!.get(event.id.replace(/:file:\d+$/, ""));
  }
  for (const source of sources) {
    const cursor = cursorOf(source);
    const resolvedRelationships = historyAdapter(source.format ?? historyClient(source.client).format)?.resolveRelationships?.(source, sources);
    const shared = [...((source as ParsedHistorySource).relationships ?? cursor?.relationships ?? []), ...(resolvedRelationships?.relationships ?? [])];
    gaps.push(...(resolvedRelationships?.gaps ?? []));
    const parentProofs: SourceReference[] = [];
    const relatedParents = new Set<string>();
    const copied = new Map<string, { event: HistoryEvent; identity?: string }>();
    for (const relationship of shared) {
      const parents = (bySession.get(relationship.parentSessionId) ?? []).filter(parent => parent.client === source.client);
      const parent = parents.find((candidate) => relationship.endByteOffset !== undefined && cursorOf(candidate)?.recordEnds.includes(relationship.endByteOffset));
      const resolved = relationship.kind === "subagent" ? parents.length > 0 : Boolean(parent);
      relationships.push({ sourceId: source.sourceId, relationship, resolved });
      if (resolved && relationship.kind === "subagent") {
        relatedParents.add(relationship.parentSessionId);
        parentProofs.push(...(relationship.sources ?? []));
      }
      if (!resolved) gaps.push({ kind: parents.length ? "ambiguous" : "source_missing", sourceId: source.sourceId, message: relationship.kind === "fork" ? "fork 父来源缺失或引用字节位置不是完整记录边界；未重造共享调用" : "子会话父来源缺失" });
      if (parent && relationship.kind === "fork") {
        const endRow = cursorOf(parent)!.recordEnds.indexOf(relationship.endByteOffset!) + 1;
        for (const event of parent.events) {
          const parentRefs = event.sources.filter((reference) => reference.sourceId === parent.sourceId);
          if (parentRefs.length && parentRefs.every((reference) => reference.recordLine <= endRow)) {
            const proof = [...new Set(parentRefs.map((reference) => reference.hash))].sort().join(":");
            copied.set(proof, { event, identity: eventIdentity(parent, event) });
            mergeEvent(events, event, gaps);
          }
        }
      }
    }
    if (relatedParents.size > 1) gaps.push({ kind: "ambiguous", sourceId: source.sourceId, message: "子会话存在多个已解析父身份，未选择父关系" });
    for (const event of source.events) {
      const proof = [...new Set(event.sources.filter((reference) => reference.sourceId === source.sourceId).map((reference) => reference.hash))].sort().join(":");
      const candidate = copied.get(proof);
      const identity = candidate ? eventIdentity(source, event) : undefined;
      const original = candidate?.identity && identity === candidate.identity ? candidate.event : undefined;
      if (candidate && !original) gaps.push({ kind: "ambiguous", sourceId: source.sourceId, message: "fork 记录内容相同但缺少可确认的原事件身份，未按文本去重" });
      const related = relatedParents.size === 1 ? { ...event, parentSessionId: [...relatedParents][0],
        sources: [...new Map([...event.sources, ...parentProofs].map(reference => [JSON.stringify(reference), reference])).values()] } : event;
      mergeEvent(events, original ? { ...related, id: original.id, sessionId: original.sessionId } : related, gaps);
    }
  }
  return { events: [...events.values()], gaps, relationships };
}

function mergeEvent(events: Map<string, HistoryEvent>, event: HistoryEvent, gaps: Gap[]) {
  const existing = events.get(event.id);
  if (!existing) { events.set(event.id, structuredClone(event)); return; }
  const seen = new Set(existing.sources.map((reference) => `${reference.path}:${reference.recordLine}:${reference.hash}`));
  if (existing.status === "unknown" && event.status !== "unknown") {
    existing.status = event.status;
    existing.fragments = structuredClone(event.fragments);
    existing.output = event.output;
    existing.reason = event.reason;
  } else if (existing.status !== "unknown" && event.status !== "unknown" && existing.status !== event.status) {
    existing.status = "unknown";
    existing.fragments = [];
    existing.reason = "ambiguous: 同一事件身份存在相互矛盾的成功与失败结果";
    gaps.push({ kind: "ambiguous", message: existing.reason });
  }
  for (const reference of event.sources) {
    const key = `${reference.path}:${reference.recordLine}:${reference.hash}`;
    if (!seen.has(key)) { existing.sources.push(reference); seen.add(key); }
  }
}
