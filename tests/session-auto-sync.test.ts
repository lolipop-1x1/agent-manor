import assert from "node:assert/strict";
import test from "node:test";
import { SessionAutoSyncScheduler, type SessionAutoSyncClock, type SessionAutoSyncWorker, type SessionGlobalCheckState } from "../src/service/session-auto-sync.js";
import type { SessionJob, SessionRefreshOptions } from "../src/session-contracts.js";
import { sessionRequestCovers } from "../src/index/worker-manager.js";

class Clock implements SessionAutoSyncClock {
  time = Date.parse("2026-01-01T00:00:00Z");
  timers = new Map<number, { at: number; callback: () => void }>();
  sequence = 0;
  now = () => this.time;
  setTimeout(callback: () => void, delayMs: number) {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return () => { this.timers.delete(id); };
  }
  advance(duration: number) {
    this.time += duration;
    this.flush();
  }
  flush() {
    for (let count = 0; count < 100; count++) {
      const entry = [...this.timers].find(([, timer]) => timer.at <= this.time);
      if (!entry) return;
      this.timers.delete(entry[0]); entry[1].callback();
    }
    throw new Error("合成调度未收敛");
  }
  iso() { return new Date(this.time).toISOString(); }
}

class Worker implements SessionAutoSyncWorker {
  jobs = new Map<string, SessionJob>();
  requests = 0;
  mapBusy = false;
  listeners = new Set<(jobs: SessionJob[]) => void>();
  constructor(readonly clock: Clock) {}
  get busy() { return this.mapBusy || this.jobs.size > 0; }
  activeSessionJobs() { return [...this.jobs.values()]; }
  coveringSessionJob(clearCache = false, options: SessionRefreshOptions = {}) {
    return this.activeSessionJobs().find(job => sessionRequestCovers({ ...job, clearCache: false }, { ...options, clearCache }));
  }
  refreshSessions(_clearCache = false, options: SessionRefreshOptions = {}) {
    const existing = this.coveringSessionJob(false, options);
    if (existing) return existing;
    const job: SessionJob = { id: `synthetic-${++this.requests}`, status: "running", createdAt: this.clock.iso(), phase: "index", progress: 0, mode: options.mode ?? "quick", ...options };
    this.jobs.set(job.id, job); this.emit([job]); return job;
  }
  finish(id = this.activeSessionJobs()[0]!.id, status: "complete" | "failed" = "complete") {
    const job: SessionJob = { ...this.jobs.get(id)!, status, finishedAt: this.clock.iso(), ...(status === "failed" ? { error: "synthetic failure" } : {}) };
    this.jobs.delete(id); this.emit([job]); return job;
  }
  emit(jobs: SessionJob[] = []) { for (const listener of this.listeners) listener(jobs); }
  subscribeChanges(listener: (jobs: SessionJob[]) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}

function fixture(history: SessionGlobalCheckState = { consecutiveFailures: 0 }) {
  const clock = new Clock();
  const worker = new Worker(clock);
  const sync = new SessionAutoSyncScheduler(worker, history, clock);
  return { clock, worker, sync };
}

test("首次开启立即检查；长任务完成后计时，无变化版本和重复通知不改变基准", () => {
  const { clock, worker, sync } = fixture();
  try {
    assert.equal(sync.status().state, "disabled");
    sync.updateInterval(5_000);
    assert.equal(worker.requests, 1); assert.equal(sync.status().state, "running");
    assert.equal(sync.status().nextRunAt, undefined);
    clock.advance(40_000);
    assert.equal(worker.requests, 1);
    const completed = worker.finish();
    assert.equal(sync.status().lastSuccessAt, clock.iso());
    assert.equal(sync.status().nextRunAt, new Date(clock.now() + 5_000).toISOString());
    clock.advance(4_999); worker.emit([completed]); sync.updateInterval(5_000);
    assert.equal(worker.requests, 1);
    clock.advance(1); assert.equal(worker.requests, 2);
    assert.equal(sync.status().state, "running");
  } finally { sync.close(); }
});

test("间隔从最近全局成功完成重算；读取状态不扫描，睡眠到期只补一次", () => {
  const { clock, worker, sync } = fixture();
  try {
    sync.updateInterval(60_000); worker.finish();
    clock.advance(10_000);
    sync.updateInterval(30_000);
    assert.equal(sync.status().nextRunAt, new Date(clock.now() + 20_000).toISOString());
    for (let count = 0; count < 50; count++) sync.status();
    assert.equal(worker.requests, 1);
    clock.advance(19_999); assert.equal(worker.requests, 1);
    clock.advance(1); assert.equal(worker.requests, 2); worker.finish();
    clock.advance(3_600_000);
    assert.equal(worker.requests, 3); assert.equal(clock.timers.size, 0);
    worker.finish(); assert.equal(clock.timers.size, 1);
    clock.advance(5_000);
    sync.updateInterval(5_000);
    assert.equal(worker.requests, 4, "新间隔已经到期，只补一轮");
  } finally { sync.close(); }
});

test("局部或地图忙碌保留单一必要补查，关闭撤销补查且保留手动局部任务", () => {
  const { clock, worker, sync } = fixture();
  try {
    const local = worker.refreshSessions(false, { client: "claude", mode: "full" });
    sync.updateInterval(5_000);
    assert.equal(sync.status().state, "pending"); assert.equal(sync.status().job, undefined);
    clock.advance(500_000); worker.emit();
    assert.equal(worker.requests, 1);
    sync.updateInterval(0);
    assert.equal(worker.activeSessionJobs()[0]?.id, local.id);
    worker.finish(local.id); assert.equal(worker.requests, 1);
    assert.equal(sync.status().lastSuccessAt, undefined);
    worker.mapBusy = true; sync.updateInterval(5_000);
    assert.equal(sync.status().state, "pending");
    worker.mapBusy = false; worker.emit();
    assert.equal(worker.requests, 2); assert.equal(sync.status().job?.client, undefined);
    sync.updateInterval(0); worker.finish();
    assert.equal(sync.status().lastSuccessAt, clock.iso());
    clock.advance(500_000); assert.equal(worker.requests, 2);
  } finally { sync.close(); }
});

test("手动全局或启动检查直接参与周期，局部成功和失败不重置全局基准", () => {
  const { clock, worker, sync } = fixture();
  try {
    worker.refreshSessions(false, { mode: "full" });
    sync.updateInterval(30_000);
    assert.equal(worker.requests, 1, "启动或手动全局任务不重复提交");
    clock.advance(1_000); worker.finish();
    const success = sync.status().lastSuccessAt;
    clock.advance(10_000);
    worker.finish(worker.refreshSessions(false, { client: "codex" }).id);
    worker.finish(worker.refreshSessions(false, { client: "claude" }).id, "failed");
    assert.equal(sync.status().lastSuccessAt, success); assert.equal(sync.status().consecutiveFailures, 0);
    clock.advance(20_000);
    assert.equal(worker.requests, 4, "局部任务没有延后全局截止时间");
    sync.updateInterval(0);
    const manual = worker.refreshSessions();
    assert.equal(manual.id, sync.status().job?.id, "手动参与的在途自动任务不取消");
    worker.finish(); assert.equal(sync.status().state, "disabled");
  } finally { sync.close(); }
});

test("整项失败从完成时刻退避至上限；手动立即重试成功恢复，诊断完成不退避", () => {
  const { clock, worker, sync } = fixture();
  try {
    sync.updateInterval(5_000);
    for (let attempt = 1; attempt <= 7; attempt++) {
      clock.advance(2_000);
      const failed = worker.finish(undefined, "failed");
      const wait = Math.min(30_000 * 2 ** (attempt - 1), 600_000);
      assert.equal(sync.status().state, "backoff");
      assert.equal(sync.status().consecutiveFailures, attempt);
      assert.equal(sync.status().error, "synthetic failure");
      assert.equal(Date.parse(sync.status().nextRunAt!) - Date.parse(failed.finishedAt!), wait);
      clock.advance(wait - 1); assert.equal(worker.requests, attempt);
      clock.advance(1); assert.equal(worker.requests, attempt + 1);
    }
    worker.finish(undefined, "failed");
    const manual = worker.refreshSessions(false, { mode: "full" });
    assert.equal(sync.status().state, "running");
    clock.advance(4_000);
    const successful = worker.finish(manual.id);
    assert.equal(sync.status().consecutiveFailures, 0); assert.equal(sync.status().error, undefined);
    assert.equal(sync.status().lastSuccessAt, successful.finishedAt);
    assert.equal(sync.status().nextRunAt, new Date(clock.now() + 5_000).toISOString());
    worker.emit([{ ...successful, phase: "completed_with_diagnostics" }]);
    assert.equal(sync.status().state, "waiting");
  } finally { sync.close(); }
});

test("失败等待不快于设定周期，修改间隔重算退避，停止后台取消唤醒", () => {
  const { clock, worker, sync } = fixture();
  sync.updateInterval(600_000); worker.finish(undefined, "failed");
  assert.equal(sync.status().nextRunAt, new Date(clock.now() + 600_000).toISOString());
  clock.advance(20_000); sync.updateInterval(10_000);
  assert.equal(sync.status().nextRunAt, new Date(clock.now() + 10_000).toISOString());
  sync.close(); assert.equal(clock.timers.size, 0); assert.equal(worker.listeners.size, 0);
  clock.advance(600_000); worker.emit(); assert.equal(worker.requests, 1);
});

test("恢复记录用全局完成时间，关闭时不安排检查，启用仍立即复用启动任务", () => {
  const successful: SessionJob = { id: "previous", status: "complete", phase: "complete", progress: 1, createdAt: "2025-12-31T22:00:00Z", finishedAt: "2025-12-31T23:59:00Z", version: "older-unchanged-version" };
  const { clock, worker, sync } = fixture({ lastSuccessAt: successful.finishedAt, lastFinished: successful, consecutiveFailures: 0 });
  try {
    assert.equal(sync.status().lastSuccessAt, successful.finishedAt); assert.equal(worker.requests, 0);
    worker.refreshSessions(); sync.updateInterval(600_000); assert.equal(worker.requests, 1);
    worker.finish();
    assert.equal(sync.status().lastSuccessAt, clock.iso());
    assert.equal(sync.status().nextRunAt, new Date(clock.now() + 600_000).toISOString());
  } finally { sync.close(); }
});

test("请求覆盖同时校验客户端、检查强度与清缓存意图", () => {
  const quick = { clearCache: false, mode: "quick" as const };
  const full = { clearCache: false, mode: "full" as const };
  const clear = { clearCache: true, mode: "full" as const };
  assert.equal(sessionRequestCovers(quick, { ...quick, client: "codex" }), true);
  assert.equal(sessionRequestCovers({ ...full, client: "codex" }, quick), false);
  assert.equal(sessionRequestCovers(quick, full), false);
  assert.equal(sessionRequestCovers(full, quick), true);
  assert.equal(sessionRequestCovers(full, clear), false);
  assert.equal(sessionRequestCovers(clear, full), true);
  assert.equal(sessionRequestCovers({ ...full, client: "claude" }, { ...full, client: "codex" }), false);
});

test("长周期只有一个短唤醒，时钟跨越睡眠后补一次，未到期唤醒不扫描", () => {
  const { clock, worker, sync } = fixture();
  try {
    sync.updateInterval(600_000); worker.finish();
    assert.equal(clock.timers.size, 1);
    assert.equal([...clock.timers.values()][0]!.at - clock.now(), 5_000);
    clock.advance(5_000);
    assert.equal(worker.requests, 1, "短唤醒只核对截止时间");
    assert.equal(clock.timers.size, 1);
    clock.time += 3_600_000;
    assert.equal(sync.status().state, "waiting"); assert.equal(worker.requests, 1, "读取状态不触发逾期检查");
    clock.flush(); assert.equal(worker.requests, 2);
    assert.equal(clock.timers.size, 0);
    worker.finish(); assert.equal(clock.timers.size, 1);
    clock.advance(5_000); assert.equal(worker.requests, 2);
  } finally { sync.close(); }
});

test("首次检查等待局部任务时修改周期，不丢失尚未满足的首次全局检查", () => {
  const { clock, worker, sync } = fixture();
  try {
    const local = worker.refreshSessions(false, { client: "claude" });
    sync.updateInterval(5_000); clock.advance(1_000); sync.updateInterval(600_000);
    assert.equal(sync.status().state, "pending");
    worker.finish(local.id);
    assert.equal(worker.requests, 2); assert.equal(sync.status().state, "running");
  } finally { sync.close(); }
});
