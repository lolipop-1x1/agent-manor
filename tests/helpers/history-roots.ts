import { clientIds } from "../../src/clients.js";
import type { DiscoverRoots } from "../../src/history/types.js";

/** 默认关闭全部已注册来源，测试显式传入需要覆盖的客户端。 */
export function isolatedHistoryRoots(overrides: DiscoverRoots = {}): DiscoverRoots {
  return { ...Object.fromEntries(clientIds.map(client => [client, []])), ...overrides } as DiscoverRoots;
}
