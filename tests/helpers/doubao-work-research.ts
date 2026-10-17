import { join } from "node:path";
import { doubaoWorkAdapter } from "../../src/history/adapters/doubao-work.js";
import { parseSessionSource } from "../../src/sessions/parser.js";
import type { SessionStore } from "../../src/sessions/store.js";

/** 只供保留的解析器研究回归使用，不经过已停用的产品发现和导入入口。 */
export async function importDoubaoResearch(store: SessionStore, directory: string): Promise<void> {
  const path = join(directory, "launcher.leveldb", "CURRENT");
  const sources = await doubaoWorkAdapter.discoverFile!({ path, client: "doubao-work", format: doubaoWorkAdapter.id });
  const revisions = [];
  for (const source of sources) {
    const pending = store.createRevision(source.sourceId!, "research");
    const meta = await parseSessionSource(source, pending.sink);
    pending.flush(); store.finishRevision(pending.revision, meta);
    revisions.push({ path: source.sourceId!, revision: pending.revision, fingerprint: "research" });
  }
  store.publish(store.createJob().id, revisions, []);
}
