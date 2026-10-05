import assert from "node:assert/strict";
import { test } from "node:test";
import { hierarchy } from "d3";
import type { FileCoverage, FileDetail } from "../src/contracts.ts";
import { clientIds } from "../src/clients.ts";
import { queryString } from "../web/api.ts";
import { boundQuery, directories, directoryTree, fileHighlights, mapTree, metricValue, timeFilters } from "../web/model.ts";

const file = (path: string, lineCount: number): FileCoverage => ({ path, lineCount, category: "source", hash: "hash", readExactLines: 1, readNearLines: 1, editExactLines: 0, editNearLines: 0, readCount: 2, editCount: 0, searchCount: 0, failedCount: 0, unknownCount: 0, activityCount: 2, readExactRanges: [{ start: 1, end: 1 }], readNearRanges: [{ start: 2, end: 2 }], editExactRanges: [], editNearRanges: [] });

test("全部已声明客户端的文件与证据查询保留版本和原筛选，路径单独编码", () => {
  for (const client of clientIds) {
    const filters = { client, from: "2026-10-01T00:00:00Z", to: "2026-10-02T23:59:59Z", categories: ["source", "config"] as const, directory: "src/a b" };
    const query = boundQuery({ ...filters, categories: [...filters.categories] }, "version-1");
    const params = new URLSearchParams(queryString(query, { path: "src/a b/a&b.ts" }));
    assert.equal(params.get("version"), "version-1");
    assert.equal(params.get("client"), client);
    assert.equal(params.get("categories"), "source,config");
    assert.equal(params.get("directory"), "src/a b");
    assert.equal(params.get("path"), "src/a b/a&b.ts");
    assert.equal(params.get("from"), filters.from);
    assert.equal(params.get("to"), filters.to);
  }
});

test("地图面积只来自行数，保留层级且不为零行文件制造面积", () => {
  const files = [file("src/a.ts", 10), file("src/deep/b.ts", 30), file("src/empty.ts", 0), file("docs/c.ts", 12)];
  const tree = mapTree(files, "src");
  const root = hierarchy(tree).sum(node => node.file?.lineCount ?? 0);
  assert.equal(root.value, 40);
  assert.deepEqual(root.leaves().map(node => node.data.path).sort(), ["src/a.ts", "src/deep/b.ts"]);
  assert.equal(tree.children?.find(node => node.path === "src/deep")?.children?.[0]?.file?.path, "src/deep/b.ts");
  assert.deepEqual(directories(files), [{ path: "docs", count: 1, depth: 1 }, { path: "src", count: 3, depth: 1 }, { path: "src/deep", count: 1, depth: 2 }]);
});

test("目录树区分同名分支，计数包含空文件和全部后代", () => {
  const files = [file("root.ts", 3), file("src/a.ts", 10), file("src/deep/b.ts", 30), file("src/deep/empty.ts", 0), file("tests/deep/c.ts", 12)];
  assert.deepEqual(directoryTree(files), [
    { path: "src", count: 3, children: [{ path: "src/deep", count: 2, children: [] }] },
    { path: "tests", count: 1, children: [{ path: "tests/deep", count: 1, children: [] }] },
  ]);
  assert.deepEqual(directoryTree([]), []);
});

test("代码内容过期或不可读时禁止旧范围高亮，近似独立可关闭", () => {
  const detail: FileDetail = { repository: { id: "repo", path: "/repo", commonDir: "/repo/.git", name: "repo", stale: false }, version: "v1", baselineHash: "baseline", createdAt: "2026-10-03T00:00:00Z", stale: false, filters: {}, file: file("src/a.ts", 3), content: "a\nb\nc", contentStale: false, events: [] };
  assert.deepEqual(fileHighlights(detail, "read", true), { exact: [{ start: 1, end: 1 }], near: [{ start: 2, end: 2 }] });
  assert.deepEqual(fileHighlights(detail, "read", false), { exact: [{ start: 1, end: 1 }], near: [] });
  assert.deepEqual(fileHighlights({ ...detail, contentStale: true }, "read", true), { exact: [], near: [] });
  assert.deepEqual(fileHighlights({ ...detail, content: null }, "read", true), { exact: [], near: [] });
});

test("时间窗转为事件时间筛选，全部历史不擅自加时间限制", () => {
  assert.deepEqual(timeFilters("all", "", ""), {});
  assert.deepEqual(timeFilters("7", "", "", Date.parse("2026-10-03T00:00:00Z")), { from: "2026-09-26T00:00:00.000Z" });
});

test("活动次数使用服务端去重结果，不将重叠的活动与失败统计相加", () => {
  const coverage = { ...file("src/a.ts", 3), readCount: 2, editCount: 3, searchCount: 1, failedCount: 2, unknownCount: 3, activityCount: 9 };
  assert.equal(metricValue(coverage, "activity"), 9);
});
