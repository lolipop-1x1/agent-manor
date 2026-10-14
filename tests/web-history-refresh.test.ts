import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionJob } from "../src/session-contracts.ts";
import { historyJobActive, historyJobCanUpdate, historyJobShouldReload } from "../web/shared/refresh/history-refresh.ts";

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
