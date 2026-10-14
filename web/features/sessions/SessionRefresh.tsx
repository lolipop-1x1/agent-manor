import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CaretDown } from "@phosphor-icons/react";
import type { SessionJob, SessionRefreshOptions } from "../../../src/session-contracts";
import { errorMessage } from "../../shared/api";
import { messageText, useI18n } from "../../shared/i18n";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import "../../shared/ui/filter-controls.css";

const phaseLabels: Record<string, string> = { queued: "common.history.queued", discover: "common.history.discover", index: "common.history.running", publish: "common.history.publish" };

export function HistoryRefreshControl({ busy, starting, onRefresh, onRetry, job, error }: {
  busy: boolean; starting: boolean; onRefresh: (options: SessionRefreshOptions) => void; onRetry: () => void;
  job?: SessionJob; error?: Error | null;
}) {
  const { t, dateTime, number, percent } = useI18n();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const activeJob = !starting && busy && (job?.status === "running" || job?.status === "queued") ? job : undefined;
  const completedAt = job?.status === "complete" ? job.finishedAt : undefined;
  const failed = !starting && (!!error || job?.status === "failed");
  // 百分比仅表示已处理的来源比例；发现与发布阶段没有可计算的总体进度。
  const progress = activeJob?.phase === "index" ? Math.min(0.99, Math.max(0, activeJob.progress)) : null;
  const phase = activeJob ? phaseLabels[activeJob.phase] ? t(phaseLabels[activeJob.phase]!) : messageText(activeJob.phaseDescriptor, activeJob.phase) : t("common.history.starting");
  const busyLabel = error ? t("common.history.progressError") : progress === null ? activeJob && !phaseLabels[activeJob.phase] ? t("common.history.preparing") : phase
    : t("common.history.updatingProgress", { progress: percent(progress, { minimumFractionDigits: 0, maximumFractionDigits: 0 }) });
  const elapsed = activeJob ? Math.max(0, Math.floor((now - Date.parse(activeJob.createdAt)) / 1000)) : 0;
  useEffect(() => {
    if (!open || !activeJob) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open, activeJob?.id]);
  return <div className="history-refresh-control"><RefreshControl label={t("common.history.update")} busy={busy} busyLabel={busyLabel}
    progress={busy ? error ? null : progress : undefined} error={failed} showStatus={false} completedAt={completedAt}
    statusLabel={t("common.history.progress")} onRefresh={() => onRefresh({ mode: "quick" })}
    menu={<Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="icon-button history-refresh-menu-trigger" aria-label={t("common.history.status")}>
        <CaretDown size={12} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal><Popover.Content className="filter-menu history-refresh-panel" align="end" sideOffset={6} collisionPadding={12} aria-label={t("common.history.status")}>
        <strong>{t("common.history.status")}</strong>
        {failed ? <><p className="history-refresh-failure" role="alert">{error ? errorMessage(error) : messageText(job?.errorDescriptor, job?.error ?? t("common.history.failed"))}</p><button className="button" onClick={onRetry}>{t("common.retry")}</button></>
          : busy ? <><p className="history-refresh-phase" role="status">{phase}</p><dl className="history-refresh-facts">
            {activeJob?.counts && activeJob.phase === "index" && <><dt>{t("common.history.processed")}</dt><dd>{t("common.history.processedCount", { count: number(Math.round(activeJob.progress * activeJob.counts.discovered)), total: number(activeJob.counts.discovered) })}</dd></>}
            {activeJob && <><dt>{t("common.history.elapsed")}</dt><dd>{t("common.history.elapsedValue", { minutes: number(Math.floor(elapsed / 60)), seconds: number(elapsed % 60) })}</dd></>}
          </dl></>
            : completedAt ? <dl className="history-refresh-facts"><dt>{t("common.history.lastUpdated")}</dt><dd><time dateTime={completedAt}>{dateTime(completedAt)}</time></dd></dl>
              : <p className="history-refresh-empty">{t("common.history.noUpdateTime")}</p>}
      </Popover.Content></Popover.Portal>
    </Popover.Root>} /></div>;
}
