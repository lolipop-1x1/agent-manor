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
  if (value && typeof value === "object" && "status" in value && value.status && typeof value.status === "object" && "indexMaintenance" in value.status) {
    return humanOutput(value.status, language);
  }
  // 其他详情按原契约展示，统计始终由同一 API 返回。
  return JSON.stringify(value, null, 2);
}
