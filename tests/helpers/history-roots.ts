import { clientIds } from "../../src/clients.js";
import type { DiscoverRoots } from "../../src/history/types.js";
import { join } from "node:path";

/** 默认关闭全部已注册来源，测试显式传入需要覆盖的客户端。 */
export function isolatedHistoryRoots(overrides: DiscoverRoots = {}): DiscoverRoots {
  return { ...Object.fromEntries(clientIds.map(client => [client, []])), ...overrides } as DiscoverRoots;
}

/** 子进程默认只看不存在的隔离目录，测试来源必须显式覆盖。 */
export function isolatedHistoryEnvironment(directory: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const roots = Object.fromEntries(clientIds.map(client => [
    `AGENT_MANOR_${client.toUpperCase().replaceAll("-", "_")}_DIR`,
    join(directory, "isolated-history", client),
  ]));
  return {
    ...process.env,
    ...roots,
    MYFLICKER_HOME: join(directory, "isolated-history", "myflicker"),
    ...overrides,
  };
}
