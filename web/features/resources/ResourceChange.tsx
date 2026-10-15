import { ArrowRight } from "@phosphor-icons/react";
import type { ResourceManagementPreview } from "../../../src/resource-management-contracts";
import { useI18n } from "../../shared/i18n";

export function ResourceChange({ preview }: { preview: ResourceManagementPreview }) {
  const { t } = useI18n();
  const change = preview.configuration;
  const value = (current: boolean | "present" | "missing") => typeof current === "boolean" ? String(current)
    : t(change?.kind === "registration" ? `resources.workspace.registration.${current}` : `resources.workspace.config.${current}`);
  return <section className="resource-change" aria-label={t("resources.workspace.changePreview")}>
    <div className="resource-change-file"><span>{t(change ? "resources.workspace.configFile" : preview.action === "restore" ? "resources.facts.recovery" : "resources.facts.original")}</span><code>{change?.path ?? preview.sourcePath}</code></div>
    {change?.keyPath.length ? <div className="resource-change-file"><span>{t("resources.workspace.configField")}</span><code>{change.keyPath.join(".").replace(".[]", "[]")}</code></div> : null}
    {change?.selector && <div className="resource-change-file"><span>{t("resources.workspace.matchRule")}</span><code>{change.selector.key} = {JSON.stringify(change.selector.value)}</code></div>}
    {change?.kind === "membership" && <p className="resource-management-note">{t("resources.workspace.membership")}</p>}
    {(change || preview.destinationPath) && <div className="resource-change-diff">
      <div><span>{t("resources.workspace.before")}</span><code>{change ? value(change.before) : preview.sourcePath}</code></div>
      <ArrowRight size={17} aria-hidden="true" />
      <div><span>{t("resources.workspace.after")}</span><code>{change ? value(change.after) : preview.destinationPath}</code></div>
    </div>}
    {change?.kind === "registration" && <p className="resource-management-note">{t("resources.workspace.registrationPrivacy")}</p>}
  </section>;
}
