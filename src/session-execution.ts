import type { Client } from "./clients.js";
import type { SessionSummary } from "./session-contracts.js";

type ExecutionEntry = NonNullable<SessionSummary["executionEntries"]>[number];

/** 只映射核查过的入口写入规则；原生子会话也可能继承该入口。 */
export function isQuietEntry(client: Client, entry: ExecutionEntry): boolean {
  return client === "codeflicker" && entry.version === "0.3.26" && entry.entrypoint === "sdk-cli";
}

/** 混合或未知入口保留为常规列表项，避免隐藏恢复后的交互会话。 */
export function sessionExecutionMode(client: Client, entries: ExecutionEntry[] | undefined): "quiet" | undefined {
  return entries?.length && entries.every(entry => isQuietEntry(client, entry)) ? "quiet" : undefined;
}
