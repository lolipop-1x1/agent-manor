import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { WeeklyReview, WeeklyReviewDetailPage, WeeklyReviewRecord, WeeklyReviewRank } from "../src/overview-contracts.ts";
import { translate, translateMessageOrOriginal } from "../src/i18n/index.ts";
import { weeklyReviewDuration, weeklyReviewParameters, weeklyReviewDetailParameters, loadWeeklyReviewDetail, weeklyReviewViews, weeklyReviewRecordTitle, weeklyReviewFreshLabel, weeklyReviewCacheShareLabel } from "../web/features/overview/review-model.ts";
import { requiredOverviewPanels, OverviewSnapshotMismatch } from "../web/features/overview/loading.ts";

const review = { version: "index-a", priceVersion: "price-a", timezone: "UTC", query: { window: "custom", from: "2026-01-01", to: "2026-01-07", anchorDay: "2026-01-08", clients: ["codex"], projects: ["/example/project"] }, range: { from: "2026-01-01", to: "2026-01-07", today: "2026-01-08", all: false, includesToday: false, comparison: null, recent: null } } as WeeklyReview;
const detail = { kind: "rounds" as const, sort: "duration" as const, page: 2, pageSize: 20 };
const page: WeeklyReviewDetailPage = { ...review, detail, rows: [], total: 0, page: 2, pageSize: 20, review };

test("固定周复盘独立于顶部日期与模型，仅沿用客户端和项目", () => {
  const query = { ...review.query, models: ["model-a"], from: "2025-01-01", to: "2025-12-31" };
  const params = new URLSearchParams(weeklyReviewParameters(query));
  assert.equal(params.get("clients"), '["codex"]'); assert.equal(params.get("projects"), '["/example/project"]');
  for (const name of ["from", "to", "window", "models", "anchorDay", "version"]) assert.equal(params.get(name), null);
  assert.ok(!requiredOverviewPanels("project").includes("insights"));
});

test("周复盘下钻沿用日期、客户端、项目、索引与价格版本", () => {
  const params = new URLSearchParams(weeklyReviewDetailParameters(review, detail));
  for (const [name, value] of Object.entries({ version: review.version, priceVersion: review.priceVersion, timezone: review.timezone, anchorDay: review.query.anchorDay, from: review.range.from, to: review.range.to })) assert.equal(params.get(name), value);
  assert.deepEqual(JSON.parse(params.get("detail")!), detail);
});

test("周复盘详情排除不同索引、价格、时区、日期和筛选的结果", async () => {
  const signal = new AbortController().signal;
  const got = await loadWeeklyReviewDetail(review, detail, async path => { assert.ok(path.startsWith("/overview/review/detail?")); return page; }, signal);
  assert.equal(got, page);
  for (const mismatch of [{ ...page, version: "index-b" }, { ...page, priceVersion: "price-b" }, { ...page, timezone: "Asia/Shanghai" }, { ...page, range: { ...page.range, from: "2026-01-02" } }, { ...page, query: { ...page.query, clients: ["claude"] } }]) await assert.rejects(loadWeeklyReviewDetail(review, detail, async () => mismatch, signal), OverviewSnapshotMismatch);
});

test("已取消的周复盘下钻不接纳迟到结果", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadWeeklyReviewDetail(review, detail, async () => page, controller.signal), { name: "AbortError" });
});

test("轮次耗时保留零值，并按秒、分钟、小时显示", () => {
  assert.equal(weeklyReviewDuration(null), null);
  assert.deepEqual(weeklyReviewDuration(0), { key: "overview.review.timeSeconds", value: 0 });
  assert.deepEqual(weeklyReviewDuration(65_000), { key: "overview.review.timeMinutes", value: 65 / 60 });
  assert.deepEqual(weeklyReviewDuration(7_200_000), { key: "overview.review.timeHours", value: 2 });
  assert.equal(translate("zh-CN", "overview.review.timeMinutes", { value: "1.1" }), "1.1 分钟");
  assert.equal(translate("en", "overview.review.timeMinutes", { value: "1.1" }), "1.1 min");
});

test("四组原始指标及扩展视图的动态文案完整", () => {
  const groups = ["sessions", "rounds", "cache", "preferences"];
  const metrics = ["active", "completed", "compressionSessions", "compressions", "steps", "toolCalls", "tokens", "duration", "zero", "readShare", "fresh", "premium", "premiumSubtotal", "uncompressed", "agents", "models", "reasoning", "promptCharacters", "activity", "longest", "highestTokens", "largeInputs"];
  for (const language of ["en", "zh-CN"] as const) for (const suffix of [...groups.map(group => `group.${group}`), ...metrics, ...weeklyReviewViews]) {
    const key = `overview.review.${suffix}`;
    const message = translate(language, key); assert.notEqual(message, key); assert.ok(!message.includes("Translation unavailable") && !message.includes("翻译不可用"), key);
  }
  const source = readFileSync(new URL("../web/features/overview/WeeklyReview.tsx", import.meta.url), "utf8");
  assert.match(source, /\[active, key\]/); assert.doesNotMatch(source, /route\.window|route\.from|route\.models/);
  assert.match(source, /<div inert=\{pending\}>/);
});


test("周复盘需求与会话标题按来源本地化，两种界面共享同一映射", () => {
  const record: WeeklyReviewRecord = { id: "request:other-record", sessionId: "codex:session-12345678", client: "codex", title: "未命名会话", titleOrigin: "fallback" };
  assert.equal(weeklyReviewRecordTitle(record, "zh-CN"), "未命名会话");
  assert.equal(weeklyReviewRecordTitle(record, "en"), "Unnamed session");
  assert.equal(weeklyReviewRecordTitle({ ...record, relationship: "child" }, "zh-CN"), "子会话 12345678");
  assert.equal(weeklyReviewRecordTitle({ ...record, relationship: "child" }, "en"), "Child session 12345678");
  for (const language of ["en", "zh-CN"] as const) {
    assert.equal(weeklyReviewRecordTitle({ ...record, titleOrigin: "first_user", title: "修复真实需求" }, language), "修复真实需求");
    const markdown = "&#x20; **修复查询**，使用 [$demo](/synthetic/demo/SKILL.md)";
    assert.equal(weeklyReviewRecordTitle({ ...record, titleOrigin: "first_user", title: markdown }, language), "修复查询，使用 $demo");
    assert.equal(weeklyReviewRecordTitle({ ...record, titleOrigin: "recorded", title: markdown }, language), markdown);
    assert.equal(weeklyReviewRecordTitle({ ...record, titleOrigin: "recorded" }, language), "未命名会话");
    assert.equal(weeklyReviewRecordTitle({ ...record, titleOrigin: undefined }, language), "未命名会话");
    assert.equal(weeklyReviewRecordTitle(undefined, language), "—");
  }
  const highlights = readFileSync(new URL("../web/features/overview/WeeklyReview.tsx", import.meta.url), "utf8");
  const details = readFileSync(new URL("../web/features/overview/WeeklyReviewDetails.tsx", import.meta.url), "utf8");
  assert.match(highlights, /weeklyReviewRecordTitle\(review.rounds.longest\[0\], language\)/);
  assert.match(highlights, /weeklyReviewRecordTitle\(review.rounds.highestTokens\[0\], language\)/);
  assert.match(details, /weeklyReviewRecordTitle\(row, language\)/);
  assert.doesNotMatch(highlights, /\?\.title \?\? "—"/);
  assert.doesNotMatch(details, /title: row.title|>\{row.title\}<[\/]button>/);
});

test("部分未缓存输入只标为已记录，完整覆盖和真实零值保留完整名称", () => {
  const partial = weeklyReviewFreshLabel({ requests: 10, freshSamples: 9 });
  assert.equal(translate("zh-CN", `overview.review.${partial}`), "已记录未缓存输入");
  assert.equal(translate("en", `overview.review.${partial}`), "Recorded uncached input");
  assert.equal(weeklyReviewFreshLabel({ requests: 10, freshSamples: 10 }), "fresh");
  assert.equal(weeklyReviewFreshLabel({ requests: 0, freshSamples: 0 }), "fresh");
  assert.equal(weeklyReviewFreshLabel({ requests: 10, freshSamples: 0 }), "freshSubtotal");
});


test("压缩排行保留产品标题描述，英文不展示存储的中文兜底", () => {
  const row: WeeklyReviewRank = { key: "session-12345678", name: "未命名会话", nameDescriptor: { key: "sessions.title.unnamed" },
    count: 2, share: 1, sessions: 1, requests: 0, tokens: null, tokenSamples: 0, tokenMissing: 0, estimatedCost: null, costCoverage: "missing" };
  assert.equal(translateMessageOrOriginal("zh-CN", row.nameDescriptor, row.name), "未命名会话");
  assert.equal(translateMessageOrOriginal("en", row.nameDescriptor, row.name), "Unnamed session");
  const child = { key: "sessions.title.childFallback", params: { id: "12345678" } };
  assert.equal(translateMessageOrOriginal("zh-CN", child, row.name), "子会话 12345678");
  assert.equal(translateMessageOrOriginal("en", child, row.name), "Child session 12345678");
  assert.equal(translateMessageOrOriginal("en", undefined, "原始会话标题"), "原始会话标题");
  const details = readFileSync(new URL("../web/features/overview/WeeklyReviewDetails.tsx", import.meta.url), "utf8");
  assert.match(details, /title=\{message\(row.nameDescriptor, row.name\)\}/);
  assert.match(details, /shortName\(row.name\) : message\(row.nameDescriptor, row.name\)/);
});


test("缓存配对分母存在缺失时主标签明确已记录范围", () => {
  const partial = weeklyReviewCacheShareLabel({ readShareMissing: 1 });
  assert.equal(translate("zh-CN", `overview.review.${partial}`), "缓存读取占输入（已记录）");
  assert.equal(translate("en", `overview.review.${partial}`), "Cached share of recorded input");
  assert.equal(weeklyReviewCacheShareLabel({ readShareMissing: 0 }), "readShare");
});


test("排行与子Agent部分Token覆盖不冒充全量，双方缺失样本按需展示", () => {
  const partial: WeeklyReviewRank = { key: "example-model", name: "example-model", count: 3, share: 1, sessions: 1,
    requests: 3, tokens: 55, tokenSamples: 2, tokenMissing: 1, estimatedCost: null, costCoverage: "missing" };
  assert.equal(partial.tokens, 55);
  assert.equal(partial.tokenSamples + partial.tokenMissing, partial.requests);
  assert.equal(translate("zh-CN", "overview.review.tokenSubtotal"), "已记录 Token 小计");
  assert.equal(translate("en", "overview.review.tokenSubtotal"), "Recorded token subtotal");
  assert.equal(translate("zh-CN", "overview.review.recordedTokenShare"), "已记录 Token 占比");
  assert.equal(translate("en", "overview.review.recordedTokenShare"), "Recorded token share");
  for (const language of ["en", "zh-CN"] as const) for (const label of ["tokenSamples", "tokenMissing", "childTokenSamples", "childTokenMissing", "userTokenSamples", "userTokenMissing", "help.tokenSubtotal"]) {
    const key = `overview.review.${label}`;
    assert.notEqual(translate(language, key), key);
  }
  const source = readFileSync(new URL("../web/features/overview/WeeklyReviewDetails.tsx", import.meta.url), "utf8");
  assert.match(source, /\["name", "count", "share", "sessionCount", "requests", "tokenSubtotal", "cost"\]/);
  assert.match(source, /\["tokenSubtotal", review.extensions.children.tokens\]/);
  assert.match(source, /\["recordedTokenShare", review.extensions.children.tokenShare, "share"\]/);
  for (const field of ["tokenSamples", "tokenMissing", "userTokenSamples", "userTokenMissing"]) assert.ok(source.includes(`review.extensions.children.${field}`));
  assert.match(source, /<details className="weekly-review-source">[\s\S]*n\(row.tokenSamples\)[\s\S]*n\(row.tokenMissing\)[\s\S]*<\/details>/);
  assert.doesNotMatch(source, /\["recordTokens", review.extensions.children.tokens\]|\["tokenShare", review.extensions.children.tokenShare/);
});
