import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReplayStep } from "../src/replay-contracts.ts";
import { buildReplayIndex, replayCurrentRange, replayEndIndex, replayLaneHit, replayNext, replayNextEdit, replayOriginalTime, replayPathSteps, replayPrevious, replayRecentRange, replaySimultaneousSteps, ReplayAccumulator, validReplaySpeed } from "../web/features/code-map/replay-model.ts";

const step = (id: string, trackId: string, time: number | undefined, paths: string[], order = 0): ReplayStep => ({ id, trackId, time, order,
  activities: [{ id: `event-${id}`, tool: "synthetic_tool", kind: "read", status: "success", paths }] });

test("所有子轨共用压缩坐标，长空档不会改变并行活动的对齐", () => {
  const index = buildReplayIndex([
    step("a", "parent", 1000, ["src/a.ts"]),
    step("b", "child-a", 3000, ["src/b.ts"]),
    step("c", "child-b", 3000, ["src/c.ts"]),
    step("d", "parent", 603000, ["src/d.ts"]),
  ]);
  assert.deepEqual(index.timed.map(value => value.position), [0, 2000, 2000, 2900]);
  assert.equal(index.segments.filter(segment => segment.collapsed).length, 1);
  assert.equal(replayOriginalTime(index, 2000), 3000);
  assert.equal(replayOriginalTime(index, 2900), 603000);
  assert.equal(replayOriginalTime(index, index.duration), 603000);
  const [start, end] = replayCurrentRange(index, 2000);
  assert.deepEqual(index.timed.slice(start, end).map(value => value.step.id), ["b", "c"]);
});

test("向后拖动撤销未来痕迹，同一次调用多文件和重复路径各计一次", () => {
  const index = buildReplayIndex([
    step("a", "main", 1000, ["src/a.ts", "src/a.ts", "src/b.ts"]),
    step("b", "main", 2000, ["src/a.ts"]),
    step("c", "child", 3000, ["src/c.ts"]),
  ]);
  const accumulator = new ReplayAccumulator(index);
  assert.deepEqual([...accumulator.seek(3)], [["src/a.ts", 2], ["src/b.ts", 1], ["src/c.ts", 1]]);
  assert.deepEqual([...accumulator.seek(1)], [["src/a.ts", 1], ["src/b.ts", 1]]);
  assert.equal(accumulator.seek(0).size, 0);
  assert.equal(accumulator.seek(2).get("src/a.ts"), 2);
  assert.deepEqual(replayPathSteps(index, "src/a.ts", 1).map(step => step.id), ["a"]);
  assert.deepEqual(replayPathSteps(index, "src/a.ts", 2).map(step => step.id), ["b", "a"]);
  assert.deepEqual(replayPathSteps(index, "src/c.ts", 2), []);
});

test("无时间记录在所属轨道保留原顺序，不编入共享时钟", () => {
  const index = buildReplayIndex([step("c", "child", undefined, ["missing.ts"], 3), step("a", "child", undefined, ["src/a.ts"], 1), step("b", "main", 1000, ["src/b.ts"])]);
  assert.deepEqual(index.untimed.get("child")?.map(step => step.id), ["a", "c"]);
  assert.equal(index.timed.length, 1);
  assert.equal(index.paths.has("missing.ts"), false);
  assert.equal(replayEndIndex(index, 0), 1);
  const empty = buildReplayIndex([]);
  assert.equal(empty.duration, 0);
  assert.equal(replayOriginalTime(empty, 0), 0);
});

test("前后活动与拖动定位使用同一序列，原始时间在断轴前后单调", () => {
  const index = buildReplayIndex([step("a", "main", 1000, ["a"]), step("b", "main", 2000, ["b"]), step("c", "main", 200000, ["c"])]);
  assert.equal(replayNext(index, 0), 1000);
  assert.equal(replayPrevious(index, 1000), 0);
  assert.equal(replayNext(index, 1000), 1900);
  assert.equal(replayPrevious(index, 1901), 1900);
  let last = -Infinity;
  for (let position = 0; position <= index.duration; position += 10) {
    const time = replayOriginalTime(index, position);
    assert.ok(time >= last); last = time;
  }
});

test("大型回放保留完整活动和索引，重复定位不改变计数", () => {
  const steps = Array.from({ length: 50_000 }, (_, i) => step(String(i), `track-${i % 4}`, i * 1000, [`src/file-${i % 1000}.ts`], i));
  const index = buildReplayIndex(steps);
  assert.equal(index.timed.length, 50_000);
  const accumulator = new ReplayAccumulator(index);
  assert.equal(accumulator.seek(50_000).get("src/file-0.ts"), 50);
  assert.equal(accumulator.seek(50_000).get("src/file-0.ts"), 50);
  assert.equal(accumulator.seek(25_000).get("src/file-0.ts"), 25);
  assert.equal(replayEndIndex(index, 24_999_000), 25_000);
  assert.equal(replayPathSteps(index, "src/file-0.ts", 25_000).length, 25);
});

test("同轨同时间点完整提供全部调用，不因可视点重叠丢失基线外证据", () => {
  const simultaneous = Array.from({ length: 6 }, (_, i) => step(`same-${i}`, "main", 1000, [`deleted-${i}.ts`], i));
  const child = step("child", "child", 1000, ["child.ts"]);
  const index = buildReplayIndex([...simultaneous, child]);
  for (const activity of simultaneous) assert.deepEqual(replaySimultaneousSteps(index, activity), simultaneous);
  assert.deepEqual(replaySimultaneousSteps(index, child), [child]);
});

test("近期摘要跨越空档保留最后活动，倍速窗口不提前展示未来且限制摘要规模", () => {
  const steps = Array.from({ length: 100 }, (_, i) => step(String(i), `track-${i % 4}`, i * 100, [`file-${i}.ts`]));
  const index = buildReplayIndex(steps);
  assert.deepEqual(replayRecentRange(index, 5000, 10000, 12), [39, 51]);
  assert.deepEqual(replayRecentRange(index, 15000, 1200), [99, 100]);
  assert.deepEqual(replayRecentRange(buildReplayIndex([]), 0), [0, 0]);
  const parallel = buildReplayIndex([step("main", "main", 1000, ["a"]), step("child", "child", 1000, ["b"])]);
  assert.deepEqual(replayRecentRange(parallel, 6000, 1200), [0, 2]);
  const [start, end] = replayCurrentRange(index, 5000, 6400);
  assert.equal(start, 0);
  assert.equal(end, 51);
});

test("密集轨道按最近坐标命中并保留同刻所有调用", () => {
  const steps = Array.from({ length: 500 }, (_, i) => step(String(i), "main", i * 1000, [`file-${i}.ts`]));
  steps.push(step("overlap", "main", 250000, ["extra.ts"]));
  const { timed } = buildReplayIndex(steps);
  assert.deepEqual(replayLaneHit(timed, 250100).map(entry => entry.step.id), ["250", "overlap"]);
  assert.equal(replayLaneHit(timed, -100)[0]?.step.id, "0");
  assert.equal(replayLaneHit(timed, 999999)[0]?.step.id, "499");
  assert.deepEqual(replayLaneHit([], 0), []);
});

test("超过摘要数量上限的最新同刻组完整保留所有并行轨道，空档中也不丢失", () => {
  const parallel = Array.from({ length: 60 }, (_, i) => step(`parallel-${i}`, `track-${i}`, 1000, [`src/file-${i}.ts`]));
  const index = buildReplayIndex([...parallel, step("future", "main", 11000, ["src/future.ts"])]);
  for (const position of [0, 6000]) {
    const [start, end] = replayRecentRange(index, position);
    const shown = index.timed.slice(start, end).map(entry => entry.step);
    assert.equal(shown.length, 60);
    assert.equal(new Set(shown.map(value => value.trackId)).size, 60);
    assert.equal(shown.some(value => value.id === "future"), false);
  }
});

test("下一次修改按共享坐标跳转，忽略读取搜索并合并同刻修改", () => {
  const steps = [step("read", "main", 1000, ["a"]), step("edit-a", "main", 2000, ["a"]), step("edit-b", "child", 2000, ["b"]), step("edit-c", "main", 3000, ["c"])];
  for (const value of steps.slice(1)) value.activities[0]!.kind = "edit";
  const index = buildReplayIndex(steps);
  assert.deepEqual(index.edits, [1000, 2000]);
  assert.equal(replayNextEdit(index, 0), 1000);
  assert.equal(replayNextEdit(index, 1000), 2000);
  assert.equal(replayNextEdit(index, 2000), undefined);
});

test("自定义倍速允许小数及边界，拒绝空范围、非有限值和越界值", () => {
  for (const value of [.25, 1.75, 128, 256]) assert.equal(validReplaySpeed(value), true);
  for (const value of [0, -.5, .24, 257, NaN, Infinity]) assert.equal(validReplaySpeed(value), false);
});
