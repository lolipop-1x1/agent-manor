import type { CoverageResult, IndexMaintenanceResult } from "../../../../src/contracts.js";
import { formatDateTime, formatNumber, isMessageDescriptorKnown, translate, translateMessage } from "../../../../src/i18n/index.js";
import type { Language, MessageParams } from "../../../../src/i18n/index.js";

export function humanOutput(value: unknown, language: Language): string {
  const t = (key: string, params?: MessageParams) => translate(language, key, params);
  const number = (value: number) => formatNumber(language, value);
  if (value && typeof value === "object" && "indexMaintenance" in value && value.indexMaintenance) {
    const { indexMaintenance, ...status } = value;
    const maintenance = indexMaintenance as IndexMaintenanceResult;
    return [translateMessage(language, maintenance.messageDescriptor),
      ...(maintenance.details ? [`${t("common.originalDetails")}: ${maintenance.details}`] : []), JSON.stringify(status, null, 2)].join("\n");
  }
  if (value && typeof value === "object" && "summary" in value && "files" in value) {
    const result = value as CoverageResult;
    const { summary } = result;
    return [
      t("cli.summary.repository", { name: result.repository.name, id: result.repository.id }),
      t("cli.summary.version", { version: result.version, createdAt: formatDateTime(language, result.createdAt), status: t(result.stale ? "cli.status.stale" : "cli.status.completed") }),
      t("cli.summary.scope", { files: summary.fileCount, lines: summary.lineCount, filters: JSON.stringify(result.filters) }),
      t("cli.summary.read", { exactFiles: summary.readExact.files, exactLines: summary.readExact.lines, nearFiles: summary.readNear.files, nearLines: summary.readNear.lines }),
      t("cli.summary.edit", { exactFiles: summary.editExact.files, exactLines: summary.editExact.lines, nearFiles: summary.editNear.files, nearLines: summary.editNear.lines }),
      t("cli.summary.columns"),
      ...result.files.map((file) => `${file.path}\t${number(file.lineCount)}\t${number(file.readExactLines)}/${number(file.readNearLines)}\t${number(file.editExactLines)}/${number(file.editNearLines)}\t${number(file.activityCount)}`),
      t("cli.summary.gaps", { count: result.gaps.length }),
      ...result.gaps.map(gap => [
        `${gap.kind}: ${isMessageDescriptorKnown(gap.messageDescriptor) ? translateMessage(language, gap.messageDescriptor) : t("common.originalDetails")}`,
        ...(gap.details ?? []).filter(isMessageDescriptorKnown).map(detail => translateMessage(language, detail)),
        `${t("common.originalDetails")}: ${gap.message}`,
      ].join("\n")),
    ].join("\n");
  }
  const managed = managedOutput(value, language);
  if (managed !== undefined) return managed;
  if (value && typeof value === "object" && "status" in value && value.status && typeof value.status === "object" && "indexMaintenance" in value.status) {
    return humanOutput(value.status, language);
  }
  // 其他详情按原契约展示，统计始终由同一 API 返回。
  return JSON.stringify(value, null, 2);
}

/** 生命周期、安装与维护提供可读摘要；业务正文和 JSON 契约保持原样。 */
function managedOutput(value: unknown, language: Language): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const result = value as Record<string, unknown>;
  const t = (key: string, params?: MessageParams) => translate(language, key, params);
  const line = (key: string, content: unknown) => content === undefined ? [] : [`${t(`cli.human.${key}`)}: ${String(content)}`];
  if (typeof result.action === "string" && typeof result.targetPath === "string" && typeof result.status === "string") {
    return [t("cli.human.skillResult", { action: t(`cli.human.skillAction.${result.action}`), status: t(`cli.human.skillStatus.${result.status}`) }),
      ...line("target", result.targetPath), ...line("version", result.installedVersion ?? result.version), ...line("backup", result.backupPath),
      ...(Array.isArray(result.conflicts) && result.conflicts.length ? [t("cli.human.conflicts"), ...result.conflicts.map(String)] : [])].join("\n");
  }
  if (typeof result.currentVersion === "string" && typeof result.targetVersion === "string") {
    const installation = result.installation as { kind?: string; root?: string } | undefined;
    return [t(result.updated ? "cli.human.updateComplete" : result.updateAvailable ? "cli.human.updateAvailable" : "cli.human.updateCurrent"),
      ...line("currentVersion", result.currentVersion), ...line("targetVersion", result.targetVersion),
      ...line("installation", installation?.kind ? t(`cli.human.installation.${installation.kind}`) : undefined),
      ...line("target", installation?.root), ...line("backup", result.backup)].join("\n");
  }
  if (Array.isArray(result.checks) && result.service && typeof result.service === "object") {
    return [t("cli.human.diagnostics"), ...line("version", result.version), ...line("dataDirectory", result.home),
      ...result.checks.map(item => {
        const check = item as { id: string; ok: boolean; details?: string };
        return `${t(`cli.human.check.${check.id}`)}: ${t(check.ok ? "cli.human.checkPassed" : "cli.human.checkFailed")}${check.details ? ` · ${check.details}` : ""}`;
      }), managedOutput(result.service, language)].filter(item => item !== undefined).join("\n");
  }
  if (typeof result.stopped === "boolean") return [t(result.stopped ? "cli.human.serviceStopped" : "cli.human.serviceAbsent"),
    ...line("pid", (result.instance as { pid?: number } | undefined)?.pid)].join("\n");
  if (typeof result.running === "boolean" && typeof result.state === "string") {
    const status = result.status as { preparation?: { state?: string; phase?: string }; indexMaintenance?: IndexMaintenanceResult } | undefined;
    const instance = result.instance as { pid?: number; port?: number; version?: string } | undefined;
    return [t(`cli.human.serviceState.${result.state}`), ...line("address", instance?.port ? `http://127.0.0.1:${instance.port}` : undefined),
      ...line("version", instance?.version), ...line("pid", instance?.pid),
      ...line("preparation", status?.preparation?.state ? t(`cli.human.preparation.${status.preparation.state}`) : undefined), ...line("log", result.logPath),
      ...(status?.indexMaintenance && status.indexMaintenance.status !== "skipped" ? [translateMessage(language, status.indexMaintenance.messageDescriptor),
        ...(status.indexMaintenance.details ? [`${t("common.originalDetails")}: ${status.indexMaintenance.details}`] : [])] : [])].join("\n");
  }
  if (result.instance && typeof result.instance === "object") {
    const instance = result.instance as { pid?: number; port?: number; version?: string };
    const preparation = result.preparation as { state?: string } | undefined;
    return [t("cli.human.serviceReady"), ...line("address", result.url ?? (instance.port ? `http://127.0.0.1:${instance.port}` : undefined)),
      ...line("version", result.version ?? instance.version), ...line("pid", instance.pid),
      ...line("preparation", preparation?.state ? t(`cli.human.preparation.${preparation.state}`) : undefined), ...line("log", result.logPath)].join("\n");
  }
  if (typeof result.version === "string" && typeof result.node === "string") return [t("cli.human.productVersion", { version: result.version }),
    ...line("node", result.node), ...line("platform", `${result.platform}/${result.arch}`)].join("\n");
  if (typeof result.path === "string" && typeof result.text === "string") return [
    ...(result.follow ? result.reset ? [t("cli.human.logReset")] : [] : line("log", result.path)), result.text].join("\n");
  return;
}
