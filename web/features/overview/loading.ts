import { overviewPanels, type OverviewPanel, type OverviewPanelResult, type OverviewQuery, type OverviewSnapshot } from "../../../src/overview-contracts";
import { overviewParameters } from "./model";

export interface OverviewPanelBatch {
  key: string;
  snapshot: OverviewSnapshot;
  panels: Partial<Record<OverviewPanel, OverviewPanelResult>>;
  complete: boolean;
}

/** 固定一个快照后并发获取分区；是否提前呈现由页面决定。 */
export async function loadOverviewPanels(query: OverviewQuery, key: string, transport: <T>(path: string, signal: AbortSignal) => Promise<T>, signal: AbortSignal, onSnapshot: (batch: OverviewPanelBatch) => void, onPanel: (batch: OverviewPanelBatch) => void, onError?: (panel: OverviewPanel, error: unknown) => void): Promise<OverviewPanelBatch> {
  const snapshot = await transport<OverviewSnapshot>(`/overview/snapshot?${overviewParameters(query)}`, signal);
  const batch: OverviewPanelBatch = { key, snapshot, panels: {}, complete: false };
  if (signal.aborted) throw new DOMException("", "AbortError");
  onSnapshot({ ...batch, panels: {} });
  const fixed = overviewParameters({ ...snapshot.query, version: snapshot.version, priceVersion: snapshot.priceVersion, timezone: snapshot.timezone });
  const results = await Promise.allSettled(overviewPanels.map(async panel => {
    try {
      const result = await transport<OverviewPanelResult>(`/overview/panel?${fixed}&panel=${panel}`, signal);
      if (signal.aborted) throw new DOMException("", "AbortError");
      if (result.panel !== panel || !sameOverviewSnapshot(snapshot, result.snapshot)) throw new OverviewSnapshotMismatch();
      batch.panels[panel] = result;
      onPanel({ ...batch, panels: { ...batch.panels } });
    } catch (error) { if (!signal.aborted) onError?.(panel, error); throw error; }
  }));
  if (signal.aborted) throw new DOMException("", "AbortError");
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return { ...batch, panels: { ...batch.panels }, complete: true };
}

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
export const sameOverviewSnapshot = (a: OverviewSnapshot, b: OverviewSnapshot) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export class OverviewSnapshotMismatch extends Error {}

/** 首次允许分区完成；已有完整结果只接纳下一份完整批次。 */
export function visibleOverviewBatch(previous: OverviewPanelBatch | null, next: OverviewPanelBatch): OverviewPanelBatch {
  return previous?.complete && !next.complete ? previous : next;
}

/** 分区重试只更新所属快照；完成后恢复整份报告的可操作状态。 */
export function replaceOverviewPanel(batch: OverviewPanelBatch | null, snapshot: OverviewSnapshot, result: OverviewPanelResult): OverviewPanelBatch | null {
  if (!batch || !sameOverviewSnapshot(batch.snapshot, snapshot)) return batch;
  if (!sameOverviewSnapshot(snapshot, result.snapshot)) throw new OverviewSnapshotMismatch();
  const panels = { ...batch.panels, [result.panel]: result };
  return { ...batch, panels, complete: overviewPanels.every(panel => Boolean(panels[panel])) };
}
