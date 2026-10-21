import { useEffect, useState } from "react";
import type { CoverageResult, Gap } from "../../../src/contracts";
import { ApiError, errorMessage, isAborted, request } from "../../shared/api";
import { dateLabel } from "../../shared/format";
import { messageText, useI18n } from "../../shared/i18n";
import { Loading } from "../../shared/ui/Loading";
import { ResourcePagination } from "../../shared/ui/ResourcePagination";
import { queryString, repositoryPath } from "./api";

export function AnalysisInfo({ coverage, active }: { coverage: CoverageResult; active: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false), [retry, setRetry] = useState(0), [page, setPage] = useState(1), [pageSize, setPageSize] = useState(20);
  const [data, setData] = useState<{ key: string; gaps: Gap[] } | null>(null);
  const [error, setError] = useState<{ key: string; cause: unknown } | null>(null);
  const count = coverage.gapCount ?? coverage.gaps.length;
  const query = queryString({ ...coverage.filters, version: coverage.version });
  const key = `${coverage.repository.id}:${query}`;
  useEffect(() => { setPage(1); }, [key]);
  useEffect(() => {
    if (!active || !open || !count || data?.key === key) return;
    const controller = new AbortController();
    setError(null);
    void request<{ version: string; gaps: Gap[] }>(`${repositoryPath(coverage.repository.id)}/coverage/gaps${query}`, { signal: controller.signal }).then(result => {
      if (result.version !== coverage.version) throw new ApiError("VERSION_MISMATCH", "采集缺口与地图结果版本不一致，请刷新后重试。", { key: "codeMap.error.versionCoverage" });
      if (!controller.signal.aborted) setData({ key, gaps: result.gaps });
    }).catch(cause => { if (!controller.signal.aborted && !isAborted(cause)) setError({ key, cause }); });
    return () => controller.abort();
  }, [active, open, count, key, retry]);
  const gaps = data?.key === key ? data.gaps : null;
  const failure = error?.key === key ? error.cause : null;
  return <details className="baseline-note" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("codeMap.analysis.info", { date: dateLabel(coverage.createdAt) })}</summary>
    <p>{t("codeMap.analysis.version", { version: coverage.version })}<br />{t("codeMap.analysis.baseline", { hash: coverage.baselineHash })}{coverage.previousVersion && t("codeMap.analysis.previous", { version: coverage.previousVersion })}</p>
    {open && count > 0 && <div className="map-analysis-gaps">
      <p><strong>{t("codeMap.analysis.gaps", { count })}</strong></p><p>{t("codeMap.analysis.partial")}</p>
      {failure ? <div role="alert">{errorMessage(failure)} <button className="text-button" onClick={() => setRetry(value => value + 1)}>{t("common.retry")}</button></div>
        : gaps ? <><ul>{gaps.slice((page - 1) * pageSize, page * pageSize).map((gap, index) => <li key={`${page}:${index}`}>{messageText(gap.messageDescriptor, gap.message)}{gap.sourceId && <code>{gap.sourceId}</code>}</li>)}</ul>
          <ResourcePagination label={t("codeMap.analysis.gaps", { count })} page={page} pageSize={pageSize} total={gaps.length} onChange={setPage} onPageSizeChange={value => { setPageSize(value); setPage(1); }} /></>
          : <Loading variant="inline" label={t("common.loading")} />}
    </div>}
  </details>;
}
