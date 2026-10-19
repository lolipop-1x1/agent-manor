import { Loading } from "../../shared/ui/Loading";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Copy, Eye, EyeSlash, Trash, X } from "@phosphor-icons/react";
import type { SessionSearchFacets } from "../../../src/session-contracts";
import type { SemanticConfig, SemanticPreview, SemanticSettings, SemanticStatus, SemanticStrategy } from "../../../src/semantic-contracts";
import { resolveModelConnection } from "../../../src/semantic/model-adapters";
import { errorMessage } from "../../shared/api";
import { useI18n } from "../../shared/i18n";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { SessionScopeFields } from "./SessionScopeFields";
import { SemanticBuildProgress } from "./SemanticBuildProgress";
import { semanticRequest } from "./semantic-api";
import { semanticCanRepreview, semanticCost } from "./semantic-ui-model";

export type SemanticSettingsTab = "connection" | "build" | "strategy";
export type SemanticFacets = SessionSearchFacets;

function SemanticSettingLabel({ id, label, container, children }: { id: string; label: string; container: HTMLElement | null; children: ReactNode }) {
  const { t } = useI18n();
  return <div className="semantic-field-heading"><label htmlFor={id}>{label}</label><HelpPopover iconOnly label={t("sessions.semantic.parameterHelp", { parameter: label })} container={container}>{children}</HelpPopover></div>;
}

export function SemanticSearchSettings({ open, initialTab, settings, status, facets, onClose, onSaved, onStatus, onGoSearch, onTabChange }: {
  open: boolean; initialTab: SemanticSettingsTab; settings?: SemanticSettings; status?: SemanticStatus; facets: SemanticFacets;
  onClose: () => void; onSaved: (settings: SemanticSettings) => void; onStatus: (status: SemanticStatus) => void; onGoSearch: () => void; onTabChange: (tab: SemanticSettingsTab) => void;
}) {
  const { t, language } = useI18n();
  const [tab, setTab] = useState<SemanticSettingsTab>(initialTab);
  const [draft, setDraft] = useState<SemanticConfig>();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [keyValue, setKeyValue] = useState<string | null>();
  const [keyChanged, setKeyChanged] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<unknown>();
  const [feedback, setFeedback] = useState("");
  const [preview, setPreview] = useState<SemanticPreview>();
  const [confirm, setConfirm] = useState<"discard" | "model" | "clear" | "disable">();
  const [editScope, setEditScope] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [tab]);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  useEffect(() => { if (open) { setTab(initialTab); setError(undefined); setConfirm(undefined); setKeyVisible(false); setFeedback(""); } else { setKeyValue(undefined); setKeyVisible(false); } }, [open, initialTab]);
  useEffect(() => {
    if (open && settings) { setDraft(structuredClone(settings.config)); setKeyValue(undefined); setKeyChanged(false); setEditScope(!status?.ready && (!status?.job || status.job.status === "complete")); }
  }, [open, settings]);
  useEffect(() => { if (tab !== "connection") setKeyVisible(false); }, [tab]);
  if (!draft) return <Dialog.Root open={open} onOpenChange={next => { if (!next) onClose(); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content semantic-settings" aria-describedby={undefined}><Dialog.Title>{t("sessions.semantic.settings")}</Dialog.Title><p role="status">{t("common.loading")}</p><Dialog.Close className="icon-button dialog-close" aria-label={t("common.close")}><X size={18} /></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>;
  const config = draft;
  const selectTab = (next: SemanticSettingsTab) => { setTab(next); onTabChange(next); };
  const dirty = JSON.stringify(config) !== JSON.stringify(settings?.config) || keyChanged;
  const number = (value: number) => new Intl.NumberFormat(language).format(value);
  const money = (value: number | null | undefined) => semanticCost(value, language) ?? t("sessions.semantic.unknown");
  const change = (next: SemanticConfig) => { setDraft(next); setPreview(undefined); setFeedback(""); setError(undefined); setConfirm(undefined); };
  const strategy = <K extends keyof SemanticStrategy>(key: K, value: SemanticStrategy[K]) => change({ ...config, strategy: { ...config.strategy, [key]: value } });
  const connection = (key: "url" | "model", value: string) => change({ ...config, connection: resolveModelConnection({ ...config.connection, [key]: value, dimensions: undefined }, settings?.config.connection) });
  const run = async (name: string, operation: () => Promise<void>) => { if (busyRef.current) return; busyRef.current = true; setBusy(name); setError(undefined); setFeedback(""); try { await operation(); } catch (failure) { setError(failure); } finally { busyRef.current = false; setBusy(""); } };
  const save = async (enable = false) => {
    const next = await semanticRequest<SemanticSettings>("/settings", { config: { ...config, enabled: enable || config.enabled }, ...(keyChanged ? { apiKey: keyValue ?? null } : {}) }, "PUT");
    onSaved(next); setDraft(structuredClone(next.config)); setKeyChanged(false); setKeyValue(undefined); setKeyVisible(false); setConfirm(undefined); setFeedback(t("sessions.semantic.saved"));
    return next;
  };
  const saveConnection = () => {
    const old = settings?.config.connection;
    const changed = old && (old.url !== config.connection.url || old.model !== config.connection.model || old.documentPrefix !== config.connection.documentPrefix || old.queryPrefix !== config.connection.queryPrefix || old.dimensions !== config.connection.dimensions || settings.config.strategy.chunkChars !== config.strategy.chunkChars || settings.config.strategy.overlapChars !== config.strategy.overlapChars);
    if (changed && status?.ready && confirm !== "model") { setConfirm("model"); return; }
    void run("save", async () => { await save(tab !== "strategy"); if (changed || tab === "connection" && !status?.ready) selectTab("build"); });
  };
  const getKey = async () => {
    if (keyValue !== undefined) return keyValue;
    const result = await semanticRequest<{ apiKey: string | null }>("/key");
    setKeyValue(result.apiKey); return result.apiKey;
  };
  const act = (action: "pause" | "resume" | "update" | "disable" | "enable" | "clear") => void run(action, async () => {
    const next = await semanticRequest<SemanticStatus>("/action", { action }); onStatus(next); setConfirm(undefined);
    if (action === "clear") setPreview(undefined);
    if (action === "disable" || action === "enable") { const nextSettings = await semanticRequest<SemanticSettings>("/settings"); onSaved(nextSettings); }
  });
  const close = () => { if (busy) return; if (dirty) { setConfirm("discard"); return; } setKeyVisible(false); onClose(); };
  const validConnection = !!config.connection.url.trim() && !!config.connection.model.trim();
  const jobActive = status?.job?.status === "running" || status?.job?.status === "paused" || status?.job?.status === "budget_stopped" || status?.job?.status === "failed";
  const previewBuild = () => {
    if (status?.ready && JSON.stringify(config.connection) !== JSON.stringify(settings?.config.connection)) { setConfirm("model"); return; }
    void run("preview", async () => { if (dirty || !config.enabled) await save(true); const next = await semanticRequest<SemanticPreview>("/preview", { scope: config.scope }); setPreview(next); setEditScope(false); });
  };
  return <Dialog.Root open={open} onOpenChange={next => { if (!next) close(); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content ref={setContainer} className="dialog-content semantic-settings" aria-describedby={undefined}
    onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
    onCloseAutoFocus={event => { setKeyVisible(false); if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus(); } }}>
    <header className="semantic-settings-heading"><Dialog.Title>{t("sessions.semantic.settings")}</Dialog.Title><div><HelpPopover iconOnly label={t("sessions.semantic.help.title")} container={container}><p>{t("sessions.semantic.help.connection")}</p><p>{t("sessions.semantic.help.scope")}</p><p>{t("sessions.semantic.help.pause")}</p></HelpPopover><button className="icon-button" aria-label={t("common.close")} disabled={!!busy} onClick={close}><X size={18} /></button></div></header>
    <div className="semantic-settings-tabs" role="tablist" aria-label={t("sessions.semantic.settings")}>{(["connection", "build", "strategy"] as const).map(value => <button role="tab" disabled={!!busy} aria-selected={tab === value} aria-controls={`semantic-tab-${value}`} id={`semantic-tab-trigger-${value}`} key={value} tabIndex={tab === value ? 0 : -1} onClick={() => { selectTab(value); setConfirm(undefined); setError(undefined); setFeedback(""); }} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const tabs = ["connection", "build", "strategy"] as const; const index = tabs.indexOf(value); const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[2] : tabs[(index + (event.key === "ArrowRight" ? 1 : 2)) % 3]!; selectTab(next); container?.querySelector<HTMLButtonElement>(`#semantic-tab-trigger-${next}`)?.focus();
    }}>{t(`sessions.semantic.tab.${value}`)}</button>)}</div>
    <div ref={bodyRef} className="semantic-settings-body" role="tabpanel" id={`semantic-tab-${tab}`} aria-labelledby={`semantic-tab-trigger-${tab}`}><fieldset className="semantic-settings-fields" disabled={!!busy}>
      {tab === "connection" && <div className="semantic-connection-fields">
        <div className="semantic-field"><SemanticSettingLabel id="semantic-connection-url" label={t("sessions.semantic.connection.url")} container={container}><p>{t("sessions.semantic.connection.urlHelp")}</p><code>http://localhost:11434/v1</code></SemanticSettingLabel><input id="semantic-connection-url" type="url" autoComplete="off" spellCheck={false} value={config.connection.url} onChange={event => connection("url", event.target.value)} /></div>
        <div className="semantic-field"><SemanticSettingLabel id="semantic-connection-model" label={t("sessions.semantic.connection.model")} container={container}><p>{t("sessions.semantic.connection.modelHelp")}</p><dl><div><dt>{t("sessions.semantic.connection.ollama")}</dt><dd>{t("sessions.semantic.connection.ollamaSetup")}<code className="semantic-help-command">ollama pull qwen3-embedding:0.6b</code></dd></div><div><dt>{t("sessions.semantic.connection.url")}</dt><dd><code>http://localhost:11434/v1</code></dd></div><div><dt>{t("sessions.semantic.connection.model")}</dt><dd><code>qwen3-embedding:0.6b</code></dd></div><div><dt>{t("sessions.semantic.connection.key")}</dt><dd>{t("sessions.semantic.connection.localKey")}</dd></div></dl><a href="https://ollama.com/download" target="_blank" rel="noreferrer">{t("sessions.semantic.connection.ollamaInstall")}</a></SemanticSettingLabel><input id="semantic-connection-model" autoComplete="off" spellCheck={false} value={config.connection.model} onChange={event => connection("model", event.target.value)} /></div>
        <div className="semantic-field"><SemanticSettingLabel id="semantic-connection-key" label={t("sessions.semantic.connection.key")} container={container}><p>{t("sessions.semantic.connection.localKeyHelp")}</p></SemanticSettingLabel><div className="semantic-key-field"><input id="semantic-connection-key" autoComplete="off" spellCheck={false} type={keyVisible ? "text" : "password"} value={keyValue ?? ""} placeholder={settings?.hasKey && keyValue === undefined ? "••••••••••••" : ""} onChange={event => { setKeyValue(event.target.value); setKeyChanged(true); setFeedback(""); }} /><button type="button" className="icon-button" disabled={!!busy} aria-label={t(keyVisible ? "sessions.semantic.connection.hideKey" : "sessions.semantic.connection.showKey")} aria-pressed={keyVisible} onClick={() => { if (keyVisible) setKeyVisible(false); else void run("key", async () => { await getKey(); setKeyVisible(true); }); }}>{keyVisible ? <EyeSlash size={17} /> : <Eye size={17} />}</button><button type="button" className="icon-button" disabled={!!busy || (!settings?.hasKey && !keyValue)} aria-label={t("sessions.semantic.connection.copyKey")} onClick={() => void run("copy", async () => { const key = await getKey(); if (key) { await navigator.clipboard.writeText(key); setCopied(true); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(false), 1500); } })}>{copied ? <Check size={17} /> : <Copy size={17} />}</button><button type="button" className="icon-button" disabled={!settings?.hasKey && !keyValue} aria-label={t("sessions.semantic.connection.clearKey")} onClick={() => { setKeyValue(null); setKeyChanged(true); setKeyVisible(false); }}><Trash size={17} /></button></div></div>
      </div>}
      {tab === "build" && <>
        {!config.connection.dimensions && <div className="semantic-inline-error" role="alert"><span>{t("sessions.semantic.connection.testFirst")}</span><button className="text-button" onClick={() => selectTab("connection")}>{t("sessions.semantic.connection.test")}</button></div>}
        {!status?.enabled && settings?.config.connection.model && <div className="semantic-inline-error"><span>{t("sessions.semantic.status.disabled")}</span><button className="text-button" onClick={() => act("enable")}>{t("sessions.semantic.enable")}</button></div>}
        {!editScope && <div className="semantic-section-heading"><h3>{t("sessions.semantic.scope.maintenance")}</h3><button className="text-button" disabled={!!busy || status?.job?.status === "running"} onClick={() => { setEditScope(true); setPreview(undefined); }}>{t("sessions.semantic.scope.edit")}</button></div>}
        {(editScope || !status?.ready && !preview && !jobActive) && <><h3 className="semantic-section-title">{t("sessions.semantic.scope.maintenance")}</h3><SessionScopeFields value={config.scope} onChange={scope => change({ ...config, scope })} {...facets} maintenance container={container} /><details className="semantic-details"><summary>{t("sessions.semantic.scope.retention")}</summary><p>{t("sessions.semantic.scope.retentionHelp")}</p><label className="semantic-check"><input type="checkbox" checked={config.strategy.cleanOutsideWindow} onChange={event => strategy("cleanOutsideWindow", event.target.checked)} />{t("sessions.semantic.scope.cleanWindow")}</label>{config.strategy.cleanOutsideWindow && <p>{t("sessions.semantic.scope.cleanHelp")}</p>}</details></>}
        {!editScope && !preview && <p className="semantic-scope-overview">{t(config.scope.timeRange === "recent" ? "sessions.semantic.scope.summaryRecent" : config.scope.timeRange === "all" ? "sessions.semantic.scope.allHistory" : "sessions.semantic.scope.chooseTime", { days: config.scope.recentDays })}</p>}
        {preview && <section className="semantic-preview" aria-label={t("sessions.semantic.preview.title")}><h3>{t("sessions.semantic.preview.title")}</h3><dl className="semantic-summary"><div><dt>{t("sessions.semantic.preview.sessions")}</dt><dd>{number(preview.sessionCount)}</dd></div><div><dt>{t("sessions.semantic.preview.pending")}</dt><dd>{number(preview.pendingInputs)}</dd></div><div className="semantic-cost"><dt>{t("sessions.semantic.preview.cost")}</dt><dd>{preview.estimatedCost === null ? <button className="text-button" onClick={() => selectTab("strategy")}>{t("sessions.semantic.unknown")} · {t("sessions.semantic.strategy.setPrice")}</button> : `≈ ${money(preview.estimatedCost)}`}</dd></div></dl><details className="semantic-details"><summary>{t("sessions.semantic.details")}</summary><dl className="semantic-summary">{(["positionCount", "uniqueInputs", "reusedInputs", "estimatedTokens"] as const).map(key => <div key={key}><dt>{t(`sessions.semantic.preview.${key}`)}</dt><dd>{number(preview[key])}</dd></div>)}<div><dt>{t("sessions.semantic.preview.vectorBytes")}</dt><dd>{preview.vectorBytes === null ? t("sessions.semantic.unknown") : `${number(Math.ceil(preview.vectorBytes / 1024))} KiB`}</dd></div></dl></details></section>}
        {!editScope && !preview && status && <SemanticBuildProgress status={status} />}
      </>}
      {tab === "strategy" && <>
        <div className="semantic-form-grid">{(["pricePerMillion", "dailyBudget", "quietMinutes", "maxDelayMinutes"] as const).map(key => <div className="semantic-field" key={key}><SemanticSettingLabel id={`semantic-strategy-${key}`} label={t(`sessions.semantic.strategy.${key}`)} container={container}><p>{t(`sessions.semantic.strategy.help.${key}.meaning`)}</p><p>{t(`sessions.semantic.strategy.help.${key}.adjust`)}</p></SemanticSettingLabel><input id={`semantic-strategy-${key}`} type="number" min="0" step={key === "pricePerMillion" || key === "dailyBudget" ? "any" : "1"} value={config.strategy[key] ?? ""} placeholder={t(key === "dailyBudget" ? "sessions.semantic.strategy.unlimited" : key === "pricePerMillion" ? "sessions.semantic.unknown" : "sessions.semantic.strategy.minutes")} onChange={event => strategy(key, event.target.value === "" ? undefined as never : Number(event.target.value))} /></div>)}</div>
        <details className="semantic-details"><summary>{t("sessions.semantic.strategy.advanced")}</summary><div className="semantic-form-grid semantic-advanced-fields">{(["concurrency", "batchSize", "batchTokens", "requestsPerMinute", "tokensPerMinute", "timeoutMs", "retries", "chunkChars", "overlapChars"] as const).map(key => <div className="semantic-field" key={key}><SemanticSettingLabel id={`semantic-strategy-${key}`} label={t(`sessions.semantic.strategy.${key}`)} container={container}><p>{t(`sessions.semantic.strategy.help.${key}.meaning`)}</p><p>{t(`sessions.semantic.strategy.help.${key}.adjust`)}</p></SemanticSettingLabel><input id={`semantic-strategy-${key}`} type="number" min={key === "overlapChars" || key === "retries" || key === "requestsPerMinute" || key === "tokensPerMinute" ? 0 : 1} step="1" value={config.strategy[key]} onChange={event => strategy(key, Number(event.target.value))} /></div>)}</div></details>
        <section className="semantic-usage"><h3>{t("sessions.semantic.strategy.today")}</h3><dl className="semantic-summary">{(["build", "query", "test"] as const).map(purpose => <div key={purpose}><dt>{t(`sessions.semantic.purpose.${purpose}`)}</dt><dd>{money(status?.usage.byPurpose[purpose].cost)}</dd></div>)}<div className="semantic-cost"><dt>{t("sessions.semantic.strategy.totalEstimated")}</dt><dd>{money(status?.usage.estimatedCost)}</dd></div></dl><details className="semantic-details"><summary>{t("sessions.semantic.details")}</summary><dl className="semantic-summary"><div><dt>{t("sessions.semantic.strategy.requests")}</dt><dd>{number(status?.usage.requests ?? 0)}</dd></div><div><dt>{t("sessions.semantic.strategy.estimatedTokens")}</dt><dd>{number(status?.usage.estimatedTokens ?? 0)}</dd></div><div><dt>{t("sessions.semantic.strategy.actualTokens")}</dt><dd>{status?.usage.actualRequests ? number(status.usage.actualTokens) : "—"}</dd></div></dl><p>{t("sessions.semantic.strategy.budgetHelp")}</p></details></section>
        <details className="semantic-details semantic-more-actions"><summary>{t("sessions.semantic.strategy.moreActions")}</summary><div><button className="button subtle" disabled={!!busy} onClick={() => status?.enabled ? setConfirm("disable") : act("enable")}>{t(status?.enabled ? "sessions.semantic.disable" : "sessions.semantic.enable")}</button><button className="button subtle semantic-danger" disabled={!!busy} onClick={() => setConfirm("clear")}>{t("sessions.semantic.clear")}</button></div></details>
      </>}
    </fieldset></div>
    <footer className="semantic-settings-footer">
      <div className="semantic-feedback" aria-live="polite">{error ? <p role="alert" className="semantic-error">{errorMessage(error)}</p> : feedback ? <p role="status">{feedback}</p> : busy ? <span role="status"><Loading variant="inline" size={15} />{t(`sessions.semantic.busy.${busy === "preview" ? "preview" : busy === "test" ? "test" : "working"}`)}</span> : null}</div>
      {confirm ? <div className="semantic-confirm" role="alert"><p>{t(`sessions.semantic.confirm.${confirm}`)}</p><div><button className="button subtle" disabled={!!busy} onClick={() => setConfirm(undefined)}>{t("common.cancel")}</button><button className={`button ${confirm === "clear" ? "semantic-danger" : "primary"}`} disabled={!!busy} onClick={() => { if (confirm === "discard") { setConfirm(undefined); onClose(); } else if (confirm === "model") saveConnection(); else act(confirm); }}>{t(confirm === "discard" ? "sessions.semantic.discard" : confirm === "model" ? "sessions.semantic.connection.save" : `sessions.semantic.${confirm}`)}</button></div></div> : <>
        <div className="semantic-footer-actions">{tab === "connection" && <><button className="button subtle" disabled={!!busy || !validConnection} onClick={() => void run("test", async () => { const result = await semanticRequest<{ dimensions: number; tokens?: number }>("/test", { connection: config.connection, ...(keyChanged ? { apiKey: keyValue ?? null } : {}) }); setDraft(current => current ? { ...current, connection: { ...current.connection, dimensions: result.dimensions } } : current); setFeedback(t("sessions.semantic.connection.success", { dimensions: result.dimensions })); })}>{t("sessions.semantic.connection.test")}</button><button className="button primary" disabled={!!busy || !validConnection} onClick={saveConnection}>{t("sessions.semantic.connection.save")}</button></>}
        {tab === "build" && <>{!editScope && !preview && status?.ready && status.enabled && <button className="button subtle" disabled={!!busy} onClick={onGoSearch}>{t("sessions.semantic.build.goSearch")}</button>}{!editScope && !preview && semanticCanRepreview(status) && <button className="button subtle" disabled={!!busy || !validConnection || !config.connection.dimensions || config.scope.timeRange === "unset"} onClick={previewBuild}>{t("sessions.semantic.build.repreview")}</button>}{!editScope && !preview && jobActive ? <button className="button primary" disabled={!!busy} onClick={() => act(status?.job?.status === "running" ? "pause" : "resume")}>{t(status?.job?.status === "running" ? "sessions.semantic.build.pause" : status?.job?.status === "failed" ? "sessions.semantic.build.retry" : "sessions.semantic.build.resume")}</button> : preview ? <><button className="button subtle" disabled={!!busy} onClick={() => { setPreview(undefined); setEditScope(true); }}>{t("sessions.semantic.scope.edit")}</button><button className="button primary" disabled={!!busy || !preview.sessionCount} onClick={() => void run("build", async () => { const next = await semanticRequest<SemanticStatus>("/build", { previewId: preview.id }); setPreview(undefined); setEditScope(false); onStatus(next); })}>{t("sessions.semantic.build.start")}</button></> : !editScope && status?.ready ? <button className="button primary" disabled={!!busy} onClick={() => act("update")}>{t("sessions.semantic.build.update")}</button> : <button className="button primary" disabled={!!busy || !validConnection || !config.connection.dimensions || config.scope.timeRange === "unset"} onClick={previewBuild}>{t("sessions.semantic.preview.action")}</button>}</>}
        {tab === "strategy" && <button className="button primary" disabled={!!busy || !validConnection} onClick={saveConnection}>{t("sessions.semantic.strategy.save")}</button>}</div>
      </>}
    </footer>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
