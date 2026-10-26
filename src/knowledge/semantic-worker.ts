import { parentPort, workerData } from "node:worker_threads";
import type { KnowledgeConfig, KnowledgeDraft, KnowledgeQuery } from "../knowledge-contracts.js";
import { SemanticError } from "../semantic/config.js";
import { KnowledgeStore, KnowledgeError } from "./store.js";
import { KnowledgeSemanticEngine } from "./semantic-engine.js";
import type { KnowledgeSemanticFailure, KnowledgeSemanticRequest, KnowledgeSemanticResponse, KnowledgeSettingsMethod } from "./semantic-worker-contracts.js";

const port = parentPort!;
const { home, dbPath } = workerData as { home: string; dbPath: string };
const store = new KnowledgeStore(dbPath);
const providers = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const requests = new Map<number, AbortController>();
let sequence = 0;
const send = (value: KnowledgeSemanticResponse) => port.postMessage(value);
const configuration = <T>(method: KnowledgeSettingsMethod): Promise<T> => new Promise((resolve, reject) => {
  const id = ++sequence;
  providers.set(id, { resolve: value => resolve(value as T), reject });
  send({ type: "configuration", id, method });
});
let engine: KnowledgeSemanticEngine;
engine = new KnowledgeSemanticEngine(home, store, { settings: () => configuration("settings"), key: () => configuration("key") },
  { settings: () => configuration("reusedSettings"), key: () => configuration("reusedKey") }, () => send({ type: "busy", busy: engine?.busy ?? false }));
const failure = (error: unknown): KnowledgeSemanticFailure => error instanceof KnowledgeError
  ? { kind: "knowledge", code: error.code, message: error.message, messageDescriptor: error.messageDescriptor }
  : error instanceof SemanticError
    ? { kind: "semantic", code: error.code, status: error.status, message: error.message, messageDescriptor: error.messageDescriptor }
    : { kind: "internal", code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error), messageDescriptor: { key: "knowledge.errors.index_failed" } };

port.on("message", async (message: KnowledgeSemanticRequest | { type: "configuration"; id: number; result?: unknown; error?: string } | { type: "cancel"; id: number }) => {
  if ("type" in message) {
    if (message.type === "cancel") { requests.get(message.id)?.abort(); return; }
    const pending = providers.get(message.id);
    if (!pending) return;
    providers.delete(message.id);
    if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
    return;
  }
  const controller = new AbortController(); requests.set(message.id, controller);
  try {
    const input = message.input;
    let result: unknown;
    switch (message.method) {
      case "status": result = await engine.status(); break;
      case "preview": result = await engine.preview(); break;
      case "build": result = await engine.build(input as string); break;
      case "action": result = await engine.action(input as "pause" | "resume"); break;
      case "search": result = await engine.search(input as KnowledgeQuery); break;
      case "maintain": result = await engine.maintain(); break;
      case "compareCandidates": {
        const { candidate, others, config } = input as { candidate: KnowledgeDraft; others: KnowledgeDraft[]; config: KnowledgeConfig };
        result = await engine.compareCandidates(candidate, others, config, controller.signal); break;
      }
      case "close": await engine.close(); store.close(); break;
    }
    send({ type: "result", id: message.id, result });
  } catch (error) { send({ type: "result", id: message.id, error: failure(error) }); }
  finally { requests.delete(message.id); }
});
send({ type: "ready" });
