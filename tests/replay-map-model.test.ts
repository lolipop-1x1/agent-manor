import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileCoverage } from "../src/contracts.ts";
import type { ReplayStep } from "../src/replay-contracts.ts";
import { layoutMap, visibleTiles } from "../web/features/code-map/map-layout.ts";
import { fitCamera, projectRect } from "../web/shared/map/geometry.ts";
import { replayCallouts, replayCollapsedModules, replayDirectories, replayFollowDirectory, replayModuleActivity, replaySessionFiles, type ReplayMapPlayback } from "../web/features/code-map/replay-map-model.ts";

const file = (path: string, lineCount = 100): FileCoverage => ({ path, lineCount, category: "source", hash: "", readExactLines: 0, readNearLines: 0, editExactLines: 0, editNearLines: 0,
  readCount: 0, editCount: 0, activityCount: 0, searchCount: 0, failedCount: 0, unknownCount: 0, readExactRanges: [], readNearRanges: [], editExactRanges: [], editNearRanges: [] });
const step = (id: string, paths: string[], trackId = "main", time?: number): ReplayStep => ({ id, trackId, order: 0, time, activities: [{ id, tool: "synthetic_tool", kind: "read", status: "success", paths }] });
const marker = { track: 0, kind: "edit", status: "unknown" };

test("会话观看范围包含未来、子轨和未定时明确文件，目录搜索不推断为文件活动", () => {
  const files = [file("src/a.ts"), file("src/next.ts"), file("tests/a.ts"), file("README.md"), file("unrelated.ts", 12_000)];
  const steps = [step("root-search", ["."]), step("directory-search", ["src"]), step("first", ["src/a.ts"], "main", 100), step("future", ["src/next.ts"], "child", 1000), step("untimed", ["tests/a.ts"]), step("missing", ["deleted.ts"])];
  assert.deepEqual(replaySessionFiles(files, steps).map(file => file.path), ["src/a.ts", "src/next.ts", "tests/a.ts"]);
  assert.deepEqual(replaySessionFiles(files, [step("directory-only", [".", "src"])]), []);
  assert.deepEqual(files.map(file => file.path), ["src/a.ts", "src/next.ts", "tests/a.ts", "README.md", "unrelated.ts"]);
  assert.equal(steps.length, 6);
});

test("目录选择保留完整路径，跟随模块由所有并行活动的共同目录决定", () => {
  const files = [file("src/history/adapters/a.ts"), file("src/history/model.ts"), file("src/sessions/a.ts"), file("tests/a.ts"), file("README.md")];
  const directories = replayDirectories(files);
  assert.deepEqual(directories, ["src", "src/history", "src/history/adapters", "src/sessions", "tests"]);
  const paths = new Set(directories);
  assert.equal(replayFollowDirectory(["src/history/adapters/a.ts"], paths), "src/history");
  assert.equal(replayFollowDirectory(["src/history/adapters/a.ts", "src/history/model.ts"], paths), "src/history");
  assert.equal(replayFollowDirectory(["src/history/model.ts", "src/sessions/a.ts"], paths), "src");
  assert.equal(replayFollowDirectory(["src/history/model.ts", "tests/a.ts"], paths), "");
  assert.equal(replayFollowDirectory(["src/history", "src/history/adapters/a.ts"], paths), "src/history");
  assert.equal(replayFollowDirectory(["README.md"], paths), "");
  assert.equal(replayFollowDirectory([], paths), null);
});

test("大树缩小时聚合模块，放大后展开；聚合不改变逻辑布局", () => {
  const files = Array.from({ length: 500 }, (_, index) => file(`src/module-${index % 10}/file-${index}.ts`));
  files.push(file("tests/example.ts"));
  const layout = layoutMap(files, "");
  const viewport = { width: 800, height: 450 };
  const camera = fitCamera(layout.bounds, viewport);
  const before = layout.files.map(tile => ({ path: tile.path, x: tile.x, y: tile.y, width: tile.width, height: tile.height }));
  assert.equal(replayCollapsedModules(layout, camera, viewport)[0]?.directory.path, "src");
  assert.equal(replayCollapsedModules(layout, { ...camera, scale: camera.scale * 8 }, { width: 6400, height: 3600 }).length, 0);
  assert.deepEqual(layout.files.map(tile => ({ path: tile.path, x: tile.x, y: tile.y, width: tile.width, height: tile.height })), before);
});

test("微小当前活动有界显示最多三个路径标签，不改变文件面积且标签彼此不重叠", () => {
  const files = [file("src/unrelated.ts", 1_000_000), ...Array.from({ length: 8 }, (_, index) => file(`src/tiny-${index}.ts`, 1))];
  const layout = layoutMap(files, "");
  const viewport = { width: 1000, height: 500 };
  const camera = fitCamera(layout.bounds, viewport);
  const visible = visibleTiles(layout.files, camera, viewport);
  const playback: ReplayMapPlayback = { visited: new Map(), current: new Map(files.slice(1).map(file => [file.path, [marker]])) };
  const selected = "src/tiny-7.ts";
  const labels = replayCallouts(visible, playback, viewport, selected);
  assert.equal(labels.length, 3);
  assert.equal(labels[0]?.tile.path, selected);
  assert.equal(labels[0]?.markers[0]?.status, "unknown");
  for (const { label, tile } of labels) {
    assert.ok(label.x >= 0 && label.y >= 0 && label.x + label.width <= viewport.width && label.y + label.height <= viewport.height);
    assert.ok(label.width >= 90 && label.height >= 18);
    assert.ok(projectRect(tile, camera).width * projectRect(tile, camera).height < label.width * label.height);
  }
  for (let index = 0; index < labels.length; index += 1) for (const other of labels.slice(index + 1)) {
    const label = labels[index]!.label;
    assert.ok(label.x + label.width <= other.label.x || other.label.x + other.label.width <= label.x || label.y + label.height <= other.label.y || other.label.y + other.label.height <= label.y);
  }
});

test("模块活动汇总保留轨道和状态，不把同名前缀目录计入", () => {
  const playback: ReplayMapPlayback = { visited: new Map([["src/history/a.ts", 1]]), current: new Map([
    ["src/history/a.ts", [marker]], ["src/history/b.ts", [marker, { track: 1, kind: "read", status: "success" }]], ["src/history-other/a.ts", [marker]],
  ]) };
  assert.deepEqual(replayModuleActivity("src/history", playback), { files: 2, visited: true, markers: [marker, { track: 1, kind: "read", status: "success" }] });
});
