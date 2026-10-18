import { useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ArrowLeft, ArrowSquareOut, DotsThree, PencilSimple } from "@phosphor-icons/react";
import { diffLines } from "diff";
import type { KnowledgeDetail as Detail, KnowledgeRevision, KnowledgeSource } from "../../../src/knowledge-contracts";
import { isMessageDescriptorKnown, useI18n } from "../../shared/i18n";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { knowledgeRequest } from "./knowledge-api";
import { knowledgeTypeKey, sourceAddress } from "./knowledge-model";
import { KnowledgeBusy, KnowledgeDialog, KnowledgeError, KnowledgeLimitations, KnowledgeMarkdown, KnowledgeTabs } from "./KnowledgeCommon";

export function KnowledgeSources({ sources, disabled = false }: { sources: KnowledgeSource[]; disabled?: boolean }) {
  const { t } = useI18n();
  if (!sources.length) return <p className="knowledge-empty-inline">{t("knowledge.noSources")}</p>;
  return <div className="knowledge-sources">{sources.map((source, index) => { const address = sourceAddress(source); return <article key={`${source.sessionId ?? source.kind}:${source.branch ?? ""}:${source.messageId ?? index}`}>
    <div className="knowledge-source-heading"><strong>{source.sessionTitle || t(`knowledge.source.${source.kind}`)}</strong>{address && <a className="button subtle" href={disabled ? undefined : address} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined}>{t("knowledge.original")}<ArrowSquareOut size={14} aria-hidden="true" /></a>}</div>
    <div className="knowledge-meta">{source.client && <span>{source.client}</span>}{source.turnPosition !== undefined && <span>{t("knowledge.sourceTurn", { turn: source.turnPosition })}</span>}{source.status && <span className={source.status === "available" ? "" : "knowledge-warning"}>{t(`knowledge.source.${source.status}`)}</span>}</div>
    {source.excerpt && <details className="knowledge-details"><summary>{t("knowledge.excerpt")}</summary><blockquote>{source.excerpt}</blockquote></details>}{(source.limitation || source.limitationDetails?.length) && <div className="knowledge-warning"><KnowledgeLimitations details={source.limitationDetails} originals={!source.limitationDetails?.length && source.limitation ? [source.limitation] : []} /></div>}
  </article>; })}</div>;
}

function RevisionBody({ revision }: { revision: KnowledgeRevision }) {
  const { t, date } = useI18n();
  return <><div className="knowledge-tags">{revision.tags?.map(tag => <span key={tag}>{tag}</span>)}</div>{revision.applicability && <section className="knowledge-applicability"><h3>{t("knowledge.applicability")}</h3><p>{revision.applicability}</p></section>}<KnowledgeMarkdown body={revision.body} />{(revision.validUntil || revision.occurredAt) && <dl className="knowledge-facts">{revision.validUntil && <div><dt>{t("knowledge.validUntil")}</dt><dd>{date(revision.validUntil)}</dd></div>}{revision.occurredAt && <div><dt>{t("knowledge.occurredAt")}</dt><dd>{date(revision.occurredAt)}</dd></div>}</dl>}</>;
}

export function KnowledgeDetail({ detail, reviewing, busy: loading, onEdit, onChanged, onBack }: { detail: Detail; reviewing: boolean; busy: boolean; onEdit: () => void; onChanged: (detail: Detail) => void; onBack: () => void }) {
  const { t, dateTime } = useI18n();
  const [tab, setTab] = useState("body"), [versionId, setVersionId] = useState<string>();
  const [mobileCompare, setMobileCompare] = useState("new");
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const [confirm, setConfirm] = useState<"approve" | "reject" | "deprecate" | "reactivate" | "restore">();
  const [reason, setReason] = useState("");
  const active = detail.revisions.find(revision => revision.id === versionId) ?? detail.revision;
  const pending = detail.pendingRevision ?? (detail.revision.review === "pending" ? detail.revision : undefined);
  const baseline = detail.revisions.find(revision => revision.id === detail.publishedRevisionId);
  const source = (reviewing ? pending : active)?.sources?.find(item => sourceAddress(item));
  const address = source && sourceAddress(source);
  const perform = async () => {
    if (!confirm) return;
    setBusy(true); setError(undefined);
    try {
      const path = `/entries/${encodeURIComponent(detail.id)}`;
      const next = confirm === "approve" || confirm === "reject" ? await knowledgeRequest<Detail>(`${path}/reviews`, { revisionId: pending!.id, baseRevisionId: detail.latestRevisionId, action: confirm, reason: reason || undefined })
        : confirm === "restore" ? await knowledgeRequest<Detail>(`${path}/restore`, { revisionId: active.id, baseRevisionId: detail.latestRevisionId, idempotencyKey: crypto.randomUUID() })
        : await knowledgeRequest<Detail>(`${path}/availability`, { availability: confirm === "deprecate" ? "deprecated" : "active", reason: reason || undefined });
      setConfirm(undefined); setReason(""); setVersionId(undefined); onChanged(next);
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  };
  const changes = diffLines(baseline?.body ?? "", pending?.body ?? "");
  const metadata = (revision: KnowledgeRevision | undefined) => ({ titleLabel: revision?.title, summary: revision?.summary, type: revision?.type ? t(`knowledge.type.${revision.type}`) : undefined, scope: revision?.scope.project ?? (revision ? t("knowledge.scope.global") : undefined), subject: revision?.subject ? t(`knowledge.view.${revision.subject}`) : undefined, tag: revision?.tags?.join(", "), applicability: revision?.applicability, validUntil: revision?.validUntil, occurredAt: revision?.occurredAt, language: revision?.language, resolved: revision?.resolved ? t("knowledge.resolved") : undefined });
  const beforeMetadata = metadata(baseline), afterMetadata = metadata(pending);
  const changedFields = Object.keys(afterMetadata).filter(key => beforeMetadata[key as keyof typeof beforeMetadata] !== afterMetadata[key as keyof typeof afterMetadata]);
  const metadataChanges = (kind: "old" | "new") => <dl className="knowledge-review-fields">{changedFields.map(key => <div key={key} className={`knowledge-diff ${kind === "old" ? "removed" : "added"}`}><dt>{t(`knowledge.${key}`)}</dt><dd>{(kind === "old" ? beforeMetadata : afterMetadata)[key as keyof typeof afterMetadata] || "—"}</dd></div>)}</dl>;
  const confirmTitle = confirm === "approve" ? "publishTitle" : confirm === "reject" ? "rejectTitle" : confirm === "restore" ? "restoreTitle" : confirm === "reactivate" ? "reactivate" : "deprecate";
  return <section className={`knowledge-reader${reviewing ? " is-review" : ""}`} aria-busy={loading || busy}>
    <header className="knowledge-reader-heading"><button className="icon-button knowledge-mobile-back" aria-label={t("knowledge.back")} onClick={onBack}><ArrowLeft size={18} /></button><div><h1>{reviewing ? t("knowledge.reviewTitle") : active.title}</h1><p className="knowledge-meta"><span>{t(knowledgeTypeKey(active.type))}</span>{active.scope.project && <span title={active.scope.project}>{active.scope.project.split(/[\\/]/).filter(Boolean).at(-1)}</span>}<span>{t(`knowledge.review.${active.review}`)}</span><span>{t("knowledge.version", { version: active.version })}</span>{detail.availability !== "active" && <span className="knowledge-warning">{t(`knowledge.availability.${detail.availability}`)}</span>}</p></div><KnowledgeBusy busy={loading || busy} />
      <div className="knowledge-reader-actions">{!reviewing && <button className="button" disabled={loading || busy} onClick={onEdit}><PencilSimple size={15} />{t("knowledge.edit")}</button>}{address && <a className="button subtle" href={loading || busy ? undefined : address} aria-disabled={loading || busy || undefined} tabIndex={loading || busy ? -1 : undefined}>{t("knowledge.original")}<ArrowSquareOut size={14} /></a>}<Dropdown.Root><Dropdown.Trigger className="icon-button" disabled={loading || busy} aria-label={t("knowledge.more")}><DotsThree size={20} /></Dropdown.Trigger><Dropdown.Portal><Dropdown.Content className="filter-menu" align="end" sideOffset={6} collisionPadding={12}><Dropdown.Item className="filter-option" onSelect={() => setConfirm(detail.availability === "deprecated" ? "reactivate" : "deprecate")}>{t(detail.availability === "deprecated" ? "knowledge.reactivate" : "knowledge.deprecate")}</Dropdown.Item></Dropdown.Content></Dropdown.Portal></Dropdown.Root></div>
    </header>
    <KnowledgeError error={error} />
    {reviewing ? pending ? <>
      <div className="knowledge-review-heading"><h2>{pending.title}</h2><HelpPopover label={t("knowledge.reviewHelp")} iconOnly><p>{t("knowledge.reviewHelpBody")}</p></HelpPopover></div>
      <div className="knowledge-mobile-comparison"><KnowledgeTabs label={t("knowledge.reviewTitle")} value={mobileCompare} onChange={setMobileCompare} options={[{ value: "old", label: t("knowledge.currentVersion") }, { value: "new", label: t("knowledge.proposedVersion") }]} /></div>
      <div className={`knowledge-comparison show-${mobileCompare}`}><section className="knowledge-compare-old"><header><strong>{t("knowledge.currentVersion")}</strong>{baseline && <span>{t("knowledge.version", { version: baseline.version })}</span>}</header>{baseline ? <div>{metadataChanges("old")}{changes.filter(change => !change.added).map((change, index) => <div className={change.removed ? "knowledge-diff removed" : "knowledge-diff"} key={index}>{change.removed && <span className="knowledge-diff-label">− {t("knowledge.removed")}</span>}<KnowledgeMarkdown body={change.value} /></div>)}</div> : <p className="knowledge-empty-inline">{t("knowledge.noBaseline")}</p>}</section>
      <section className="knowledge-compare-new"><header><strong>{t("knowledge.proposedVersion")}</strong><span>{t("knowledge.version", { version: pending.version })}</span></header><div>{metadataChanges("new")}{changes.filter(change => !change.removed).map((change, index) => <div className={change.added ? "knowledge-diff added" : "knowledge-diff"} key={index}>{change.added && <span className="knowledge-diff-label">+ {t("knowledge.added")}</span>}<KnowledgeMarkdown body={change.value} /></div>)}</div></section></div>
      <details className="knowledge-details knowledge-review-metadata"><summary>{t("knowledge.snapshot")}</summary><dl className="knowledge-facts"><div><dt>{t("knowledge.scope")}</dt><dd>{pending.scope.project ?? t("knowledge.scope.global")}</dd></div><div><dt>{t("knowledge.tagsInput")}</dt><dd>{pending.tags?.join(", ") || "—"}</dd></div><div><dt>{t("knowledge.applicability")}</dt><dd>{pending.applicability || "—"}</dd></div><div><dt>{t("knowledge.validUntil")}</dt><dd>{pending.validUntil || "—"}</dd></div><div><dt>{t("knowledge.reason")}</dt><dd>{pending.changeReason || "—"}</dd></div></dl></details>
      <KnowledgeSources sources={pending.sources ?? []} disabled={loading || busy} />
      <footer className="knowledge-review-footer"><button className="text-button" disabled={busy || loading} onClick={() => setConfirm("reject")}>{t("knowledge.reject")}</button><span /><button className="button" disabled={busy || loading} onClick={onEdit}>{t("knowledge.editSuggestion")}</button><button className="button primary" disabled={busy || loading} onClick={() => setConfirm("approve")}>{t("knowledge.approve")}</button></footer>
    </> : <p className="knowledge-empty-inline">{t("knowledge.noPending")}</p> : <>
      {pending && pending.id !== active.id && <button className="knowledge-pending-link" onClick={() => { location.hash = `#knowledge?${new URLSearchParams({ page: "review", id: detail.id, review: "pending" })}`; }}>{t("knowledge.reviewAction")}<ArrowSquareOut size={15} /></button>}
      <KnowledgeTabs label={t("knowledge.title")} value={tab} onChange={setTab} options={["body", "sources", "versions"].map(value => ({ value, label: t(`knowledge.${value}`) }))} />
      <div role="tabpanel">{tab === "body" ? <RevisionBody revision={active} /> : tab === "sources" ? <KnowledgeSources sources={active.sources ?? []} disabled={loading || busy} /> : <>
        <div className="knowledge-history-layout"><ol className="knowledge-revisions">{[...detail.revisions].sort((a, b) => b.version - a.version).map(revision => <li key={revision.id}><button aria-current={revision.id === active.id ? "true" : undefined} disabled={loading || busy} onClick={() => setVersionId(revision.id)}><strong>{t("knowledge.version", { version: revision.version })}</strong><span>{t(`knowledge.review.${revision.review}`)}</span><time>{dateTime(revision.createdAt)}</time>{revision.author && <span>{revision.author}</span>}{revision.changeReason && <span>{revision.changeReason}</span>}</button></li>)}</ol><section className="knowledge-history-snapshot"><header><h3>{active.title}</h3><button className="button" disabled={busy || loading} onClick={() => setConfirm("restore")}>{t("knowledge.restore")}</button></header><RevisionBody revision={active} />{active.id !== detail.revision.id && <details className="knowledge-details"><summary>{t("knowledge.compareCurrent")}</summary><div className="knowledge-revision-diff">{diffLines(active.body, detail.revision.body).map((change, index) => <div key={index} className={`knowledge-diff${change.added ? " added" : change.removed ? " removed" : ""}`}>{(change.added || change.removed) && <span className="knowledge-diff-label">{change.added ? "+ " : "− "}{t(change.added ? "knowledge.added" : "knowledge.removed")}</span>}<KnowledgeMarkdown body={change.value} /></div>)}</div></details>}</section></div>
        <details className="knowledge-details"><summary>{t("knowledge.audit")}</summary><ol className="knowledge-audit">{detail.audit.map(item => <li key={item.id}><time>{dateTime(item.createdAt)}</time><span>{isMessageDescriptorKnown({ key: `knowledge.audit.${item.action}` }) ? t(`knowledge.audit.${item.action}`) : item.action}</span>{item.reason && <p>{item.reason}</p>}</li>)}</ol></details>
      </>}</div>
    </>}
    {confirm && <KnowledgeDialog open title={t(`knowledge.${confirmTitle}`)} description={t(confirm === "approve" ? "knowledge.publishHelp" : confirm === "restore" ? "knowledge.restoreHelp" : confirm === "reject" ? "knowledge.reviewHelpBody" : "knowledge.availabilityHelp")} onClose={() => { if (!busy) setConfirm(undefined); }} footer={<><KnowledgeBusy busy={busy} /><KnowledgeError error={error} /><button className="button" disabled={busy} onClick={() => setConfirm(undefined)}>{t("knowledge.cancel")}</button><button className="button primary" disabled={busy} onClick={() => void perform()}>{t(confirm === "approve" ? "knowledge.approve" : "knowledge.confirm")}</button></>}><strong>{(pending ?? active).title}</strong>{confirm !== "restore" && <label className="knowledge-field"><span>{t("knowledge.reason")}</span><textarea rows={3} value={reason} onChange={event => setReason(event.target.value)} /></label>}</KnowledgeDialog>}
  </section>;
}
