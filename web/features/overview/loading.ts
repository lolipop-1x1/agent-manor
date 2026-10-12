import { overviewPanels, type OverviewDetailPage, type OverviewDetailQuery, type OverviewDistributionDimension, type OverviewEvidencePage, type OverviewEvidenceQuery, type OverviewPanel, type OverviewPanelResult, type OverviewQuery, type OverviewSnapshot } from "../../../src/overview-contracts";
import { overviewParameters } from "./model";

type Distribution = OverviewDistributionDimension | "tool";
type Transport = <T>(path: string, signal: AbortSignal) => Promise<T>;
export const requiredOverviewPanels = (dimension: Distribution): OverviewPanel[] => [...overviewPanels, "facets", ...(dimension === "tool" ? [] : ["distribution" as const])];
export interface OverviewPanelBatch {
  key: string;
  snapshot: OverviewSnapshot;
  panels: Partial<Record<OverviewPanel, OverviewPanelResult>>;
  distributions: Partial<Record<OverviewDistributionDimension, OverviewPanelResult>>;
  dimension: Distribution;
  complete: boolean;
}

export async function loadOverviewPanel(snapshot: OverviewSnapshot, panel: OverviewPanel, transport: Transport, signal: AbortSignal, dimension?: OverviewDistributionDimension): Promise<OverviewPanelResult> {
  const fixed = overviewParameters({ ...snapshot.query, version: snapshot.version, priceVersion: snapshot.priceVersion, timezone: snapshot.timezone, panel, dimension });
  const result = await transport<OverviewPanelResult>(`/overview/panel?${fixed}`, signal);
  if (signal.aborted) throw new DOMException("", "AbortError");
  if (result.panel !== panel || result.dimension !== dimension || !sameOverviewSnapshot(snapshot, result.snapshot) || panel === "distribution" && !result.data.distribution || panel === "delegation" && !result.data.delegation) throw new OverviewSnapshotMismatch();
  return result;
}

/** 固定一个快照后并发获取必需分区，维度变化只补读缺少的分布。 */
export async function loadOverviewPanels(query: OverviewQuery, key: string, transport: Transport, signal: AbortSignal, onSnapshot: (batch: OverviewPanelBatch) => void, onPanel: (batch: OverviewPanelBatch) => void, onError?: (panel: OverviewPanel, error: unknown) => void, currentDimension: () => Distribution = () => "project"): Promise<OverviewPanelBatch> {
  const snapshot = await transport<OverviewSnapshot>(`/overview/snapshot?${overviewParameters(query)}`, signal);
  let batch: OverviewPanelBatch = { key, snapshot, panels: {}, distributions: {}, dimension: currentDimension(), complete: false };
  if (signal.aborted) throw new DOMException("", "AbortError");
  onSnapshot(batch);
  const receive = async (panel: OverviewPanel, dimension?: OverviewDistributionDimension) => {
    try {
      const result = await loadOverviewPanel(snapshot, panel, transport, signal, dimension);
      batch = replaceOverviewPanel(batch, snapshot, result)!;
      onPanel({ ...batch, complete: false });
    } catch (error) { if (!signal.aborted && (panel !== "distribution" || dimension === currentDimension())) onError?.(panel, error); throw error; }
  };
  const initialDimension = batch.dimension;
  const panels = requiredOverviewPanels(initialDimension);
  const results = await Promise.allSettled(panels.map(panel => receive(panel, panel === "distribution" && initialDimension !== "tool" ? initialDimension : undefined)));
  if (signal.aborted) throw new DOMException("", "AbortError");
  const failure = results.find((result, index) => result.status === "rejected" && (panels[index] !== "distribution" || initialDimension === currentDimension()));
  if (failure?.status === "rejected") throw failure.reason;
  // 全局更新期间的局部切换必须属于新快照，不能补入仍显示的旧快照。
  while (true) {
    const dimension = currentDimension();
    batch = { ...batch, dimension };
    if (dimension === "tool" || batch.distributions[dimension]) break;
    try { await receive("distribution", dimension); } catch (error) { if (signal.aborted || dimension === currentDimension()) throw error; }
  }
  return { ...batch, complete: true };
}

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
export const sameOverviewSnapshot = (a: OverviewSnapshot, b: OverviewSnapshot) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export class OverviewSnapshotMismatch extends Error {}

/** 首次允许分区完成；已有完整结果只接纳下一份完整批次。 */
export function visibleOverviewBatch(previous: OverviewPanelBatch | null, next: OverviewPanelBatch): OverviewPanelBatch {
  return previous?.complete && !next.complete ? previous : next;
}

/** 分区重试只更新所属快照，分布按维度缓存且不改变其他区域。 */
export function replaceOverviewPanel(batch: OverviewPanelBatch | null, snapshot: OverviewSnapshot, result: OverviewPanelResult): OverviewPanelBatch | null {
  if (!batch || !sameOverviewSnapshot(batch.snapshot, snapshot)) return batch;
  if (!sameOverviewSnapshot(snapshot, result.snapshot) || result.panel === "distribution" && !result.dimension) throw new OverviewSnapshotMismatch();
  const panels = { ...batch.panels, [result.panel]: result };
  const distributions = result.panel === "distribution" ? { ...batch.distributions, [result.dimension!]: result } : batch.distributions;
  return selectOverviewDimension({ ...batch, panels, distributions }, batch.dimension);
}

/** 首次分区重试以当前维度判断完整性；局部切换不会撤销已经完整的报告。 */
export function selectOverviewDimension(batch: OverviewPanelBatch, dimension: Distribution): OverviewPanelBatch {
  const complete = ([...overviewPanels, "facets"] as OverviewPanel[]).every(panel => Boolean(batch.panels[panel])) && (dimension === "tool" || Boolean(batch.distributions[dimension]));
  return { ...batch, dimension, complete };
}

export interface OverviewDistributionView { snapshot: OverviewSnapshot; dimension: Distribution; rows: NonNullable<OverviewPanelResult["data"]["distribution"]> }
/** 新维度未完成时保留同快照的排名与名称，下钻由当前选择的一致性决定。 */
export function visibleOverviewDistribution(previous: OverviewDistributionView | null, batch: OverviewPanelBatch | null, dimension: Distribution): OverviewDistributionView | null {
  if (!batch) return null;
  const rows = dimension === "tool" ? batch.panels.process?.data.process?.tools : batch.distributions[dimension]?.data.distribution;
  if (rows) return { snapshot: batch.snapshot, dimension, rows };
  return previous && sameOverviewSnapshot(previous.snapshot, batch.snapshot) ? previous : null;
}

/** 委派分摊只随委派证据读取；证据和分摊都成功且同快照后才发布。 */
export async function loadOverviewInvestigation(snapshot: OverviewSnapshot, query: { evidence?: OverviewEvidenceQuery; detail?: OverviewDetailQuery }, transport: Transport, signal: AbortSignal, cachedDelegation?: OverviewPanelResult): Promise<{ result: OverviewEvidencePage | OverviewDetailPage; delegation?: OverviewPanelResult }> {
  const fixed = overviewParameters({ ...snapshot.query, version: snapshot.version, priceVersion: snapshot.priceVersion, timezone: snapshot.timezone, ...(query.evidence ? { evidence: JSON.stringify(query.evidence) } : { detail: JSON.stringify(query.detail) }) });
  const delegation = query.evidence?.kind === "delegation" ? cachedDelegation && sameOverviewSnapshot(snapshot, cachedDelegation.snapshot) ? Promise.resolve(cachedDelegation) : loadOverviewPanel(snapshot, "delegation", transport, signal) : Promise.resolve(undefined);
  const [result, panel] = await Promise.all([transport<OverviewEvidencePage | OverviewDetailPage>(`/overview/${query.evidence ? "evidence" : "detail"}?${fixed}`, signal), delegation]);
  if (signal.aborted) throw new DOMException("", "AbortError");
  if ("snapshot" in result ? !sameOverviewSnapshot(snapshot, result.snapshot) : result.version !== snapshot.version || result.priceVersion !== snapshot.priceVersion || result.timezone !== snapshot.timezone) throw new OverviewSnapshotMismatch();
  return { result, delegation: panel };
}
