import { Loading } from "../../shared/ui/Loading";
import { useRef, useState, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowSquareOut, WarningCircle, X } from "@phosphor-icons/react";
import type { UsageRequestPage, UsageSessionRow } from "../../../src/usage-contracts";
import { errorMessage } from "../../shared/api";
import { useI18n } from "../../shared/i18n";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { ResourcePagination } from "../../shared/ui/ResourcePagination";
import { sessionDisplayTitle } from "../sessions/session-model";
import { TokenAmount } from "./TokenAmount";
import { PriceDetails } from "./PriceDetails";

export function UsageRequestDialog({ active, session, requests, loading, error, returnFocus, onClose, onPage, onRetry, onSession }: {
  active: boolean; session?: UsageSessionRow; requests: UsageRequestPage | null; loading: boolean; error: Error | null;
  returnFocus: RefObject<HTMLElement | null>; onClose: () => void; onPage: (page: number) => void;
  onRetry: () => void; onSession: (sessionId: string, messageId?: string) => void;
}) {
  const { t, number, dateTime, language } = useI18n();
  const title = useRef<HTMLHeadingElement>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const value = (amount: number | null | undefined, cost = false) => amount == null ? "—" : number(amount, cost
    ? { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: 2 } : {});
  return <Dialog.Root open={active && !!session} onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className="usage-dialog-overlay" />
      <Dialog.Content ref={setContainer} className="usage-request-dialog usage-request-section" aria-describedby={undefined}
        onOpenAutoFocus={event => { event.preventDefault(); title.current?.focus(); }}
        onCloseAutoFocus={event => { event.preventDefault(); if (active && returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); }}>
        <header className="usage-request-header"><div><Dialog.Title ref={title} tabIndex={-1}>{t("usage.sessions.requests")}</Dialog.Title>
          {session && <p>{sessionDisplayTitle(session.session, language)}</p>}</div>
          <div className="usage-request-actions"><HelpPopover container={container} label={t("usage.pricing.help")} iconOnly><p>{t("usage.help.cost")}</p>{session && <><p>{t("usage.coverage.cost", { complete: session.totals.pricedRequests, partial: session.totals.partiallyPricedRequests, missing: session.totals.unpricedRequests })}</p><p>{t("usage.coverage.priceBasis", { historical: session.totals.historicalPricedRequests, snapshot: session.totals.currentSnapshotPricedRequests, manual: session.totals.manualPricedRequests })}</p></>}</HelpPopover><Dialog.Close className="icon-button" aria-label={t("common.closeNamed", { label: t("usage.sessions.requests") })}><X size={20} /></Dialog.Close></div></header>
        <div className="usage-request-body">
          {loading && <div role="status" className="usage-loading"><Loading variant="inline" /><span>{t("usage.loading")}</span></div>}
          {error && <div role="alert" className="usage-notice danger">{errorMessage(error)}<button className="text-button" onClick={onRetry}>{t("usage.retry")}</button></div>}
          {requests && <div className="usage-table-scroll"><table className="usage-table usage-request-table"><thead><tr>
            <th>{t("usage.sessions.requestTime")}</th><th>{t("usage.sessions.model")}</th><th>{t("usage.tokens.input")}</th><th>{t("usage.tokens.output")}</th>
            <th>{t("usage.composition.cacheRead")}</th><th>{t("usage.composition.cacheWrite")}</th><th>{t("usage.metric.cost")}</th><th>{t("usage.pricing.effective")}</th><th aria-label={t("usage.sessions.open")} />
          </tr></thead><tbody>{requests.requests.map(item => <tr key={item.usage.id}>
            <td>{item.usage.occurredAt ? dateTime(item.usage.occurredAt) : t("common.timeUnknown")}</td><td>{item.usage.model ?? t("usage.unknown")}</td>
            <td className="usage-number"><TokenAmount value={item.usage.inputTokens} /></td><td className="usage-number"><TokenAmount value={item.usage.outputTokens} /></td>
            <td className="usage-number"><TokenAmount value={item.usage.cachedInputTokens} /></td><td className="usage-number"><TokenAmount value={item.usage.cacheWriteTokens} /></td>
            <td className="usage-number"><div className="usage-value-state">{value(item.cost.amount, true)}{item.cost.coverage !== "complete" && <HelpPopover container={container} label={t(item.cost.coverage === "partial" ? "usage.chart.partialCost" : "usage.chart.unpriced")}
              trigger={<button className="usage-state-trigger" aria-label={t(item.cost.coverage === "partial" ? "usage.chart.partialCost" : "usage.chart.unpriced")}><WarningCircle size={16} /></button>}>
              <p>{item.cost.reason === "price_missing" && item.cost.priceResolutionReason ? t(`usage.pricing.reason.${item.cost.priceResolutionReason}`) : item.cost.reason ? t(`usage.reason.${item.cost.reason}`) : t(`usage.${item.cost.coverage}`)}</p>
            </HelpPopover>}</div></td>
            <td className="usage-request-price">{item.cost.price ? <div className="usage-price-target"><span>{(item.cost.priceProvider ?? item.cost.price.provider) === "manual" ? t("usage.pricing.globalScope") : item.cost.priceProvider ?? item.cost.price.provider} / {item.cost.price.model}</span>
              <PriceDetails container={container} price={item.cost.price} cost={item.cost} threshold={item.cost.appliedContextThreshold} /></div> : "—"}</td>
            <td><button className="text-button" onClick={() => session && onSession(session.session.id, item.usage.messageId ?? item.usage.requestMessageIds?.[0])} title={!item.usage.messageId && !item.usage.requestMessageIds?.length ? t("usage.sessions.noLocator") : undefined}><ArrowSquareOut size={15} />{t("usage.sessions.open")}</button></td>
          </tr>)}</tbody></table>{!requests.requests.length && <div className="usage-empty">{t("usage.sessions.emptyRequests")}</div>}</div>}
        </div>
        {requests && <footer><ResourcePagination label={t("usage.sessions.requests")} page={requests.page} total={requests.total} pageSize={requests.pageSize} onChange={onPage} /></footer>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
