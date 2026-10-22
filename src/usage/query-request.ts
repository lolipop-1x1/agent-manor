/** 长筛选放入请求体，避免模型分组和项目路径超过 HTTP 请求头限制。 */
export function usageReadRequest(path: string, parameters: string): {
  path: string; method: "GET" | "POST"; body?: Record<string, string>;
} {
  const query = parameters.startsWith("?") ? parameters.slice(1) : parameters;
  return query.length <= 4096 ? { path: query ? `${path}?${query}` : path, method: "GET" }
    : { path, method: "POST", body: Object.fromEntries(new URLSearchParams(query)) };
}
