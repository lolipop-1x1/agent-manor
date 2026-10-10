/** 查询身份区分缺失维度与原始名称，索引中的原值始终保留。 */
export function usageDimensionKey(value: string | undefined): string {
  if (value === undefined) return "unknown";
  return value === "unknown" || value.startsWith("literal:") ? `literal:${value}` : value;
}

export function usageDimensionValue(key: string): string | undefined {
  return key === "unknown" ? undefined : key.startsWith("literal:") ? key.slice("literal:".length) : key;
}
