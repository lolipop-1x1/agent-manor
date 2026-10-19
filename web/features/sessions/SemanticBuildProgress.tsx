import { Loading } from "../../shared/ui/Loading";
import type { SemanticStatus } from "../../../src/semantic-contracts";
import { semanticErrorDescriptor } from "../../../src/semantic/messages";
import { messageText, useI18n } from "../../shared/i18n";
import { semanticBuildMetrics, semanticCost, semanticProgress, semanticStatusKey } from "./semantic-ui-model";

export function SemanticBuildProgress({ status }: { status?: SemanticStatus }) {
  const { t, language } = useI18n();
  const number = (value: number) => new Intl.NumberFormat(language).format(value);
  const job = status?.job;
  const progress = semanticProgress(status);
  const metrics = semanticBuildMetrics(status);
  const descriptor = job?.errorDescriptor ?? semanticErrorDescriptor(job?.errorCode);
  const usage = status?.usage.byPurpose.build;
  const seconds = job ? Math.max(0, Math.floor((new Date(job.finishedAt ?? Date.now()).getTime() - new Date(job.createdAt).getTime()) / 1000)) : 0;
  return <section className="semantic-build-progress" aria-label={t("sessions.semantic.build.progress")}>
    <div className="semantic-progress-heading"><strong>{t(semanticStatusKey(status))}</strong>{job?.status === "running" && <Loading variant="inline" size={15} />}</div>
    {job && <>
      <div className="semantic-progress-track" role="progressbar" aria-label={t(`sessions.semantic.phase.${job.phase}`)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: progress === undefined ? "20%" : `${progress}%` }} className={progress === undefined ? "is-indeterminate" : undefined} /></div>
      <div className="semantic-progress-meta"><span>{t(`sessions.semantic.phase.${job.phase}`)}</span><span>{job.totalInputs ? t("sessions.semantic.build.completed", { done: job.completedInputs, total: job.totalInputs }) : "—"}</span><span>{t("sessions.semantic.build.elapsed", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })}</span></div>
      {job.error && <><p className="semantic-error" role="alert">{descriptor ? messageText(descriptor, job.error) : t("common.originalDetail", { detail: job.error })}</p>{descriptor && <details className="semantic-details"><summary>{t("common.originalDetails")}</summary><p>{job.error}</p></details>}</>}
      <details className="semantic-details"><summary>{t("sessions.semantic.details")}</summary><dl className="semantic-summary"><div><dt>{t("sessions.semantic.build.encoded")}</dt><dd>{number(metrics.encoded)}</dd></div><div><dt>{t("sessions.semantic.build.throughput")}</dt><dd>{metrics.perMinute === undefined ? "—" : t("sessions.semantic.build.perMinute", { count: metrics.perMinute })}</dd></div><div><dt>{t("sessions.semantic.build.eta")}</dt><dd>{metrics.remainingSeconds === undefined ? "—" : t("sessions.semantic.build.elapsed", { minutes: Math.floor(metrics.remainingSeconds / 60), seconds: metrics.remainingSeconds % 60 })}</dd></div><div><dt>{t("sessions.semantic.build.todayRequests")}</dt><dd>{usage ? number(usage.requests) : "—"}</dd></div><div><dt>{t("sessions.semantic.build.todayTokens")}</dt><dd>{usage ? number(usage.tokens) : "—"}</dd></div><div><dt>{t("sessions.semantic.build.todayCost")}</dt><dd>{semanticCost(usage?.cost, language) ?? t("sessions.semantic.unknown")}</dd></div><div><dt>{t("sessions.semantic.build.reused")}</dt><dd>{number(job.reusedInputs)}</dd></div><div><dt>{t("sessions.semantic.build.failed")}</dt><dd>{number(job.failedInputs)}</dd></div></dl></details>
    </>}
    {status?.ready && <dl className="semantic-summary"><div><dt>{t("sessions.semantic.build.coveredSessions")}</dt><dd>{number(status.indexedSessions)}</dd></div><div><dt>{t("sessions.semantic.build.vectors")}</dt><dd>{number(status.uniqueVectors)}</dd></div><div><dt>{t("sessions.semantic.build.storage")}</dt><dd>{number(Math.ceil(status.databaseBytes / 1024))} KiB</dd></div></dl>}
  </section>;
}
