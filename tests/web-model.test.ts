import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileCoverage, FileDetail } from "../src/contracts.ts";
import { clientIds } from "../src/clients.ts";
import { queryString } from "../web/features/code-map/api.ts";
import { translate } from "../src/i18n/index.ts";
import { boundQuery, directories, directoryTree, fileHighlights, metricValue, refreshFailureReason } from "../web/features/code-map/model.ts";
import { timeFilters } from "../web/shared/time-filters.ts";

const file = (path: string, lineCount: number): FileCoverage => ({ path, lineCount, category: "source", hash: "hash", readExactLines: 1, readNearLines: 1, editExactLines: 0, editNearLines: 0, readCount: 2, editCount: 0, searchCount: 0, failedCount: 0, unknownCount: 0, activityCount: 2, readExactRanges: [{ start: 1, end: 1 }], readNearRanges: [{ start: 2, end: 2 }], editExactRanges: [], editNearRanges: [] });

test("刷新错误只匹配错误描述，已知失败阶段不能遮住外部或旧错误原文", () => {
  const phase = { phase: "刷新失败", phaseDescriptor: { key: "diagnostics.index.store.m008" } };
  for (const language of ["en", "zh-CN"] as const) {
    for (const errorDescriptor of [undefined, { key: "diagnostics.synthetic.obsolete" }]) {
      assert.equal(refreshFailureReason({ ...phase, error: "external synthetic failure", errorDescriptor }, language), translate(language, "common.originalDetail", { detail: "external synthetic failure" }));
    }
    assert.equal(refreshFailureReason({ ...phase, error: "原始产品错误", errorDescriptor: { key: "common.error.http", params: { status: 503 } } }, language), translate(language, "common.error.http", { status: 503 }));
    assert.equal(refreshFailureReason(phase, language), translate(language, "diagnostics.index.store.m008"));
    assert.equal(refreshFailureReason({ ...phase, errorDescriptor: { key: "common.error.http", params: { status: 503 } } }, language), translate(language, "diagnostics.index.store.m008"));
    assert.equal(refreshFailureReason({ phase: "原始合成阶段", phaseDescriptor: { key: "diagnostics.synthetic.obsolete" } }, language), translate(language, "common.originalDetail", { detail: "原始合成阶段" }));
    assert.equal(refreshFailureReason({ ...phase, error: "" }, language), translate(language, "common.originalDetail", { detail: "" }));
  }
});

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

test("目录统计保留层级且包含零行文件", () => {
  const files = [file("src/a.ts", 10), file("src/deep/b.ts", 30), file("src/empty.ts", 0), file("docs/c.ts", 12)];
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
