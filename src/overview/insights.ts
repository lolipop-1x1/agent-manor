import type { OverviewInsight, OverviewPeriod, OverviewQuery, OverviewReport, OverviewResources, OverviewSource } from "../overview-contracts.js";
import type { UsageReport } from "../usage-contracts.js";
import type { PricingView } from "../usage/pricing.js";
import { buildUsageReport } from "../usage/analytics.js";
import { selectedSource, buildResources } from "./analytics.js";
import { decomposeUsage } from "./insight-math.js";

export interface OverviewInsightUsage {
  current: UsageReport;
  previous: UsageReport;
  currentProjects: UsageReport;
  previousProjects: UsageReport;
  currentMissing?: number;
  previousMissing?: number;
}
export interface OverviewInsightContext {
  comparison?: OverviewInsightUsage;
  recent?: OverviewInsightUsage;
  previousResources?: OverviewResources;
  currentResources?: OverviewResources;
}
const significant = (current: number, previous: number, floor = .2) => previous > 0 && Math.abs(current - previous) / previous >= floor;

/** 每类先选一个有样本、有实际变化的结论，不构造片段、组合和后续调用列表。 */
export function coreOverviewInsights(report: Pick<OverviewReport, "query" | "range" | "priceVersion" | "resources" | "process">,
  context: OverviewInsightContext): { insights: OverviewInsight[]; featuredInsights: OverviewInsight[] } {
  const result: OverviewInsight[] = [];
  const add = (value: Omit<OverviewInsight, "id" | "period" | "missing"> & { period?: OverviewPeriod; missing?: number }) => {
    if (result.length >= 5) return;
    result.push({ ...value, period: value.period ?? { from: report.range.from, to: report.range.to }, missing: value.missing ?? 0,
      id: JSON.stringify([value.rule, value.metric, value.object, value.period ?? report.range]) });
  };
  const usageChange = (values: OverviewInsightUsage | undefined, period: typeof report.range.comparison, recent: boolean) => {
    if (!values || !period) return;
    const next = values.current.totals, prior = values.previous.totals;
    if (next.completeTokenRequests < 20 || prior.completeTokenRequests < 20 || next.tokens === null || prior.tokens === null
      || !significant(next.tokens, prior.tokens)) return;
    const decomposition = decomposeUsage(prior.completeTokenRequests, prior.tokens, next.completeTokenRequests, next.tokens)!;
    add({ rule: "01", type: "change", metric: recent ? "recent_complete_tokens" : "complete_tokens",
      descriptor: { key: recent ? "overview.insight.recentUsage" : "overview.insight.usage", params: { current: next.tokens,
        previous: prior.tokens, ...(recent ? {} : { countContribution: decomposition.countContribution, meanContribution: decomposition.meanContribution }) } },
      current: next.tokens, previous: prior.tokens, sample: next.completeTokenRequests,
      missing: values.currentMissing ?? next.partialTokenRequests + next.missingTokenRequests, period: period.current, previousPeriod: period.previous,
      values: { currentRequests: next.completeTokenRequests, previousRequests: prior.completeTokenRequests,
        previousMissing: values.previousMissing ?? prior.partialTokenRequests + prior.missingTokenRequests, currentInput: next.inputTokens, previousInput: prior.inputTokens,
        currentOutput: next.outputTokens, previousOutput: prior.outputTokens, currentMean: decomposition.currentMean,
        previousMean: decomposition.previousMean, countContribution: decomposition.countContribution, meanContribution: decomposition.meanContribution,
        priceVersion: report.priceVersion }, evidence: { kind: "requests", scope: "usage", period: recent ? "recent" : "current", sort: "tokens", rule: "01" } });
  };
  // 年度视图优先近期变化，同长度比较仅在不重复同一结论时使用。
  usageChange(context.recent, report.range.recent, true);
  if (!result.length) usageChange(context.comparison, report.range.comparison, false);
  if (context.comparison && report.range.comparison) {
    for (const dimension of ["project", "model"] as const) {
      const next = dimension === "project" ? context.comparison.currentProjects : context.comparison.current;
      const prior = dimension === "project" ? context.comparison.previousProjects : context.comparison.previous;
      if (next.totals.requests < 20 || prior.totals.requests < 20) continue;
      const previous = new Map(prior.groups.map(group => [group.key, group]));
      const changes = next.groups.filter(group => group.key !== "unknown" && group.totals.requests >= 20)
        .map(group => ({ group, prior: previous.get(group.key), shift: group.totals.requests / next.totals.requests
          - (previous.get(group.key)?.totals.requests ?? 0) / prior.totals.requests }))
        .filter(value => value.prior && value.prior.totals.requests >= 20 && Math.abs(value.shift) >= .1)
        .sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift) || a.group.key.localeCompare(b.group.key));
      const strongest = changes[0]; if (!strongest) continue;
      const currentShare = strongest.group.totals.requests / next.totals.requests, previousShare = strongest.prior!.totals.requests / prior.totals.requests;
      add({ rule: dimension === "project" ? "07" : "08", type: "change", object: strongest.group.label,
        metric: `${dimension}_request_share`, descriptor: { key: `overview.insight.${dimension}ShareChange`,
          params: { name: strongest.group.label, current: currentShare * 100, previous: previousShare * 100 } },
        current: currentShare, previous: previousShare, sample: next.totals.requests, period: report.range.comparison.current,
        previousPeriod: report.range.comparison.previous, values: { currentShare, previousShare, currentRequests: strongest.group.totals.requests,
          previousRequests: strongest.prior!.totals.requests }, evidence: { kind: "requests", scope: "usage", period: "current",
          ...(dimension === "project" ? { project: strongest.group.key } : { model: strongest.group.key }) } });
    }
  }
  const resources = [...report.resources.skills, ...report.resources.mcp].filter(row => row.sessions >= 5 && row.activeWeeks >= 4
    && row.nameDescriptor?.key !== "sessions.resource.nameUnrecorded").sort((a, b) => b.sessions - a.sessions || b.uses - a.uses || a.id.localeCompare(b.id));
  const previousResources = new Map([...(context.previousResources?.skills ?? []), ...(context.previousResources?.mcp ?? [])].map(row => [row.id, row]));
  const changed = [...(context.currentResources?.skills ?? []), ...(context.currentResources?.mcp ?? [])].filter(row => row.sessions >= 5 && row.activeWeeks >= 4
    && row.nameDescriptor?.key !== "sessions.resource.nameUnrecorded").find(row => { const previous = previousResources.get(row.id);
    return previous && previous.sessions >= 5 && significant(row.sessions, previous.sessions); });
  const resource = changed ?? resources[0];
  if (resource) {
    const previous = previousResources.get(resource.id);
    add({ rule: "03", type: changed ? "change" : "feature", object: resource.id, metric: "resource_breadth",
      descriptor: { key: changed ? "overview.insight.resourceChange" : "overview.insight.resource", params: changed
        ? { name: resource.name, current: resource.sessions, previous: previous!.sessions }
        : { name: resource.name, sessions: resource.sessions, calls: resource.uses, weeks: resource.activeWeeks } },
      current: resource.sessions, ...(changed ? { previous: previous!.sessions, period: report.range.comparison!.current,
        previousPeriod: report.range.comparison!.previous } : {}), sample: resource.sessions,
      values: { uses: resource.uses, activeWeeks: resource.activeWeeks, explicitCalls: resource.explicitCalls, successfulReads: resource.successfulReads },
      evidence: { kind: "resources", resourceId: resource.id, ...(changed ? { period: "current" as const } : {}) } });
  }
  const failed = [...report.process.tools].filter(tool => tool.results.failure >= 3 && tool.results.known >= 20
    && (tool.results.coverage ?? 0) >= .8 && (tool.results.failureRate ?? 0) >= .05)
    .sort((a, b) => b.results.failure - a.results.failure || a.key.localeCompare(b.key))[0];
  if (failed) add({ rule: "11", type: "investigation", object: failed.key, metric: "confirmed_tool_failure",
    descriptor: { key: "overview.insight.failure", params: { tool: failed.name, failures: failed.results.failure,
      days: failed.days.filter(day => day.failures > 0).length, known: failed.results.known, unknown: failed.results.unknown } },
    current: failed.results.failure, sample: failed.results.known, missing: failed.results.unknown,
    values: { success: failed.results.success, failure: failed.results.failure, unknown: failed.results.unknown,
      resultCoverage: failed.results.coverage, failureRate: failed.results.failureRate, server: failed.server ?? null },
    evidence: { kind: "failures", tool: failed.name, toolId: failed.key, server: failed.server, status: "failure" } });
  return { insights: result, featuredInsights: result };
}

/** 兼容完整报告入口仍使用同一有界洞察规则，详细序列另走调查。 */
export function generateOverviewInsights(source: OverviewSource, query: OverviewQuery, pricing: PricingView, report: OverviewReport) {
  const usage = (period: OverviewPeriod, groupBy: "project" | "model") => buildUsageReport(source, { version: source.version,
    timezone: report.timezone, priceVersion: pricing.status.version, from: period.from, to: period.to, clients: query.clients,
    projects: query.projects, models: query.models, coverage: "complete", groupBy }, pricing.status, pricing.estimate);
  const compare = (period: NonNullable<typeof report.range.comparison>): OverviewInsightUsage => {
    const current = usage(period.current, "model"), previous = usage(period.previous, "model");
    const all = (range: OverviewPeriod) => buildUsageReport(source, { ...current.query, ...range, coverage: "all" }, pricing.status, pricing.estimate);
    return { current, previous, currentProjects: usage(period.current, "project"), previousProjects: usage(period.previous, "project"),
      currentMissing: all(period.current).totals.requests - current.totals.requests, previousMissing: all(period.previous).totals.requests - previous.totals.requests };
  };
  const previous = report.range.comparison?.previous;
  const previousResources = previous ? buildResources(source, selectedSource(source, query, { ...report.range, ...previous }),
    { ...report.range, ...previous }, report.timezone, false) : undefined;
  return { ...coreOverviewInsights(report, { comparison: report.range.comparison ? compare(report.range.comparison) : undefined,
    recent: report.range.recent ? compare(report.range.recent) : undefined, previousResources,
    currentResources: report.range.comparison ? buildResources(source, selectedSource(source, query, { ...report.range, ...report.range.comparison.current }),
      { ...report.range, ...report.range.comparison.current }, report.timezone, false) : undefined }), projectMonths: [], modelTransitions: [] };
}
