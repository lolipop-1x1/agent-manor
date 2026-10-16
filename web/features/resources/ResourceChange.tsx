import { ArrowRight } from "@phosphor-icons/react";
import type { ResourceManagementPreview } from "../../../src/resource-management-contracts";
import { clientLabel, useI18n } from "../../shared/i18n";

export function ResourceChange({ preview }: { preview: ResourceManagementPreview }) {
  const { t } = useI18n();
  const change = preview.configuration;
  const value = (current: boolean | "present" | "missing") => {
    if (change?.kind === "membership" && typeof current === "boolean") return t(current ? "resources.workspace.inDisabledList" : "resources.workspace.notInDisabledList");
    return typeof current === "boolean" ? String(current)
      : t(change?.kind === "registration" ? `resources.workspace.registration.${current}` : `resources.workspace.config.${current}`);
  };
  const location = preview.originalPath ?? (preview.action === "restore" ? preview.destinationPath : preview.sourcePath);
  return <section className="resource-change" aria-label={t("resources.workspace.changePreview")}>
    <div className="resource-change-file"><span>{t(change ? "resources.workspace.configFile" : "resources.facts.original")}</span><code>{change?.path ?? location ?? preview.sourcePath}</code></div>
    {change?.controlScope && <div className="resource-change-file"><span>{t("resources.workspace.effectScope")}</span><strong>{t(`resources.workspace.controlScope.${change.controlScope}`, { client: clientLabel(preview.resource.client) })}</strong>{change.controlScope === "project" && change.controlProject && <code>{change.controlProject}</code>}</div>}
    {change?.keyPath.length ? <div className="resource-change-file"><span>{t("resources.workspace.configField")}</span><code>{change.keyPath.join(".").replace(".[]", "[]")}</code></div> : null}
    {change?.selector && <div className="resource-change-file"><span>{t("resources.workspace.matchRule")}</span><code>{change.selector.key} = {JSON.stringify(change.selector.value)}</code></div>}
    {preview.link && <div className="resource-change-file"><span>{t("resources.workspace.linkTarget")}</span><code>{preview.link.target}</code><div className="resource-tags"><span className={preview.link.state === "available" ? "" : "is-warning"}>{t(`resources.workspace.linkState.${preview.link.state}`)}</span></div></div>}
    {preview.link?.resolvedTarget && preview.link.resolvedTarget !== preview.link.target && <div className="resource-change-file"><span>{t("resources.workspace.resolvedLinkTarget")}</span><code>{preview.link.resolvedTarget}</code></div>}
    {!change && preview.action !== "purge" && <p className="resource-management-note">{t(preview.link ? preview.action === "restore" ? "resources.workspace.restoreLinkEffect" : "resources.management.linkEffect" : "resources.workspace.pathEffect")}</p>}
    {(change || preview.destinationPath) && <div className="resource-change-diff">
      <div><span>{t("resources.workspace.before")}</span><code>{change ? value(change.before) : t(preview.action === "restore" ? "resources.workspace.recoveryLocation" : "resources.workspace.originalLocation")}</code></div>
      <ArrowRight size={17} aria-hidden="true" />
      <div><span>{t("resources.workspace.after")}</span><code>{change ? value(change.after) : t(preview.action === "restore" ? "resources.workspace.originalLocation" : "resources.workspace.recoveryLocation")}</code></div>
    </div>}
  </section>;
}
