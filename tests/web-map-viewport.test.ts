import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileCoverage } from "../src/contracts.ts";
import { fileLabelRect } from "../web/model.ts";
import {
  clipRect, fitCamera, layoutMap, locateCamera, panCamera, projectRect, refreshCamera, resizeCamera, visibleTiles, zoomCamera,
  type MapCamera, type MapPoint, type MapRect, type MapSize,
} from "../web/map-viewport.ts";

const file = (path: string, lineCount: number): FileCoverage => ({ path, lineCount, category: "source", hash: "synthetic", readExactLines: 0, readNearLines: 0, editExactLines: 0, editNearLines: 0, readCount: 0, editCount: 0, searchCount: 0, failedCount: 0, unknownCount: 0, activityCount: 0, readExactRanges: [], readNearRanges: [], editExactRanges: [], editNearRanges: [] });
const close = (actual: number, expected: number, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} 应接近 ${expected}`);
const worldAt = (camera: MapCamera, point: MapPoint): MapPoint => ({ x: (point.x - camera.x) / camera.scale, y: (point.y - camera.y) / camera.scale });
const valid = (bounds: MapRect) => {
  for (const value of [bounds.x, bounds.y, bounds.width, bounds.height]) assert.ok(Number.isFinite(value));
  assert.ok(bounds.width > 0);
  assert.ok(bounds.height > 0);
};

test("自动换版保留中心文件与文件内位置，适配全图和文件移除均有效", () => {
  const viewport = { width: 900, height: 600 };
  const previous = layoutMap([file("src/a.ts", 100), file("src/b.ts", 50)], "");
  const next = layoutMap([file("src/a.ts", 200), file("src/b.ts", 50), file("src/c.ts", 60)], "");
  const anchor = previous.files.find(tile => tile.path === "src/b.ts")!;
  const camera = { scale: 4, x: viewport.width / 2 - (anchor.x + anchor.width * .3) * 4, y: viewport.height / 2 - (anchor.y + anchor.height * .7) * 4 };
  const refreshed = refreshCamera(camera, previous, next, viewport);
  const replacement = next.files.find(tile => tile.path === anchor.path)!;
  const center = worldAt(refreshed, { x: viewport.width / 2, y: viewport.height / 2 });
  close((center.x - replacement.x) / replacement.width, .3); close((center.y - replacement.y) / replacement.height, .7);
  assert.deepEqual(refreshCamera(fitCamera(previous.bounds, viewport), previous, next, viewport), fitCamera(next.bounds, viewport));
  const missing = refreshCamera(camera, previous, layoutMap([file("src/a.ts", 100)], ""), viewport);
  assert.ok(Number.isFinite(missing.scale) && missing.scale > 0);
});

test("文件标签避让屏幕目录标题，原始面积与无关标签位置不变", () => {
  const rect = { x: 20, y: 30, width: 160, height: 120 };
  const original = { ...rect };
  const heading = { x: 25, y: 33, width: 150, height: 22 };
  const labels = fileLabelRect(rect, [heading]);
  assert.ok(labels.y >= heading.y + heading.height + 4);
  assert.ok(labels.y + labels.height <= rect.y + rect.height);
  assert.ok(labels.x >= rect.x && labels.x + labels.width <= rect.x + rect.width);
  assert.deepEqual(rect, original);
  assert.deepEqual(fileLabelRect(rect, [{ ...heading, x: 200 }]), fileLabelRect(rect, []));
  assert.deepEqual(fileLabelRect(rect, [{ ...heading, y: 200 }]), fileLabelRect(rect, []));
  const tiny = { x: 20, y: 30, width: 40, height: 20 };
  assert.equal(fileLabelRect(tiny, [heading]).height, 0);
  assert.ok(fileLabelRect(tiny, [heading]).width > 0);
});

test("悬殊行数的小文件定位后，目录标题下仍可显示名称、指标和行数", () => {
  const layout = layoutMap([file("large.ts", 90_000), file("medium.ts", 10_000), file("small/tiny.ts", 1)], "");
  const viewport = { width: 800, height: 500 };
  const tiny = layout.files.find(tile => tile.path === "small/tiny.ts")!;
  const original = { ...tiny };
  const camera = locateCamera(tiny, viewport, fitCamera(layout.bounds, viewport).scale, layout.maxScale);
  const visible = clipRect(projectRect(tiny, camera), viewport)!;
  const headings = layout.directories.filter(node => node.depth === 1).map(node => {
    const rect = clipRect(projectRect(node, camera), viewport)!;
    return { x: rect.x + 5, y: rect.y + 3, width: rect.width - 10, height: 22 };
  });
  const labels = fileLabelRect(visible, headings);
  assert.ok(labels.width >= 102);
  assert.ok(labels.height >= 78);
  assert.deepEqual(tiny, original);
});

test("逻辑布局保持目录和行数比例，零行文件不获得面积", () => {
  const files = [file("src/a.ts", 10), file("src/deep/b.ts", 30), file("src/empty.ts", 0), file("docs/a.md", 20)];
  const snapshot = structuredClone(files);
  const layout = layoutMap(files, "src");
  assert.deepEqual(layout.bounds, { x: 0, y: 0, width: 1000, height: 650 });
  assert.deepEqual(layout.files.map(tile => tile.path).sort(), ["src/a.ts", "src/deep/b.ts"]);
  assert.equal(layout.directories[0]?.path, "src/deep");
  const a = layout.files.find(tile => tile.path === "src/a.ts")!;
  const b = layout.files.find(tile => tile.path === "src/deep/b.ts")!;
  close(b.width * b.height / (a.width * a.height), 3);
  assert.deepEqual(files, snapshot);
  assert.deepEqual(layoutMap([...files].reverse(), "src"), layout);
});

test("一万个合成文件包含悬殊行数和长文件名，全部非空叶子可放大至可读尺寸", () => {
  for (const largest of [100_000, Number.MAX_SAFE_INTEGER]) {
    const files = Array.from({ length: 10_000 }, (_, index) => file(`group-${index % 80}/file-${index}-${"long-name-".repeat(index % 7)}.ts`, index === 0 ? largest : index % 13 === 0 ? 20 : 1));
    files.push(file("empty.ts", 0));
    const layout = layoutMap(files, "");
    assert.equal(layout.files.length, 10_000);
    assert.ok(layout.maxScale > 16);
    for (const tile of layout.files) {
      valid(tile);
      assert.ok(tile.x >= 0 && tile.y >= 0);
      assert.ok(tile.x + tile.width <= layout.bounds.width + 1e-7);
      assert.ok(tile.y + tile.height <= layout.bounds.height + 1e-7);
      assert.ok(tile.width * layout.maxScale >= 160 - 1e-6);
      assert.ok(tile.height * layout.maxScale >= 128 - 1e-6);
    }
  }
});

test("深目录不消耗叶子面积，极端行数仍保留有限的正面积", () => {
  const deep = `${Array.from({ length: 180 }, (_, index) => `level-${index}`).join("/")}/tiny.ts`;
  const layout = layoutMap([file("large.ts", Number.MAX_SAFE_INTEGER), file(deep, 1), file("other/tiny.ts", 1)], "");
  assert.equal(layout.files.length, 3);
  assert.equal(layout.directories.length, 181);
  assert.ok(Number.isFinite(layout.maxScale));
  for (const tile of layout.files) {
    valid(tile);
    assert.ok(tile.width * layout.maxScale >= 160 - 1);
    assert.ok(tile.height * layout.maxScale >= 128 - 1);
  }
  const tiny = layout.files.find(tile => tile.path === deep)!;
  const deepest = layout.directories.find(node => node.depth === 180)!;
  assert.deepEqual({ x: tiny.x, y: tiny.y, width: tiny.width, height: tiny.height }, { x: deepest.x, y: deepest.y, width: deepest.width, height: deepest.height });
});

test("单文件和少量文件的上限保留充足余量，完整适应和文件可读后仍能继续放大", () => {
  const viewport = { width: 2800, height: 1800 };
  const focus = { x: viewport.width / 2, y: viewport.height / 2 };
  for (const files of [[file("single.ts", 20)], [file("large.ts", 100_000), file("tiny.ts", 1)]]) {
    const layout = layoutMap(files, "");
    const fitted = fitCamera(layout.bounds, viewport);
    assert.ok(layout.maxScale >= 1024);
    assert.ok(layout.maxScale > fitted.scale * 16);
    assert.equal(zoomCamera(fitted, 16, focus, fitted.scale, layout.maxScale).scale, fitted.scale * 16);
    for (const tile of layout.files) {
      const readable = Math.max(160 / tile.width, 128 / tile.height);
      assert.ok(layout.maxScale >= readable * 16);
      const located = locateCamera(tile, viewport, fitted.scale, layout.maxScale);
      assert.ok(zoomCamera(located, 2, focus, fitted.scale, layout.maxScale).scale > located.scale);
    }
  }
});

test("焦点缩放保持同一个逻辑点，倍率在动态边界处稳定", () => {
  const camera = { x: -75, y: 22, scale: 1.4 };
  const focus = { x: 317, y: 193 };
  const before = worldAt(camera, focus);
  for (const factor of [1.6, 0.7, 1e9, 1e-9]) {
    const result = zoomCamera(camera, factor, focus, 0.5, 20_000);
    const after = worldAt(result, focus);
    close(after.x, before.x);
    close(after.y, before.y);
    assert.ok(result.scale >= 0.5 && result.scale <= 20_000);
  }
  assert.equal(zoomCamera(camera, Infinity, focus, 0.5, 20_000), camera);
  assert.equal(zoomCamera(camera, -1, focus, 0.5, 20_000), camera);
  assert.equal(zoomCamera(camera, NaN, focus, 0.5, 20_000), camera);
  assert.equal(zoomCamera(camera, 2, { x: NaN, y: 0 }, 0.5, 20_000), camera);
});

test("平移和视口尺寸变化保持倍率及中心逻辑点，适应窗口覆盖完整世界", () => {
  const bounds = { x: 0, y: 0, width: 1000, height: 650 };
  const previous = { width: 720, height: 450 };
  const next = { width: 1280, height: 800 };
  const fitted = fitCamera(bounds, previous);
  const projected = projectRect(bounds, fitted);
  assert.ok(projected.x >= 12 && projected.y >= 12);
  assert.ok(projected.x + projected.width <= previous.width - 12 + 1e-7);
  assert.ok(projected.y + projected.height <= previous.height - 12 + 1e-7);
  const camera = panCamera(zoomCamera(fitted, 12, { x: 250, y: 150 }, fitted.scale, 1000), { x: 51, y: -24 });
  const resized = resizeCamera(camera, previous, next);
  const oldCenter = worldAt(camera, { x: previous.width / 2, y: previous.height / 2 });
  const newCenter = worldAt(resized, { x: next.width / 2, y: next.height / 2 });
  assert.equal(resized.scale, camera.scale);
  close(newCenter.x, oldCenter.x);
  close(newCenter.y, oldCenter.y);
  assert.deepEqual(resizeCamera(resized, next, previous), camera);
  const newFit = projectRect(bounds, fitCamera(bounds, next));
  assert.ok(newFit.width > projected.width && newFit.height > projected.height);
});

test("极小文件定位进入可读局部，裁剪与可见叶子不改变原始几何或文件", () => {
  const layout = layoutMap([file("large.ts", 100_000), file("tiny.ts", 1), file("empty.ts", 0)], "");
  const viewport: MapSize = { width: 800, height: 500 };
  const tiny = layout.files.find(tile => tile.path === "tiny.ts")!;
  const minimum = fitCamera(layout.bounds, viewport).scale;
  const camera = locateCamera(tiny, viewport, minimum, layout.maxScale);
  const projected = projectRect(tiny, camera);
  close(projected.x + projected.width / 2, viewport.width / 2);
  close(projected.y + projected.height / 2, viewport.height / 2);
  assert.ok(projected.width >= 160 && projected.height >= 128 - 1e-7);
  const visible = visibleTiles(layout.files, camera, viewport);
  assert.ok(visible.some(item => item.tile === tiny));
  for (const item of visible) {
    assert.ok(item.visible.x >= 0 && item.visible.y >= 0);
    assert.ok(item.visible.x + item.visible.width <= viewport.width);
    assert.ok(item.visible.y + item.visible.height <= viewport.height);
    assert.equal(item.tile.file, layout.files.find(tile => tile.path === item.tile.path)!.file);
  }
  assert.deepEqual(clipRect({ x: -20, y: -15, width: 100, height: 80 }, { width: 60, height: 40 }), { x: 0, y: 0, width: 60, height: 40 });
  assert.equal(clipRect({ x: 60, y: 0, width: 20, height: 20 }, { width: 60, height: 40 }), null);
  assert.equal(clipRect({ x: 0, y: 0, width: 0, height: 20 }, viewport), null);
});

test("空布局与暂时不可测量的视口保留有限相机，异常平移不会引入非数值", () => {
  const layout = layoutMap([file("empty.ts", 0)], "");
  assert.deepEqual(layout.files, []);
  assert.deepEqual(layout.directories, []);
  assert.equal(layout.maxScale, 1024);
  const camera = fitCamera(layout.bounds, { width: 0, height: 0 });
  assert.ok(camera.scale > 0 && Number.isFinite(camera.scale));
  assert.deepEqual(visibleTiles([], camera, { width: 0, height: 0 }), []);
  assert.deepEqual(panCamera(camera, { x: NaN, y: Infinity }), camera);
  const extreme = panCamera({ x: Number.MAX_SAFE_INTEGER, y: 0, scale: 1 }, { x: Number.MAX_VALUE, y: -Number.MAX_VALUE });
  assert.ok(Number.isFinite(extreme.x) && Number.isFinite(extreme.y));
  const zoomed = zoomCamera(camera, Number.MAX_VALUE, { x: 0, y: 0 }, camera.scale, Number.MAX_VALUE);
  assert.ok(Object.values(zoomed).every(Number.isFinite));
});
