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

/** 固定快照后的基础区并行读取；选择通知取消废弃分布并立即补读当前维度。 */
export async function loadOverviewPanels(query: OverviewQuery, key: string, transport: Transport, signal: AbortSignal, onSnapshot: (batch: OverviewPanelBatch) => void, onPanel: (batch: OverviewPanelBatch) => void, onError?: (panel: OverviewPanel, error: unknown) => void, currentDimension: () => Distribution = () => "project", subscribeDimension?: (listener: () => void) => () => void): Promise<OverviewPanelBatch> {
  const snapshot = await transport<OverviewSnapshot>(`/overview/snapshot?${overviewParameters(query)}`, signal);
  let batch: OverviewPanelBatch = { key, snapshot, panels: {}, distributions: {}, dimension: currentDimension(), complete: false };
  if (signal.aborted) throw new DOMException("", "AbortError");
  onSnapshot(batch);
  return new Promise<OverviewPanelBatch>((resolve, reject) => {
    const basePanels = requiredOverviewPanels("tool"), failures: unknown[] = [];
    let remaining = basePanels.length, finished = false, distributionFailure: unknown;
    let distributionRequest: AbortController | undefined, unsubscribe = () => {};
    const cleanup = () => { finished = true; distributionRequest?.abort(); unsubscribe(); signal.removeEventListener("abort", abort); };
    const abort = () => { if (!finished) { cleanup(); reject(new DOMException("", "AbortError")); } };
    const finish = () => {
      if (finished) return;
      if (batch.dimension !== currentDimension()) { changeDimension(); return; }
      if (remaining) return;
      const failure = failures[0] ?? distributionFailure;
      if (failure) { cleanup(); reject(failure); }
      else if (batch.dimension === "tool" || batch.distributions[batch.dimension]) { cleanup(); resolve({ ...batch, complete: true }); }
    };
    const publish = (result: OverviewPanelResult) => {
      batch = replaceOverviewPanel(batch, snapshot, result)!;
      onPanel({ ...batch, complete: false });
    };
    const changeDimension = () => {
      if (finished) return;
      const dimension = currentDimension();
      if (batch.dimension === dimension && distributionRequest) { finish(); return; }
      distributionRequest?.abort(); distributionRequest = undefined; distributionFailure = undefined;
      batch = { ...batch, dimension, complete: false };
      if (dimension === "tool" || batch.distributions[dimension]) { finish(); return; }
      const controller = new AbortController(); distributionRequest = controller;
      void loadOverviewPanel(snapshot, "distribution", transport, controller.signal, dimension).then(result => {
        if (finished || controller.signal.aborted) return;
        if (dimension !== currentDimension()) { changeDimension(); return; }
        publish(result); finish();
      }).catch(error => {
        if (finished || controller.signal.aborted) return;
        if (dimension !== currentDimension()) { changeDimension(); return; }
        distributionFailure = error; onError?.("distribution", error); finish();
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    unsubscribe = subscribeDimension?.(changeDimension) ?? unsubscribe;
    changeDimension();
    for (const panel of basePanels) void loadOverviewPanel(snapshot, panel, transport, signal).then(result => {
      if (!finished) publish(result);
    }).catch(error => {
      if (!finished) { failures.push(error); onError?.(panel, error); }
    }).finally(() => { remaining -= 1; finish(); });
  });
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
