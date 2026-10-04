import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnalysisSnapshot, HistoryEvent, HistorySource } from "../src/contracts.js";
import { hashContent, matchEvent, scanRepository } from "../src/analysis/index.js";
import { AnalysisStore } from "../src/index/store.js";

/** 直接发布通用事件，查询回归不依赖任何客户端原始记录解析规则。 */
export async function publishClientQueryFixture(home: string, repositoryPath: string, sourceDirectory: string): Promise<AnalysisSnapshot> {
  await mkdir(sourceDirectory, { recursive: true });
  const baseline = await scanRepository(repositoryPath);
  const events: HistoryEvent[] = [];
  const sources: HistorySource[] = [];
  for (const client of ["codeflicker", "claude"] as const) {
    const sourceId = `${client}:query-fixture`;
    const path = join(sourceDirectory, `${client}.jsonl`);
    const definitions: { path: string; kind: "read" | "edit"; content: string }[] = client === "codeflicker"
      ? [{ path: "src/a.ts", kind: "read", content: "alpha\nbeta\n" }, { path: "src/b.ts", kind: "edit", content: "unread\n" }]
      : [{ path: "src/b.ts", kind: "read", content: "unread\n" }];
    const rows = definitions.map(definition => JSON.stringify({ fixture: "query", client, ...definition }));
    const content = rows.join("\n") + "\n";
    await writeFile(path, content);
    // 客户端身份与格式独立；这里只复用 JSONL 的物理行回读，不测试原始格式。
    const source: HistorySource = { sourceId, client, format: "codex-jsonl", path, hash: hashContent(content), sessionId: sourceId, cwd: repositoryPath };
    sources.push(source);
    definitions.forEach((definition, index) => events.push({
      id: `${client}-${definition.kind}`, client, sessionId: source.sessionId,
      occurredAt: "2026-01-01T00:00:01Z", tool: definition.kind, kind: definition.kind, status: "success", cwd: repositoryPath, path: definition.path,
      fragments: [{ content: definition.content, kind: definition.kind === "read" ? "read" : "added", path: definition.path, completeLines: true }],
      sources: [{ sourceId, format: source.format, path, recordLine: index + 1, hash: hashContent(rows[index]!) }],
    }));
  }
  const mappings = events.map(event => matchEvent(event, baseline.files.find(file => file.path === event.path)!));
  const snapshot: AnalysisSnapshot = { repository: baseline.repository, version: "query-codeflicker-v1", baseline, sources, events, mappings, gaps: [], createdAt: baseline.createdAt };
  const store = new AnalysisStore(join(home, "index.sqlite"));
  try {
    await store.registerRepository(repositoryPath);
    store.publish({
      snapshot,
      sources: { version: snapshot.version, sources: sources.map(source => ({ ...source, eventCount: events.filter(event => event.client === source.client).length, completeBytes: 0, association: "automatic" })), unassociated: [], gaps: [] },
      parsed: [], mappings: [], stats: { sourcesParsed: 0, parsedRecords: 0, mappingsComputed: mappings.length, mappingsReused: 0 },
      clearCache: false, jobId: store.createJob(snapshot.repository.id).id,
    });
  } finally { store.close(); }
  return snapshot;
}
