import assert from "node:assert/strict";
import { join } from "node:path";
import { AnalysisStore, WorkerManager } from "../../src/index/index.js";

const [repositoryPath, history, directory] = process.argv.slice(2) as [string, string, string];
const store = new AnalysisStore(join(directory, "index.sqlite"));
const repository = await store.registerRepository(repositoryPath);
const manager = new WorkerManager(store, { roots: { codex: [], claude: [], codeflicker: history, "codeflicker-desktop": [] } });
try {
  for (let attempt = 0; attempt < 2; attempt++) {
    const job = await manager.waitForJob(manager.refresh(repository.id).id);
    assert.equal(job.status, "completed", job.error);
    const snapshot = store.getSnapshot(repository.id);
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0]!.fragments[0]!.content, "alpha\n");
    assert.equal(store.listSources(repository.id).unassociated.length, 24);
    const cached = store.getParsedSources(repository.id);
    assert.equal(cached.length, 25);
    assert.equal(cached.filter(source => !(source.cursor as { associationOnly?: boolean })?.associationOnly).length, 1);
    assert.ok(cached.filter(source => (source.cursor as { associationOnly?: boolean })?.associationOnly)
      .every(source => source.events.every(event => event.output === undefined && event.fragments.every(fragment => fragment.content === ""))));
  }
  console.log("受限堆首次分析与增量刷新通过，保留相关证据和全部未关联来源");
} finally {
  await manager.close();
  store.close();
}
