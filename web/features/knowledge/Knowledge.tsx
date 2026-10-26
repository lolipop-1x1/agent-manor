import { useEffect, useRef, useState, type FormEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowClockwise, BookOpen, FunnelSimple, GearSix, Globe, List, MagnifyingGlass, Plus, User, FolderSimple, X } from "@phosphor-icons/react";
import type { KnowledgeDetail as Detail, KnowledgeEntry, KnowledgeExtractionScope, KnowledgeFacets, KnowledgeIndexStatus, KnowledgeList, KnowledgeQuery, KnowledgeType } from "../../../src/knowledge-contracts";
import { knowledgeTypes } from "../../../src/knowledge-contracts";
import { isAborted } from "../../shared/api";
import { useI18n } from "../../shared/i18n";
import { FilterSelect } from "../../shared/ui/FilterSelect";
import { Hint } from "../../shared/ui/Hint";
import { DatePicker } from "../../shared/ui/DatePicker";
import { ProjectPicker } from "../../shared/ui/ProjectPicker";
import { ResourcePagination } from "../../shared/ui/ResourcePagination";
import { Loading } from "../../shared/ui/Loading";
import { LoadingSkeleton } from "../../shared/ui/LoadingSkeleton";
import { SelectionIndicator } from "../../shared/ui/SelectionIndicator";
import { KnowledgeBusy, KnowledgeError } from "./KnowledgeCommon";
import { KnowledgeDetail } from "./KnowledgeDetail";
import { KnowledgeEditor } from "./KnowledgeEditor";
import { KnowledgeTasks } from "./KnowledgeTasks";
import { KnowledgeSplit, KnowledgeWorkspace } from "./KnowledgeSplit";
import { KnowledgeSettings } from "./KnowledgeSettings";
import { knowledgeRequest } from "./knowledge-api";
import { knowledgeCollectionAddress, knowledgeCollectionQuery, knowledgeTypeKey, readKnowledgeAddress, type KnowledgeCollection, type KnowledgePage } from "./knowledge-model";
import "./knowledge.css";

const viewIcons = { all: BookOpen, personal: User, project: FolderSimple, general: Globe };
export default function Knowledge({ active }: { active: boolean }) {
  const { t, date } = useI18n();
  const initial = useRef(readKnowledgeAddress(location.hash)).current;
  const [page, setPage] = useState<KnowledgePage>(initial.page), [query, setQuery] = useState<KnowledgeQuery>(initial.query);
  const [input, setInput] = useState(initial.query.q ?? ""), [mode, setMode] = useState<"keyword" | "semantic">(initial.mode);
  const [list, setList] = useState<KnowledgeList>(), [facets, setFacets] = useState<KnowledgeFacets>({ projects: [], clients: [], tags: [] });
  const [selectedId, setSelectedId] = useState<string | undefined>(initial.id), [detail, setDetail] = useState<Detail>();
  const [listBusy, setListBusy] = useState(false), [detailBusy, setDetailBusy] = useState(false);
  const [listError, setListError] = useState<unknown>(), [detailError, setDetailError] = useState<unknown>();
  const [reload, setReload] = useState(0), [editing, setEditing] = useState<"new" | "edit">();
  const [scope, setScope] = useState<KnowledgeExtractionScope | undefined>(initial.scope);
  const [selection, setSelection] = useState(initial.selection), [taskId, setTaskId] = useState(initial.taskId);
  const [newEntry, setNewEntry] = useState(0);
  const [railOpen, setRailOpen] = useState(false), [more, setMore] = useState(false), [mobileReader, setMobileReader] = useState(!!initial.id);
  const [index, setIndex] = useState<KnowledgeIndexStatus>();
  const listScroll = useRef<HTMLDivElement>(null);
  const ownHash = useRef<string | undefined>(undefined);
  const preserveScroll = useRef(0);
  const initialTarget = useRef(Boolean(initial.id));
  const currentSelection = useRef(selectedId); currentSelection.current = selectedId;
  const reviewReturn = useRef<{ query: KnowledgeQuery; input: string; mode: "keyword" | "semantic"; id?: string; scroll: number } | undefined>(undefined);
  const writeAddress = (hash: string) => { if (location.hash !== hash) { ownHash.current = hash; location.hash = hash; } };
  useEffect(() => {
    const navigate = (event: HashChangeEvent) => {
      const hash = new URL(event.newURL).hash;
      if (hash !== location.hash) return;
      if (ownHash.current === hash) { ownHash.current = undefined; return; }
      ownHash.current = undefined; reviewReturn.current = undefined;
      if (!hash.startsWith("#knowledge")) return;
      const next = readKnowledgeAddress(hash);
      setPage(next.page); setTaskId(next.taskId); if (next.page === "new") { setScope(next.scope); setSelection(next.selection); setNewEntry(value => value + 1); }
      if (next.page === "review" || next.page === "library") {
        initialTarget.current = Boolean(next.id); setSelectedId(next.id); setMobileReader(Boolean(next.id));
        setQuery(next.query); setInput(next.query.q ?? ""); setMode(next.mode);
      }
      setRailOpen(false);
    };
    globalThis.addEventListener("hashchange", navigate); return () => globalThis.removeEventListener("hashchange", navigate);
  }, []);
  const navigate = (next: KnowledgePage, options: { id?: string; taskId?: string; fresh?: boolean; query?: KnowledgeQuery } = {}) => {
    let addressQuery = options.query, addressId = options.id, addressMode = mode, restoredSelection = false;
    if (next === "review" && page !== "review") reviewReturn.current = { query, input, mode, id: selectedId, scroll: listScroll.current?.scrollTop ?? preserveScroll.current };
    if (next === "library" && !options.fresh && reviewReturn.current) {
      const previous = reviewReturn.current; setQuery(previous.query); addressQuery = previous.query; addressId = previous.id; addressMode = previous.mode; restoredSelection = true; setInput(previous.input); setMode(previous.mode); setSelectedId(previous.id); preserveScroll.current = previous.scroll; reviewReturn.current = undefined;
    } else if (next === "library" && page === "review" && !options.query) {
      addressQuery = knowledgeCollectionQuery({}, "all"); setQuery(addressQuery); setInput("");
    }
    if (options.fresh) reviewReturn.current = undefined;
    setPage(next); setTaskId(options.taskId); setRailOpen(false);
    if (next === "new") { setScope(undefined); setSelection(undefined); setNewEntry(value => value + 1); }
    const params = new URLSearchParams(); if (next !== "library") params.set("page", next);
    if (options.id) params.set("id", options.id);
    if (next === "review") params.set("review", "pending");
    if (options.taskId) params.set("taskId", options.taskId);
    const hash = next === "library" || next === "review" ? knowledgeCollectionAddress(next, addressQuery ?? query, addressId ?? (restoredSelection || options.fresh || options.query ? undefined : selectedId), addressMode) : `#knowledge?${params}`;
    writeAddress(hash);
  };
  const changeQuery = (patch: Partial<KnowledgeQuery>) => {
    initialTarget.current = false; preserveScroll.current = 0;
    const next = { ...query, ...patch, page: patch.page ?? 1 }; setQuery(next);
    const addressId = new URLSearchParams(location.hash.split("?")[1]).has("id") ? selectedId : undefined;
    if (page === "library" || page === "review") writeAddress(knowledgeCollectionAddress(page, next, addressId, mode));
  };
  const openCollection = (collection: KnowledgeCollection, project?: string) => {
    const nextQuery = knowledgeCollectionQuery(query, collection, project);
    initialTarget.current = false; preserveScroll.current = 0; setQuery(nextQuery); setMobileReader(false); navigate(collection === "review" ? "review" : "library", { fresh: collection !== "review", query: nextQuery });
  };
  useEffect(() => {
    if (!active || page === "settings" || page === "tasks" || page === "new") return;
    const controller = new AbortController();
    void knowledgeRequest<KnowledgeFacets>("/facets", undefined, undefined, controller.signal).then(setFacets).catch(failure => { if (!isAborted(failure)) setListError(failure); });
    void knowledgeRequest<KnowledgeIndexStatus>("/index/status", undefined, undefined, controller.signal).then(setIndex).catch(failure => { if (!isAborted(failure)) setListError(failure); });
    return () => controller.abort();
  }, [active, page, reload]);
  useEffect(() => {
    if (!active || page === "settings" || page === "tasks" || page === "new") return;
    const controller = new AbortController(); setListBusy(true); setListError(undefined);
    const nextQuery = { ...query, ...(page === "review" ? { review: "pending" as const, availability: "all" as const } : {}) };
    const params = new URLSearchParams(); for (const [key, value] of Object.entries(nextQuery)) if (value !== undefined && value !== "") params.set(key, String(value));
    const operation = mode === "semantic" && nextQuery.q?.trim() ? knowledgeRequest<KnowledgeList>("/search", { mode, ...nextQuery }, "POST", controller.signal) : knowledgeRequest<KnowledgeList>(`/entries?${params}`, undefined, undefined, controller.signal);
    void operation.then(next => {
      if (controller.signal.aborted) return;
      const lastPage = Math.max(1, Math.ceil(next.total / next.pageSize));
      if (next.page > lastPage) {
        const corrected = { ...nextQuery, page: lastPage };
        setQuery(corrected);
        const addressId = new URLSearchParams(location.hash.split("?")[1]).has("id") ? currentSelection.current : undefined;
        history.replaceState(history.state, "", knowledgeCollectionAddress(page, corrected, addressId, mode));
        return;
      }
      const current = currentSelection.current;
      const nextId = current && (initialTarget.current || next.items.some(entry => entry.id === current)) ? current : next.items[0]?.id;
      setList(next); setSelectedId(nextId);
      // 审阅或筛选使显式选中项退出结果时，刷新地址不能继续指向旧条目。
      if (new URLSearchParams(location.hash.split("?")[1]).has("id")) history.replaceState(history.state, "", knowledgeCollectionAddress(page, nextQuery, nextId, mode));
      initialTarget.current = false;
      if (listScroll.current) listScroll.current.scrollTop = preserveScroll.current;
    }).catch(failure => { if (!isAborted(failure)) setListError(failure); }).finally(() => { if (!controller.signal.aborted) setListBusy(false); });
    return () => controller.abort();
  }, [active, page, query, reload, mode]);
  const selectedRevisionId = list?.items.find(entry => entry.id === selectedId)?.revision.id;
  useEffect(() => {
    if (!active || !selectedId || page === "settings" || page === "tasks" || page === "new") return;
    const controller = new AbortController(); setDetailBusy(true); setDetailError(undefined);
    void knowledgeRequest<Detail>(`/entries/${encodeURIComponent(selectedId)}?review=all&availability=all${selectedRevisionId ? `&revisionId=${encodeURIComponent(selectedRevisionId)}` : ""}`, undefined, undefined, controller.signal).then(next => { if (!controller.signal.aborted) setDetail(next); }).catch(failure => { if (!isAborted(failure)) setDetailError(failure); }).finally(() => { if (!controller.signal.aborted) setDetailBusy(false); });
    return () => controller.abort();
  }, [active, page, selectedId, selectedRevisionId, reload]);
  const update = (next: Detail) => { setDetail(next); setSelectedId(next.id); setEditing(undefined); setReload(value => value + 1); };
  const search = (event: FormEvent) => { event.preventDefault(); if (mode === "semantic" && index?.status !== "ready") { setListError(new Error(t("knowledge.semanticUnavailable"))); return; } changeQuery({ q: input.trim() }); };
  const rawDetail = detail?.id === selectedId ? detail : undefined;
  const visibleRevision = page !== "review" && query.review === "reviewed" && rawDetail?.publishedRevisionId ? rawDetail.revisions.find(revision => revision.id === rawDetail.publishedRevisionId) : query.review === "rejected" ? rawDetail?.revisions.find(revision => revision.id === rawDetail.latestRevisionId) : rawDetail?.revision;
  const currentDetail = rawDetail && visibleRevision ? { ...rawDetail, revision: visibleRevision } : rawDetail;
  const select = (entry: KnowledgeEntry) => { preserveScroll.current = listScroll.current?.scrollTop ?? 0; setSelectedId(entry.id); setMobileReader(true); if (page === "library" || page === "review") writeAddress(knowledgeCollectionAddress(page, query, entry.id, mode)); };
  const pageVisible = page === "library" || page === "review";
  const railContent = <>
<header><h2>{t("knowledge.title")}<span className="knowledge-beta" title={t("knowledge.betaHelp")}>{t("knowledge.beta")}</span></h2><button className="icon-button knowledge-mobile-back" aria-label={t("knowledge.close")} onClick={() => setRailOpen(false)}><X size={17} /></button></header><nav aria-label={t("knowledge.views")}><SelectionIndicator value={page === "review" ? "review" : query.project ?? query.view ?? "all"} selector='[aria-current="page"]' />{(["all", "personal", "project", "general"] as const).map(value => { const Icon = viewIcons[value]; return <button key={value} aria-current={page === "library" && query.view === value && !(value === "project" && query.project) ? "page" : undefined} onClick={() => openCollection(value)}><Icon size={18} aria-hidden="true" />{t(`knowledge.view.${value}`)}</button>; })}</nav>
      <div className="knowledge-rail-projects"><h3>{t("knowledge.project")}</h3>{facets.projects.slice(0, 12).map(project => <Hint key={project} label={project}><button aria-label={project.split(/[\\/]/).filter(Boolean).at(-1) ?? project} aria-pressed={page === "library" && query.view === "project" && query.project === project} onClick={() => openCollection("project", project)}><FolderSimple size={17} /><span>{project.split(/[\\/]/).filter(Boolean).at(-1) ?? project}</span></button></Hint>)}</div>
      <button className="knowledge-rail-review" aria-current={page === "review" ? "page" : undefined} onClick={() => openCollection("review")}>{t("knowledge.reviewQueue")}</button>

  </>;
  const saveEditor = (next: Detail) => {
    const nextQuery: KnowledgeQuery = { ...(editing === "new" ? { view: "all", pageSize: 20 } : query), review: next.revision.review === "reviewed" ? "reviewed" : "pending", availability: "all", taskId: undefined, page: 1 };
    setQuery(nextQuery); if (editing === "new") { setInput(""); setMode("keyword"); }
    if (page === "library" || page === "review") writeAddress(knowledgeCollectionAddress(page, nextQuery, next.id, editing === "new" ? "keyword" : mode));
    setMobileReader(true); update(next);
  };
  return <Dialog.Root open={railOpen} onOpenChange={setRailOpen}><KnowledgeWorkspace className={`knowledge-workspace${railOpen ? " rail-open" : ""}${mobileReader ? " reader-open" : ""}`}>
    <aside id="knowledge-navigation-pane" className="knowledge-rail knowledge-rail-desktop" aria-label={t("knowledge.title")}>{railContent}</aside>
    <main className="knowledge-main">
      <Dialog.Trigger asChild><button className="button subtle knowledge-rail-toggle"><List size={17} />{t("knowledge.views")}</button></Dialog.Trigger>
      <div hidden={!pageVisible}><KnowledgeSplit reader={mobileReader}>
        <section id="knowledge-list-pane" className="knowledge-list-pane" aria-label={t(page === "review" ? "knowledge.reviewQueue" : "knowledge.title")}>
          <div className="knowledge-list-toolbar">{page === "review" && <button className="button subtle" onClick={() => navigate("library")}>{t("knowledge.back")}</button>}<button className="button" onClick={() => setEditing("new")}><Plus size={16} />{t("knowledge.new")}</button><button className="button primary" onClick={() => navigate("new")}>{t("knowledge.extract")}</button><button className="button" onClick={() => navigate("tasks")}>{t("knowledge.tasks")}</button><button className="icon-button" aria-label={t("knowledge.settings")} onClick={() => navigate("settings")}><GearSix size={18} /></button></div>
          <form className="knowledge-search" onSubmit={search}><FilterSelect label={t("knowledge.searchMode")} value={mode} options={["keyword", "semantic"].map(value => ({ value, label: t(`knowledge.${value}`) }))} onChange={value => { if (value === "semantic" && index?.status !== "ready") { navigate("settings"); return; } setMode(value as "keyword" | "semantic"); if (page === "library" || page === "review") writeAddress(knowledgeCollectionAddress(page, query, selectedId, value as "keyword" | "semantic")); }} /><label><MagnifyingGlass size={17} /><input aria-label={t("knowledge.search")} placeholder={t("knowledge.searchPlaceholder")} value={input} onChange={event => setInput(event.target.value)} /></label><button className="icon-button" type="submit" aria-label={t("knowledge.search")}><ArrowClockwise size={16} /></button></form>
          <div className="knowledge-filter-row"><ProjectPicker label={t("knowledge.project")} value={query.project ?? "all"} options={[{ value: "all", label: t("knowledge.allProjects") }, ...facets.projects.map(value => ({ value, label: value.split(/[\\/]/).filter(Boolean).at(-1) ?? value, description: value }))]} onChange={value => changeQuery({ project: value === "all" ? undefined : value })} /><FilterSelect label={t("knowledge.client")} value={query.client ?? "all"} options={[{ value: "all", label: t("knowledge.allClients") }, ...facets.clients.map(value => ({ value, label: value }))]} onChange={value => changeQuery({ client: value === "all" ? undefined : value })} /><FilterSelect label={t("knowledge.review")} value={page === "review" ? "pending" : query.review ?? "reviewed"} disabled={page === "review"} options={["reviewed", "pending", "rejected", "all"].map(value => ({ value, label: t(value === "all" ? "knowledge.all" : `knowledge.review.${value}`) }))} onChange={value => changeQuery({ review: value as KnowledgeQuery["review"] })} />
          <Popover.Root open={more} onOpenChange={setMore}><Popover.Trigger className="button subtle" aria-label={t("knowledge.moreFilters")}><FunnelSimple size={16} /></Popover.Trigger><Popover.Portal><Popover.Content className="filter-menu knowledge-filter-menu" sideOffset={6} collisionPadding={12}><header><strong>{t("knowledge.moreFilters")}</strong><Popover.Close className="icon-button" aria-label={t("knowledge.close")}><X size={16} /></Popover.Close></header><div className="knowledge-form-stack"><label className="knowledge-field"><span>{t("knowledge.type")}</span><FilterSelect label={t("knowledge.type")} value={query.type ?? "all"} options={[{ value: "all", label: t("knowledge.all") }, ...knowledgeTypes.map(value => ({ value, label: t(`knowledge.type.${value}`) }))]} onChange={value => changeQuery({ type: value === "all" ? undefined : value as KnowledgeType })} /></label><label className="knowledge-field"><span>{t("knowledge.tag")}</span><ProjectPicker label={t("knowledge.tag")} value={query.tag ?? "all"} options={[{ value: "all", label: t("knowledge.allTags") }, ...facets.tags.map(value => ({ value, label: value }))]} onChange={value => changeQuery({ tag: value === "all" ? undefined : value })} /></label><label className="knowledge-field"><span>{t("knowledge.availability")}</span><FilterSelect label={t("knowledge.availability")} value={query.availability ?? "active"} options={["active", "deprecated", "expired", "superseded", "resolved", "all"].map(value => ({ value, label: t(value === "all" ? "knowledge.all" : `knowledge.availability.${value}`) }))} onChange={value => changeQuery({ availability: value as KnowledgeQuery["availability"] })} /></label><div className="knowledge-form-grid"><label className="knowledge-field"><span>{t("knowledge.from")}</span><DatePicker label={t("knowledge.from")} value={query.from ?? ""} onChange={value => changeQuery({ from: value || undefined })} /></label><label className="knowledge-field"><span>{t("knowledge.to")}</span><DatePicker label={t("knowledge.to")} value={query.to ?? ""} onChange={value => changeQuery({ to: value || undefined })} /></label></div><button className="text-button" onClick={() => { const cleared: KnowledgeQuery = { view: "all", review: "reviewed", availability: "active", page: 1, pageSize: 20 }; setQuery(cleared); setInput(""); initialTarget.current = false; preserveScroll.current = 0; writeAddress(knowledgeCollectionAddress(page === "review" ? "review" : "library", cleared, undefined, mode)); }}>{t("knowledge.clear")}</button></div></Popover.Content></Popover.Portal></Popover.Root>
          <KnowledgeBusy busy={listBusy && !!list} /><button className="icon-button" aria-label={t("knowledge.refresh")} disabled={listBusy} onClick={() => setReload(value => value + 1)}><ArrowClockwise size={15} /></button></div>
          <KnowledgeError error={listError} retry={() => setReload(value => value + 1)} />
          <div className="knowledge-entry-list" ref={listScroll} aria-busy={listBusy} onScroll={event => { preserveScroll.current = event.currentTarget.scrollTop; }}>{listBusy && !list && <LoadingSkeleton label={t("knowledge.loadingContent")} />}{list?.items.map(entry => <button className="knowledge-entry" key={entry.id} aria-current={entry.id === selectedId ? "true" : undefined} disabled={listBusy} onClick={() => select(entry)}><div><strong>{entry.revision.title}</strong><span>v{entry.revision.version}</span></div><p><span>{t(knowledgeTypeKey(entry.revision.type))}</span>{entry.revision.scope.project && <span title={entry.revision.scope.project}>{entry.revision.scope.project.split(/[\\/]/).filter(Boolean).at(-1)}</span>}<span>{t(`knowledge.review.${entry.revision.review}`)}</span></p>{entry.snippet && <p className="knowledge-entry-snippet">{entry.snippetField && ["applicability", "tags", "source"].includes(entry.snippetField) && <span>{t(`knowledge.snippet.${entry.snippetField}`)}: </span>}{entry.snippet}</p>}<time>{date(entry.updatedAt)}</time></button>)}{list && !list.items.length && <div className="knowledge-empty"><BookOpen size={27} /><h3>{t("knowledge.empty")}</h3><button className="text-button" onClick={() => setEditing("new")}>{t("knowledge.emptyAction")}</button></div>}</div>
          {list && <ResourcePagination page={list.page} pageSize={list.pageSize} total={list.total} label={t("knowledge.title")} onChange={page => changeQuery({ page })} onPageSizeChange={pageSize => changeQuery({ pageSize })} />}
        </section>
        <div className="knowledge-detail-slot"><KnowledgeError error={detailError} retry={() => setReload(value => value + 1)} />{currentDetail ? <KnowledgeDetail key={currentDetail.id} detail={currentDetail} reviewing={page === "review"} busy={detailBusy || listBusy} onEdit={() => setEditing("edit")} onChanged={update} onBack={() => setMobileReader(false)} /> : selectedId ? !detailError && <div className="knowledge-loading" role="status"><Loading /><span>{t("knowledge.loadingContent")}</span></div> : <div className="knowledge-empty"><BookOpen size={28} /><h2>{t("knowledge.noSelection")}</h2></div>}</div>
      </KnowledgeSplit></div>
      <div hidden={page !== "tasks" && page !== "new"}><KnowledgeTasks active={active && (page === "tasks" || page === "new")} mode={page === "new" ? "new" : "tasks"} entryKey={newEntry} taskId={taskId} onSelectTask={id => navigate("tasks", { taskId: id })} onNew={() => navigate("new")} initialScope={scope} initialSession={selection} onResults={taskId => { const nextQuery = { ...knowledgeCollectionQuery({}, "review"), taskId, pageSize: query.pageSize }; initialTarget.current = false; preserveScroll.current = 0; setQuery(nextQuery); setInput(""); navigate("review", { taskId, query: nextQuery }); }} onBack={() => navigate("library")} onSettings={() => navigate("settings")} /></div>
      <div hidden={page !== "settings"}><KnowledgeSettings active={active && page === "settings"} onBack={() => navigate("library")} onSaved={() => setReload(value => value + 1)} onTasks={nextScope => { navigate("new"); setScope(nextScope); }} /></div>
    </main>
    {editing && <KnowledgeEditor detail={editing === "edit" ? currentDetail : undefined} projects={facets.projects} onClose={() => setEditing(undefined)} onSaved={saveEditor} />}
  </KnowledgeWorkspace><Dialog.Portal><Dialog.Overlay className="dialog-overlay knowledge-rail-overlay" /><Dialog.Content className="knowledge-rail knowledge-rail-mobile" aria-describedby={undefined}><Dialog.Title className="sr-only">{t("knowledge.views")}</Dialog.Title>{railContent}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}
