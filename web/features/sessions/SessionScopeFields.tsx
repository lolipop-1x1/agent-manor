import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CaretDown, X } from "@phosphor-icons/react";
import type { Client } from "../../../src/clients";
import type { SemanticScope } from "../../../src/semantic-contracts";
import { useI18n } from "../../shared/i18n";
import { FilterSelect } from "../../shared/ui/FilterSelect";
import { ProjectPicker } from "../../shared/ui/ProjectPicker";
import { DatePicker } from "../../shared/ui/DatePicker";
import { availableClientOptions } from "../../shared/ui/client-options";
import { localSemanticDate, semanticDateBoundary, searchScopeExtraCount, searchScopeInvalid } from "./semantic-ui-model";

export function SessionScopeFields({ value, onChange, clients, projects, models = [], maintenance = false, container, includeProcess, onIncludeProcessChange }: {
  value: SemanticScope; onChange: (scope: SemanticScope) => void; clients?: Client[]; projects?: string[]; models?: string[]; maintenance?: boolean; container?: HTMLElement | null;
  includeProcess?: boolean; onIncludeProcessChange?: (value: boolean) => void;
}) {
  const { t } = useI18n();
  const [more, setMore] = useState(false);
  const [modelInput, setModelInput] = useState("");
  const change = <K extends keyof SemanticScope>(key: K, next: SemanticScope[K]) => onChange({ ...value, [key]: next });
  const numbers = (["minMessages", "maxMessages", "minTurns", "maxTurns"] as const).map(key => <label className="semantic-field" key={key}><span>{t(`sessions.semantic.scope.${key}`)}</span><input type="number" min="0" step="1" value={value[key] ?? ""} onChange={event => change(key, event.target.value === "" ? undefined : Number(event.target.value))} /></label>);
  const modelOptions = [...new Set([...models, ...value.models])].sort().map(model => ({ value: model, label: model }));
  const extra = <>
    <div className="semantic-form-grid">
      <label className="semantic-field"><span>{t("sessions.semantic.scope.relationship")}</span><FilterSelect label={t("sessions.semantic.scope.relationship")} value={value.relationship} onChange={next => change("relationship", next as SemanticScope["relationship"])} container={container} options={(["exclude_children", "all", "children", "forks", "unknown"] as const).map(item => ({ value: item, label: t(`sessions.semantic.relationship.${item}`) }))} /></label>
      <label className="semantic-field"><span>{t("sessions.filter.execution")}</span><FilterSelect label={t("sessions.filter.execution")} value={value.executionMode} onChange={next => change("executionMode", next as SemanticScope["executionMode"])} container={container} options={(["exclude_quiet", "all", "quiet", "unknown"] as const).map(item => ({ value: item, label: t(`sessions.semantic.execution.${item}`) }))} /></label>
      <label className="semantic-field"><span>{t("sessions.filter.from")}</span><DatePicker label={t("sessions.filter.startDate")} value={localSemanticDate(value.from)} onChange={next => change("from", semanticDateBoundary(next))} /></label>
      <label className="semantic-field"><span>{t("sessions.filter.to")}</span><DatePicker label={t("sessions.filter.endDate")} value={localSemanticDate(value.to)} onChange={next => change("to", semanticDateBoundary(next, true))} /></label>
      <label className="semantic-field"><span>{t("sessions.semantic.scope.models")}</span><ProjectPicker multiple label={t("sessions.semantic.scope.models")} emptyLabel={t("sessions.filter.allModels")} value={value.models} options={modelOptions} onChange={next => change("models", next)} container={container} /></label>
      <label className="semantic-field"><span>{t("sessions.semantic.scope.branch")}</span><FilterSelect label={t("sessions.semantic.scope.branch")} value={value.branch} onChange={next => change("branch", next as SemanticScope["branch"])} container={container} options={[{ value: "all", label: t("sessions.branch.all") }, { value: "current", label: t("sessions.branch.current") }]} /></label>
    </div>
    {maintenance && <div className="semantic-model-input"><input aria-label={t("sessions.semantic.scope.addModel")} value={modelInput} onChange={event => setModelInput(event.target.value)} placeholder={t("sessions.semantic.scope.modelPlaceholder")} /><button className="button subtle" type="button" disabled={!modelInput.trim()} onClick={() => { change("models", [...new Set([...value.models, modelInput.trim()])]); setModelInput(""); }}>{t("sessions.semantic.scope.addModel")}</button></div>}
    <label className="semantic-field"><span>{t("sessions.semantic.scope.title")}</span><input value={value.title} onChange={event => change("title", event.target.value)} /></label>
    <div className="semantic-form-grid">{numbers}</div>
    {onIncludeProcessChange && <label className="semantic-check"><input type="checkbox" checked={includeProcess} onChange={event => onIncludeProcessChange(event.target.checked)} />{t("sessions.search.process")}</label>}
    {searchScopeInvalid(value) && <p role="alert" className="semantic-error">{t("sessions.filter.invalidScope")}</p>}
    <button className="text-button" type="button" onClick={() => { onChange({ ...value, relationship: "exclude_children", executionMode: "exclude_quiet", from: undefined, to: undefined, models: [], title: "", minMessages: undefined, maxMessages: undefined, minTurns: undefined, maxTurns: undefined, branch: "all" }); onIncludeProcessChange?.(false); }}>{t("sessions.semantic.scope.resetMore")}</button>
  </>;
  return <div className={`semantic-scope${maintenance ? " is-maintenance" : ""}`}>
    {maintenance && <fieldset className="semantic-time-range"><legend>{t("sessions.semantic.scope.time")}</legend><div className="semantic-time-options">
      <label><input type="radio" name="semantic-time" checked={value.timeRange === "all"} onChange={() => change("timeRange", "all")} />{t("sessions.semantic.scope.allHistory")}</label>
      <label><input type="radio" name="semantic-time" checked={value.timeRange === "recent"} onChange={() => change("timeRange", "recent")} />{t("sessions.semantic.scope.recent")}</label>
      {value.timeRange === "recent" && <label className="semantic-days"><input aria-label={t("sessions.semantic.scope.recentDays")} type="number" min="1" step="1" value={value.recentDays} onChange={event => change("recentDays", Number(event.target.value))} /><span>{t("sessions.semantic.scope.days")}</span></label>}
    </div></fieldset>}
    <div className="semantic-form-grid">
      <ProjectPicker multiple label={t("sessions.filter.client")} emptyLabel={t("sessions.allClients")} value={value.clients} options={availableClientOptions([...new Set([...(clients ?? []), ...value.clients])])} onChange={next => change("clients", next as Client[])} container={container} />
      <ProjectPicker multiple label={t("sessions.semantic.scope.project")} emptyLabel={t("sessions.filter.allProjects")} value={value.projects} options={[...new Set(["none", ...(projects ?? []), ...value.projects])].map(path => ({ value: path, label: path === "none" ? t("sessions.noProject") : path.split(/[\\/]/).filter(Boolean).at(-1) ?? path, description: path === "none" ? undefined : path }))} onChange={next => change("projects", next)} container={container} />
    </div>
    {maintenance ? <details className="semantic-details"><summary>{t("sessions.semantic.scope.moreConditions")}</summary><div className="semantic-scope-extra">{extra}</div></details> : <Popover.Root open={more} onOpenChange={setMore}><Popover.Trigger className="button subtle session-more-filters">{t("sessions.filter.more")}{searchScopeExtraCount(value) + Number(!!includeProcess) > 0 && <span>{searchScopeExtraCount(value) + Number(!!includeProcess)}</span>}<CaretDown size={13} aria-hidden="true" /></Popover.Trigger><Popover.Portal container={container}><Popover.Content className="filter-menu semantic-filter-popover" aria-label={t("sessions.semantic.scope.search")} align="start" sideOffset={6} collisionPadding={12} onEscapeKeyDown={event => event.stopPropagation()}><header><strong>{t("sessions.semantic.scope.search")}</strong><Popover.Close className="icon-button" aria-label={t("common.close")}><X size={16} /></Popover.Close></header><div className="semantic-scope-extra">{extra}</div></Popover.Content></Popover.Portal></Popover.Root>}
    {!maintenance && !more && searchScopeInvalid(value) && <p role="alert" className="semantic-error">{t("sessions.filter.invalidScope")}</p>}
  </div>;
}
