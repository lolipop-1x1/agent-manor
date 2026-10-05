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
import { parseSessionSource } from "./parser.js";
import { SessionStore } from "./store.js";
import type { SessionRevision } from "./store.js";
import { loadCodexTitles } from "./codex-titles.js";
import { loadCodeFlickerProjects } from "./codeflicker-projects.js";
import { desktopModels, loadDesktopTitles } from "./codeflicker-desktop.js";

// 会话规范化规则升级时使来源缓存失效，独立于地图索引迁移。
const SESSION_INDEX_RULE_VERSION = "3";

async function fingerprint(path: string, byteLimit?: number): Promise<{ hash: string; bytes: number }> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("会话来源必须为普通文件");
  const bytes = byteLimit ?? before.size;
  if (before.size < bytes) throw new Error("会话来源在解析期间被截短，请重新刷新");
  const digest = createHash("sha256");
  if (bytes) for await (const chunk of createReadStream(path, { start: 0, end: bytes - 1 })) digest.update(chunk);
  const after = await lstat(path);
  if (after.size < bytes) throw new Error("会话来源在检查期间被截短，请重新刷新");
  return { hash: `${SESSION_INDEX_RULE_VERSION}:${digest.digest("hex")}`, bytes };
}

/** 来源解析逐记录落库；完整发布前不改变任何正在查询的版本。 */
export async function refreshSessions(store: SessionStore, jobId: string, roots?: DiscoverRoots, clearCache = false): Promise<void> {
  store.updateJob(jobId, { status: "running", phase: "discover", progress: 0 });
  try {
    const sources = await discoverSources(roots);
    const codexTitles = sources.some(source => source.client === "codex") ? await loadCodexTitles(roots) : new Map<string, string>();
    const codeflickerProjects = await loadCodeFlickerProjects(sources);
    const desktopTitles = await loadDesktopTitles(sources);
    const cached = new Map(store.cachedRevisions().map(item => [item.path, item]));
    const current: SessionRevision[] = [];
    const gaps: Gap[] = [];
    const discovered = new Set(sources.map(sourceLocationKey));
    let missing = [...cached.keys()].filter(path => !discovered.has(path)).length;
    for (const [index, source] of sources.entries()) {
      store.updateJob(jobId, { phase: "index", progress: sources.length ? index / sources.length : 0 });
      const sourceKey = sourceLocationKey(source);
      let nativeSnapshot: IdeSnapshot | undefined;
      let digest: { hash: string; bytes: number };
      try {
        nativeSnapshot = source.format === IDE_FORMAT ? await readIdeSnapshot(source) : undefined;
        digest = nativeSnapshot ? { hash: `${SESSION_INDEX_RULE_VERSION}:${nativeSnapshot.hash}`, bytes: 0 } : await fingerprint(source.path);
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { missing += 1; continue; }
        throw error;
      }
      const title = source.sessionId ? (source.client === "codex" ? codexTitles : source.client === "codeflicker-desktop" ? desktopTitles : new Map<string, string>()).get(source.sessionId) : undefined;
      // Codex 标题与正文分别更新；只失效对应来源，其他客户端沿用现有缓存。
      const titleFingerprint = ["codex", "codeflicker-desktop"].includes(source.client) ? `:title-v1:${createHash("sha256").update(JSON.stringify(title ?? null)).digest("hex")}` : "";
      // 新增子任务标题只失效 Codex 子来源，保留未改变的长主会话及其他客户端缓存。
      const childTitleFingerprint = source.client === "codex" && source.parentSessionId ? ":child-title-v1" : "";
      const projectMetadata = codeflickerProjects.get(source.path);
      const projectFingerprint = source.client === "codeflicker" ? `:project-v1:${createHash("sha256").update(JSON.stringify(projectMetadata ?? null)).digest("hex")}` : "";
      const nativeModels = source.format === DESKTOP_FORMAT ? await desktopModels(source.path) : undefined;
      const desktopFingerprint = nativeModels ? `:desktop-v3:${source.cwd ?? ""}:${nativeModels.fingerprint}:${nativeModels.limited}` : "";
      const sourceFingerprint = `${source.client}:${source.format ?? "default"}:${digest.hash}${titleFingerprint}${childTitleFingerprint}${projectFingerprint}${desktopFingerprint}`;
      const previous = cached.get(sourceKey);
      if (!clearCache && previous?.fingerprint === sourceFingerprint) { current.push(previous); continue; }
      const pending = store.createRevision(sourceKey, sourceFingerprint);
      try {
        const meta = await parseSessionSource(source, pending.sink, { byteLimit: digest.bytes, title, projectMetadata, desktopModels: nativeModels?.entries, nativeSnapshot });
        if (nativeModels?.limited) meta.gaps.push({ kind: "budget_exceeded", message: "原生模型旁路日志超过有界读取上限，部分模型信息未关联", sourceId: meta.sourceId });
        pending.flush();
        // 允许活动日志追加；发布的始终是开始检查时的同一字节前缀。
        const after = nativeSnapshot ? { hash: `${SESSION_INDEX_RULE_VERSION}:${(await readIdeSnapshot(source)).hash}` } : await fingerprint(source.path, digest.bytes);
        if (after.hash !== digest.hash) throw new Error("会话来源已有内容在解析期间被改写，请重新刷新");
        store.finishRevision(pending.revision, meta);
        current.push({ path: sourceKey, revision: pending.revision, fingerprint: sourceFingerprint });
      } catch (error) {
        store.removeRevision(pending.revision);
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { missing += 1; continue; }
        throw error;
      }
    }
    if (missing) gaps.push({ kind: "source_missing", message: "已有来源已删除或移走，新版统计已排除；上一版保留供对照", count: missing });
    store.updateJob(jobId, { phase: "publish", progress: 0.99 });
    store.publish(jobId, current, gaps);
  } catch (error) {
    store.failJob(jobId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
