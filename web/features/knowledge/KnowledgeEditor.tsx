import { useRef, useState } from "react";
import type { KnowledgeDetail, KnowledgeDraft, KnowledgeLanguage, KnowledgeType } from "../../../src/knowledge-contracts";
import { knowledgeTypes } from "../../../src/knowledge-contracts";
import { useI18n } from "../../shared/i18n";
import { DatePicker } from "../../shared/ui/DatePicker";
import { FilterSelect } from "../../shared/ui/FilterSelect";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { ProjectPicker } from "../../shared/ui/ProjectPicker";
import { ApiError } from "../../shared/api";
import { knowledgeRequest } from "./knowledge-api";
import { knowledgeTypeKey, editableDraft, emptyDraft } from "./knowledge-model";
import { KnowledgeBusy, KnowledgeDialog, KnowledgeError, KnowledgeMarkdown } from "./KnowledgeCommon";

export function KnowledgeEditor({ detail, projects, onClose, onSaved }: { detail?: KnowledgeDetail; projects: string[]; onClose: () => void; onSaved: (detail: KnowledgeDetail) => void }) {
  const { t, language } = useI18n();
  const initial = detail ? editableDraft(detail) : emptyDraft(language);
  const [draft, setDraft] = useState<KnowledgeDraft>(initial);
  const [tags, setTags] = useState(initial.tags?.join(", ") ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const [publish, setPublish] = useState(false), [discard, setDiscard] = useState(false);
  const [baseRevisionId, setBaseRevisionId] = useState(detail?.latestRevisionId);
  const [latest, setLatest] = useState<KnowledgeDetail>();
  const retryKey = useRef({ payload: "", key: "" });
  const [savedPending, setSavedPending] = useState<KnowledgeDetail>();
  const [preview, setPreview] = useState(false);
  const changed = JSON.stringify(draft) !== JSON.stringify(initial) || tags !== (initial.tags?.join(", ") ?? "");
  const close = () => { if (busy) return; if (changed && !savedPending) setDiscard(true); else onClose(); };
  const change = <K extends keyof KnowledgeDraft>(key: K, value: KnowledgeDraft[K]) => { setDraft(current => ({ ...current, [key]: value })); setSavedPending(undefined); };
  const submit = async (approve: boolean) => {
    setBusy(true); setError(undefined);
    try {
      const payload = JSON.stringify({ ...draft, tags, baseRevisionId });
      if (retryKey.current.payload !== payload) retryKey.current = { payload, key: crypto.randomUUID() };
      const input = { ...draft, tags: [...new Set(tags.split(/[,，]/).map(value => value.trim()).filter(Boolean))], idempotencyKey: retryKey.current.key };
      const saved = savedPending ?? await knowledgeRequest<KnowledgeDetail>(detail ? `/entries/${encodeURIComponent(detail.id)}/revisions` : "/entries", detail ? { ...input, baseRevisionId } : input);
      setSavedPending(saved);
      if (approve) {
        const published = await knowledgeRequest<KnowledgeDetail>(`/entries/${encodeURIComponent(saved.id)}/reviews`, { revisionId: saved.latestRevisionId, action: "approve", baseRevisionId: saved.latestRevisionId });
        onSaved(published);
      } else onSaved(saved);
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  };
  const valid = Boolean(draft.title.trim() && draft.body.trim() && (draft.scope.kind !== "project" || draft.scope.project));
  return <>
    <KnowledgeDialog open title={t(detail ? "knowledge.edit" : "knowledge.new")} onClose={close} wide footer={<><KnowledgeBusy busy={busy} /><KnowledgeError error={error} /><button className="button subtle" disabled={busy} onClick={close}>{t("knowledge.cancel")}</button><button className="button" disabled={busy || !valid} onClick={() => void submit(false)}>{t("knowledge.savePending")}</button><button className="button primary" disabled={busy || !valid} onClick={() => setPublish(true)}>{t("knowledge.savePublish")}</button></>}>
      {detail && error instanceof ApiError && ["CONFLICT", "CONTENT_STALE"].includes(error.code) && <div className="knowledge-conflict"><button className="button" disabled={busy} onClick={() => { setBusy(true); void knowledgeRequest<KnowledgeDetail>(`/entries/${encodeURIComponent(detail.id)}?review=all&availability=all`).then(value => { setLatest(value); setBaseRevisionId(value.latestRevisionId); setSavedPending(undefined); setError(undefined); }).catch(setError).finally(() => setBusy(false)); }}>{t("knowledge.reloadLatest")}</button></div>}
      {latest && <details className="knowledge-details" open><summary>{t("knowledge.latestSnapshot")}</summary><KnowledgeMarkdown body={(latest.pendingRevision ?? latest.revision).body} /></details>}
      <fieldset disabled={busy || !!savedPending} className="knowledge-editor-fields">
        <div className="knowledge-form-heading"><label className="knowledge-field knowledge-wide"><span>{t("knowledge.titleLabel")}</span><input required value={draft.title} onChange={event => change("title", event.target.value)} /></label><HelpPopover label={t("knowledge.editorHelp")} iconOnly><p>{t("knowledge.saveHelp")}</p></HelpPopover></div>
        <div className="knowledge-form-grid">
          <label className="knowledge-field"><span>{t("knowledge.type")}</span><FilterSelect label={t("knowledge.type")} value={draft.type ?? "unclassified"} options={[{ value: "unclassified", label: t(knowledgeTypeKey()) }, ...knowledgeTypes.map(value => ({ value, label: t(knowledgeTypeKey(value)) }))]} onChange={value => { setDraft(current => ({ ...current, type: value === "unclassified" ? undefined : value as KnowledgeType, resolved: value === "open_question" ? current.resolved : false })); setSavedPending(undefined); }} /></label>
          <label className="knowledge-field"><span>{t("knowledge.subject")}</span><FilterSelect label={t("knowledge.subject")} value={draft.subject ?? "general"} options={["personal", "project", "general"].map(value => ({ value, label: t(`knowledge.view.${value}`) }))} onChange={value => change("subject", value as KnowledgeDraft["subject"])} /></label>
          <label className="knowledge-field"><span>{t("knowledge.scope")}</span><FilterSelect label={t("knowledge.scope")} value={draft.scope.kind} options={["global", "project"].map(value => ({ value, label: t(`knowledge.scope.${value}`) }))} onChange={kind => change("scope", kind === "project" ? { kind, project: draft.scope.project ?? projects[0] } : { kind: "global" })} /></label>
          {draft.scope.kind === "project" && <label className="knowledge-field"><span>{t("knowledge.project")}</span><ProjectPicker label={t("knowledge.project")} value={draft.scope.project ?? ""} options={projects.map(value => ({ value, label: value.split(/[\\/]/).filter(Boolean).at(-1) ?? value, description: value }))} onChange={project => change("scope", { kind: "project", project })} /><input aria-label={t("knowledge.project")} value={draft.scope.project ?? ""} onChange={event => change("scope", { kind: "project", project: event.target.value })} /></label>}
          <label className="knowledge-field"><span>{t("knowledge.language")}</span><FilterSelect label={t("knowledge.language")} value={draft.language ?? language} options={[{ value: "zh-CN", label: "简体中文" }, { value: "en", label: "English" }]} onChange={value => change("language", value as KnowledgeLanguage)} /></label>
        </div>
        <label className="knowledge-field"><span>{t("knowledge.tagsInput")}</span><input value={tags} onChange={event => { setTags(event.target.value); setSavedPending(undefined); }} /></label>
        <div className="knowledge-form-heading"><label htmlFor="knowledge-body">{t("knowledge.body")}</label><button type="button" className="text-button" onClick={() => setPreview(value => !value)} aria-pressed={preview}>{t(preview ? "knowledge.edit" : "knowledge.preview")}</button></div>
        {preview ? <KnowledgeMarkdown body={draft.body} /> : <textarea id="knowledge-body" required className="knowledge-body-input" value={draft.body} onChange={event => change("body", event.target.value)} />}
        <details className="knowledge-details"><summary>{t("knowledge.more")}</summary><div className="knowledge-form-stack">
          <label className="knowledge-field"><span>{t("knowledge.summary")}</span><textarea rows={2} value={draft.summary ?? ""} onChange={event => change("summary", event.target.value)} /></label>
          <label className="knowledge-field"><span>{t("knowledge.applicability")}</span><textarea rows={2} value={draft.applicability ?? ""} onChange={event => change("applicability", event.target.value)} /></label>
          <div className="knowledge-form-grid"><label className="knowledge-field"><span>{t("knowledge.validUntil")}</span><DatePicker label={t("knowledge.validUntil")} value={draft.validUntil?.slice(0, 10) ?? ""} onChange={value => change("validUntil", value || undefined)} /></label>{draft.type === "event" && <label className="knowledge-field"><span>{t("knowledge.occurredAt")}</span><DatePicker label={t("knowledge.occurredAt")} value={draft.occurredAt?.slice(0, 10) ?? ""} onChange={value => change("occurredAt", value || undefined)} /></label>}</div>
          {draft.type === "open_question" && <label className="knowledge-check"><input type="checkbox" checked={draft.resolved ?? false} onChange={event => change("resolved", event.target.checked)} />{t("knowledge.resolved")}</label>}
          <label className="knowledge-field"><span>{t("knowledge.reason")}</span><input value={draft.changeReason ?? ""} onChange={event => change("changeReason", event.target.value)} /></label>
        </div></details>
      </fieldset>
    </KnowledgeDialog>
    {publish && <KnowledgeDialog open title={t("knowledge.publishTitle")} description={t("knowledge.publishHelp")} onClose={() => setPublish(false)} footer={<><button className="button" disabled={busy} onClick={() => setPublish(false)}>{t("knowledge.cancel")}</button><button className="button primary" disabled={busy} onClick={() => { setPublish(false); void submit(true); }}>{t("knowledge.approve")}</button></>}><strong>{draft.title}</strong></KnowledgeDialog>}
    {discard && <KnowledgeDialog open title={t("knowledge.discard")} description={t("knowledge.unsaved")} onClose={() => setDiscard(false)} footer={<><button className="button" onClick={() => setDiscard(false)}>{t("knowledge.cancel")}</button><button className="button" onClick={onClose}>{t("knowledge.discard")}</button></>}><strong>{draft.title}</strong></KnowledgeDialog>}
  </>;
}
