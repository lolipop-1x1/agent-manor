import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionJob } from "../src/session-contracts.ts";
import { historyJobActive, historyJobCanUpdate, historyJobShouldReload, historySnapshotShouldReload, historyManualJobOutcome, historyManualJobToRead, historyRetryOptions } from "../web/shared/refresh/history-refresh.ts";

const job = (status: SessionJob["status"], id = "job-a"): SessionJob => ({ id, status, phase: "publish", progress: 1,
  createdAt: "2026-01-01T00:00:00Z", version: "version-a" });

test("迟到状态不会将完成任务退回运行或覆盖正在执行的新任务", () => {
  assert.equal(historyJobCanUpdate(job("complete"), job("running")), false);
  assert.equal(historyJobCanUpdate(job("running"), job("queued")), false);
  assert.equal(historyJobCanUpdate(job("running"), job("complete", "job-b")), true);
  assert.equal(historyJobCanUpdate({ ...job("complete", "job-b"), createdAt: "2026-01-01T01:00:00Z" }, job("running")), false);
  assert.equal(historyJobCanUpdate(job("complete"), job("queued", "job-b"), true), true);
});

test("错过任务完成阶段后，最新快照仍能切换到后继任务", () => {
  const running = job("running");
  const successor = { ...job("running", "job-b"), createdAt: "2026-01-01T00:01:00Z" };
  assert.equal(historyJobCanUpdate(running, successor), true);
  assert.equal(historyJobCanUpdate(successor, running), false);
});

test("完整版本观察不依赖当前任务范围、终态或是否观察过运行阶段", () => {
  assert.equal(historySnapshotShouldReload(false, undefined, { version: "version-a" }), false);
  assert.equal(historySnapshotShouldReload(true, undefined, { version: "version-a" }), true);
  assert.equal(historySnapshotShouldReload(true, "version-a", { version: "version-a", job: job("complete") }), false);
  assert.equal(historySnapshotShouldReload(true, "version-a", { version: "version-b" }), true);
  assert.equal(historySnapshotShouldReload(true, "version-a", { version: "version-b", job: { ...job("running"), client: "claude" } }), true);
  assert.equal(historySnapshotShouldReload(true, "version-a", { version: "version-b", job: job("failed") }), true);
  assert.equal(historySnapshotShouldReload(true, "version-b", { version: "version-b", job: job("failed") }), false);
  assert.equal(historySnapshotShouldReload(true, "version-a", {}), false);
});

test("手动检查完成且未变化仍可重读一次，自动检查不重复通知", () => {
  const summary = { version: "version-a", job: job("complete") };
  assert.equal(historySnapshotShouldReload(true, "version-a", summary, undefined, summary.job.id), true);
  assert.equal(historySnapshotShouldReload(true, "version-a", summary, summary.job.id, summary.job.id), false);
  assert.equal(historySnapshotShouldReload(true, "version-a", summary), false);
});

test("旧完成记录及失败状态不触发历史更新联动", () => {
  assert.equal(historyJobShouldReload(undefined, job("complete")), false);
  assert.equal(historyJobShouldReload("old-version", job("failed")), false);
  assert.equal(historyJobShouldReload("version-a", job("complete")), false);
});

test("自动同步无变化不重读，版本变化或手动同步只通知一次", () => {
  const running = job("running"), complete = job("complete");
  assert.equal(historyJobShouldReload("version-a", complete), false);
  assert.equal(historyJobShouldReload("old-version", complete), true);
  assert.equal(historyJobShouldReload("old-version", complete, complete.id), false);
  assert.equal(historyJobShouldReload("version-a", complete, undefined, true), true);
  assert.equal(historyJobShouldReload("version-a", complete, complete.id, true), false);
  assert.equal(historyJobShouldReload("old-version", running), false);
  assert.equal(historyJobActive(running), true);
  assert.equal(historyJobActive(job("queued")), true);
  assert.equal(historyJobActive(complete), false);
});

test("首次索引从运行到完整发布时通知页面，初始旧完成记录不通知", () => {
  const running = job("running"), complete = job("complete");
  assert.equal(historyJobShouldReload(undefined, complete, undefined, false, running), true);
  assert.equal(historyJobShouldReload(undefined, complete, complete.id, false, running), false);
  assert.equal(historyJobShouldReload(undefined, complete, undefined, false, complete), false);
  assert.equal(historyJobShouldReload(undefined, complete, undefined, false, job("running", "other-job")), false);
});

test("全局失败的重试始终为全客户端快速检查，不继承上次局部请求", () => {
  const localRequest = { client: "claude" as const, mode: "full" as const };
  const localFailed = { ...job("failed"), ...localRequest };
  assert.deepEqual(historyRetryOptions({ error: "synthetic global failure" }, localFailed, localRequest), { mode: "quick" });
  assert.deepEqual(historyRetryOptions({ error: "synthetic global failure" }, job("complete"), localRequest), { mode: "quick" });
  assert.deepEqual(historyRetryOptions(undefined, localFailed, { mode: "quick" }), localRequest);
  assert.deepEqual(historyRetryOptions(undefined, job("complete"), localRequest), localRequest);
});

test("手动无变化任务被后继摘要替代，按身份确认终态且只主动重读一次", () => {
  let pendingId: string | undefined = "job-a";
  const successor = { ...job("running", "job-b"), createdAt: "2026-01-01T00:01:00Z" };
  const completed = job("complete");
  assert.equal(historySnapshotShouldReload(true, "version-a", { version: "version-a", job: successor }, undefined, pendingId), false);
  assert.equal(historyManualJobToRead(pendingId, successor), completed.id);
  assert.equal(historyManualJobOutcome(pendingId, successor), undefined);
  assert.equal(historyManualJobOutcome(pendingId, job("running")), undefined);
  assert.equal(historyManualJobOutcome(pendingId, completed), "complete");
  assert.equal(historyJobCanUpdate(successor, completed), false, "手动完成不把后继进度退回旧任务");
  pendingId = undefined;
  assert.equal(historyManualJobToRead(pendingId, successor), undefined);
  assert.equal(historyManualJobOutcome(pendingId, completed), undefined, "终态确认后不重复主动通知");
  assert.equal(historyManualJobToRead(completed.id, completed), undefined, "摘要已包含该任务时不增加请求");
});

test("错过的手动失败独立结算，不被后继成功吞掉，也不产生重读", () => {
  const pendingId = "job-a";
  assert.equal(historyManualJobToRead(pendingId, job("complete", "job-b")), pendingId);
  assert.equal(historyManualJobOutcome(pendingId, job("failed")), "failed");
  assert.equal(historyManualJobOutcome(pendingId, job("complete", "job-b")), undefined);
});
