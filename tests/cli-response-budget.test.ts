import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { startService } from "../src/server.js";
import { isolatedHistoryEnvironment, isolatedHistoryRoots } from "./helpers/history-roots.js";

const run = promisify(execFile);

test("真实CLI默认响应有界，完整模式与快照分页仍可回读原始明细", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-cli-budget-"));
  const home = join(directory, "data"), history = join(directory, "history");
  await mkdir(history);
  const rows: unknown[] = [
    { type: "session_meta", payload: { id: "synthetic-budget", cwd: join(directory, "atlas") } },
    { type: "turn_context", payload: { model: "synthetic-model" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Explain the Atlas cache policy." }] } },
  ];
  for (let index = 0; index < 4_000; index++) rows.push({
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    type: "event_msg", payload: { type: "token_count", info: {
      total_token_usage: { input_tokens: 1_000 + index, output_tokens: 20 + index, total_tokens: 1_020 + index * 2 },
      last_token_usage: { input_tokens: 100, output_tokens: 20, context_tokens: 1_000 + index }, model_context_window: 32_768,
    } },
  });
  const body = "Atlas cache validation. ".repeat(1_000);
  rows.push({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: body }] } });
  await writeFile(join(history, "synthetic.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const service = await startService({ home, roots: isolatedHistoryRoots({ codex: [history] }), startupRefresh: false,
    resourceInventory: { userHome: join(directory, "user"), environment: {} }, usagePricing: { fetch: async () => new Response("offline fixture", { status: 503 }) } });
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const hook = fileURLToPath(import.meta.resolve("tsx/esm"));
  const environment = isolatedHistoryEnvironment(directory, { AGENT_MANOR_HOME: home, AGENT_MANOR_LANG: "en" });
  const invoke = async (args: string[], json = true) => {
    const result = await run(process.execPath, ["--import", hook, cli, ...args, ...(json ? ["--json"] : [])],
      { env: environment, cwd: tmpdir(), timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    return { ...result, value: json ? JSON.parse(result.stdout) : undefined };
  };
  try {
    await invoke(["sessions", "refresh", "--wait"]);
    const compact = await invoke(["sessions", "list", "--page-size", "1"]);
    const complete = await invoke(["sessions", "list", "--page-size", "1", "--full"]);
    assert.equal(compact.value.total, 1);
    assert.equal(compact.value.sessions.length, 1);
    assert.equal(compact.value.sessions[0].contextSnapshots, undefined);
    assert.equal(compact.value.sessions[0].usageReports, undefined);
    assert.ok(complete.value.sessions[0].contextSnapshots.length >= 4_000);
    assert.ok(Buffer.byteLength(compact.stdout) < 16_000, "列表体积不随4000个隐藏快照增长");
    assert.ok(Buffer.byteLength(complete.stdout) > Buffer.byteLength(compact.stdout) * 30);
    const id = compact.value.sessions[0].id, version = compact.value.version;
    const profile = await invoke(["sessions", "profile", id, "--version", version]);
    assert.ok(Buffer.byteLength(profile.stdout) < 32_000);
    assert.equal(profile.value.contextSnapshots, undefined);
    assert.equal(profile.value.usageReports, undefined);
    const contexts = await invoke(["sessions", "profile", id, "--version", version, "--section", "context", "--page-size", "2"]);
    assert.equal(contexts.value.items.length, 2);
    assert.ok(contexts.value.total >= 4_000);
    assert.equal(contexts.value.version, version);
    const nextContexts = await invoke(["sessions", "profile", id, "--version", version, "--section", "context", "--page-size", "2", "--page", "2"]);
    assert.notDeepEqual(contexts.value.items, nextContexts.value.items);
    const messages = await invoke(["sessions", "messages", id, "--version", version, "--mode", "brief", "--max-text-chars", "200"]);
    assert.ok(Buffer.byteLength(messages.stdout) < 16_000);
    const first = messages.value.messages.find((message: { kind: string }) => message.kind === "assistant");
    assert.ok(first.textTruncated);
    let text = first.text, offset = first.nextTextOffset;
    while (offset !== undefined) {
      const part = await invoke(["sessions", "messages", id, "--version", version, "--mode", "brief", "--message-id", first.id,
        "--text-offset", String(offset), "--max-text-chars", "4000"]);
      const message = part.value.messages.find((item: { id: string }) => item.id === first.id);
      assert.equal(message.textOffset, offset);
      assert.equal(message.textLength, body.length);
      text += message.text;
      offset = message.nextTextOffset;
    }
    assert.equal(text, body, "截断后的连续字符范围必须完整还原正文");
    const status = await invoke(["status"]);
    assert.ok(Buffer.byteLength(status.stdout) < 16_000);
    assert.equal(status.value.running, true);
    const prices = await invoke(["usage", "pricing", "get"]);
    assert.equal(prices.value.prices, undefined);
    assert.ok(Buffer.byteLength(prices.stdout) < 16_000);
    const page = await invoke(["usage", "pricing", "list", "--page-size", "2"]);
    assert.equal(page.value.prices.length, 2);
    assert.ok(page.value.total > 2);
    const human = await invoke(["sessions", "list", "--page-size", "1"], false);
    assert.ok(human.stdout.includes("Atlas"));
    assert.ok(!human.stdout.trimStart().startsWith("{"));
    assert.ok(human.stdout.split("\n").length < 15);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
