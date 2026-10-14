import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionJob } from "../src/session-contracts.ts";
import { historyJobActive, historyJobCanUpdate, historyJobCompleted } from "../web/shared/refresh/history-refresh.ts";

const job = (status: SessionJob["status"], id = "job-a"): SessionJob => ({ id, status, phase: "publish", progress: 1,
  createdAt: "2026-01-01T00:00:00Z", version: "version-a" });

test("迟到状态不会将完成任务退回运行或覆盖正在执行的新任务", () => {
  assert.equal(historyJobCanUpdate(job("complete"), job("running")), false);
  assert.equal(historyJobCanUpdate(job("running"), job("queued")), false);
  assert.equal(historyJobCanUpdate(job("running"), job("complete", "job-b")), false);
  assert.equal(historyJobCanUpdate({ ...job("complete", "job-b"), createdAt: "2026-01-01T01:00:00Z" }, job("running")), false);
  assert.equal(historyJobCanUpdate(job("complete"), job("queued", "job-b"), true), true);
});

test("旧完成记录及失败状态不触发历史更新联动", () => {
  assert.equal(historyJobCompleted(undefined, job("complete")), false);
  assert.equal(historyJobCompleted(job("running"), job("failed")), false);
  assert.equal(historyJobCompleted(job("running"), job("complete", "job-b")), false);
});

test("本次任务完成只通知一次，无变化仍允许页面读取检查后的结果", () => {
  const running = job("running"), complete = job("complete");
  assert.equal(historyJobCompleted(running, complete), true);
  assert.equal(historyJobCompleted(running, complete, complete.id), false);
  assert.equal(historyJobCompleted(complete, complete), false);
  assert.equal(historyJobCompleted(undefined, complete, undefined, true), true);
  assert.equal(historyJobActive(running), true);
  assert.equal(historyJobActive(job("queued")), true);
  assert.equal(historyJobActive(complete), false);
});
