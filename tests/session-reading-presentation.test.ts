import assert from "node:assert/strict";
import { test } from "node:test";
import { questionPreview } from "../web/features/sessions/session-question-preview.js";
import { usageCoverage } from "../web/features/sessions/session-usage-coverage.js";
import type { SessionProfile } from "../src/session-contracts.js";

test("问题摘要保留 Markdown 可见文字、代码与图片说明，省略链接目标", () => {
  assert.equal(questionPreview("[$review](/synthetic/skills/review/SKILL.md) **请检查** `timeout`\n\n[文档](https://example.invalid) ![布局图](image.png)").text,
    "$review 请检查 timeout 文档 布局图");
  assert.equal(questionPreview("# 问题\n\n- 第一点\n- 第二点").text, "问题 第一点 第二点");
});

test("技能注入只提取原文名称，保留后续真实问题，前缀截断不编造问题", () => {
  const skill = "<skill><name>review</name><path>/synthetic/review/SKILL.md</path>技能说明</skill>";
  assert.deepEqual(questionPreview(skill), { text: "", skills: ["review"] });
  assert.deepEqual(questionPreview(`${skill}\n实际问题`), { text: "实际问题", skills: ["review"] });
  assert.deepEqual(questionPreview("<skill><name>review</name><path>/synthetic/"), { text: "", skills: ["review"] });
  assert.equal(questionPreview("<skill>无法识别的内容</skill>").text, "无法识别的内容");
  assert.deepEqual(questionPreview(""), { text: "", skills: [] });
});

test("用量覆盖范围合并相同计数，保留不同范围与零记录", () => {
  const usage = { requests: 378, inputRecordedRequests: 375, cacheRecordedRequests: 374,
    recordedRequests: { outputTokens: 375, reasoningOutputTokens: 0 } } as SessionProfile["usage"];
  assert.deepEqual(usageCoverage(usage, [["inputTokens", "input"], ["outputTokens", "output"], ["peakInputTokens", "peak"],
    ["cachedInputTokens", "cache"], ["reasoningOutputTokens", "reasoning"], ["peakContextTokens", "context"]]), [
    { count: 375, total: 378, labels: ["input", "output", "peak"] },
    { count: 374, total: 378, labels: ["cache"] }, { count: 0, total: 378, labels: ["reasoning"] },
  ]);
  assert.deepEqual(usageCoverage({ ...usage, requests: 375 }, [["inputTokens", "input"], ["outputTokens", "output"]]), []);
});
