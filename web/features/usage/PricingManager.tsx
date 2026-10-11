import { Fragment, useMemo, useRef, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowClockwise, ArrowLeft, CaretDown, CaretUp, CaretUpDown, MagnifyingGlass, Plus, X } from "@phosphor-icons/react";
import type { JsonValue } from "../../../src/contracts";
import type { ModelPrice, ModelPriceOverride, PricingConfiguration, PricingStatus } from "../../../src/usage-contracts";
import { ApiError, errorMessage, request } from "../../shared/api";
import { useI18n } from "../../shared/i18n";
import { FilterSelect } from "../../shared/ui/FilterSelect";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { ProjectPicker } from "../../shared/ui/ProjectPicker";
import { ResourcePagination } from "../../shared/ui/ResourcePagination";
import { createPriceMatcher } from "../../../src/usage/price-resolution";
import { PriceDetails } from "./PriceDetails";
import { selectPriceRows, type PriceRow, type PriceListState, type PriceListSort, type PriceSortKey } from "./pricing-list";
import "./pricing-manager.css";

interface PriceDraft { model: string; provider: string; input: string; output: string; cacheRead: string; cacheWrite: string; original?: { model: string; provider: string } }
interface MappingDraft { model: string; target: string; original?: string; relatedOnly?: boolean }
const blankDraft = (): PriceDraft => ({ model: "", provider: "", input: "", output: "", cacheRead: "", cacheWrite: "" });
const sameOverride = (value: ModelPriceOverride, identity: { model: string; provider?: string }) => value.model === identity.model && (value.provider ?? "") === (identity.provider ?? "");
export function PricingManager({ status, models, onChange, open, onOpenChange }: {
  status: PricingStatus; models: string[]; onChange: (status: PricingStatus) => void; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const { t, number, dateTime, message } = useI18n();
  const [dialog, setDialog] = useState<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const editorOpener = useRef<HTMLElement | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState(""); const [page, setPage] = useState(1);
  const [scope, setScope] = useState("recorded");
  const [state, setState] = useState<PriceListState>("all");
  const [sort, setSort] = useState<PriceListSort | null>(null);
  const [draft, setDraft] = useState<PriceDraft | null>(null);
  const [mapping, setMapping] = useState<MappingDraft | null>(null);
  const [saving, setSaving] = useState(false); const [error, setError] = useState<Error | null>(null); const [saved, setSaved] = useState(false);
  const editing = !!draft || !!mapping;
  const match = useMemo(() => createPriceMatcher(status.prices, status.configuration, status.historicalPrices), [status]);
  const rows = useMemo(() => {
    const items: PriceRow[] = scope === "catalog" ? status.prices.filter(price => price.source !== "manual").map(price => ({ model: `${price.provider}/${price.model}`, provider: price.provider, price, manual: false })) : [];
    for (const price of status.configuration.overrides) items.unshift({ model: price.model, provider: price.provider ?? "", price: { ...price, provider: price.provider ?? "manual", source: "manual" }, manual: true });
    for (const model of [...models, ...status.configuration.mappings.map(value => value.model)]) if (!items.some(item => (item.recorded || item.manual) && item.model === model)) {
      const resolution = match(model), price = resolution.price;
      items.unshift({ model, provider: price?.provider ?? "", price, resolution, manual: false, recorded: true, mapped: status.configuration.mappings.some(value => value.model === model) });
    }
    const query = search.toLowerCase();
    return selectPriceRows(items.filter(item => `${item.model} ${item.provider} ${item.price?.model ?? ""} ${item.resolution?.canonicalModelId ?? ""} ${item.resolution?.candidates.map(price => `${price.provider} ${price.model} ${price.name ?? ""}`).join(" ") ?? ""} ${status.configuration.mappings.filter(value => value.model === item.model).map(value => `${value.targetModel} ${value.targetProvider}`).join(" ")}`.toLowerCase().includes(query)), state, sort);
  }, [status, models, search, scope, match, state, sort]);
  const sortHeader = (key: PriceSortKey, label: string) => <th aria-sort={sort?.key === key ? sort.direction === "asc" ? "ascending" : "descending" : "none"}><button type="button" className="pricing-sort" onClick={() => { setSort({ key, direction: sort?.key === key && sort.direction === "asc" ? "desc" : "asc" }); setPage(1); }}>{label}{sort?.key === key ? sort.direction === "asc" ? <CaretUp size={13} aria-hidden="true" /> : <CaretDown size={13} aria-hidden="true" /> : <CaretUpDown size={13} aria-hidden="true" />}</button></th>;
  const closeEditor = () => {
    setDraft(null); setMapping(null); setError(null);
    requestAnimationFrame(() => (editorOpener.current?.isConnected ? editorOpener.current : searchInput.current)?.focus({ preventScroll: true }));
  };
  const save = async (configuration: PricingConfiguration) => {
    setSaving(true); setError(null); setSaved(false);
    try { const result = await request<PricingStatus>("/usage/pricing", { method: "PUT", body: configuration as unknown as JsonValue }); onChange(result); if (editing) closeEditor(); setSaved(true); }
    catch (failure) { setError(failure instanceof Error ? failure : new ApiError("QUERY_FAILED", "", { key: "common.error.query" })); }
    finally { setSaving(false); }
  };
  const savePrice = (event: FormEvent) => {
    event.preventDefault(); if (!draft) return;
    const validRate = (value: string) => value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
    if (!draft.model.trim() || !validRate(draft.input) || !validRate(draft.output) || [draft.cacheRead, draft.cacheWrite].some(value => value.trim() !== "" && !validRate(value))) { setError(new ApiError("INVALID_PRICE", "", { key: "usage.pricing.validation" })); return; }
    const override: ModelPriceOverride = { model: draft.model.trim(), ...(draft.provider.trim() ? { provider: draft.provider.trim() } : {}), input: Number(draft.input), output: Number(draft.output), ...(draft.cacheRead.trim() ? { cacheRead: Number(draft.cacheRead) } : {}), ...(draft.cacheWrite.trim() ? { cacheWrite: Number(draft.cacheWrite) } : {}) };
    void save({ ...status.configuration, overrides: [...status.configuration.overrides.filter(value => !sameOverride(value, override) && (!draft.original || !sameOverride(value, draft.original))), override] });
  };
  const saveMapping = (event: FormEvent) => {
    event.preventDefault(); if (!mapping?.model.trim() || !mapping.target) return;
    const [targetProvider, targetModel] = JSON.parse(mapping.target) as [string, string];
    void save({ ...status.configuration, mappings: [...status.configuration.mappings.filter(value => value.model !== mapping.model.trim() && value.model !== mapping.original), { model: mapping.model.trim(), targetModel, targetProvider }] });
  };
  const edit = (model: string, provider: string, trigger: HTMLElement, price?: ModelPrice | ModelPriceOverride, manual = false) => {
    editorOpener.current = trigger; setMapping(null); setError(null); setSaved(false);
    setDraft({ ...(price ? { input: String(price.input), output: String(price.output), cacheRead: price.cacheRead === undefined ? "" : String(price.cacheRead), cacheWrite: price.cacheWrite === undefined ? "" : String(price.cacheWrite) } : blankDraft()), model, provider, ...(manual ? { original: { model, provider } } : {}) });
  };
  const targetOptions = useMemo(() => [...new Map([...(status.historicalPrices ?? []), ...status.prices].map(price => [JSON.stringify([price.provider, price.model]), price])).values()].map(price => ({ value: JSON.stringify([price.provider, price.model]), label: price.name ?? price.model, description: `${price.provider} / ${price.model}` })), [status.prices, status.historicalPrices]);
  const editMapping = (model: string, trigger: HTMLElement, price?: ModelPrice, relatedOnly = false) => {
    const configured = status.configuration.mappings.find(value => value.model === model);
    const automatic = price?.source === "manual" ? createPriceMatcher(status.prices, { overrides: [], mappings: [] }, status.historicalPrices)(model).price : price;
    const configuredTarget = configured && JSON.stringify([configured.targetProvider, configured.targetModel]);
    const target = configured ? price && targetOptions.some(option => option.value === configuredTarget) ? configuredTarget! : "" : automatic ? JSON.stringify([automatic.provider, automatic.model]) : "";
    editorOpener.current = trigger; setDraft(null); setError(null); setSaved(false);
    setMapping({ model, ...(configured ? { original: configured.model } : {}), target, relatedOnly });
  };
  const refresh = async () => { setSaving(true); setError(null); setSaved(false); try { onChange(await request<PricingStatus>("/usage/pricing/refresh", { method: "POST", body: {} })); } catch (failure) { setError(failure instanceof Error ? failure : new ApiError("QUERY_FAILED", "", { key: "common.error.query" })); } finally { setSaving(false); } };
  const mappingResolution = mapping?.model.trim() ? match(mapping.model.trim()) : undefined;
  const relatedTargets = new Set(mappingResolution?.candidates.map(price => JSON.stringify([price.provider, price.model])));
  const mappingOptions = mapping?.relatedOnly ? targetOptions.filter(option => relatedTargets.has(option.value) || option.value === mapping.target) : targetOptions;
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / 20)));
  const help = <>
    <p>{t("usage.pricing.description")}</p><p>{t("usage.pricing.automaticBasis")}</p><p>{t("usage.help.cost")}</p>
    <p>{t(`usage.pricing.${status.source}`)} · {status.fetchedAt ? t("usage.pricing.updated", { time: dateTime(status.fetchedAt) }) : t("usage.pricing.bundled")}</p>
    <p><a href={status.sourceUrl} target="_blank" rel="noreferrer">models.dev</a></p>
    {status.error && <p>{t("usage.pricing.fallback")} {message(status.errorDescriptor, status.error)}</p>}
    {status.history && <><p>{t("usage.pricing.history")} · {status.history.fetchedAt ? t("usage.pricing.updated", { time: dateTime(status.history.fetchedAt) }) : t("usage.pricing.historyUnavailable")}</p><p><a href={status.history.sourceUrl} target="_blank" rel="noreferrer">{t("usage.pricing.source")}</a></p>{status.history.error && <p>{message(status.history.errorDescriptor, status.history.error)}</p>}</>}
    <p>{t("usage.pricing.version", { version: status.version })}</p>
  </>;
  return <Dialog.Root open={open} onOpenChange={next => { if (!next) { setDraft(null); setMapping(null); } onOpenChange(next); }}><Dialog.Portal><Dialog.Overlay className="usage-dialog-overlay" /><Dialog.Content ref={setDialog} className="pricing-workspace" aria-describedby="usage-pricing-description"
    onOpenAutoFocus={() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
    onCloseAutoFocus={event => { event.preventDefault(); opener.current?.focus(); }}
    onEscapeKeyDown={event => { if (editing) { event.preventDefault(); if (!saving) closeEditor(); } }}>
    <Dialog.Description id="usage-pricing-description" className="pricing-description">{t("usage.pricing.description")}</Dialog.Description>
    <div className="pricing-list" hidden={editing}>
      <header className="pricing-list-header"><Dialog.Title>{t("usage.pricing.title")}</Dialog.Title><div><HelpPopover label={t("usage.pricing.help")} container={dialog} iconOnly>{help}</HelpPopover><button className="text-button" onClick={() => void refresh()} disabled={saving || status.refreshing}><ArrowClockwise size={15} aria-hidden="true" />{t(status.refreshing ? "usage.pricing.refreshing" : "usage.pricing.refresh")}</button><Dialog.Close className="icon-button" aria-label={t("common.closeNamed", { label: t("usage.pricing.title") })}><X size={18} aria-hidden="true" /></Dialog.Close></div></header>
      <div className="pricing-list-toolbar"><FilterSelect label={t("usage.pricing.listScope")} value={scope} options={[{ value: "recorded", label: t("usage.pricing.scope.recorded") }, { value: "catalog", label: t("usage.pricing.scope.catalog") }]} onChange={value => { setScope(value); setPage(1); }} container={dialog} /><FilterSelect label={t("usage.pricing.filterState")} value={state} options={["all", "unmatched", "automatic", "mapping", "manual"].map(value => ({ value, label: t(`usage.pricing.state.${value}`) }))} onChange={value => { setState(value as PriceListState); setPage(1); }} container={dialog} /><label className="pricing-search"><MagnifyingGlass size={17} aria-hidden="true" /><input ref={searchInput} value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder={t("usage.pricing.search")} aria-label={t("usage.pricing.search")} /></label><button className="button" onClick={event => edit("", "", event.currentTarget)} disabled={saving}><Plus size={15} aria-hidden="true" />{t("usage.pricing.add")}</button><button className="button" onClick={event => editMapping("", event.currentTarget)} disabled={saving}>{t("usage.pricing.map")}</button></div>
      <div className="pricing-list-status">
        {status.error && <div className="pricing-notice" role="status">{t("usage.pricing.sourceFallback")}</div>}
        {status.history && (!status.history.fetchedAt || status.history.error) && <div className="pricing-notice" role="status">{t(status.history.fetchedAt ? "usage.pricing.historyFallbackShort" : "usage.pricing.historyUnavailableShort")}</div>}
        {error && <div className="pricing-notice danger" role="alert">{errorMessage(error)}</div>}{saved && <div role="status" className="pricing-save-status">{t("usage.pricing.saved")}</div>}
      </div>
      <div className="pricing-table-heading"><span>{t("usage.pricing.rateLabel")}</span></div><div className="pricing-list-scroll"><table className="usage-table pricing-table"><thead><tr>{sortHeader("model", t("usage.pricing.model"))}{sortHeader("effective", t("usage.pricing.effective"))}{(["input", "output", "cacheRead", "cacheWrite"] as const).map(key => <Fragment key={key}>{sortHeader(key, t(`usage.pricing.${key}`))}</Fragment>)}<th /></tr></thead><tbody>
        {rows.slice((current - 1) * 20, current * 20).map(row => {
          const configured = status.configuration.mappings.find(value => value.model === row.model);
          const recorded = row.recorded || row.manual && (models.includes(row.model) || !!configured);
          const rowStatus = row.manual ? t("usage.pricing.manual") : row.resolution?.reason ? t(`usage.pricing.reason.${row.resolution.reason}`) : configured ? t("usage.pricing.mappingStatus") : row.price ? undefined : t("usage.pricing.unmatched");
          const target = row.manual ? row.provider ? t("usage.pricing.providerScope", { provider: row.provider }) : t("usage.pricing.globalScope") : configured ? `${configured.targetProvider} / ${configured.targetModel}` : row.price ? `${row.price.provider} / ${row.price.model}` : undefined;
          return <tr key={JSON.stringify([row.model, row.recorded ? "" : row.provider, !!row.recorded || row.manual])}><td><strong>{row.model}</strong></td><td>{rowStatus && <span className={row.resolution?.reason ? "usage-warning" : "pricing-row-status"}>{rowStatus}</span>}{target && <span className="pricing-row-target">{target}</span>}{row.price && <PriceDetails container={dialog} price={row.price} catalog />}</td>{(["input", "output", "cacheRead", "cacheWrite"] as const).map(key => <td key={key} className="usage-number">{row.price?.[key] === undefined ? "—" : number(row.price[key]!, { maximumFractionDigits: 6 })}</td>)}<td className="pricing-row-actions">
            <button className="text-button" disabled={saving} onClick={event => edit(row.recorded || row.manual ? row.model : row.price!.model, row.recorded ? "" : row.provider, event.currentTarget, row.price, row.manual)}>{t("usage.pricing.edit")}</button>
            {recorded && <button className="text-button" disabled={saving} onClick={event => editMapping(row.model, event.currentTarget, row.price, !!row.resolution?.candidates.length)}>{t("usage.pricing.editMap")}</button>}
            {configured && <button className="text-button" disabled={saving} onClick={() => void save({ ...status.configuration, mappings: status.configuration.mappings.filter(value => value.model !== row.model) })}>{t("usage.pricing.removeMap")}</button>}
            {row.manual && <button className="text-button" disabled={saving} onClick={() => void save({ ...status.configuration, overrides: status.configuration.overrides.filter(value => !sameOverride(value, row)) })}>{t("usage.pricing.restore")}</button>}
          </td></tr>;
        })}
      </tbody></table>{!rows.length && <div className="usage-empty">{t("usage.pricing.empty")}</div>}</div>
      <div className="pricing-pagination"><ResourcePagination label={t("usage.pricing.title")} page={current} total={rows.length} pageSize={20} onChange={setPage} /></div>
    </div>
    {editing && <form className="pricing-editor" onSubmit={draft ? savePrice : saveMapping}>
      <header className="pricing-editor-header"><button className="button" type="button" onClick={closeEditor} disabled={saving}><ArrowLeft size={16} aria-hidden="true" />{t("usage.pricing.back")}</button><h2 className="pricing-editor-title">{t(draft ? "usage.pricing.edit" : "usage.pricing.editMap")}<span aria-label={t("usage.pricing.editObject")}>{(draft?.model ?? mapping?.model)?.trim() || t(draft ? "usage.pricing.newModel" : "usage.pricing.newMapping")}</span></h2><div className="pricing-editor-actions"><HelpPopover label={t("usage.pricing.help")} container={dialog} iconOnly>{help}</HelpPopover><button className="button" type="button" onClick={closeEditor} disabled={saving}>{t("usage.pricing.cancel")}</button><button type="submit" className="button pricing-primary" disabled={saving || !!mapping && !mapping.target}>{t("usage.pricing.save")}</button></div></header>
      <div className="pricing-editor-body">
        {error && <div className="pricing-notice danger" role="alert">{errorMessage(error)}</div>}
        {draft && <>
          <div className="pricing-identity-fields"><label>{t("usage.pricing.model")}<input autoFocus value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} required /></label><label>{t("usage.pricing.provider")}<input value={draft.provider} onChange={event => setDraft({ ...draft, provider: event.target.value })} /></label></div>
          <p className="pricing-scope">{draft.provider.trim() ? t("usage.pricing.providerScope", { provider: draft.provider.trim() }) : t("usage.pricing.globalScope")}</p>
          <div className="pricing-rate-heading"><h3>{t("usage.pricing.rates")}</h3><span>{t("usage.pricing.rateLabel")}</span></div>
          <div className="pricing-rate-fields">{(["input", "output", "cacheRead", "cacheWrite"] as const).map(key => <label key={key}>{t(`usage.pricing.${key}`)}<input type="number" min="0" step="any" value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value })} required={key === "input" || key === "output"} placeholder={key === "input" || key === "output" ? undefined : t("usage.pricing.optional")} /></label>)}</div>
        </>}
        {mapping && <>
          <div className="pricing-mapping-fields"><label>{t("usage.pricing.model")}<input autoFocus value={mapping.model} required onChange={event => setMapping({ ...mapping, model: event.target.value, relatedOnly: false })} /></label><label>{t("usage.pricing.target")}<ProjectPicker value={mapping.target} label={t("usage.pricing.target")} options={mappingOptions} onChange={target => setMapping({ ...mapping, target })} container={dialog} modal /></label></div>
          <div className="pricing-mapping-feedback">{mappingResolution?.reason && <span className="usage-warning">{t(`usage.pricing.reason.${mappingResolution.reason}`)}</span>}{!!relatedTargets.size && <button className="text-button" type="button" aria-pressed={!!mapping.relatedOnly} onClick={() => setMapping({ ...mapping, relatedOnly: !mapping.relatedOnly })}>{t(mapping.relatedOnly ? "usage.pricing.allTargets" : "usage.pricing.relatedTargets", { count: relatedTargets.size })}</button>}</div>
        </>}
      </div>
    </form>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
