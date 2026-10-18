import type { CoverageResult, IndexMaintenanceResult } from "../../../../src/contracts.js";
import { formatDateTime, formatNumber, isMessageDescriptorKnown, translate, translateMessage } from "../../../../src/i18n/index.js";
import type { Language, MessageDescriptor, MessageParams } from "../../../../src/i18n/index.js";

export function humanOutput(value: unknown, language: Language, full = false): string {
  if (full) return JSON.stringify(value, null, 2);
  const t = (key: string, params?: MessageParams) => translate(language, key, params);
  const number = (value: number) => formatNumber(language, value);
  const managed = managedOutput(value, language);
  if (managed !== undefined) return managed;
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
  // 展示层只排版 API 已返回的数据，不重算统计。
  return businessOutput(value, language);
}

/** 生命周期、安装与维护提供可读摘要；业务正文和 JSON 契约保持原样。 */
function managedOutput(value: unknown, language: Language): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const result = value as Record<string, unknown>;
  const t = (key: string, params?: MessageParams) => translate(language, key, params);
  const line = (key: string, content: unknown) => content === undefined ? [] : [`${t(`cli.human.${key}`)}: ${String(content)}`];
  const failure = (preparation: unknown) => {
    const source = preparation && typeof preparation === "object" && "error" in preparation && preparation.error !== undefined
      ? preparation as Record<string, unknown> : result;
    return line("error", describedValue(source, "error", source.error, language));
  };
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
    const status = result.status as { preparation?: { state?: string; phase?: string; error?: string }; indexMaintenance?: IndexMaintenanceResult } | undefined;
    const instance = result.instance as { pid?: number; port?: number; version?: string } | undefined;
    return [t(`cli.human.serviceState.${result.state}`), ...line("address", instance?.port ? `http://127.0.0.1:${instance.port}` : undefined),
      ...line("version", instance?.version), ...line("pid", instance?.pid),
      ...line("preparation", status?.preparation?.state ? t(`cli.human.preparation.${status.preparation.state}`) : undefined), ...line("log", result.logPath), ...failure(status?.preparation),
      ...statusFacts(result.status, language),
      ...(status?.indexMaintenance && status.indexMaintenance.status !== "skipped" ? [translateMessage(language, status.indexMaintenance.messageDescriptor),
        ...(status.indexMaintenance.details ? [`${t("common.originalDetails")}: ${status.indexMaintenance.details}`] : [])] : [])].join("\n");
  }
  if (result.instance && typeof result.instance === "object") {
    const instance = result.instance as { pid?: number; port?: number; version?: string };
    const preparation = result.preparation as { state?: string; error?: string } | undefined;
    return [t("cli.human.serviceReady"), ...line("address", result.url ?? (instance.port ? `http://127.0.0.1:${instance.port}` : undefined)),
      ...line("version", result.version ?? instance.version), ...line("pid", instance.pid),
      ...line("preparation", preparation?.state ? t(`cli.human.preparation.${preparation.state}`) : undefined), ...line("log", result.logPath), ...failure(preparation), ...statusFacts(result, language)].join("\n");
  }
  if (typeof result.version === "string" && typeof result.node === "string") return [t("cli.human.productVersion", { version: result.version }),
    ...line("node", result.node), ...line("platform", `${result.platform}/${result.arch}`)].join("\n");
  if (typeof result.path === "string" && typeof result.text === "string") return [
    ...(result.follow ? result.reset ? [t("cli.human.logReset")] : [] : line("log", result.path)), result.text].join("\n");
  return;
}

function statusFacts(value: unknown, language: Language): string[] {
  if (!value || typeof value !== "object") return [];
  const state = value as Record<string, unknown>;
  const sessions = state.sessions && typeof state.sessions === "object" ? state.sessions as Record<string, unknown> : {};
  const facts: Record<string, unknown> = {};
  for (const key of ["repositoryCount", "jobCount"]) if (state[key] !== undefined) facts[key] = state[key];
  for (const key of ["sessionCount", "sourceCount", "stale"]) if (sessions[key] !== undefined) facts[key] = sessions[key];
  for (const [key, label] of [["job", "historySync"], ["autoSync", "autoSync"]]) {
    const task = sessions[key!] as Record<string, unknown> | undefined;
    if (task?.error) facts[label!] = task;
  }
  return Object.keys(facts).length ? [businessOutput(facts, language)] : [];
}

function describedValue(row: Record<string, unknown>, key: string, value: unknown, language: Language): string | undefined {
  if (typeof value !== "string") return;
  const descriptor = row[`${key}Descriptor`] as MessageDescriptor | undefined;
  const diagnostic = ["error", "message", "reason", "details"].includes(key);
  if (isMessageDescriptorKnown(descriptor)) {
    const translated = translateMessage(language, descriptor!);
    return diagnostic && translated !== value ? `${translated} (${translate(language, "common.originalDetails")}: ${value})` : translated;
  }
  if (diagnostic) return `${translate(language, "common.originalDetails")}: ${value}`;
}

/** 表格聚焦可定位字段，嵌套统计独立显示，原始结构可通过 --json 读取。 */
function businessOutput(value: unknown, language: Language): string {
  const t = (key: string, params?: MessageParams) => translate(language, key, params);
  const label = (key: string) => isMessageDescriptorKnown({ key: `cli.field.${key}` }) ? t(`cli.field.${key}`) : key;
  const scalar = (item: unknown): string => item === null || item === undefined ? "—"
    : typeof item === "number" ? formatNumber(language, item)
      : typeof item === "boolean" ? t(item ? "cli.human.yes" : "cli.human.no") : String(item);
  let condensed = false;
  const described = (row: Record<string, unknown>, key: string, value: unknown) => describedValue(row, key, value, language);
  const cell = (item: unknown, key: string): string => {
    const text = scalar(item).replace(/\s+/g, " ");
    if (key === "id" || key.endsWith("Id") || text.length <= 160) return text;
    condensed = true;
    return `${Array.from(text).slice(0, 157).join("")}…`;
  };
  const flatten = (item: unknown): Record<string, unknown> => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { value: item };
    const row = item as Record<string, unknown>;
    const nested = ["identity", "session", "revision", "body"].map(key => row[key]).find(nested => nested && typeof nested === "object" && !Array.isArray(nested));
    const flattened = nested ? { ...(nested as Record<string, unknown>), ...row } : { ...row };
    for (const [key, content] of Object.entries(flattened)) flattened[key] = described(flattened, key, content) ?? content;
    return flattened;
  };
  const table = (items: unknown[]): string[] => {
    if (!items.length) return [t("cli.human.noResults")];
    const rows = items.slice(0, 20).map(flatten);
    if (items.length > rows.length) condensed = true;
    const priority = ["id", "title", "name", "client", "project", "review", "status", "model", "provider", "input", "output", "kind", "updatedAt", "version", "estimatedTokens", "snippet", "text", "message", "path", "value"];
    const simple = (item: unknown) => item === null || typeof item !== "object";
    const available = [...new Set(rows.flatMap(row => Object.keys(row).filter(key => simple(row[key]))))];
    const columns = [...priority.filter(key => available.includes(key)), ...available.filter(key => !priority.includes(key))].slice(0, 8);
    if (!columns.length) return rows.map((row, index) => `${index + 1}. ${Object.keys(row).map(label).join(", ")}`);
    return [columns.map(label).join("\t"), ...rows.map(row => columns.map(key => cell(row[key], key)).join("\t"))];
  };
  const render = (item: unknown, depth = 0): string[] => {
    if (Array.isArray(item)) return table(item);
    if (!item || typeof item !== "object") return [scalar(item)];
    const lines: string[] = [];
    for (const [key, content] of Object.entries(item)) {
      if (content === undefined) continue;
      if (Array.isArray(content)) {
        if (depth || !content.length || content.every(element => element === null || typeof element !== "object")) {
          const values = content.slice(0, 20).map(element => cell(element, key));
          lines.push(`${label(key)}: ${content.length ? values.join(", ") : t("cli.human.noResults")}`);
          if (content.length > 20) { lines[lines.length - 1] += ` … (${formatNumber(language, content.length)})`; condensed = true; }
          if (content.some(element => element && typeof element === "object")) {
            lines[lines.length - 1] = `${label(key)}: ${formatNumber(language, content.length)}`;
            condensed = true;
          }
        } else lines.push(`${label(key)} (${formatNumber(language, content.length)})`, ...table(content));
      } else if (content && typeof content === "object") {
        if (key.endsWith("Descriptor")) continue;
        if (depth < 2) lines.push(`${label(key)}:`, ...render(content, depth + 1).map(line => `  ${line}`));
        else { lines.push(`${label(key)}: ${Object.keys(content).map(label).join(", ")}`); condensed = true; }
      } else lines.push(`${label(key)}: ${described(item as Record<string, unknown>, key, content) ?? scalar(content)}`);
    }
    return lines;
  };
  const lines = render(value);
  if (condensed) lines.push(t("cli.human.summaryHint"));
  return lines.length ? lines.join("\n") : t("cli.human.noResults");
}
