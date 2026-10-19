import type { StatusResponse } from "../../../../src/contracts.js";
import { translate, type Language } from "../../../../src/i18n/index.js";

/** 人类进度写入 stderr；非终端仅在阶段变化或五秒心跳时追加，避免污染结果及日志。 */
export function startupProgress(language: Language) {
  const started = Date.now(), tty = process.stderr.isTTY;
  let current: StatusResponse | undefined, lastStage = "", lastAt = 0;
  const t = (key: string, params?: Record<string, string | number>) => translate(language, key, params);
  const render = () => {
    const preparation = current?.preparation, job = current?.sessions?.job;
    let stage = preparation?.phase ?? "starting";
    if (stage === "history") stage = job?.status === "complete" ? (preparation!.jobIds.length > 1 ? "maps" : "publish") : job?.phase ?? "discover";
    if (preparation?.state === "failed") stage = "failed";
    if (preparation?.state === "ready" || preparation?.state === "skipped") stage = "complete";
    const identity = `${stage}:${preparation?.step ?? ""}`;
    const now = Date.now();
    if (identity === lastStage && now - lastAt < (tty ? 1000 : 5000)) return;
    const label = stage === "overview" && preparation?.step
      ? t("cli.startup.overviewPanel", { panel: t(`cli.startup.panel.${preparation.step}`) })
      : t(`cli.startup.stage.${["starting", "discover", "index", "search", "publish", "maps", "usage", "overview", "complete", "failed"].includes(stage) ? stage : "history"}`);
    const counts = stage === "index" && job?.totalSources !== undefined
      ? t("cli.startup.counts", { completed: job.processedSources ?? 0, total: job.totalSources })
      : stage === "overview" && preparation?.total !== undefined
        ? t("cli.startup.counts", { completed: preparation.completed ?? 0, total: preparation.total }) : "";
    const elapsed = t("cli.startup.elapsed", { minutes: Math.floor((now - started) / 60000), seconds: Math.floor((now - started) / 1000) % 60 });
    const line = t("cli.startup.progress", { mark: stage === "complete" ? "✓" : stage === "failed" ? "✗" : "…", stage: label, counts, elapsed });
    process.stderr.write(tty ? `\r\u001b[2K${line}` : `${line}\n`);
    lastStage = identity; lastAt = now;
  };
  render();
  const timer = setInterval(render, 1000); timer.unref();
  return { update(status: StatusResponse) { current = status; render(); }, close() { clearInterval(timer); if (tty) process.stderr.write("\n"); } };
}
