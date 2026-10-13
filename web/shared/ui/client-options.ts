import { CLIENTS } from "../../../src/clients";
import { clientLabel } from "../i18n";
import type { FilterOption } from "./FilterSelect";

/** 只显示完整功能数据中的客户端，按共享名单排序并实时翻译名称。 */
export function availableClientOptions(clients: readonly string[] = []): FilterOption[] {
  const available = new Set(clients);
  return CLIENTS.filter(client => available.has(client.id)).map(client => ({ value: client.id, label: clientLabel(client.id) }));
}
