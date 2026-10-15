import assert from "node:assert/strict";
import { test } from "node:test";
import { panelWidthRange, workspaceWidths } from "../web/shared/layout/workspace-layout.ts";

const expanded = { sidebar: false, details: false };

test("面板默认宽度沿用桌面与窄屏布局", () => {
  assert.deepEqual(workspaceWidths(1440, {}, expanded), { sidebar: 200, details: 320 });
  assert.deepEqual(workspaceWidths(1200, {}, expanded), { sidebar: 175, details: 285 });
  assert.deepEqual(workspaceWidths(900, {}, expanded), { sidebar: 170, details: 285 });
});

test("工作区按阅读与资源任务分配宽度，用户调整仍优先", () => {
  assert.deepEqual(workspaceWidths(1280, {}, expanded, "sessions"), { sidebar: 300, details: 260 });
  assert.deepEqual(workspaceWidths(1280, {}, expanded, "resources"), { sidebar: 220, details: 400 });
  assert.deepEqual(workspaceWidths(1920, {}, expanded, "resources"), { sidebar: 220, details: 440 });
  for (const variant of ["sessions", "resources"] as const) {
    assert.deepEqual(workspaceWidths(1440, { sidebar: 350, details: 380 }, expanded, variant), { sidebar: 350, details: 380 });
    const compact = workspaceWidths(1024, { sidebar: 460, details: 620 }, expanded, variant);
    assert.ok(1024 - compact.sidebar - compact.details >= 360 - 1e-7);
    assert.deepEqual(workspaceWidths(1024, {}, { sidebar: true, details: true }, variant), { sidebar: 44, details: 44 });
  }
});

test("拖动范围保护相邻面板与地图，右侧堆叠时不占横向空间", () => {
  const widths = { sidebar: 300, details: 400 };
  assert.deepEqual(panelWidthRange("sidebar", 1024, widths), { min: 160, max: 264 });
  assert.deepEqual(panelWidthRange("details", 1024, widths), { min: 260, max: 364 });
  assert.deepEqual(panelWidthRange("sidebar", 900, widths), { min: 160, max: 480 });
  assert.equal(panelWidthRange("sidebar", 800, { sidebar: 170, details: 44 }).max, 396);
});

test("调整后的宽度在收起、恢复与窗口变窄后保留偏好", () => {
  const preferred = { sidebar: 460, details: 620 };
  const snapshot = { ...preferred };
  assert.deepEqual(workspaceWidths(1920, preferred, expanded), preferred);
  const compact = workspaceWidths(1024, preferred, expanded);
  assert.ok(compact.sidebar >= 160 && compact.details >= 260);
  assert.ok(1024 - compact.sidebar - compact.details >= 360 - 1e-7);
  assert.deepEqual(workspaceWidths(1024, preferred, { sidebar: true, details: true }), { sidebar: 44, details: 44 });
  assert.deepEqual(workspaceWidths(1920, preferred, expanded), snapshot);
  assert.deepEqual(preferred, snapshot);
  const stacked = workspaceWidths(768, preferred, { sidebar: false, details: true });
  assert.equal(stacked.sidebar, 364);
});

test("超出上下限的宽度被约束，四种收起组合均不挤压地图", () => {
  assert.deepEqual(workspaceWidths(1920, { sidebar: 0, details: 9999 }, expanded), { sidebar: 160, details: 640 });
  for (const sidebar of [true, false]) for (const details of [true, false]) {
    const widths = workspaceWidths(1024, { sidebar: 480, details: 640 }, { sidebar, details });
    assert.ok(1024 - widths.sidebar - widths.details >= 360 - 1e-7);
    if (sidebar) assert.equal(widths.sidebar, 44);
    if (details) assert.equal(widths.details, 44);
  }
});
