import assert from "node:assert/strict";
import { join } from "node:path";
import { AnalysisStore, WorkerManager } from "../../src/index/index.js";
import { isolatedHistoryRoots } from "../helpers/history-roots.js";

const [repositoryPath, history, directory] = process.argv.slice(2) as [string, string, string];
const store = new AnalysisStore(join(directory, "index.sqlite"));
const repository = await store.registerRepository(repositoryPath);
const manager = new WorkerManager(store, { roots: isolatedHistoryRoots({ codex: history }) });
try {
  for (let attempt = 0; attempt < 2; attempt++) {
    const job = await manager.waitForJob(manager.refresh(repository.id).id);
    assert.equal(job.status, "completed", job.error);
    const parts = new Map<string, number>();
    const snapshot = store.getCoverageSnapshot(repository.id, undefined, parts);
    assert.equal(snapshot.events.length, 481);
    const read = snapshot.events.find(event => event.tool === "shell_command")!;
    assert.equal(snapshot.mappings.find(mapping => mapping.eventId === read.id)?.exactRanges.length, 1);
    const large = snapshot.events.find(event => event.tool === "synthetic_dump")!;
    const [event] = store.getSnapshotEvents(repository.id, snapshot.version, new Map([[large.id, parts.get(large.id)!]]));
    assert.equal((event!.input as { marker: string }).marker, "synthetic-payload");
    assert.equal((event!.output as { visibleOutput: string }).visibleOutput.length, 256 * 1024);
    const source = snapshot.sources.find(source => source.sourceId === large.sources[0]!.sourceId)!;
    const cached = store.getParsedSource(repository.id, source.sourceId, source.path)!;
    assert.equal((cached.events.find(event => event.id === large.id)!.output as { visibleOutput: string }).visibleOutput.length, 256 * 1024);
  }
  console.log("受限堆关联历史首次与增量分析通过，完整工具输入输出及读取映射保留");
} finally {
  await manager.close();
  store.close();
}
