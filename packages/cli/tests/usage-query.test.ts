import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { registerUsage } from "../src/commands/usage.js";
import type { CliContext } from "../src/context.js";
import { createProgram } from "../src/program.js";

test("用量 CLI 保留短 GET 查询，复杂报告、状态和请求页使用 POST 请求体", async () => {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const context: CliContext = { language: "en", t: key => key, output: () => undefined, fetch: async () => ({}),
    request: async (_command, path, method, body) => { calls.push({ path, method, body }); return {}; },
    filters: command => command, waiting: command => command };
  const groups = Array.from({ length: 120 }, (_, index) => `["codex","synthetic-${index}-${"variant".repeat(12)}"]`);
  for (const name of ["report", "status", "requests"]) {
    const program = new Command(); registerUsage(program, context);
    await program.parseAsync(["usage", name, "--query", JSON.stringify({ includeSpeed: true, speedGroups: groups,
      ...(name === "requests" ? { sessionId: "synthetic-session", requestPage: 2 } : {}) })], { from: "user" });
    const actual = calls.at(-1)!;
    assert.equal(actual.method, "POST"); assert.equal(actual.path, name === "report" ? "/usage" : `/usage/${name}`);
    const body = actual.body as Record<string, string>;
    assert.deepEqual(JSON.parse(body.speedGroups!), groups); assert.equal(body.includeSpeed, "true");
    if (name === "requests") assert.equal(body.requestPage, "2");
  }
  const program = new Command(); registerUsage(program, context);
  await program.parseAsync(["usage", "report", "--page", "2"], { from: "user" });
  assert.deepEqual(calls.at(-1), { path: "/usage?page=2", method: "GET", body: undefined });
});

test("实际 CLI 长查询发送 POST 正文，默认 JSON 摘要与 full 保持原响应约定", async () => {
  const { createServer } = await import("node:http");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { VERSION } = await import("../../../src/version.js");
  const home = await mkdtemp(join(tmpdir(), "manor-cli-usage-query-"));
  let instance: Record<string, unknown>;
  const calls: { method?: string; url: URL; body: Record<string, string> }[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname === "/api/v1/status") { response.end(JSON.stringify({ instance, version: VERSION, protocolVersion: 1 })); return; }
    let body = ""; for await (const chunk of request) body += String(chunk);
    calls.push({ method: request.method, url, body: JSON.parse(body) });
    response.end(JSON.stringify({ version: "synthetic-index", totals: { requests: 1, tokens: 2000, estimatedCost: 0.5 },
      sessions: [{ session: { id: "synthetic-session", title: "合成会话", client: "codex" },
        ...(url.searchParams.get("response") === "summary" ? {} : { requests: [{ usage: { id: "synthetic-request" } }] }) }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  instance = { id: "synthetic-usage-service", pid: process.pid, host: "127.0.0.1", port: address.port,
    startedAt: new Date().toISOString(), version: VERSION, protocolVersion: 1 };
  await writeFile(join(home, "service.json"), JSON.stringify(instance));
  const groups = Array.from({ length: 120 }, (_, index) => `synthetic-${index}-${"variant".repeat(12)}`);
  const original = process.stdout.write; let output = "";
  process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    for (const full of [false, true]) {
      output = "";
      await createProgram("en").parseAsync(["--home", home, "--no-update-check", "--json", ...(full ? ["--full"] : []),
        "usage", "report", "--query", JSON.stringify({ includeSpeed: true, speedGroups: groups })], { from: "user" });
      const result = JSON.parse(output), actual = calls.at(-1)!;
      assert.equal(actual.method, "POST"); assert.equal(actual.url.pathname, "/api/v1/usage");
      assert.equal(actual.url.searchParams.get("response"), full ? null : "summary");
      assert.deepEqual(JSON.parse(actual.body.speedGroups!), groups);
      assert.equal(result.totals.tokens, 2000); assert.equal(result.sessions[0].requests?.length, full ? 1 : undefined);
    }
  } finally {
    process.stdout.write = original;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
