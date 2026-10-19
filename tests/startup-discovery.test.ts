import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverSources } from "../src/history/index.js";
import { sessionStatusSummaryResponse } from "../src/service/summary-response.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

test("来源扫描报告目录开始、增量计数与完成，发现结果不变", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-discovery-progress-"));
  try {
    const first = join(directory, "first"), second = join(directory, "second");
    for (const [index, root] of [first, second].entries()) {
      await mkdir(root);
      await writeFile(join(root, "sample.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: `synthetic-${index}`, cwd: "/synthetic/project" } }) + "\n");
    }
    const updates: { client: string; path: string; sourceCount: number; complete: boolean }[] = [];
    const roots = isolatedHistoryRoots({ codex: [first, second] });
    const sources = await discoverSources(roots, { clients: ["codex"], onProgress: value => { updates.push({ ...value }); } });
    assert.deepEqual(sources, await discoverSources(roots, { clients: ["codex"] }));
    assert.deepEqual(updates.filter(value => value.complete).map(value => [value.path, value.sourceCount]), [[first, 1], [second, 1]]);
    for (const path of [first, second]) {
      const root = updates.filter(value => value.path === path);
      assert.deepEqual(root[0], { client: "codex", path, sourceCount: 0, complete: false });
      assert.ok(root.some(value => value.sourceCount === 1 && !value.complete));
      assert.equal(root.at(-1)!.complete, true);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("启动状态保留来源进度及必要计数，省略回退诊断正文", () => {
  const job = { id: "synthetic-import", status: "running", phase: "index", processedSources: 2, totalSources: 4, parserConcurrency: 2,
    discovery: [{ client: "codex", path: "/synthetic/sessions", sourceCount: 4, complete: true }],
    sourceCounts: [{ client: "codex", count: 4 }], activeSources: [{ client: "codex", path: "/synthetic/sessions/sample.jsonl" }],
    counts: { discovered: 4, parsed: 1, quickReused: 1, verifiedReused: 0, missing: 0, fallbacks: [{ reason: "private diagnostic", count: 1 }] } };
  const status = sessionStatusSummaryResponse({ job, gaps: [] })!;
  assert.deepEqual(status.job, { ...job, counts: { discovered: 4, parsed: 1, quickReused: 1, verifiedReused: 0, missing: 0 } });
  assert.ok(!JSON.stringify(status).includes("private diagnostic"));
});
