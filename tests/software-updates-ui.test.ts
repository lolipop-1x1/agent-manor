import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReleaseStatus } from "../src/updates/contracts.js";
import { updateUi as english } from "../src/i18n/locales/en/update-ui.js";
import { updateUi as chinese } from "../src/i18n/locales/zh-CN/update-ui.js";
import { updateReminderVisible, updateSummaryKey } from "../web/features/updates/update-model.js";

const release = (patch: Partial<ReleaseStatus> = {}): ReleaseStatus => ({
  currentVersion: "1.0.0", latestVersion: "1.1.0", checkState: "ready", checkedAt: "2026-01-01T00:00:00.000Z",
  stale: false, updateAvailable: true, versionRelation: "behind", installationKind: "global", selfUpdateSupported: true,
  autoCheck: true, ignoredVersion: null, compatibility: { compatible: true, reason: null },
  updateCommand: "am update", shell: "posix", ...patch,
});

test("页头只提醒有效的新版本，关闭、忽略、过期和失败不自动打扰", () => {
  assert.equal(updateReminderVisible(release()), true);
  for (const patch of [
    { autoCheck: false }, { automaticDisabled: true }, { ignoredVersion: "1.1.0" }, { stale: true }, { checkState: "failed" as const },
    { checkState: "checking" as const }, { checkState: "unknown" as const }, { updateAvailable: false },
    { updateAvailable: null }, { latestVersion: null },
  ]) assert.equal(updateReminderVisible(release(patch)), false, JSON.stringify(patch));
  assert.equal(updateReminderVisible(null), false);
});

test("忽略只影响自动提醒，手动查看保留新版，后续更高版本重新提醒", () => {
  const ignored = release({ ignoredVersion: "1.1.0" });
  assert.equal(updateSummaryKey(ignored), "updateUi.available");
  assert.equal(ignored.updateAvailable, true);
  assert.equal(updateReminderVisible({ ...ignored, latestVersion: "1.2.0" }), true);
  assert.equal(updateReminderVisible({ ...ignored, ignoredVersion: null }), true);
  assert.equal(updateReminderVisible(release({ compatibility: { compatible: false, reason: "Node.js requirement" } })), true);
});

test("旧结果、失败、未检查与高于稳定版都有独立表达，不能误报已是最新", () => {
  assert.equal(updateSummaryKey(release({ latestVersion: null, updateAvailable: null, versionRelation: "unknown", checkState: "unknown" })), "updateUi.unknown");
  const current = release({ latestVersion: "1.0.0", updateAvailable: false, versionRelation: "current" });
  assert.equal(updateSummaryKey(current), "updateUi.upToDate");
  assert.equal(updateSummaryKey({ ...current, stale: true }), "updateUi.stale");
  assert.equal(updateSummaryKey({ ...current, checkState: "checking" }), "updateUi.stale");
  assert.equal(updateSummaryKey({ ...current, checkState: "failed" }), "updateUi.failed");
  assert.equal(updateSummaryKey(release({ latestVersion: "0.9.0", updateAvailable: false, versionRelation: "ahead" })), "updateUi.ahead");
});

test("界面动态状态及所有动作具备中英文，变量保持一致", () => {
  assert.deepEqual(Object.keys(english).sort(), Object.keys(chinese).sort());
  for (const key of Object.keys(english) as (keyof typeof english)[]) {
    assert.ok(english[key].trim(), key); assert.ok(chinese[key].trim(), key);
    assert.deepEqual(english[key].match(/\{\{.*?\}\}/g), chinese[key].match(/\{\{.*?\}\}/g), key);
  }
  for (const status of [release(), release({ stale: true }), release({ checkState: "failed" }), release({ latestVersion: null, updateAvailable: null }), release({ versionRelation: "ahead", updateAvailable: false }), release({ versionRelation: "current", updateAvailable: false })]) {
    assert.ok(updateSummaryKey(status) in english);
  }
});
