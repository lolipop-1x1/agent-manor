import assert from "node:assert/strict";
import test from "node:test";
import { importConcurrency } from "../src/sessions/import-concurrency.js";

test("解析并发按来源数量、CPU、整机内存和可用预算选择，不超过四个", () => {
  const GiB = 1024 ** 3;
  const capacity = { cpus: 12, totalBytes: 32 * GiB, availableBytes: 8 * GiB };
  assert.equal(importConcurrency(7, capacity), 1);
  assert.equal(importConcurrency(8, capacity), 4);
  assert.equal(importConcurrency(100, { ...capacity, cpus: 1 }), 1);
  assert.equal(importConcurrency(100, { ...capacity, cpus: 2 }), 1);
  assert.equal(importConcurrency(100, { ...capacity, cpus: 4 }), 2);
  assert.equal(importConcurrency(100, { ...capacity, totalBytes: 4 * GiB }), 2);
  assert.equal(importConcurrency(100, { ...capacity, totalBytes: 2 * GiB }), 1);
  assert.equal(importConcurrency(100, { ...capacity, availableBytes: GiB }), 2);
  assert.equal(importConcurrency(100, { ...capacity, availableBytes: GiB / 4 }), 1);
});
