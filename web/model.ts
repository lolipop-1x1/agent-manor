import type { CoverageQuery, FileCategory, FileCoverage, FileDetail, Filters, GapKind, Job, LineRange } from "../src/contracts";
import type { MapRect } from "./map-viewport";
import { formatDateTime, formatNumber, formatPercent, isMessageDescriptorKnown, translate, translateMessage } from "../src/i18n";
import { formatList, getLanguage, t } from "./i18n";

export type Metric = "read" | "edit" | "activity";
export type Theme = "light" | "dark";
export const metricNames: Record<Metric, string> = {
  get read() { return t("codeMap.metric.read"); }, get edit() { return t("codeMap.metric.edit"); }, get activity() { return t("codeMap.metric.activity"); },
};
export const categoryNames: Record<FileCategory, string> = {
  get source() { return t("common.category.source"); }, get config() { return t("common.category.config"); },
  get docs() { return t("common.category.docs"); }, get unknown() { return t("common.category.unknown"); },
};
const gapKeys: Record<GapKind, string> = {
  source_missing: "sourceMissing", source_unavailable: "sourceUnavailable", range_unknown: "rangeUnknown",
  unsupported_format: "unsupportedFormat", unsupported_tool: "unsupportedTool", ambiguous: "ambiguous",
  unassociated: "unassociated", parse_error: "parseError", incomplete_record: "incompleteRecord",
  unpaired_call: "unpairedCall", budget_exceeded: "budgetExceeded",
};
export const gapNames = Object.fromEntries(Object.entries(gapKeys).map(([kind, key]) => [kind, key])) as Record<GapKind, string>;
for (const [kind, key] of Object.entries(gapKeys)) Object.defineProperty(gapNames, kind, { get: () => t(`codeMap.gap.${key}`) });
export const fmt = (value: number) => formatNumber(getLanguage(), value);
export const percent = (numerator: number, denominator: number) => denominator ? formatPercent(getLanguage(), numerator / denominator, { minimumFractionDigits: 1 }) : "—";
export const filename = (path: string) => path.split("/").at(-1) ?? path;
export const rangesLabel = (ranges: LineRange[]) => formatList(ranges.map(range => range.start === range.end ? `L${fmt(range.start)}` : `L${fmt(range.start)}–${fmt(range.end)}`));
export const dateLabel = (value?: string) => value ? formatDateTime(getLanguage(), value, { dateStyle: "medium", timeStyle: "medium", hour12: false }) : t("common.timeUnknown");

export function refreshFailureReason(job: Pick<Job, "error" | "errorDescriptor" | "phase" | "phaseDescriptor">, language = getLanguage()): string {
  const original = job.error !== undefined ? job.error : job.phase;
  const descriptor = job.error !== undefined ? job.errorDescriptor : job.phaseDescriptor;
  return isMessageDescriptorKnown(descriptor) ? translateMessage(language, descriptor) : translate(language, "common.originalDetail", { detail: original });
}

/** 每次下钻使用已发布的版本和原筛选，目录以显式参数覆盖。 */
export function boundQuery(filters: Filters, version: string, directory?: string): CoverageQuery {
  return { ...filters, version, directory: directory ?? filters.directory };
}

export function timeFilters(window: string, from: string, to: string, now = Date.now()): Pick<Filters, "from" | "to"> {
  if (window === "custom") {
    return {
      from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
    };
  }
  return window === "all" ? {} : { from: new Date(now - Number(window) * 86_400_000).toISOString() };
}

export interface MapNode { name: string; path: string; file?: FileCoverage; children?: MapNode[] }

/** 只给屏幕上的文字避让目录标题，不改变文件的逻辑面积或点击区域。 */
export function fileLabelRect(rect: MapRect, headings: MapRect[], inset = 10): MapRect {
  const x = rect.x + inset;
  const right = rect.x + rect.width - inset;
  const bottom = rect.y + rect.height - inset;
  let y = rect.y + inset;
  for (const heading of headings) {
    if (heading.x < right && heading.x + heading.width > x && heading.y < bottom && heading.y + heading.height > y) {
      y = Math.max(y, heading.y + heading.height + 4);
    }
  }
  return { x, y: Math.min(y, bottom), width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

export function directories(files: FileCoverage[]): { path: string; count: number; depth: number }[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const parts = file.path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i += 1) {
      const path = parts.slice(0, i).join("/");
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([path, count]) => ({ path, count, depth: path.split("/").length }));
}

export interface DirectoryNode { path: string; count: number; children: DirectoryNode[] }

/** 目录计数包含全部后代文件，按真实父子路径组织选择层级。 */
export function directoryTree(files: FileCoverage[]): DirectoryNode[] {
  const root: DirectoryNode[] = [];
  const nodes = new Map<string, DirectoryNode>();
  for (const directory of directories(files)) {
    const node: DirectoryNode = { path: directory.path, count: directory.count, children: [] };
    nodes.set(node.path, node);
    const parent = node.path.slice(0, node.path.lastIndexOf("/"));
    (directory.depth === 1 ? root : nodes.get(parent)!.children).push(node);
  }
  return root;
}

export function metricValue(file: FileCoverage, metric: Metric): number {
  return metric === "activity" ? file.activityCount
    : metric === "edit" ? file.editExactLines : file.readExactLines;
}

export function fileHighlights(detail: FileDetail, metric: Metric, showNear: boolean): { exact: LineRange[]; near: LineRange[] } {
  if (detail.contentStale || detail.content === null) return { exact: [], near: [] };
  return {
    exact: metric === "edit" ? detail.file.editExactRanges : detail.file.readExactRanges,
    near: showNear ? metric === "edit" ? detail.file.editNearRanges : detail.file.readNearRanges : [],
  };
}
