import { useMemo, useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowClockwise, MagnifyingGlass, Plus, X } from "@phosphor-icons/react";
import type { JsonValue } from "../../../src/contracts";
import type { ModelPrice, ModelPriceOverride, PricingConfiguration, PricingStatus } from "../../../src/usage-contracts";
import { errorMessage, request } from "../../shared/api";
import { useI18n } from "../../shared/i18n";
import { ProjectPicker } from "../../shared/ui/ProjectPicker";
import { ResourcePagination } from "../../shared/ui/ResourcePagination";

interface PriceDraft { model: string; provider: string; input: string; output: string; cacheRead: string; cacheWrite: string }
const blankDraft = (): PriceDraft => ({ model: "", provider: "", input: "", output: "", cacheRead: "", cacheWrite: "" });
export function PricingManager({ status, models, onChange, open, onOpenChange }: {
  status: PricingStatus; models: string[]; onChange: (status: PricingStatus) => void; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const { t, number, dateTime, message } = useI18n();
  const dialog = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState(""); const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<PriceDraft | null>(null);
  const [mapping, setMapping] = useState<{ model: string; target: string } | null>(null);
  const [saving, setSaving] = useState(false); const [error, setError] = useState(""); const [saved, setSaved] = useState(false);
  const rows = useMemo(() => {
    const items: { model: string; provider: string; price?: ModelPrice | ModelPriceOverride; manual: boolean }[] = status.prices.filter(price => price.source !== "manual").map(price => ({ model: price.model, provider: price.provider, price, manual: false }));
    for (const price of status.configuration.overrides) items.unshift({ model: price.model, provider: price.provider ?? "", price, manual: true });
    for (const model of models) if (!items.some(item => item.model === model)) items.unshift({ model, provider: "", manual: false });
    const query = search.toLowerCase();
    return items.filter(item => `${item.model} ${item.provider} ${status.configuration.mappings.filter(value => value.model === item.model).map(value => `${value.targetModel} ${value.targetProvider}`).join(" ")}`.toLowerCase().includes(query));
  }, [status, models, search]);
  const save = async (configuration: PricingConfiguration) => {
    setSaving(true); setError(""); setSaved(false);
    try { const result = await request<PricingStatus>("/usage/pricing", { method: "PUT", body: configuration as unknown as JsonValue }); onChange(result); setDraft(null); setMapping(null); setSaved(true); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setSaving(false); }
  };
  const savePrice = (event: FormEvent) => {
    event.preventDefault(); if (!draft) return;
    const validRate = (value: string) => value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
    if (!draft.model.trim() || !validRate(draft.input) || !validRate(draft.output) || [draft.cacheRead, draft.cacheWrite].some(value => value.trim() !== "" && !validRate(value))) { setError(t("usage.pricing.validation")); return; }
    const override: ModelPriceOverride = { model: draft.model.trim(), ...(draft.provider.trim() ? { provider: draft.provider.trim() } : {}), input: Number(draft.input), output: Number(draft.output), ...(draft.cacheRead.trim() ? { cacheRead: Number(draft.cacheRead) } : {}), ...(draft.cacheWrite.trim() ? { cacheWrite: Number(draft.cacheWrite) } : {}) };
    void save({ ...status.configuration, overrides: [...status.configuration.overrides.filter(value => value.model !== override.model), override] });
  };
  const edit = (model: string, provider: string, price?: ModelPrice | ModelPriceOverride) => { setMapping(null); setError(""); setDraft({ model, provider, input: price ? String(price.input) : "", output: price ? String(price.output) : "", cacheRead: price?.cacheRead === undefined ? "" : String(price.cacheRead), cacheWrite: price?.cacheWrite === undefined ? "" : String(price.cacheWrite) }); };
  const refresh = async () => { setSaving(true); setError(""); try { onChange(await request<PricingStatus>("/usage/pricing/refresh", { method: "POST", body: {} })); } catch (failure) { setError(errorMessage(failure)); } finally { setSaving(false); } };
  const targetOptions = useMemo(() => status.prices.map(price => ({ value: JSON.stringify([price.provider, price.model]), label: price.name ?? price.model, description: `${price.provider} / ${price.model}` })), [status.prices]);
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / 20)));
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="usage-dialog-overlay" /><Dialog.Content ref={dialog} className="usage-price-dialog" aria-describedby="usage-pricing-description">
    <header><Dialog.Title>{t("usage.pricing.title")}</Dialog.Title><Dialog.Close className="icon-button" aria-label={t("common.closeNamed", { label: t("usage.pricing.title") })}><X size={18} /></Dialog.Close></header>
    <Dialog.Description id="usage-pricing-description">{t("usage.pricing.description")}</Dialog.Description>
    <div className="usage-price-source"><span>{t(`usage.pricing.${status.source}`)}</span><span>{status.fetchedAt ? t("usage.pricing.updated", { time: dateTime(status.fetchedAt) }) : t("usage.pricing.bundled")}</span><a href={status.sourceUrl} target="_blank" rel="noreferrer">models.dev</a><button className="text-button" onClick={() => void refresh()} disabled={saving || status.refreshing}><ArrowClockwise size={14} />{t(status.refreshing ? "usage.pricing.refreshing" : "usage.pricing.refresh")}</button></div>
    {status.error && <div className="usage-notice" role="status">{t("usage.pricing.fallback")} <span>{message(status.errorDescriptor, status.error)}</span></div>}
    {error && <div className="usage-notice danger" role="alert">{error}</div>}{saved && <div role="status" className="usage-save-status">{t("usage.pricing.saved")}</div>}
    <div className="usage-price-actions"><label className="usage-search"><MagnifyingGlass size={17} /><input value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder={t("usage.pricing.search")} aria-label={t("usage.pricing.search")} /></label><button onClick={() => edit("", "")}><Plus size={15} />{t("usage.pricing.add")}</button><button onClick={() => { setDraft(null); setMapping({ model: "", target: "" }); setError(""); }}>{t("usage.pricing.map")}</button></div>
    {draft && <form className="usage-price-editor" onSubmit={savePrice}>
      <h3>{t("usage.pricing.edit")}</h3><div className="usage-price-fields">
        <label>{t("usage.pricing.model")}<input value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} required /></label>
        <label>{t("usage.pricing.provider")}<input value={draft.provider} onChange={event => setDraft({ ...draft, provider: event.target.value })} /></label>
        {(["input", "output", "cacheRead", "cacheWrite"] as const).map(key => <label key={key}>{t(`usage.pricing.${key}`)}<input type="number" min="0" step="any" value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value })} required={key === "input" || key === "output"} placeholder={key === "input" || key === "output" ? undefined : t("usage.pricing.optional")} /></label>)}
      </div><div className="usage-editor-actions"><button type="submit" className="primary" disabled={saving}>{t("usage.pricing.save")}</button><button type="button" onClick={() => setDraft(null)} disabled={saving}>{t("usage.pricing.cancel")}</button></div>
    </form>}
    {mapping && <form className="usage-price-editor" onSubmit={event => { event.preventDefault(); if (!mapping.model.trim() || !mapping.target) return; const [targetProvider, targetModel] = JSON.parse(mapping.target) as [string, string]; void save({ ...status.configuration, mappings: [...status.configuration.mappings.filter(value => value.model !== mapping.model.trim()), { model: mapping.model.trim(), targetModel, targetProvider }] }); }}>
      <h3>{t("usage.pricing.map")}</h3><div className="usage-price-fields"><label>{t("usage.pricing.model")}<input value={mapping.model} required onChange={event => setMapping({ ...mapping, model: event.target.value })} /></label><label>{t("usage.pricing.target")}<ProjectPicker value={mapping.target} label={t("usage.pricing.target")} options={targetOptions} onChange={target => setMapping({ ...mapping, target })} container={dialog.current} modal /></label></div>
      <div className="usage-editor-actions"><button className="primary" disabled={saving || !mapping.target}>{t("usage.pricing.save")}</button><button type="button" onClick={() => setMapping(null)} disabled={saving}>{t("usage.pricing.cancel")}</button></div>
    </form>}
    {status.configuration.mappings.length > 0 && <div className="usage-mappings">{status.configuration.mappings.map(value => <div key={value.model}><span>{t("usage.pricing.mapping", { model: value.model, provider: value.targetProvider, target: value.targetModel })}</span><button className="text-button" disabled={saving} onClick={() => void save({ ...status.configuration, mappings: status.configuration.mappings.filter(item => item.model !== value.model) })}>{t("usage.pricing.removeMap")}</button></div>)}</div>}
    <div className="usage-table-scroll"><table className="usage-table usage-price-table"><thead><tr><th>{t("usage.pricing.model")}</th><th>{t("usage.pricing.effective")}</th><th>{t("usage.pricing.input")}</th><th>{t("usage.pricing.output")}</th><th>{t("usage.pricing.cacheRead")}</th><th>{t("usage.pricing.cacheWrite")}</th><th /></tr></thead><tbody>
      {rows.slice((current - 1) * 20, current * 20).map((row, index) => <tr key={`${row.model}:${row.provider}:${row.manual}:${index}`}><td><strong>{row.model}</strong><small>{row.provider}</small></td><td>{row.manual ? t("usage.pricing.manual") : row.price && "source" in row.price ? t(`usage.pricing.${row.price.source}`) : t("usage.pricing.unpriced")}{row.price && "tiers" in row.price && !!row.price.tiers?.length && <small>{t("usage.pricing.tiers", { count: row.price.tiers.length })}</small>}</td>{(["input", "output", "cacheRead", "cacheWrite"] as const).map(key => <td key={key} className="usage-number">{row.price?.[key] === undefined ? "—" : number(row.price[key]!, { maximumFractionDigits: 6 })}</td>)}<td><button className="text-button" onClick={() => edit(row.model, row.provider, row.price)}>{t("usage.pricing.edit")}</button>{row.manual && <button className="text-button" disabled={saving} onClick={() => void save({ ...status.configuration, overrides: status.configuration.overrides.filter(value => value.model !== row.model || (value.provider ?? "") !== row.provider) })}>{t("usage.pricing.restore")}</button>}</td></tr>)}
    </tbody></table></div>{!rows.length && <div className="usage-empty">{t("usage.pricing.empty")}</div>}
    <ResourcePagination label={t("usage.pricing.title")} page={current} total={rows.length} pageSize={20} onChange={setPage} />
    <footer>{t("usage.pricing.version", { version: status.version })}</footer>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
