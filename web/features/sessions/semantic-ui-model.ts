import type { SemanticScope, SemanticStatus } from "../../../src/semantic-contracts";
import type { SessionSearchScope } from "../../../src/session-contracts";

export function sharedSessionSearchScope(scope: SemanticScope): SessionSearchScope {
  const { timeRange: _timeRange, recentDays: _recentDays, ...shared } = scope;
  return shared;
}

export function searchScopeExtraCount(scope: SemanticScope): number {
  return [scope.relationship !== "exclude_children", scope.executionMode !== "exclude_quiet", !!scope.from, !!scope.to, !!scope.models.length,
    !!scope.title, scope.branch !== "all", scope.minMessages !== undefined, scope.maxMessages !== undefined, scope.minTurns !== undefined, scope.maxTurns !== undefined].filter(Boolean).length;
}

export function searchScopeInvalid(scope: SemanticScope): boolean {
  return Boolean(scope.from && scope.to && Date.parse(scope.from) > Date.parse(scope.to))
    || [[scope.minMessages, scope.maxMessages], [scope.minTurns, scope.maxTurns]].some(([min, max]) =>
      [min, max].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000)) || min !== undefined && max !== undefined && min > max);
}

/** 查询范围独立于后台维护范围，缺省不限制日期。 */
export function semanticQueryScope(): SemanticScope {
  return { timeRange: "all", recentDays: 30, clients: [], projects: [], relationship: "exclude_children", executionMode: "exclude_quiet", models: [], title: "", branch: "all" };
}

export function semanticStatusKey(status?: SemanticStatus): string {
  if (!status) return "sessions.semantic.status.unconfigured";
  if (!status.enabled) return "sessions.semantic.status.disabled";
  if (status.job?.status === "running") return "sessions.semantic.status.building";
  if (status.job?.status === "paused") return "sessions.semantic.status.paused";
  if (status.job?.status === "budget_stopped") return "sessions.semantic.status.budgetStopped";
  if (status.job?.status === "failed") return "sessions.semantic.status.failed";
  return status.ready ? "sessions.semantic.status.ready" : "sessions.semantic.status.needsBuild";
}

export function semanticProgress(status?: SemanticStatus): number | undefined {
  const job = status?.job;
  if (job?.phase === "complete") return 100;
  if (!job || job.phase === "scanning" || !job.totalInputs) return undefined;
  return Math.max(0, Math.min(100, Math.floor(job.completedInputs / job.totalInputs * 100)));
}

export function localSemanticDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function semanticDateBoundary(value: string, end = false): string | undefined {
  if (!value) return undefined;
  return new Date(`${value}T${end ? "23:59:59.999" : "00:00:00"}`).toISOString();
}

/** 非零的小额估算保留有效数字，避免把微小费用展示成免费。 */
export function semanticCost(value: number | null | undefined, language: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return new Intl.NumberFormat(language, { style: "currency", currency: "USD", ...(value > 0 && value < 0.01 ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 2 }) }).format(value);
}

/** 暂停或失败时允许放弃过期计划重新预览，成功的兼容向量继续复用。 */
export function semanticCanRepreview(status?: SemanticStatus): boolean {
  return Boolean(status?.job && status.job.status !== "running" && status.job.status !== "complete");
}

export function semanticBuildMetrics(status?: SemanticStatus, now = Date.now()): { encoded: number; perMinute?: number; remainingSeconds?: number } {
  const job = status?.job;
  if (!job) return { encoded: 0 };
  const encoded = Math.max(0, job.completedInputs - job.reusedInputs);
  const elapsed = ((job.finishedAt ? Date.parse(job.finishedAt) : now) - Date.parse(job.createdAt)) / 1000;
  const perMinute = encoded > 0 && elapsed > 0 && Number.isFinite(elapsed) ? encoded / elapsed * 60 : undefined;
  const pending = Math.max(0, job.totalInputs - job.completedInputs);
  return { encoded, perMinute, remainingSeconds: job.status === "running" && perMinute ? Math.ceil(pending / perMinute * 60) : undefined };
}
