import type { StatusResponse } from "../../../../src/contracts.js";
import { homedir } from "node:os";
import { sep } from "node:path";
import { clientName, type Client } from "../../../../src/clients.js";
import { formatPercent, translate, translateMessageOrOriginal, type Language } from "../../../../src/i18n/index.js";

/** 人类进度写入 stderr；非终端仅在阶段变化或五秒心跳时追加，避免污染结果及日志。 */
export function startupProgress(language: Language) {
  const started = Date.now(), tty = process.stderr.isTTY;
  let current: StatusResponse | undefined, lastStage = "", lastAt = 0;
  const t = (key: string, params?: Record<string, string | number>) => translate(language, key, params);
  const client = (value: Client) => value === "codeflicker-desktop" ? t("common.client.codeflickerDesktop") : clientName(value);
  const pathLabel = (value: string) => (value.startsWith(homedir() + sep) ? `~${value.slice(homedir().length)}` : value).replace(/[\u0000-\u001f\u007f]/g, " ");
  const roots = new Map<string, boolean>(), summaries = new Set<string>();
  let lastSource = "", lastSourceAt = -Infinity;
  const detail = (line: string) => {
    process.stderr.write(`${tty ? "\r\u001b[2K" : ""}  ${line}\n`);
    lastStage = "";
  };
  const details = () => {
    const job = current?.sessions?.job;
    for (const root of job?.discovery ?? []) {
      const key = JSON.stringify([job!.id, root.client, root.path]);
      if (!roots.has(key) || root.complete && !roots.get(key)) {
        detail(t(root.complete ? "cli.startup.scanned" : "cli.startup.scanning", { client: client(root.client), path: pathLabel(root.path), count: root.sourceCount }));
      }
      roots.set(key, root.complete);
    }
    if (job?.sourceCounts && !summaries.has(job.id)) {
      for (const source of job.sourceCounts) detail(t("cli.startup.sources", { client: client(source.client), count: source.count }));
      summaries.add(job.id);
    }
    const active = job?.activeSources?.[0];
    if (job?.phase === "index" && active) {
      const key = JSON.stringify([job.id, active.client, active.path]);
      if (key !== lastSource && Date.now() - lastSourceAt >= 5000) {
        detail(t("cli.startup.activeSource", { client: client(active.client), path: pathLabel(active.path) }));
        lastSource = key; lastSourceAt = Date.now();
      }
    }
  };
  const render = () => {
    const preparation = current?.preparation, job = current?.sessions?.job;
    let stage = preparation?.phase ?? "starting";
    if (stage === "history") stage = job?.status === "complete" ? (preparation!.jobIds.length > 1 ? "maps" : "publish") : job?.phase ?? "discover";
    if (preparation?.state === "failed") stage = "failed";
    if (preparation?.state === "ready" || preparation?.state === "skipped") stage = "complete";
    const repository = preparation?.repository;
    const identity = `${stage}:${preparation?.step ?? ""}:${repository?.id ?? ""}:${repository?.phase ?? ""}:${stage === "maps" ? preparation?.completed : ""}`;
    const now = Date.now();
    if (identity === lastStage && now - lastAt < (tty ? 1000 : 5000)) return;
    const label = stage === "overview" && preparation?.step
      ? t("cli.startup.overviewPanel", { panel: t(`cli.startup.panel.${preparation.step}`) })
      : t(`cli.startup.stage.${["starting", "discover", "metadata", "index", "search", "publish", "maps", "usage", "overview", "complete", "failed"].includes(stage) ? stage : "history"}`);
    const scanning = job?.discovery?.find(root => !root.complete);
    const counts = stage === "index" && job?.totalSources !== undefined
      ? job.counts && job.parserConcurrency ? t("cli.startup.importCounts", { completed: job.processedSources ?? 0, total: job.totalSources,
        parsed: job.counts.parsed, reused: job.counts.quickReused + job.counts.verifiedReused, workers: job.parserConcurrency })
        : t("cli.startup.counts", { completed: job.processedSources ?? 0, total: job.totalSources })
      : stage === "discover" && scanning ? t("cli.startup.scanCounts", { client: client(scanning.client), count: scanning.sourceCount })
      : stage === "maps" && preparation?.total !== undefined
        ? repository ? t("cli.startup.repositories", { completed: preparation.completed ?? 0, total: preparation.total, name: repository.name,
          phase: translateMessageOrOriginal(language, repository.phaseDescriptor, repository.phase), progress: formatPercent(language, repository.progress, { maximumFractionDigits: 0 }) })
          : t("cli.startup.counts", { completed: preparation.completed ?? 0, total: preparation.total })
      : stage === "overview" && preparation?.total !== undefined
        ? t("cli.startup.counts", { completed: preparation.completed ?? 0, total: preparation.total }) : "";
    const elapsed = t("cli.startup.elapsed", { minutes: Math.floor((now - started) / 60000), seconds: Math.floor((now - started) / 1000) % 60 });
    const line = t("cli.startup.progress", { mark: stage === "complete" ? "✓" : stage === "failed" ? "✗" : "…", stage: label, counts, elapsed });
    process.stderr.write(tty ? `\r\u001b[2K${line}` : `${line}\n`);
    lastStage = identity; lastAt = now;
  };
  render();
  const timer = setInterval(render, 1000); timer.unref();
  return { update(status: StatusResponse) { current = status; details(); render(); }, close() { clearInterval(timer); if (tty) process.stderr.write("\n"); } };
}
