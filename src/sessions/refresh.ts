import { errorDescriptor } from "../i18n/diagnostics.js";
import { DiagnosticError } from "../i18n/diagnostics.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { discoverSources } from "../history/index.js";
import { sourceLocationKey } from "../history/types.js";
import { DESKTOP_FORMAT } from "../history/adapters/codeflicker-desktop.js";
import { IDE_FORMAT, readIdeSnapshot } from "../history/adapters/codeflicker-ide.js";
import type { IdeSnapshot } from "../history/adapters/codeflicker-ide.js";
import type { DiscoverRoots } from "../history/types.js";
import type { Gap } from "../contracts.js";
import type { SessionRefreshCounts } from "../session-contracts.js";
import { parseSessionSource } from "./parser.js";
import { SessionStore } from "./store.js";
import type { SessionRevision } from "./store.js";
import { loadCodexTitles } from "./codex-titles.js";
import { loadCodeFlickerProjects } from "./codeflicker-projects.js";
import { desktopModels, loadDesktopTitles } from "./codeflicker-desktop.js";
import { historyAdapter, historyClient } from "../history/adapters/index.js";
import type { NormalizedSnapshot } from "../history/adapters/normalized.js";
import { sourceQuickStamp } from "./quick-check.js";

// 会话规范化规则升级时使来源缓存失效，独立于地图索引迁移。
const SESSION_INDEX_RULE_VERSION = "6";

async function fingerprint(path: string, byteLimit?: number): Promise<{ hash: string; bytes: number }> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new DiagnosticError("会话来源必须为普通文件", { key: "diagnostics.sessions.refresh.m001" });
  const bytes = byteLimit ?? before.size;
  if (before.size < bytes) throw new DiagnosticError("会话来源在解析期间被截短，请重新刷新", { key: "diagnostics.sessions.refresh.m002" });
  const digest = createHash("sha256");
  if (bytes) for await (const chunk of createReadStream(path, { start: 0, end: bytes - 1 })) digest.update(chunk);
  const after = await lstat(path);
  if (after.size < bytes) throw new DiagnosticError("会话来源在检查期间被截短，请重新刷新", { key: "diagnostics.sessions.refresh.m003" });
  return { hash: `${SESSION_INDEX_RULE_VERSION}:${digest.digest("hex")}`, bytes };
}

/** 旁路读取失败不能当成正文来源被删除。 */
async function confirmedMissing(path: string, error?: unknown): Promise<boolean> {
  if (error && (error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  try { await lstat(path); return false; }
  catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ENOENT") return true; throw failure; }
}

/** 来源解析逐记录落库；完整发布前不改变任何正在查询的版本。 */
export async function refreshSessions(store: SessionStore, jobId: string, roots?: DiscoverRoots, clearCache = false): Promise<void> {
  const job = store.getJob(jobId);
  const client = clearCache ? undefined : job.client;
  const mode = clearCache ? "full" : job.mode ?? "quick";
  const counts: SessionRefreshCounts = { discovered: 0, quickReused: 0, verifiedReused: 0, parsed: 0, missing: 0, fallbacks: [] };
  const missing = new Set<string>();
  const fallback = (reason: string) => {
    const item = counts.fallbacks.find(item => item.reason === reason);
    if (item) item.count += 1;
    else counts.fallbacks.push({ reason, count: 1 });
  };
  store.updateJob(jobId, { status: "running", phase: "discover", phaseDescriptor: { key: "diagnostics.sessions.refresh.m004" }, progress: 0, client, mode, counts });
  try {
    await store.prepareSearchIndex(progress => store.updateJob(jobId, { phase: "建立搜索索引", phaseDescriptor: { key: "diagnostics.sessions.refresh.m005" }, progress }));
    store.updateJob(jobId, { phase: "discover", phaseDescriptor: { key: "diagnostics.sessions.refresh.m004" }, progress: 0 });
    // 基础版本在执行时读取，连续范围任务保留前一任务刚发布的结果。
    const cached = new Map(store.cachedRevisions().map(item => [item.path, item]));
    const selected = [...cached.values()].filter(item => !client || item.client === client);
    const cachedSources = selected.flatMap(item => item.location && item.quickFingerprint ? [{ location: item.location, stamp: item.quickFingerprint }] : []);
    const sources = await discoverSources(roots, { clients: client ? [client] : undefined, cachedSources: mode === "quick" ? cachedSources : undefined });
    counts.discovered = sources.length;
    const codexTitles = sources.some(source => source.client === "codex") ? await loadCodexTitles(roots) : new Map<string, string>();
    const codeflickerProjects = await loadCodeFlickerProjects(sources);
    const desktopTitles = await loadDesktopTitles(sources);
    const current: SessionRevision[] = [...cached.values()].filter(item => client && item.client !== client);
    const gaps: Gap[] = [];
    const discovered = new Set(sources.map(sourceLocationKey));
    for (const previous of selected) {
      if (discovered.has(previous.path)) continue;
      // 发现阶段已经确认容器内的选择器集合；仍检查物理路径，读取错误不发布删除。
      const path = previous.location?.path ?? (previous.path.startsWith("[") ? (JSON.parse(previous.path) as string[])[0]! : previous.path);
      await confirmedMissing(path);
      missing.add(previous.path);
    }
    for (const [index, source] of sources.entries()) {
      store.updateJob(jobId, { phase: "index", phaseDescriptor: { key: "diagnostics.sessions.refresh.m006" }, progress: sources.length ? index / sources.length : 0, counts });
      const { discoveryQuickStamp, ...location } = source;
      const sourceKey = sourceLocationKey(source);
      const previous = cached.get(sourceKey);
      const title = source.sessionId ? (source.client === "codex" ? codexTitles : source.client === "codeflicker-desktop" ? desktopTitles : new Map<string, string>()).get(source.sessionId) : undefined;
      // 标题、归属和模型仍分别检查，正文快检命中不能遮蔽旁路变化。
      const titleFingerprint = ["codex", "codeflicker-desktop"].includes(source.client) ? `:title-v1:${createHash("sha256").update(JSON.stringify(title ?? null)).digest("hex")}` : "";
      const childTitleFingerprint = source.client === "codex" && source.parentSessionId ? ":child-title-v2" : "";
      const projectMetadata = codeflickerProjects.get(source.path);
      const projectFingerprint = source.client === "codeflicker" ? `:project-v1:${createHash("sha256").update(JSON.stringify(projectMetadata ?? null)).digest("hex")}:execution-v2:attachments-v1:compression-v1:hidden-context-v1` : "";
      const nativeModels = source.format === DESKTOP_FORMAT ? await desktopModels(source.path) : undefined;
      const desktopFingerprint = nativeModels ? `:desktop-v4:${source.cwd ?? ""}:${nativeModels.fingerprint}:${nativeModels.limited}` : "";
      // 保留原生 Skill 目录的资源规则只失效桌面会话缓存，避免触发其他客户端重建。
      const desktopResourceFingerprint = source.client === "codeflicker-desktop" ? ":skill-directory-v1" : "";
      const contextUsageFingerprint = source.client === "codex" ? ":active-context-v1" : "";
      // 请求计时按来源升级；桌面冲突校验单独失效，不重建其他来源。
      const requestTimingFingerprint = source.client === "codeflicker-desktop" ? ":request-timing-v3" : ":request-timing-v2";
      const metadataSuffix = `${requestTimingFingerprint}${contextUsageFingerprint}${titleFingerprint}${childTitleFingerprint}${projectFingerprint}${desktopFingerprint}${desktopResourceFingerprint}`;
      const metadataFingerprint = createHash("sha256").update(JSON.stringify({ rule: SESSION_INDEX_RULE_VERSION, source: location, metadataSuffix })).digest("hex");
      let stamp: string | undefined;
      try { stamp = await sourceQuickStamp(source); }
      catch (error) { if (await confirmedMissing(source.path, error)) { missing.add(sourceKey); continue; } throw error; }
      if (!clearCache && mode === "quick") {
        if (stamp && stamp === discoveryQuickStamp && previous?.quickFingerprint === stamp && previous.metadataFingerprint === metadataFingerprint
          && previous.fingerprint.startsWith(`${source.client}:${source.format ?? "default"}:`) && previous.fingerprint.endsWith(metadataSuffix)) {
          current.push({ ...previous, location });
          counts.quickReused += 1;
          continue;
        }
        fallback(!stamp ? "unsupported_source" : !previous ? "cache_missing" : !previous.quickFingerprint || !previous.metadataFingerprint ? "check_record_missing"
          : previous.metadataFingerprint !== metadataFingerprint ? "metadata_changed" : "source_changed");
      }
      let nativeSnapshot: IdeSnapshot | undefined;
      let normalizedSnapshot: NormalizedSnapshot | undefined;
      const adapter = historyAdapter(source.format ?? historyClient(source.client).format);
      let digest: { hash: string; bytes: number };
      try {
        nativeSnapshot = source.format === IDE_FORMAT ? await readIdeSnapshot(source) : undefined;
        normalizedSnapshot = adapter?.normalized ? await adapter.readRecords!(source) as NormalizedSnapshot : undefined;
        digest = normalizedSnapshot ? { hash: `normalized-1:${normalizedSnapshot.hash}`, bytes: 0 }
          : nativeSnapshot ? { hash: `${SESSION_INDEX_RULE_VERSION}:${nativeSnapshot.hash}`, bytes: 0 } : await fingerprint(source.path);
      }
      catch (error) {
        if (await confirmedMissing(source.path, error)) { missing.add(sourceKey); continue; }
        throw error;
      }
      const sourceFingerprint = `${source.client}:${source.format ?? "default"}:${digest.hash}${metadataSuffix}`;
      const cacheRecord = async (revision: string): Promise<SessionRevision> => {
        const stable = stamp && stamp === discoveryQuickStamp && await sourceQuickStamp(source) === stamp;
        return { path: sourceKey, revision, fingerprint: sourceFingerprint, client: source.client, location,
          quickFingerprint: stable ? stamp : undefined, metadataFingerprint };
      };
      if (!clearCache && previous?.fingerprint === sourceFingerprint && (!previous.metadataFingerprint || previous.metadataFingerprint === metadataFingerprint)) {
        current.push(await cacheRecord(previous.revision));
        counts.verifiedReused += 1;
        continue;
      }
      const pending = store.createRevision(sourceKey, sourceFingerprint);
      try {
        const meta = await parseSessionSource(source, pending.sink, { byteLimit: digest.bytes, title, projectMetadata, desktopModels: nativeModels?.entries, nativeSnapshot, normalizedSnapshot });
        if (nativeModels?.limited) meta.gaps.push({ kind: "budget_exceeded", message: "原生模型旁路日志超过有界读取上限，部分模型信息未关联", messageDescriptor: { key: "diagnostics.sessions.refresh.m007" }, sourceId: meta.sourceId });
        pending.flush();
        // 允许活动日志追加；发布的始终是开始检查时的同一字节前缀。
        const after = normalizedSnapshot ? { hash: `normalized-1:${(await adapter!.readRecords!(source)).hash}` }
          : nativeSnapshot ? { hash: `${SESSION_INDEX_RULE_VERSION}:${(await readIdeSnapshot(source)).hash}` } : await fingerprint(source.path, digest.bytes);
        if (after.hash !== digest.hash) throw new DiagnosticError("会话来源已有内容在解析期间被改写，请重新刷新", { key: "diagnostics.sessions.refresh.m008" });
        store.finishRevision(pending.revision, meta);
        current.push(await cacheRecord(pending.revision));
        counts.parsed += 1;
      } catch (error) {
        store.removeRevision(pending.revision);
        if (await confirmedMissing(source.path, error)) { missing.add(sourceKey); continue; }
        throw error;
      }
    }
    counts.missing = missing.size;
    if (counts.missing) gaps.push({ kind: "source_missing", message: "已有来源已删除或移走，新版统计已排除；上一版保留供对照", messageDescriptor: { key: "diagnostics.sessions.refresh.m009" }, count: counts.missing });
    store.updateJob(jobId, { phase: "publish", phaseDescriptor: { key: "diagnostics.sessions.refresh.m010" }, progress: 0.99, counts });
    store.publish(jobId, current, gaps);
  } catch (error) {
    counts.missing = missing.size;
    store.updateJob(jobId, { counts });
    store.failJob(jobId, error instanceof Error ? error.message : String(error), errorDescriptor(error));
    throw error;
  }
}
