// 全部历史与身份均为人工合成；直接索引样例只验证 UI 分支，不代替原生导入。
const at = seconds => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const timed = (record, seconds) => ({ ...record, timestamp: at(seconds) });
const usage = output => ({ input_tokens: 100, cached_input_tokens: 0, output_tokens: output });
const user = (id, seconds, text) => timed({ type: "response_item", payload: { type: "message", id, role: "user",
  content: [{ type: "input_text", text }] } }, seconds);
const model = (id, seconds, text, final = false) => timed({ type: "response_item", payload: { type: "message", id,
  role: "assistant", phase: final ? "final_answer" : "commentary", content: [{ type: "output_text", text }] } }, seconds);
const count = (id, seconds, output, total) => timed({ type: "token_usage_record", payload: { response_id: id,
  usage: usage(output), thread_token_usage: usage(total) } }, seconds);
const tool = (id, seconds) => timed({ type: "response_item", payload: { type: "function_call", id: `call-${id}`,
  call_id: id, name: "fixture_tool", arguments: JSON.stringify({ note: "合成参数" }) } }, seconds);
const result = (id, seconds) => timed({ type: "response_item", payload: { type: "function_call_output", id: `result-${id}`,
  call_id: id, output: "合成工具结果" } }, seconds);
const header = (id, title, project, fields = {}) => ({ type: "session_meta", payload: { id, cwd: project, title, ...fields } });
const weighted = { requests: 5, eligibleRequests: 2, outputTokens: 1080, durationMs: 42000, tokensPerSecond: 1080 / 42 };

function native(client, id, role, seconds, content, output, request = id, extra = {}) {
  return timed(client === "claude"
    ? { type: role, uuid: id, sessionId: "speed-claude", message: { id: request, role, model: "fixture-model", content,
      ...(output === undefined ? {} : { usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }), ...extra } }
    : { type: "message", uuid: id, sessionId: "speed-codeflicker", role, model: "fixture-model", content,
      ...(output === undefined ? {} : { usage: usage(output) }), metadata: { requestTokenBaseline: { requestId: request } }, ...extra }, seconds);
}

function nativeRequests(client, project) {
  const text = value => [{ type: "text", text: value }];
  const assistant = (id, seconds, content, output, request, extra = {}) => native(client, id, "assistant", seconds, content, output, request, extra);
  const prompt = (id, seconds, content) => ({ ...native(client, id, "user", seconds, content), cwd: project });
  const call = { type: "tool_use", id: "native-tool", name: "fixture_tool", input: { note: "合成参数" } };
  const records = [prompt("native-user-one", 0, client === "claude" ? "Claude 速度验收" : "CLI 速度验收")];
  if (client === "claude") {
    records.push(assistant("native-thinking", 2, [{ type: "thinking", thinking: "合成思考：准备工具调用" }], 50, "native-one"),
      assistant("native-comment", 8, text("第一请求正文：合成过程说明"), 200, "native-one"),
      assistant("native-call", 12, [call], 480, "native-one", { stop_reason: "tool_use" }),
      native(client, "native-result", "user", 60, [{ type: "tool_result", tool_use_id: "native-tool", content: "合成工具结果" }]));
  } else {
    records.push(assistant("native-first", 12, [{ type: "reasoning", text: "合成思考：准备工具调用" }, ...text("第一请求正文：合成过程说明"), call], 480, "native-one"),
      native(client, "native-result", "tool", 60, [{ type: "tool-result", toolCallId: "native-tool", result: { llmContent: "合成工具结果" } }]));
  }
  records.push(assistant("native-final", 90, text("第二请求正文：合成最终回答"), 600, "native-two", client === "claude" ? { stop_reason: "end_turn" } : {}),
    prompt("native-user-two", 100, "短输出保留过滤原因"),
    assistant("native-short", 110, text("短输出"), 199, "native-three", client === "claude" ? { stop_reason: "end_turn" } : {}),
    prompt("native-user-three", 120, "未知结束保留原因"),
    assistant("native-unknown", 130, text("过程回复尚无结束证据"), 400, "native-four", client === "claude" ? {} : { metadata: undefined }),
    prompt("native-user-four", 140, "取消请求保留原因"),
    assistant("native-partial", 150, text("部分响应"), 400, "native-five", client === "claude" ? { stop_reason: "end_turn" } : { isInterrupted: true }));
  if (client === "claude") records.push({ type: "system", uuid: "native-interruption", sessionId: "speed-claude", interruptedMessageId: "native-partial", timestamp: at(151) });
  return records;
}

export function sessionSpeedFixture(project = "/workspace/speed-demo") {
  const codex = [header("speed-codex", "吐字速度验收", project), timed({ type: "turn_context", payload: { model: "fixture-model" } }, 0),
    user("user-one", 0, "比较同轮两个请求的速度"),
    timed({ type: "response_item", payload: { type: "reasoning", id: "thinking-one", summary: [{ type: "summary_text", text: "合成思考：准备工具调用" }] } }, 2),
    model("comment-one", 8, "第一请求正文：合成过程说明"), tool("tool", 12), count("one", 12, 480, 480), result("tool", 60),
    model("final-one", 90, "第二请求正文：合成最终回答", true), count("two", 90, 600, 1080),
    user("user-two", 100, "短输出保留过滤原因"), model("short", 110, "短输出", true), count("three", 110, 199, 1279),
    user("user-three", 120, "未知结束保留原因"), model("unknown", 130, "过程回复尚无结束证据"), count("four", 130, 400, 1679),
    user("user-four", 140, "取消请求保留原因"), model("partial", 150, "部分响应"), count("five", 150, 400, 2079),
    timed({ type: "event_msg", payload: { type: "turn_aborted" } }, 151)];
  const child = [header("speed-child", "子会话速度验收", project, { source: { subagent: { thread_spawn: { parent_thread_id: "speed-codex", agent_path: "/root/synthetic-child" } } } }),
    user("child-user", 1000, "子会话合成请求"), model("child-answer", 1010, "子会话合成回答", true), count("child-request", 1010, 400, 400)];
  const thresholds = [header("speed-thresholds", "门槛与缺失验收", project),
    user("equal-user", 200, "等号门槛"), model("equal-answer", 201, "恰好 200 Token 与 1 秒", true), count("equal", 201, 200, 200),
    user("short-time-user", 210, "短耗时"), model("short-time-answer", 210.999, "耗时 999 毫秒", true), count("short-time", 210.999, 200, 400),
    user("missing-output-user", 220, "缺失输出"), model("missing-output-answer", 225, "工具前回复"), tool("missing-output", 230), result("missing-output", 240),
    { ...user("missing-time-user", 250, "缺失起始时间"), timestamp: undefined }, model("missing-time-answer", 260, "计时缺失", true), count("missing-time", 260, 400, 800)];
  const insufficient = [header("speed-insufficient", "速度数据不足验收", project), user("gap-user", 300, "没有结束证据"),
    model("gap-answer", 310, "过程回复尚未确认结束"), count("gap-request", 310, 400, 400)];
  const bulk = [header("speed-bulk", "长列表速度验收", project)];
  let total = 0;
  for (let turn = 1; turn <= 110; turn++) {
    const start = 2000 + turn * 30;
    bulk.push(user(`bulk-user-${turn}`, start, `合成速度问题 ${turn}`));
    for (let request = 1; request <= 6; request++) {
      const id = `bulk-${turn}-${request}`;
      const end = start + (request - 1) * 3 + 1;
      bulk.push(model(`bulk-comment-${id}`, end, `合成请求 ${turn}/${request}`, request === 6));
      if (request < 6) bulk.push(tool(id, end));
      total += 200;
      bulk.push(count(id, end, 200, total));
      if (request < 6) bulk.push(result(id, end + 2));
    }
  }
  const pi = [{ type: "session", version: 3, id: "speed-pi", cwd: project, timestamp: at(500) },
    { type: "message", id: "pi-user", parentId: null, timestamp: at(500), message: { role: "user", content: "原生分支速度缺失验收" } },
    { type: "message", id: "pi-old", parentId: "pi-user", timestamp: at(510), message: { role: "assistant", model: "fixture-model", stopReason: "stop",
      content: [{ type: "text", text: "旧分支合成回答" }], usage: { input: 100, output: 400, cacheRead: 0, cacheWrite: 0 } } },
    { type: "message", id: "pi-current", parentId: "pi-user", timestamp: at(520), message: { role: "assistant", model: "fixture-model", stopReason: "stop",
      content: [{ type: "text", text: "当前分支合成回答" }], usage: { input: 100, output: 400, cacheRead: 0, cacheWrite: 0 } } }];
  return { files: [
    { client: "codex", name: "speed.jsonl", records: codex, id: "speed-codex", expected: weighted },
    { client: "claude", name: "speed.jsonl", records: nativeRequests("claude", project), id: "speed-claude", expected: weighted },
    { client: "codeflicker", name: "speed.jsonl", records: nativeRequests("codeflicker", project), id: "speed-codeflicker", expected: weighted },
    { client: "codex", name: "child.jsonl", records: child, id: "speed-child", expected: { requests: 1, eligibleRequests: 1, outputTokens: 400, durationMs: 10000, tokensPerSecond: 40 } },
    { client: "codex", name: "thresholds.jsonl", records: thresholds, id: "speed-thresholds", expected: { requests: 4, eligibleRequests: 1, outputTokens: 200, durationMs: 1000, tokensPerSecond: 200 } },
    { client: "codex", name: "insufficient.jsonl", records: insufficient, id: "speed-insufficient", expected: { requests: 1, eligibleRequests: 0, outputTokens: null, durationMs: null, tokensPerSecond: null } },
    { client: "codex", name: "bulk.jsonl", records: bulk, id: "speed-bulk", expected: { requests: 660, eligibleRequests: 660, outputTokens: 132000, durationMs: 660000, tokensPerSecond: 200 } },
    { client: "pi", name: "branch.jsonl", records: pi, id: "speed-pi", expected: { requests: 2, eligibleRequests: 0, outputTokens: null, durationMs: null, tokensPerSecond: null } },
  ], treeExpected: { requests: 6, eligibleRequests: 3, outputTokens: 1480, durationMs: 52000, tokensPerSecond: 1480 / 52 } };
}

/** 只供分支 UI 范围与旧索引兼容验证；三来源计时必须另从原生历史导入。 */
export function indexSpeedBranchFixture(store, path) {
  const id = "codex:synthetic-speed-branch";
  const pending = store.createRevision(path, "synthetic-ui-branch");
  let ordinal = 0;
  const message = (kind, turn, text, fields = {}) => {
    const value = { id: `${id}:message:${++ordinal}`, sessionId: id, ordinal, recordLine: ordinal, turnId: `${id}:turn:${turn}`,
      kind, text, occurredAt: at(5000 + ordinal), branchIds: ["branch-a", "branch-b"], currentBranch: true, ...fields };
    pending.sink.message(value); return value;
  };
  for (let turn = 1; turn <= 15; turn++) {
    const prompt = message("user", turn, `分支速度问题 ${turn}`, { occurredAt: at(6000 + turn * 30) });
    for (const [branch, duration] of [["branch-a", 20000], ["branch-b", 10000]]) {
      const answer = message("assistant", turn, `${branch === "branch-a" ? "旧分支" : "当前分支"}速度回答 ${turn}`, {
        branchIds: [branch], currentBranch: branch === "branch-b", final: "explicit", model: "fixture-model",
        occurredAt: at(6000 + turn * 30 + duration / 1000) });
      pending.sink.usage({ id: `${id}:request:${turn}:${branch}`, messageId: answer.id, requestMessageIds: [answer.id], turnId: answer.turnId,
        model: "fixture-model", inputTokens: 100, outputTokens: 400, occurredAt: answer.occurredAt,
        timing: { basis: "estimated", method: "codex_event_boundary", completion: "inferred", completionEvidence: "final_response_snapshot",
          start: { messageId: prompt.id, occurredAt: prompt.occurredAt, recordLine: prompt.recordLine },
          end: { messageId: answer.id, occurredAt: answer.occurredAt, recordLine: answer.recordLine }, durationMs: duration } });
    }
  }
  pending.flush();
  store.finishRevision(pending.revision, { id, client: "codex", clientSessionId: "synthetic-speed-branch", title: "分支速度验收", titleOrigin: "recorded", path,
    sourceId: "synthetic-ui-branch", messageCount: ordinal, turnCount: 15, models: ["fixture-model"], gaps: [], branches: [
      { id: "branch-a", label: "合成旧分支", current: false }, { id: "branch-b", label: "当前分支", labelDescriptor: { key: "sessions.branch.current" }, current: true } ] });
  return { id, path, revision: pending.revision, fingerprint: "synthetic-ui-branch" };
}
