import type { MessageDescriptor } from "../i18n/types.js";
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
import { HISTORY_ADAPTERS, HISTORY_CLIENTS, historyAdapter, historyClient } from "./adapters/index.js";
import type { HistoryAdapterContext, HistoryClient } from "./adapters/types.js";
import { sourceQuickCheck, sourceQuickStamp } from "./quick-check.js";

import type { DiscoverOptions, DiscoverRoots, HistoricalWorktree, HistoryCursor, HistoryRelationship, ParsedHistorySource, PendingCall, SharedHistoryResult, SourceAssociation, SourceLocation } from "./types.js";

export { normalizeHistoryPath } from "./adapters/common.js";

export type { DiscoverOptions, DiscoverRoots, HistoryRelationship, ParsedHistorySource, SharedHistoryResult, SourceAssociation, SourceLocation } from "./types.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const git = promisify(execFile);

/** 发现只读至多 64 KiB 的头部；正文留给已选来源的 parseSource。 */
export async function discoverSources(roots: DiscoverRoots = {}, options: DiscoverOptions = {}): Promise<SourceLocation[]> {
  const found: SourceLocation[] = [];
  const paths = new Set<string>();
  const selected = options.clients ? new Set(options.clients) : undefined;
  const cachedByFile = new Map<string, NonNullable<DiscoverOptions["cachedSources"]>[number][]>();
  const cacheKey = (client: Client, format: string, path: string) => JSON.stringify([client, format, resolve(path)]);
  for (const cached of options.cachedSources ?? []) {
    const format = cached.location.format ?? historyClient(cached.location.client).format;
    const key = cacheKey(cached.location.client, format, cached.location.path);
    cachedByFile.set(key, [...(cachedByFile.get(key) ?? []), cached]);
  }
  async function reuseDiscovery(path: string, client: Client, format: string): Promise<boolean> {
    const cached = cachedByFile.get(cacheKey(client, format, path));
    if (!cached?.length) return false;
    for (const value of cached) {
      const stamp = await sourceQuickStamp(value.location);
      if (!stamp || stamp !== value.stamp) return false;
    }
    found.push(...cached.map(value => ({ ...structuredClone(value.location), discoveryQuickStamp: value.stamp })));
    return true;
  }
  async function discoverFile(location: SourceLocation, read: () => Promise<SourceLocation[]>): Promise<void> {
    const before = await sourceQuickCheck(location);
    const sources = await read();
    for (const source of sources) {
      const after = before && await sourceQuickCheck(source);
      // 标记覆盖头部和旁路读取；其间变化不能把旧元信息绑定到新依赖标记。
      found.push({ ...source, discoveryQuickStamp: before && after?.dependencies === before.dependencies ? after.stamp : undefined });
    }
  }
  async function walk(path: string, declaration: HistoryClient): Promise<void> {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if (object(error).code === "ENOENT") return; throw error; }
    const adapter = historyAdapter(declaration.format);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child, declaration);
      else if (entry.isFile() && declaration.acceptsContainer?.(child) && !paths.has(child)) {
        paths.add(child);
        if (await reuseDiscovery(child, declaration.client, declaration.containerFormat!)) continue;
        const container = historyAdapter(declaration.containerFormat!);
        const location = { path: child, client: declaration.client, format: declaration.containerFormat };
        await discoverFile(location, () => container!.discoverFile!(location));
      }
      else if (entry.isFile() && (declaration.acceptsFile?.(child) ?? entry.name.endsWith(".jsonl")) && !paths.has(child)) {
        paths.add(child);
        if (await reuseDiscovery(child, declaration.client, declaration.format)) continue;
        const location = { path: child, client: declaration.client, format: declaration.format };
        if (adapter?.discoverFile) {
          await discoverFile(location, () => adapter.discoverFile!(location));
          continue;
        }
        await discoverFile(location, async () => {
          let metadata: SourceLocation = location;
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
          return [await adapter?.readSourceMetadata?.(metadata) ?? metadata];
        });
      }
    }
  }
  for (const declaration of HISTORY_CLIENTS) {
    if (selected && !selected.has(declaration.client)) continue;
    const environment = process.env[declaration.environmentVariable];
    const clientHome = declaration.homeEnvironmentVariable ? process.env[declaration.homeEnvironmentVariable] : undefined;
    const configured = roots[declaration.client] ?? (environment ? [environment] : declaration.resolveNativeRoots ? declaration.resolveNativeRoots(homedir(), process.env)
      : clientHome ? [join(clientHome, "sessions"), ...declaration.defaultRoots.slice(1).map(path => join(homedir(), path))] : declaration.defaultRoots.map(path => join(homedir(), path)));
    for (const root of typeof configured === "string" ? [configured] : configured) await walk(resolve(root), declaration);
  }
  return HISTORY_ADAPTERS.reduce((sources, adapter) => adapter.selectSources?.(sources) ?? sources, found);
}

function cursorOf(source: ParsedSource | undefined): HistoryCursor | undefined {
  const cursor = object(source?.cursor);
  if (cursor.ruleVersion !== PARSER_RULE_VERSION || typeof cursor.prefixHash !== "string" || !Array.isArray(cursor.pending)
    || !Array.isArray(cursor.recordEnds) || !Array.isArray(cursor.relationships)) return undefined;
  return cursor as unknown as HistoryCursor;
}

/** prefixHash 验证完整旧前缀后只解析追加记录；尾部不完整 JSONL 保留至下一轮。 */
export async function parseSource(path: string, client: Client, previous?: ParsedSource, format = historyClient(client).format,
  options: { allowAssociationMetadata?: boolean; location?: SourceLocation } = {}): Promise<ParsedHistorySource> {
  const absolutePath = resolve(path);
  const adapter = historyAdapter(format);
  const container = await adapter?.readRecords?.({ ...options.location, path: absolutePath, client, format });
  const metadata = container?.source ?? await adapter?.readSourceMetadata?.({ path: absolutePath, client, format });
  // 原生容器直接消费记录快照，没有 JSONL 字节前缀游标。
  const bytes = container ? Buffer.alloc(0) : await readFile(absolutePath);
  const sourceHash = container?.hash ?? hash(bytes);
  let oldCursor = cursorOf(previous);
  if (container && previous?.hash === sourceHash && previous.client === client && oldCursor?.format === format && (!oldCursor.associationOnly || options.allowAssociationMetadata)) {
    const reused = structuredClone(previous) as ParsedHistorySource;
    Object.assign(reused, metadata);
    for (const event of reused.events) for (const reference of event.sources) reference.path = absolutePath;
    reused.cursor = json({ ...oldCursor, parsedRecords: 0 });
    return reused;
  }
  if (container) { previous = undefined; oldCursor = undefined; }
  // 旁路 cwd 改变时重建事件，不能沿用旧归属或相对路径解析。
  if (metadata && previous && (metadata.cwd !== previous.cwd || metadata.sessionId !== previous.sessionId)) {
    previous = undefined;
    oldCursor = undefined;
  }
  if (oldCursor?.associationOnly) {
    if (options.allowAssociationMetadata && previous?.client === client && oldCursor.format === format && previous.hash === sourceHash) {
      const source = structuredClone(previous) as ParsedHistorySource;
      source.path = absolutePath;
      source.cursor = json({ ...oldCursor, parsedRecords: 0 });
      for (const event of source.events) for (const reference of event.sources) reference.path = absolutePath;
      return source;
    }
    previous = undefined;
    oldCursor = undefined;
  }
  const appended = oldCursor && oldCursor.format === format && previous?.client === client && bytes.length >= oldCursor.completeBytes
    && hash(bytes.subarray(0, oldCursor.completeBytes)) === oldCursor.prefixHash;
  const cursor: HistoryCursor = appended ? structuredClone(oldCursor!) : {
    ruleVersion: PARSER_RULE_VERSION, format, prefixHash: hash(""), completeBytes: 0, recordLine: 0,
    pending: [], seen: {}, occurrences: {}, recordEnds: [], relationships: [], parsedRecords: 0,
  };
  cursor.parsedRecords = 0;
  const source: ParsedHistorySource = appended && previous ? {
    ...structuredClone(previous), path: absolutePath, hash: sourceHash, relationships: cursor.relationships,
    gaps: previous.gaps.filter((gap) => !["unpaired_call", "incomplete_record"].includes(gap.kind)),
  } : { sourceId: `${client}:unidentified:${hash(absolutePath).slice(0, 24)}`, client, format, path: absolutePath, hash: sourceHash, sessionId: `unknown:${hash(absolutePath).slice(0, 16)}`, events: [], gaps: [], completeBytes: 0, relationships: [] };
  if (metadata) Object.assign(source, metadata);
  for (const event of source.events) for (const reference of event.sources) reference.path = absolutePath;
  const eventById = new Map(source.events.map((event) => [event.id, event]));
  const gap = (kind: Gap["kind"], message: string, messageDescriptor?: MessageDescriptor, details?: MessageDescriptor[]) => source.gaps.push({ kind, message, messageDescriptor, details, sourceId: source.sourceId });
  let activeContext: HistoryAdapterContext;
  const reference = (recordLine: number, raw: string, callId?: string): SourceReference => ({ sourceId: source.sourceId, format, path: absolutePath,
    selector: metadata?.selector, recordLine, hash: hash(raw), callId,
    ...(activeContext.nativeOrdinal !== undefined ? { recordOrdinal: activeContext.nativeOrdinal } : {}),
    ...(activeContext.nativeIdentityHash ? { recordIdentityHash: activeContext.nativeIdentityHash } : {}) });
  const findEvent = (id: string) => eventById.get(id);
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
      path: extracted.path, fragments: [], sources: [reference(row, raw)], input: json(input), reason: "调用结果尚未配对", reasonDescriptor: { key: "diagnostics.history.index.m001" },
    };
    source.events.push(event);
    eventById.set(event.id, event);
    return event;
  }
  function finish(call: PendingCall, result: unknown, visible: string, status: HistoryEvent["status"], row: number, raw: string, reason?: string, reasonDescriptor?: MessageDescriptor) {
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
      target.status = evidence.status ?? status;
      target.fragments = target.status === "success" ? evidence.fragments : [];
      target.reason = reason ?? (evidence.status || status === "success" ? evidence.reason : status === "failure" ? "工具执行失败" : "未确认工具成功终态");
      target.reasonDescriptor = reason !== undefined ? reasonDescriptor : evidence.status || status === "success" ? evidence.reasonDescriptor : { key: status === "failure" ? "diagnostics.history.toolFailed" : "diagnostics.history.toolStatusUnknown" };
      if (index) source.events.push(target);
      if (target.reason?.startsWith("range_unknown:")) gap("range_unknown", target.reason, target.reasonDescriptor);
      if (target.reason?.startsWith("unsupported_tool:")) gap("unsupported_tool", target.reason, target.reasonDescriptor);
    });
  }
  function pair(callId: string, requestUuid?: string): PendingCall | undefined {
    const matching = cursor.pending.filter((call) => call.callId === callId && (!requestUuid || call.requestUuid === requestUuid));
    if (matching.length !== 1) {
      gap(matching.length ? "ambiguous" : "unpaired_call", matching.length ? `调用 ${callId} 有多个待配对出现位置` : `结果 ${callId} 没有请求`, matching.length ? { key: "diagnostics.history.index.m002", params: { p0: String(callId) } } : { key: "diagnostics.history.index.m003", params: { p0: String(callId) } });
      return undefined;
    }
    const call = matching[0]!;
    cursor.pending = cursor.pending.filter((candidate) => candidate !== call);
    return call;
  }
  if (!adapter && !source.gaps.some(item => item.kind === "unsupported_format")) gap("unsupported_format", `历史格式 ${format} 尚未注册适配器`, { key: "diagnostics.history.index.m004", params: { p0: String(format) } });
  let position = cursor.completeBytes;
  let nativePosition = 0;
  while (container ? nativePosition < container.records.length : position < bytes.length) {
    const nativeRecord = container?.records[nativePosition++];
    const newline = nativeRecord ? 0 : bytes.indexOf(10, position);
    if (!nativeRecord && newline < 0) break;
    const raw = nativeRecord?.raw ?? bytes.subarray(position, newline).toString("utf8");
    if (!nativeRecord) position = newline + 1;
    cursor.recordLine = nativeRecord?.line ?? cursor.recordLine + 1;
    cursor.parsedRecords += 1;
    if (!nativeRecord) cursor.recordEnds.push(position);
    const row = cursor.recordLine;
    let record: Record<string, unknown>;
    try { record = nativeRecord?.record ?? object(JSON.parse(raw)); }
    catch { gap("parse_error", `物理记录 ${row} 不是有效 JSON`, { key: "diagnostics.history.index.m005", params: { p0: row } }); continue; }
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
  if (position < bytes.length) gap("incomplete_record", "末尾记录尚未以换行完成，等待下一轮补齐", { key: "diagnostics.history.index.m006" });
  for (const call of cursor.pending) gap("unpaired_call", `调用 ${call.callId} 的出现位置 ${call.recordLine} 尚无可确认结果`, { key: "diagnostics.history.index.m007", params: { p0: String(call.callId), p1: String(call.recordLine) } });
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

/** 保留事件身份、路径、fork 边界和关系证明，避免未关联来源正文贯穿整轮分析。 */
export function associationMetadata(source: ParsedHistorySource): ParsedHistorySource {
  const adapter = historyAdapter(source.format ?? historyClient(source.client).format);
  const cursor = cursorOf(source);
  return { ...source, cursor: cursor ? json({ ...cursor, associationOnly: true, pending: [], adapterState: undefined }) : undefined,
    events: source.events.map(event => {
      const command = object(event.input).command;
      const worktreeProof = event.tool === "CommandExecution" && Array.isArray(command)
        && command.some(part => typeof part === "string" && /\bworktree\b/.test(part));
      return { ...event, input: undefined, output: undefined,
        fragments: event.fragments.map(fragment => ({ ...fragment, content: "" })),
        ...(worktreeProof ? { input: event.input, output: event.output } : adapter?.relationshipEvidence?.(event)) };
    }) };
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

/** 只在一次刷新中共享，不能把路径或 Git 身份的验证结果带到下一次刷新。 */
export function createSourceAssociationCache() {
  return { canonicalPaths: new Map<string, Promise<string>>(), commonDirectories: new Map<string, Promise<string | undefined>>(),
    worktreeRoots: new Map<string, Promise<string | undefined>>() };
}

/** 仅映射实际属于基线的路径；历史 worktree 必须有对应时间的 Git 证据。 */
export async function associateSource(source: ParsedSource, baseline: Baseline, worktrees: HistoricalWorktree[] = [], cache = createSourceAssociationCache()): Promise<SourceAssociation> {
  const parsed: ParsedHistorySource = { ...source, relationships: (source as ParsedHistorySource).relationships ?? cursorOf(source)?.relationships ?? [] };
  const events: HistoryEvent[] = [];
  const gaps: Gap[] = [];
  function canonical(path: string): Promise<string> {
    if (!cache.canonicalPaths.has(path)) cache.canonicalPaths.set(path, canonicalPath(path));
    return cache.canonicalPaths.get(path)!;
  }
  const root = await canonical(resolve(baseline.repository.path));
  const repositoryCommonDir = await canonical(resolve(baseline.repository.commonDir));
  const available = new Set(baseline.files.map((file) => file.path));
  async function relativePath(path: string | undefined, cwd: string | undefined, at: number, proof: SourceReference[]): Promise<string | undefined> {
    const normalized = normalizeHistoryPath(path);
    const working = normalizeHistoryPath(cwd);
    if (!normalized) return undefined;
    const rawAbsolute = isAbsolute(normalized) ? normalized : working && isAbsolute(working) ? resolve(working, normalized) : undefined;
    if (!rawAbsolute) return undefined;
    const absolute = await canonical(rawAbsolute);
    if (inside(root, absolute)) return relative(root, absolute).split(sep).join("/");
    const historical = worktrees.find(tree => inside(tree.path, absolute) && at >= tree.from && at <= tree.until);
    if (historical) {
      proof.push(...historical.sources);
      return relative(historical.path, absolute).split(sep).join("/");
    }
    if (working && isAbsolute(working)) {
      if (!cache.commonDirectories.has(working)) {
        const check = commonDir(working);
        cache.commonDirectories.set(working, check);
        // 校验失败只表示身份未知；后续来源仍可重试，不能把读取错误共享为缺失。
        void check.then(result => { if (!result && cache.commonDirectories.get(working) === check) cache.commonDirectories.delete(working); });
      }
      if (await cache.commonDirectories.get(working) === repositoryCommonDir) {
        if (!cache.worktreeRoots.has(working)) {
          const check = (async () => {
            try {
              const path = (await git("git", ["-C", working, "rev-parse", "--show-toplevel"], { timeout: 5_000 })).stdout.trim();
              return path ? canonical(path) : undefined;
            } catch { return undefined; }
          })();
          cache.worktreeRoots.set(working, check);
          void check.then(result => { if (!result && cache.worktreeRoots.get(working) === check) cache.worktreeRoots.delete(working); });
        }
        const worktreeRoot = await cache.worktreeRoots.get(working);
        if (worktreeRoot && inside(worktreeRoot, absolute)) return relative(worktreeRoot, absolute).split(sep).join("/");
      }
    }
    return undefined;
  }
  for (const event of source.events) {
    if (!event.path) {
      const cwd = normalizeHistoryPath(event.cwd ?? source.cwd);
      if (cwd && isAbsolute(cwd) && inside(root, await canonical(cwd))) events.push({ ...event, fragments: [] });
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
    if (!available.has(path) && (event.kind === "read" || event.kind === "edit")) gaps.push({ kind: "range_unknown", message: `历史文件 ${path} 不在当前仓库基线中`, messageDescriptor: { key: "diagnostics.history.index.m008", params: { p0: String(path) } }, sourceId: source.sourceId });
  }
  const cwd = normalizeHistoryPath(source.cwd);
  const belongsByCwd = Boolean(cwd && isAbsolute(cwd) && inside(root, await canonical(cwd)));
  const associated = events.length > 0 || belongsByCwd;
  if (!associated) gaps.push({ kind: "unassociated", message: "来源工作目录与逐事件路径无法可靠归属仓库", messageDescriptor: { key: "diagnostics.history.index.m009" }, sourceId: source.sourceId });
  return { associated, source: parsed, events, gaps, reason: events.length ? "逐事件路径或 Git commonDir 确认" : belongsByCwd ? "来源 cwd 属于仓库，外部路径活动已排除" : "归属未知", reasonDescriptor: events.length ? { key: "diagnostics.history.index.m010" } : belongsByCwd ? { key: "diagnostics.history.index.m011" } : { key: "diagnostics.history.index.m012" } };
}

/** 共享历史须有明确父来源与完整边界或已核验的原生复制身份；文本相同不去重。 */
export function resolveSharedHistory(sources: ParsedSource[]): SharedHistoryResult {
  const bySession = new Map<string, ParsedSource[]>();
  for (const source of sources) bySession.set(source.sessionId, [...(bySession.get(source.sessionId) ?? []), source]);
  const events = new Map<string, HistoryEvent>();
  const gaps: Gap[] = [];
  const relationships: SharedHistoryResult["relationships"] = [];
  const resolvedSources = sources.map(source => ({ source,
    resolution: historyAdapter(source.format ?? historyClient(source.client).format)?.resolveRelationships?.(source, sources) }));
  const invalidatedParents = new Set(resolvedSources.filter(item => item.resolution?.invalidateParent).map(item => item.source.sourceId));
  const identities = new Map<ParsedSource, Map<string, string>>();
  function eventIdentity(source: ParsedSource, event: HistoryEvent): string | undefined {
    if (!identities.has(source)) {
      identities.set(source, new Map(Object.entries(cursorOf(source)?.seen ?? {}).filter(([key]) => key.startsWith("concrete:") || key.startsWith("request:")).map(([key, id]) => [id, key])));
    }
    return identities.get(source)!.get(event.id.replace(/:file:\d+$/, ""));
  }
  for (const { source, resolution: resolvedRelationships } of resolvedSources) {
    const cursor = cursorOf(source);
    const invalidatedParent = invalidatedParents.has(source.sourceId);
    const shared = invalidatedParent ? [] : [...((source as ParsedHistorySource).relationships ?? cursor?.relationships ?? []), ...(resolvedRelationships?.relationships ?? [])];
    gaps.push(...(resolvedRelationships?.gaps ?? []));
    const parentProofs: SourceReference[] = [];
    const relatedParents = new Set<string>();
    const copied = new Map<string, { event: HistoryEvent; identity?: string }>();
    for (const relationship of shared) {
      const parents = (bySession.get(relationship.parentSessionId) ?? []).filter(parent => parent.client === source.client);
      const hasDshOrdinalProof = source.format === "dsh-jsonl" && relationship.endOrdinalExclusive !== undefined
        && Number.isSafeInteger(relationship.endOrdinalExclusive) && relationship.endOrdinalExclusive >= 0;
      const copiedIdentities = new Set(relationship.copiedRecordIdentityHashes ?? []);
      const hasNativeCopyProof = copiedIdentities.size > 0 && (source.format === "pi-jsonl"
        || source.client === "reasonix" && source.format === "reasonix-events" && relationship.copiedRecordIdentityProof === "reasonix-superseded-prefix");
      const parent = parents.length === 1 && (relationship.endByteOffset !== undefined
        && cursorOf(parents[0])?.recordEnds.includes(relationship.endByteOffset)
        || hasDshOrdinalProof || hasNativeCopyProof) ? parents[0] : undefined;
      const resolved = relationship.kind === "subagent" ? parents.length > 0 : Boolean(parent);
      relationships.push({ sourceId: source.sourceId, relationship, resolved });
      if (resolved) {
        relatedParents.add(relationship.parentSessionId);
        parentProofs.push(...(relationship.sources ?? []));
      }
      if (!resolved) gaps.push({ kind: parents.length ? "ambiguous" : "source_missing", sourceId: source.sourceId,
        message: relationship.kind === "fork" ? "fork 缺少可核验的完整记录边界或原生复制身份；未按文本推断共享调用" : "子会话父来源缺失", messageDescriptor: relationship.kind === "fork" ? { key: "diagnostics.history.index.m013" } : { key: "diagnostics.history.index.m014" } });
      if (parent && relationship.kind === "fork") {
        for (const event of parent.events) {
          const parentRefs = event.sources.filter((reference) => reference.sourceId === parent.sourceId);
          const withinByteCut = relationship.endByteOffset !== undefined
            && parentRefs.every(reference => reference.recordLine <= cursorOf(parent)!.recordEnds.indexOf(relationship.endByteOffset!) + 1);
          const withinOrdinalCut = hasDshOrdinalProof
            && parentRefs.every(reference => reference.recordOrdinal !== undefined && reference.recordOrdinal < relationship.endOrdinalExclusive!);
          const copiedByIdentity = hasNativeCopyProof
            && parentRefs.every(reference => reference.recordIdentityHash !== undefined && copiedIdentities.has(reference.recordIdentityHash));
          if (parentRefs.length && (withinByteCut || withinOrdinalCut || copiedByIdentity)) {
            const proof = [...new Set(parentRefs.map((reference) => reference.hash))].sort().join(":");
            copied.set(proof, { event, identity: eventIdentity(parent, event) });
            mergeEvent(events, event, gaps);
          }
        }
      }
    }
    if (relatedParents.size > 1) gaps.push({ kind: "ambiguous", sourceId: source.sourceId, message: "子会话存在多个已解析父身份，未选择父关系", messageDescriptor: { key: "diagnostics.history.index.m015" } });
    for (const event of source.events) {
      const proof = [...new Set(event.sources.filter((reference) => reference.sourceId === source.sourceId).map((reference) => reference.hash))].sort().join(":");
      const candidate = copied.get(proof);
      const identity = candidate ? eventIdentity(source, event) : undefined;
      const original = candidate?.identity && identity === candidate.identity ? candidate.event : undefined;
      if (candidate && !original) gaps.push({ kind: "ambiguous", sourceId: source.sourceId, message: "fork 记录内容相同但缺少可确认的原事件身份，未按文本去重", messageDescriptor: { key: "diagnostics.history.index.m016" } });
      const related = invalidatedParent ? { ...event, parentSessionId: undefined } : relatedParents.size === 1 ? { ...event, parentSessionId: [...relatedParents][0],
        sources: [...new Map([...event.sources, ...parentProofs].map(reference => [JSON.stringify(reference), reference])).values()] } : event;
      mergeEvent(events, original ? { ...related, id: original.id, sessionId: original.sessionId } : related, gaps);
    }
  }
  return { events: [...events.values()], gaps, relationships, invalidatedParentSourceIds: [...invalidatedParents] };
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
    existing.reasonDescriptor = event.reasonDescriptor;
  } else if (existing.status !== "unknown" && event.status !== "unknown" && existing.status !== event.status) {
    existing.status = "unknown";
    existing.fragments = [];
    existing.reason = "ambiguous: 同一事件身份存在相互矛盾的成功与失败结果"; existing.reasonDescriptor = { key: "diagnostics.history.index.m017" };
    gaps.push({ kind: "ambiguous", message: existing.reason, messageDescriptor: existing.reasonDescriptor });
  }
  for (const reference of event.sources) {
    const key = `${reference.path}:${reference.recordLine}:${reference.hash}`;
    if (!seen.has(key)) { existing.sources.push(reference); seen.add(key); }
  }
}
