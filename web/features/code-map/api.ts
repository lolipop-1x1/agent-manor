import type { CoverageQuery } from "../../../src/contracts";

export function queryString(query: CoverageQuery, extra: Record<string, string | number | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...query, ...extra })) {
    if (value === undefined || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const result = params.toString();
  return result ? `?${result}` : "";
}

export const repositoryPath = (id: string) => `/repositories/${encodeURIComponent(id)}`;
