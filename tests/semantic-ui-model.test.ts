import assert from "node:assert/strict";
import { test } from "node:test";
import type { SemanticStatus } from "../src/semantic-contracts.ts";
import { localSemanticDate, semanticCost, semanticDateBoundary, semanticProgress, semanticQueryScope } from "../web/features/sessions/semantic-ui-model.ts";

test("查询缺省覆盖所有日期，范围实例不共用可变筛选", () => {
  const first = semanticQueryScope();
  first.clients.push("codex");
  first.timeRange = "recent";
  const second = semanticQueryScope();
  assert.equal(second.timeRange, "all");
  assert.deepEqual(second.clients, []);
  assert.equal(second.from, undefined);
  assert.equal(second.to, undefined);
  assert.equal(second.relationship, "exclude_children");
});

test("扫描没有确定分母时不展示虚构百分比，零新增输入完成后展示完成态", () => {
  const status = { job: { phase: "scanning", completedInputs: 0, totalInputs: 20 } } as SemanticStatus;
  assert.equal(semanticProgress(status), undefined);
  status.job!.phase = "encoding";
  status.job!.totalInputs = 0;
  assert.equal(semanticProgress(status), undefined);
  status.job!.phase = "complete";
  assert.equal(semanticProgress(status), 100);
});

test("未知费用、免费和非零微额费用保持不同含义", () => {
  for (const language of ["en", "zh-CN"]) {
    assert.equal(semanticCost(undefined, language), undefined);
    assert.equal(semanticCost(null, language), undefined);
    assert.notEqual(semanticCost(0, language), undefined);
    for (const value of [0.000000001, 0.0000008, 0.00042]) {
      assert.notEqual(semanticCost(value, language), semanticCost(0, language));
      assert.match(semanticCost(value, language)!, /[1-9]/);
    }
  }
});

test("语义筛选日期沿用本地日历边界，夏令时日期不强制按24小时延伸", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const start = semanticDateBoundary("2026-03-08")!;
    const end = semanticDateBoundary("2026-03-08", true)!;
    assert.equal(start, "2026-03-08T05:00:00.000Z");
    assert.equal(end, "2026-03-09T03:59:59.999Z");
    assert.equal(new Date(end).getTime() - new Date(start).getTime() + 1, 23 * 60 * 60 * 1000);
    assert.equal(localSemanticDate(start), "2026-03-08");
    assert.equal(localSemanticDate(end), "2026-03-08");
    assert.equal(semanticDateBoundary(""), undefined);
    assert.equal(localSemanticDate(undefined), "");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("失败和暂停计划可重新预览，吞吐不把复用算新编码且暂停不编 ETA", async () => {
  const { semanticCanRepreview, semanticBuildMetrics } = await import("../web/features/sessions/semantic-ui-model.ts");
  const status = { job: { status: "failed", totalInputs: 10, completedInputs: 6, reusedInputs: 4, createdAt: "2026-01-01T00:00:00Z" } } as SemanticStatus;
  assert.equal(semanticCanRepreview(status), true);
  status.job!.status = "paused"; assert.equal(semanticCanRepreview(status), true);
  const now = Date.parse("2026-01-01T00:01:00Z"); assert.deepEqual(semanticBuildMetrics(status, now), { encoded: 2, perMinute: 2, remainingSeconds: undefined });
  status.job!.status = "running"; assert.equal(semanticCanRepreview(status), false); assert.equal(semanticBuildMetrics(status, now).remainingSeconds, 120);
  status.job!.completedInputs = 4; assert.equal(semanticBuildMetrics(status, now).perMinute, undefined); assert.equal(semanticBuildMetrics(status, now).remainingSeconds, undefined);
});
