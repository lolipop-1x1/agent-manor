import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultSemanticConfig, encodingFingerprint, SemanticConfigStore } from "../src/semantic/config.js";
import { automaticModelPrefixes, resolveModelConnection } from "../src/semantic/model-adapters.js";

test("常见模型按明确名称使用对应的正文和查询格式", () => {
  const qwen = { documentPrefix: "", queryPrefix: "Instruct: Retrieve past conversations relevant to the search query.\nQuery:" };
  for (const model of ["qwen3-embedding:0.6b", "library/qwen3-embedding:4b", "Qwen/Qwen3-Embedding-0.6B", "Qwen/Qwen3-Embedding-8B"]) assert.deepEqual(automaticModelPrefixes(model), qwen, model);
  for (const model of ["intfloat/multilingual-e5-small", "multilingual-e5-base", "multilingual-e5-large:latest"]) assert.deepEqual(automaticModelPrefixes(model), { documentPrefix: "passage: ", queryPrefix: "query: " }, model);
  for (const size of ["small", "base", "large"]) {
    assert.deepEqual(automaticModelPrefixes(`BAAI/bge-${size}-en-v1.5`), { documentPrefix: "", queryPrefix: "Represent this sentence for searching relevant passages: " });
    assert.deepEqual(automaticModelPrefixes(`bge-${size}-zh-v1.5`), { documentPrefix: "", queryPrefix: "为这个句子生成表示以用于检索相关文章：" });
  }
  for (const model of ["nomic-embed-text", "nomic-embed-text:latest", "nomic-ai/nomic-embed-text-v1.5"]) assert.deepEqual(automaticModelPrefixes(model), { documentPrefix: "search_document: ", queryPrefix: "search_query: " }, model);
});

test("未知名称、相似名称和其他模型变体不推测编码规则", () => {
  for (const model of ["", "text-embedding-3-small", "BAAI/bge-m3", "multilingual-e5-large-instruct", "nomic-embed-text-v2-moe", "custom/qwen3-embedding", "my-qwen3-embedding", "qwen3", "bge-small-en-v1.5-custom"]) {
    assert.deepEqual(automaticModelPrefixes(model), { documentPrefix: "", queryPrefix: "" }, model);
  }
});

test("更换连接时自动适配，改回原连接恢复原有规则快照", () => {
  const previous = { ...defaultSemanticConfig().connection, url: "https://example.invalid/v1", model: "qwen3-embedding:0.6b", queryPrefix: "legacy: " };
  const updated = resolveModelConnection({ ...previous, model: "intfloat/multilingual-e5-small" }, previous);
  assert.equal(updated.documentPrefix, "passage: "); assert.equal(updated.queryPrefix, "query: ");
  assert.deepEqual(resolveModelConnection({ ...updated, model: previous.model }, previous), previous);
  const otherService = resolveModelConnection({ ...previous, url: "https://another.example.invalid/v1" }, previous);
  assert.equal(otherService.queryPrefix, automaticModelPrefixes(previous.model).queryPrefix);
});

test("读取与保存已有连接保留编码规则和索引指纹，不静默应用新增适配", async t => {
  const home = await mkdtemp(join(tmpdir(), "manor-semantic-adapter-")); t.after(() => rm(home, { recursive: true, force: true }));
  const store = new SemanticConfigStore(home), config = defaultSemanticConfig();
  Object.assign(config.connection, { url: "https://example.invalid/v1", model: "qwen3-embedding:0.6b", dimensions: 1024 });
  const original = encodingFingerprint(config);
  await store.save({ config });
  const loaded = await new SemanticConfigStore(home).read();
  assert.equal(loaded.fingerprint, original); assert.equal(loaded.config.connection.queryPrefix, "");
  loaded.config.connection = resolveModelConnection({ ...loaded.config.connection, queryPrefix: "new-rule: " }, loaded.config.connection);
  loaded.config.strategy.concurrency = 2;
  const saved = await store.save({ config: loaded.config });
  assert.equal(saved.fingerprint, original); assert.equal(saved.config.connection.queryPrefix, "");
});
