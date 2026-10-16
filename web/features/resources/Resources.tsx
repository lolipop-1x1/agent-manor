import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowClockwise, ArrowSquareOut, CaretDown, CaretLeft, CaretRight, CaretUp, CaretUpDown, DotsThree, Funnel, List, ArrowCounterClockwise, ClockCounterClockwise, MagnifyingGlass, MapTrifold, Plus, Star, X } from "@phosphor-icons/react";
import { CLIENTS, type Client } from "../../../src/clients";
import type { ResourceKind, ResourceUsageDetail, ResourceUsageDistribution, ResourceUsageEvidenceResult, ResourceUsageStats } from "../../../src/resource-contracts";
import type { ResourceInventoryDiagnostic, ResourceInventoryEntry, ResourceManualSource } from "../../../src/resource-inventory-contracts";
import type { ResourceManagementAction, ResourceManagementInput, ResourceManagementOperation, ResourceManagementOperations, ResourceManagementPreview } from "../../../src/resource-management-contracts";
import type { ResourceCandidate, ResourceMapQuery, ResourceMapSummary, ResourceOverviewCandidate, ResourceOverviewDetail, ResourceOverviewQuery, ResourceOverviewSummary, ResourceOverviewRow, ResourceStatus, ResourceStatusSummary } from "../../../src/resource-service-contracts";
import { ApiError, errorMessage, isAborted } from "../../shared/api";
import { DatePicker } from "../../shared/ui/DatePicker";
import { FilterSelect } from "../../shared/ui/FilterSelect";
import { availableClientOptions } from "../../shared/ui/client-options";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { ProjectPicker } from "../../shared/ui/ProjectPicker";
import { ResourcePagination } from "../../shared/ui/ResourcePagination";
import { ResourceMap } from "./ResourceMap";
import { ResourceTrend } from "./ResourceTrend";
import { ResourceEmpty } from "./ResourceEmpty";
import { resourceControlScope } from "../../../src/resources/control-scope";
import { recoveryKind, restoreActionKey, managementSuccessKey } from "./resource-recovery";
import { ResourceChange } from "./ResourceChange";
import { physicalLocationEntry, resourceLocationGroups, resourceLocationScopes, type ResourceLocationGroup } from "./resource-location-groups";
import { normalizeResourceRouteParams } from "./resource-usage-state";
import { applyResourceFavorites } from "../../../src/resources/favorites";
import { localFavoriteRow, mapFavorites, overviewFavorites, pendingFavoriteIds, type PendingFavorite } from "./resource-favorites";
import { ResizableWorkspace } from "../../shared/layout/ResizableWorkspace";
import { dateLabel, fmt } from "../../shared/format";
import { timeFilters } from "../../shared/time-filters";
import { resourceApi, resourceQuery, type FavoriteResult, type ResourceArchiveResult, type ResourceUsageFilters } from "./resource-api";
import { clientLabel, formatList, isMessageDescriptorKnown, messageText, t, useI18n } from "../../shared/i18n";
import { type MessageDescriptor } from "../../../src/i18n";
import "./resources.css";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import { useHistoryRevision } from "../../shared/refresh/useHistoryRefresh";

type ResourceTab = "usage" | "recovery" | "operations";
interface ResourceRoute {
  kind: ResourceKind; tab: ResourceTab; client: string; project: string; window: string;
  from: string; to: string; q: string; sort: string; order: "asc" | "desc"; candidate: Exclude<ResourceCandidate | ResourceOverviewCandidate, "review">;
  low: number; inactive: number; favorite: boolean; page: number; pageSize: number; id: string; evidencePage: number; tool: string;
  view: "list" | "map"; metric: "uses" | "sessions"; maxValue: string;
  presence: "all" | "present" | "missing" | "unknown"; scope: "all" | "user" | "project"; locationProject: string;
  detail: "overview" | "locations" | "history";
}
const tabs: { value: ResourceTab; labelKey: string }[] = [
  { value: "usage", labelKey: "resources.workspace.resourceList" },
  { value: "recovery", labelKey: "resources.recovery.title" }, { value: "operations", labelKey: "resources.tab.operations" },
];
const overviewCandidates: { value: Exclude<ResourceOverviewCandidate, "review">; labelKey: string }[] = [
  { value: "all", labelKey: "resources.candidate.all" }, { value: "used", labelKey: "resources.candidate.used" }, { value: "unused", labelKey: "resources.candidate.unused" },
  { value: "low", labelKey: "resources.candidate.low" }, { value: "old", labelKey: "resources.candidate.old" }, { value: "favorite", labelKey: "resources.candidate.favorite" },
];
const disableActionKey = (entry?: ResourceInventoryEntry, preview?: ResourceManagementPreview) => {
  const scope = preview?.configuration?.controlScope ?? (entry ? resourceControlScope(entry)?.controlScope : undefined);
  const nameRule = preview?.configuration?.kind === "membership" || entry?.locator.nativeRule?.type === "name-list" || entry?.locator.nativeControl === "codeflicker-skill";
  return scope === "project" ? "resources.workspace.disableProject" : scope === "client" ? nameRule ? "resources.workspace.disableClient" : "resources.workspace.disableGlobalConfig" : "resources.workspace.disablePath";
};
const positive = (value: string | null, fallback = 1) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
};
const validDate = (value: string | null): string => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00`);
  return Number.isFinite(date.getTime()) && date.getFullYear() === Number(value.slice(0, 4))
    && date.getMonth() + 1 === Number(value.slice(5, 7)) && date.getDate() === Number(value.slice(8, 10)) ? value : "";
};
const readRoute = (): ResourceRoute => {
  const params = normalizeResourceRouteParams(new URLSearchParams(location.hash.startsWith("#resources") ? location.hash.split("?")[1] : ""));
  const kind = params.get("kind") === "mcp" ? "mcp" : "skill";
  let preferredView = "list";
  try { preferredView = localStorage.getItem("agent-manor:resource-view") ?? "list"; } catch { /* 无法存储时仍保留当前路由。 */ }
  // 旧调用／读取指标统一为调用次数，原上限的口径不兼容。
  const maximum = ["uses", "sessions"].includes(params.get("metric") ?? "") ? params.get("maxValue") : null;
  return {
    kind,
    tab: params.get("tab") === "local" ? "usage" : tabs.some(tab => tab.value === params.get("tab")) ? params.get("tab") as ResourceTab : "usage",
    client: CLIENTS.some(client => client.id === params.get("client")) ? params.get("client")! : "all",
    project: params.get("tab") === "local" ? "all" : params.get("project") ?? "all", window: ["7", "30", "90", "custom"].includes(params.get("window") ?? "") ? params.get("window")! : "all",
    from: validDate(params.get("from")), to: validDate(params.get("to")),
    q: params.get("q") ?? "", sort: ["uses", "sessions", "recent", "name"].includes(params.get("sort") ?? "") ? params.get("sort")! : "uses",
    order: params.get("order") === "asc" ? "asc" : params.get("order") === "desc" ? "desc" : params.get("sort") === "name" ? "asc" : "desc",
    candidate: overviewCandidates.some(item => item.value === params.get("candidate")) ? params.get("candidate") as ResourceRoute["candidate"] : "all",
    low: Math.min(10000, positive(params.get("low"), 2)), inactive: Math.min(3650, positive(params.get("inactive"), 90)),
    favorite: params.get("favorite") === "true", page: positive(params.get("page")), pageSize: [20, 50, 100].includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 20, id: params.get("id") ?? (params.get("tab") === "local" ? params.get("bodyId") : null) ?? "",
    evidencePage: positive(params.get("evidencePage")), tool: params.get("tool") ?? "",
    view: (params.get("view") ?? preferredView) === "map" ? "map" : "list",
    metric: params.get("metric") === "sessions" ? "sessions" : "uses",
    maxValue: maximum !== null && /^\d+$/.test(maximum) && Number.isSafeInteger(Number(maximum)) ? String(Number(maximum)) : "",
    presence: ["present", "missing", "unknown"].includes(params.get("presence") ?? "") ? params.get("presence") as ResourceRoute["presence"] : "all",
    scope: ["user", "project"].includes(params.get("scope") ?? "") ? params.get("scope") as ResourceRoute["scope"] : "all",
    locationProject: params.get("locationProject") ?? (params.get("tab") === "local" && params.get("project") !== "none" ? params.get("project") : null) ?? "all",
    detail: params.get("tab") === "local" ? "locations" : ["locations", "history"].includes(params.get("detail") ?? "") ? params.get("detail") as ResourceRoute["detail"] : "overview",
  };
};
function address(route: ResourceRoute) {
  const params = new URLSearchParams(resourceQuery({ ...route, client: route.client === "all" ? undefined : route.client,
    project: route.project === "all" ? undefined : route.project, page: route.page === 1 ? undefined : route.page,
    evidencePage: route.evidencePage === 1 ? undefined : route.evidencePage }).slice(1));
  return `#resources?${normalizeResourceRouteParams(params)}`;
}
const usageMetricLabel = (kind: ResourceKind) => t(kind === "skill" ? "resources.column.uses" : "resources.column.calls");
const shortPath = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const sourceStateNames = { ok: "resources.source.ok", missing: "resources.source.missing", unreadable: "resources.source.unreadable", invalid: "resources.source.invalid", unsupported: "resources.source.unsupported" };
const methodNames = { directory: "resources.entry.directory", symlink: "resources.entry.symlink", file: "resources.entry.file", registration: "resources.entry.registration" };
const resultNames = { success: "resources.result.success", failure: "resources.result.failure", unknown: "resources.result.unknown" };
const evidenceNames = { skill_call: "resources.evidence.skillCall", skill_read: "resources.evidence.skillRead", mcp: "resources.evidence.mcp" };
const actionNames: Record<ResourceManagementAction, string> = { disable: "resources.action.disable", standby: "resources.action.standby", trash: "resources.action.trash", restore: "resources.action.restore", purge: "resources.action.purge" };
const operationStatusNames = { success: "resources.operation.success", failure: "resources.operation.failure", conflict: "resources.operation.conflict", partial: "resources.operation.partial" };
const operationMethodNames = { native_toggle: "resources.operationMethod.nativeToggle", entry_isolation: "resources.operationMethod.entryIsolation", registration_remove: "resources.operationMethod.registrationRemove", restore: "resources.operationMethod.restore", permanent_purge: "resources.operationMethod.purge" };
const protectionNames: Record<string, string> = { favorite: "resources.protection.favorite", system: "resources.protection.system", plugin: "resources.protection.plugin", managed: "resources.protection.managed" };
const diagnosticNames = { shadowed: "resources.diagnostic.shadowed", residual: "resources.diagnostic.residual", conflict: "resources.diagnostic.conflict", dynamic: "resources.diagnostic.dynamic", invalid_reference: "resources.diagnostic.invalidReference" };
const nativeStateLabel = (state: ResourceInventoryEntry["nativeState"]) => t(state === "disabled" ? "resources.tab.disabled" : state === "enabled" ? "resources.entry.enabled" : "resources.entry.stateUnknown");
const registrationKeys = (client: Client) => client === "codex" ? "mcp_servers" : client === "opencode" ? "mcp" : "mcpServers";

function SourceDiagnostics({ diagnostics }: { diagnostics?: ResourceInventoryDiagnostic[] }) {
  useI18n();
  const [open, setOpen] = useState(false);
  if (!diagnostics?.length) return null;
  return <details className="resource-data-details" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{t("resources.diagnostic.count", { count: diagnostics.length })}</summary><div className="resource-source-list resource-diagnostics">
    {open && diagnostics.map((item, index) => <div key={`${item.sourceId}:${item.reason}:${item.path}:${item.project ?? ""}:${index}`}><header><strong>{item.name ?? clientLabel(item.client)}</strong><span className="resource-state is-warning">{t(diagnosticNames[item.reason])}</span></header>
      <div className="resource-tags"><span>{clientLabel(item.client)}</span><span>{item.scope === "user" ? t("resources.scope.userDefault") : item.project ?? t("resources.project.unknown")}</span></div>
      <p className="resource-path">{item.path}</p>{item.selectedPath && <dl className="resource-facts"><dt>{t("resources.diagnostic.selectedPath")}</dt><dd>{item.selectedPath}</dd></dl>}
    </div>)}
  </div></details>;
}

function HistoryGaps({ gaps }: { gaps: ResourceUsageDetail["coverage"]["gaps"] }) {
  const [open, setOpen] = useState(false);
  if (!gaps.length) return null;
  return <details className="resource-data-details" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("resources.source.gapCount", { count: gaps.length })}</summary>
    {open && <div className="resource-source-gaps">{gaps.map((gap, index) => <div key={index}><ResourceMessage descriptor={gap.messageDescriptor} original={gap.message} details={gap.details} />{gap.sourceId && <p className="resource-path">{gap.sourceId}</p>}</div>)}</div>}
  </details>;
}

function ResourceDialog({ open, onOpenChange, title, description, children, className = "", contentRef, focusTarget, afterClose }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: ReactNode; className?: string; contentRef?: RefObject<HTMLDivElement | null>; focusTarget?: () => HTMLElement | null; afterClose?: () => void;
}) {
  useI18n();
  const returnFocus = useRef<HTMLElement | null>(null);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" /><Dialog.Content ref={contentRef} className={`dialog-content resource-dialog ${className}`}
      onEscapeKeyDown={event => {
        // Radix 先于图表收到 Escape，先保留详情，再由图表收起明细浮层。
        if (event.target instanceof Element && event.target.closest(".resource-trend-hit[aria-describedby]")) event.preventDefault();
      }}
      onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={event => {
        const target = focusTarget?.() ?? returnFocus.current;
        if (target?.isConnected && target !== document.body && target.getClientRects().length) { event.preventDefault(); target.focus(); }
        afterClose?.();
      }}>
      <Dialog.Title>{title}</Dialog.Title><Dialog.Description className="dialog-description">{description}</Dialog.Description>
      <Dialog.Close asChild><button className="icon-button dialog-close" aria-label={t("common.closeNamed", { label: title })}><X size={18} /></button></Dialog.Close>
      {children}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
function ResourceMessage({ descriptor, original, details }: { descriptor?: MessageDescriptor; original: string; details?: MessageDescriptor[] }) {
  useI18n();
  const recognized = isMessageDescriptorKnown(descriptor);
  return <div className="resource-operation-message">
    {recognized ? messageText(descriptor, original) : <><strong>{t("common.originalDetails")}</strong><p>{original}</p></>}
    {details?.length ? <ul>{details.map((detail, index) => <li key={index}>{isMessageDescriptorKnown(detail) ? messageText(detail, original) : t("common.originalDetail", { detail: original })}</li>)}</ul> : null}
    {recognized && <details className="resource-data-details"><summary>{t("common.originalDetails")}</summary><p>{original}</p></details>}
  </div>;
}
function ResourceErrorText({ error }: { error: Error }) {
  return <ResourceMessage descriptor={error instanceof ApiError ? error.messageDescriptor : undefined} original={error.message} />;
}
function FavoriteButton({ name, favorite, disabled, onClick }: { name: string; favorite: boolean; disabled?: boolean; onClick: () => void }) {
  useI18n();
  return <button className={`icon-button resource-favorite${favorite ? " is-favorite" : ""}`} aria-label={t(favorite ? "resources.unfavoriteLabel" : "resources.favoriteLabel", { name })}
    aria-pressed={favorite} aria-disabled={disabled || undefined} aria-busy={disabled || undefined} onClick={() => { if (!disabled) onClick(); }}><Star size={17} weight={favorite ? "fill" : "regular"} /></button>;
}
function selectResourceRow(event: MouseEvent<HTMLTableRowElement>, id: string, onSelect: (id: string) => void) {
  const selection = globalThis.getSelection();
  if (event.defaultPrevented || event.target instanceof Element && event.target.closest("button, a, input, select, textarea, summary, [role=button], [role=combobox]")
    || selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode)) return;
  event.currentTarget.focus();
  onSelect(id);
}
function OverviewTable({ rows, route, onSort, onSelect, onFavorite, favoritePending }: {
  rows: ResourceOverviewRow[]; route: ResourceRoute; onSort: (sort: string) => void; onSelect: (id: string) => void;
  onFavorite: (id: string, favorite: boolean) => void; favoritePending: ReadonlySet<string>;
}) {
  const { dateTime } = useI18n();
  const columns = [{ value: "name", label: route.kind === "skill" ? t("resources.kind.skill") : t("resources.column.server") }, { value: "uses", label: usageMetricLabel(route.kind) }, { value: "sessions", label: t("resources.column.sessions") }, { value: "recent", label: t("resources.column.recent") }];
  const heading = (column: { value: string; label: string }) => <th key={column.value} scope="col" aria-sort={route.sort === column.value ? route.order === "asc" ? "ascending" : "descending" : "none"}>
    <button aria-label={t("resources.sortColumn", { column: column.label })} onClick={() => onSort(column.value)}>{column.label}{route.sort === column.value ? route.order === "asc" ? <CaretUp size={12} aria-hidden="true" /> : <CaretDown size={12} aria-hidden="true" /> : <CaretUpDown size={12} aria-hidden="true" />}</button>
  </th>;
  return <div className="resource-overview-scroll"><table className="resource-overview-table" aria-label={t("resources.overview", { kind: route.kind === "skill" ? t("resources.kind.skill") : t("resources.kind.mcp") })}>
    <colgroup><col className="resource-name-column" /><col className="resource-location-column" /><col className="resource-number-column" /><col className="resource-number-column resource-session-column" /><col className="resource-recent-column" /><col className="resource-favorite-column" /></colgroup>
    <thead><tr>{heading(columns[0]!)}<th scope="col">{t("resources.workspace.localLocation")}</th>{columns.slice(1).map(heading)}<th scope="col"><span className="sr-only">{t("resources.candidate.favorite")}</span></th></tr></thead>
    <tbody>{rows.map(row => <tr tabIndex={0} aria-label={t("resources.viewUsage", { name: messageText(row.identity.nameDescriptor, row.identity.name) })} aria-selected={route.id === row.identity.id} data-resource-row={row.identity.id} className={`resource-overview-row${route.id === row.identity.id ? " is-selected" : ""}`} key={row.identity.id} onClick={event => selectResourceRow(event, row.identity.id, onSelect)} onKeyDown={event => { if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) { event.preventDefault(); onSelect(row.identity.id); } }}>
      <th scope="row"><div className="resource-overview-name"><button tabIndex={-1} aria-label={t("resources.viewUsage", { name: messageText(row.identity.nameDescriptor, row.identity.name) })} onClick={() => onSelect(row.identity.id)}>{messageText(row.identity.nameDescriptor, row.identity.name)}</button></div><SkillDescription description={row.description} /></th>
      <td className="resource-local-summary"><span className={`resource-presence is-${row.localSummary?.presence ?? "unknown"}`}>{t(`resources.workspace.presence.${row.localSummary?.presence ?? "unknown"}`)}</span>{!!row.localSummary?.locations && <small>{row.localSummary.scopes.length === 2 ? t("resources.workspace.globalAndProject") : t(row.localSummary.scopes[0] === "user" ? "resources.scope.user" : "resources.scope.project")} · {t("resources.workspace.locationCount", { count: row.localSummary.locations })}</small>}</td>
      <td>{row.stats ? fmt(row.stats.events) : "—"}</td>
      <td>{row.stats ? fmt(row.stats.sessions) : "—"}</td>
      <td className="resource-overview-time">{row.stats?.lastUsedAt ? <Tooltip.Root><Tooltip.Trigger asChild><time dateTime={row.stats.lastUsedAt} tabIndex={0}>{dateTime(row.stats.lastUsedAt, { year: "2-digit", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</time></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={6}>{dateLabel(row.stats.lastUsedAt)}</Tooltip.Content></Tooltip.Portal></Tooltip.Root> : "—"}</td>
      <td><FavoriteButton name={messageText(row.identity.nameDescriptor, row.identity.name)} favorite={row.favorite} disabled={favoritePending.has(row.identity.id)} onClick={() => onFavorite(row.identity.id, row.favorite)} /></td>
    </tr>)}</tbody>
  </table></div>;
}
function SkillDescription({ description }: { description?: string }) {
  if (!description) return null;
  return <Tooltip.Root><Tooltip.Trigger asChild><p tabIndex={0} className="resource-description-preview">{description}</p></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip resource-description-tooltip" side="bottom" align="start" sideOffset={6} collisionPadding={12}>{description}</Tooltip.Content></Tooltip.Portal></Tooltip.Root>;
}
function Stats({ stats, kind }: { stats: ResourceUsageStats | null; kind: ResourceKind }) {
  const { percent } = useI18n();
  return <div className="resource-stats">
    <div><strong>{stats ? fmt(stats.events) : t("common.unknown")}</strong><span>{usageMetricLabel(kind)}</span></div>
    <div><strong>{stats ? fmt(stats.sessions) : t("common.unknown")}</strong><span>{t("resources.stat.sessions")}</span></div>
    {kind === "skill" && <div><strong>{stats ? fmt(stats.explicitCalls) : t("common.unknown")}</strong><span>{t("resources.stat.explicitCalls")}</span></div>}
    {kind === "skill" && <div><strong>{stats ? fmt(stats.successfulReads) : t("common.unknown")}</strong><span>{t("resources.stat.successfulReads")}</span></div>}
    <div><strong>{stats?.results.successRate === null || !stats ? t("common.notRecorded") : percent(stats.results.successRate, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</strong><span>{t("resources.stat.successRate")}</span></div>
    <div><strong>{stats?.duration.averageMs === null || !stats ? t("common.notRecorded") : t("resources.stat.milliseconds", { value: Math.round(stats.duration.averageMs) })}</strong><span>{t("resources.stat.averageDuration", { count: stats?.duration.samples ?? 0 })}</span></div>
    {stats && <div><strong>{fmt(stats.results.unknown)}</strong><span>{t("resources.result.unknown")}</span></div>}
  </div>;
}
function Distribution({ rows, title, label }: { rows: ResourceUsageDistribution[]; title: string; label: (value: string | null) => string }) {
  useI18n();
  const max = rows.reduce((maximum, row) => Math.max(maximum, row.stats.events), 1);
  return <section className="resource-detail-section"><header><h3>{title}</h3><span>{t("common.itemCount", { count: rows.length })}</span></header>
    <div className="resource-distribution">{rows.map(row => <div key={row.value ?? "unknown"} title={row.value ?? t("common.notRecorded")}><span>{label(row.value)}</span><i style={{ width: `${Math.max(2, row.stats.events / max * 100)}%` }} /><strong>{fmt(row.stats.events)}</strong></div>)}</div>
  </section>;
}
function UsageHelp({ kind }: { kind: ResourceKind }) {
  useI18n();
  return <HelpPopover label={t("resources.help.usage")}><dl>
    <div><dt>{t("resources.overview", { kind: kind === "skill" ? t("resources.kind.skill") : t("resources.kind.mcp") })}</dt><dd>{t(kind === "skill" ? "resources.help.skillOverview" : "resources.help.mcpOverview")}</dd></div>
    <div><dt>{usageMetricLabel(kind)}</dt><dd>{t(kind === "skill" ? "resources.help.skillCalls" : "resources.help.mcpCalls")}</dd></div>
    <div><dt>{t("resources.stat.sessions")}</dt><dd>{t(kind === "skill" ? "resources.help.skillSessions" : "resources.help.mcpSessions")}</dd></div>
    <div><dt>{t("resources.help.knownResults")}</dt><dd>{t("resources.help.knownResultsText")}</dd></div>
    <div><dt>{t("resources.help.association")}</dt><dd>{t("resources.help.associationText")}</dd></div>
    <div><dt>{t("resources.help.organization")}</dt><dd>{t("resources.help.organizationText")}</dd></div>
  </dl></HelpPopover>;
}

export default function Resources({ active, onSession, onHistoryReading, historyRevision = 0 }: { historyRevision?: number; onHistoryReading?: (reading: boolean) => void; active: boolean; onSession: (target: { sessionId: string; messageId: string }) => void }) {
  useI18n();
  const [route, setRoute] = useState<ResourceRoute>(readRoute);
  const [status, setStatus] = useState<ResourceStatusSummary | null>(null);
  const [sourceStatus, setSourceStatus] = useState<ResourceStatus | null>(null);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourcesRetry, setSourcesRetry] = useState(0);
  const [overview, setOverview] = useState<FavoriteResult<ResourceOverviewSummary> | null>(null);
  const overviewRef = useRef(overview);
  overviewRef.current = overview;
  const [map, setMap] = useState<ResourceMapSummary | null>(null);
  const mapLoadedQuery = useRef("");
  const [overviewDetail, setOverviewDetail] = useState<FavoriteResult<ResourceOverviewDetail> | null>(null);
  const [usageDetail, setUsageDetail] = useState<ResourceUsageDetail | null>(null);
  const [evidence, setEvidence] = useState<ResourceUsageEvidenceResult | null>(null);
  const [archives, setArchives] = useState<ResourceArchiveResult | null>(null);
  const [operations, setOperations] = useState<ResourceManagementOperations | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [detailError, setDetailError] = useState<Error | null>(null);
  const [evidenceError, setEvidenceError] = useState<Error | null>(null);
  const [reload, setReload] = useState(0);
  const [managementReload, setManagementReload] = useState(0);
  const [historyReload, setHistoryReload] = useState(0);
  useHistoryRevision(active, historyRevision, () => setHistoryReload(value => value + 1), listLoading || detailLoading || evidenceLoading, onHistoryReading);
  const detailTarget = useRef("");
  const detailPending = useRef(false);
  const evidenceLoaded = useRef<{ id: string; key: string } | undefined>(undefined);
  const [favoriteReload, setFavoriteReload] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [inventoryError, setInventoryError] = useState<Error | null>(null);
  const [favoritePending, setFavoritePending] = useState<ReadonlySet<string>>(new Set());
  const favoriteBase = useRef<string[] | null>(null);
  const favoriteActions = useRef(new Map<string, PendingFavorite>());
  const favoriteRevision = useRef(0);
  const favoriteQueue = useRef(Promise.resolve());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailsCollapsed, setDetailsCollapsed] = useState(() => !route.id);
  useEffect(() => { setDetailsCollapsed(!route.id); }, [route.id]);
  const [compact, setCompact] = useState(() => globalThis.innerWidth < 1024);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sourceLocationsOpen, setSourceLocationsOpen] = useState(false);
  const [sourceGapsOpen, setSourceGapsOpen] = useState(false);
  const [sourcePage, setSourcePage] = useState(1);
  useEffect(() => { if (!sourcesOpen) { setSourceLocationsOpen(false); setSourceGapsOpen(false); setSourcePage(1); } }, [sourcesOpen]);
  const [sourceAdding, setSourceAdding] = useState(false);
  const [sourcePending, setSourcePending] = useState(false);
  const [sourceError, setSourceError] = useState<Error | null>(null);
  const [source, setSource] = useState<ResourceManualSource>({ client: "codex", kind: "skill", path: "", format: "skill-directory" });
  const [sourceKeys, setSourceKeys] = useState("mcpServers");
  const managementFocus = useRef<HTMLElement | null>(null);
  const managementFocusAction = useRef<string | null>(null);
  const managementReturnPending = useRef(false);
  const managementHeading = useRef<HTMLHeadingElement>(null);
  const [managementOpen, setManagementOpen] = useState(false);
  const [managementInput, setManagementInput] = useState<ResourceManagementInput | null>(null);
  const [preview, setPreview] = useState<ResourceManagementPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [managementError, setManagementError] = useState<Error | null>(null);
  const [managementResult, setManagementResult] = useState<ResourceManagementOperation | null>(null);
  const [purgeConfirmed, setPurgeConfirmed] = useState(false);
  const [queryText, setQueryText] = useState(route.q);
  const [timeAnchor, setTimeAnchor] = useState(Date.now);
  const listScroll = useRef<HTMLDivElement>(null);
  const detailScroll = useRef<HTMLDivElement>(null);
  const detailDialogScroll = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);
  const savedDetailScroll = useRef(0);
  const returnFromEvidence = useRef(false);
  const restoreScroll = useRef(false);
  const busy = useRef({ list: listLoading, detail: detailLoading || evidenceLoading });
  busy.current = { list: listLoading, detail: detailLoading || evidenceLoading };
  const viewRoutes = useRef(new Map<string, { route: ResourceRoute; scroll: number }>());
  const routeRef = useRef(route);
  const managementRequest = useRef(0);
  const completedPreview = useRef<ResourceManagementPreview | null>(null);
  const previewAbort = useRef<AbortController | null>(null);
  routeRef.current = route;
  useEffect(() => () => { managementRequest.current++; previewAbort.current?.abort(); }, []);
  useEffect(() => { if (!active) { managementRequest.current++; previewAbort.current?.abort(); } }, [active]);

  const update = useCallback((patch: Partial<ResourceRoute>, push = false) => {
    const next = { ...routeRef.current, ...patch }; routeRef.current = next; setRoute(next);
    if (location.hash.startsWith("#resources")) history[push ? "pushState" : "replaceState"]({}, "", address(next));
  }, []);
  const switchView = (tab: ResourceTab, patch: Partial<ResourceRoute> = {}, kind = routeRef.current.kind) => {
    if (applying) return;
    const current = routeRef.current;
    if (current.tab === tab && current.kind === kind && !Object.keys(patch).length) return;
    viewRoutes.current.set(`${current.kind}:${current.tab}`, { route: current, scroll: listScroll.current?.scrollTop ?? 0 });
    const saved = viewRoutes.current.get(`${kind}:${tab}`);
    const next = { ...(saved?.route ?? { ...current, kind, tab, q: "", id: "", page: 1, evidencePage: 1, tool: "", client: "all", project: "all", window: "all", from: "", to: "", candidate: "all" as const, favorite: false, presence: "all" as const, scope: "all" as const, locationProject: "all" }), ...patch, kind, tab };
    savedScroll.current = Object.keys(patch).length ? 0 : saved?.scroll ?? 0; restoreScroll.current = true;
    managementRequest.current++; previewAbort.current?.abort(); setManagementOpen(false); setManagementResult(null); setManagementError(null); setFiltersOpen(false);
    update(next, true); setQueryText(next.q);
  };
  useEffect(() => {
    if (!active || !location.hash.startsWith("#resources")) return;
    const canonical = address(route);
    if (location.hash !== canonical) history.replaceState({}, "", canonical);
  }, [active, route]);
  const filter = (patch: Partial<ResourceRoute>) => { if (listScroll.current) listScroll.current.scrollTop = 0; update({ ...patch, page: 1, evidencePage: 1 }); };
  const sort = (value: string) => filter({ sort: value, order: route.sort === value ? route.order === "asc" ? "desc" : "asc" : value === "name" ? "asc" : "desc" });
  const pageChange = (page: number) => { if (listScroll.current) listScroll.current.scrollTop = 0; update({ page }); };
  const select = (id: string) => {
    if (busy.current.list || refreshing || applying) return;
    managementRequest.current++; previewAbort.current?.abort(); setManagementOpen(false); managementReturnPending.current = false;
    savedScroll.current = listScroll.current?.scrollTop ?? 0; setDetailsCollapsed(false); update({ id, evidencePage: 1, tool: "" }, true);
  };
  const closeDetails = () => {
    if (applying) return;
    const id = routeRef.current.id;
    managementRequest.current++; previewAbort.current?.abort(); setManagementOpen(false); setDetailsCollapsed(true);
    if (compact) update({ id: "" });
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-resource-row="${CSS.escape(id)}"]`)?.focus());
  };
  const currentFavorites = () => pendingFavoriteIds(favoriteBase.current ?? [], favoriteActions.current);
  const acceptFavoriteIds = (ids: string[], revision: number) => {
    if (revision === favoriteRevision.current) favoriteBase.current = ids;
    return currentFavorites();
  };
  const syncFavorites = () => {
    const favorites = currentFavorites(), favoriteIds = [...favorites];
    setStatus(current => current ? { ...current, favoriteIds } : current);
    setSourceStatus(current => current ? { ...current, favoriteIds } : current);
    setOverview(current => current ? { ...overviewFavorites(current, favorites), favoriteIds } : current);
    setMap(current => current ? mapFavorites(current, favorites) : current);
    setUsageDetail(current => current ? { ...current, resource: applyResourceFavorites(current.resource, favorites) } : current);
    setOverviewDetail(current => current ? { ...current, favoriteIds, resource: applyResourceFavorites(current.resource, favorites),
      history: current.history ? { ...current.history, resource: applyResourceFavorites(current.history.resource, favorites) } : null,
      local: current.local.map(row => localFavoriteRow(row, favorites)) } : current);
  };
  useEffect(() => {
    const navigate = () => {
      if (!location.hash.startsWith("#resources")) return;
      const next = readRoute(); const current = routeRef.current;
      if (current.kind !== next.kind || current.tab !== next.tab) {
        viewRoutes.current.set(`${current.kind}:${current.tab}`, { route: current, scroll: listScroll.current?.scrollTop ?? 0 });
        savedScroll.current = viewRoutes.current.get(`${next.kind}:${next.tab}`)?.scroll ?? 0;
        managementRequest.current++; previewAbort.current?.abort(); setManagementOpen(false); setManagementResult(null); setManagementError(null); setFiltersOpen(false);
      }
      routeRef.current = next; setRoute(next); setQueryText(next.q); restoreScroll.current = true;
    };
    globalThis.addEventListener("hashchange", navigate); globalThis.addEventListener("popstate", navigate);
    return () => { globalThis.removeEventListener("hashchange", navigate); globalThis.removeEventListener("popstate", navigate); };
  }, []);
  useEffect(() => {
    const resize = () => setCompact(globalThis.innerWidth < 1024);
    globalThis.addEventListener("resize", resize); return () => globalThis.removeEventListener("resize", resize);
  }, []);
  useEffect(() => { const timer = globalThis.setTimeout(() => setQueryText(route.q), 250); return () => clearTimeout(timer); }, [route.q]);
  const clientCandidatesPending = useRef(false);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const revision = favoriteRevision.current;
    clientCandidatesPending.current = true;
    void resourceApi.status(controller.signal).then(result => {
      if (!controller.signal.aborted) { clientCandidatesPending.current = false; setStatus({ ...result, favoriteIds: [...acceptFavoriteIds(result.favoriteIds, revision)] }); syncFavorites(); }
    }).catch(failure => { if (!isAborted(failure)) setError(failure instanceof Error ? failure : new Error(errorMessage(failure))); });
    return () => controller.abort();
  }, [active, reload, historyReload]);
  useEffect(() => {
    if (!active || !sourcesOpen) return;
    const controller = new AbortController();
    setSourcesLoading(true); setSourceError(null); setSourceStatus(null);
    void resourceApi.sources(controller.signal).then(setSourceStatus)
      .catch(failure => { if (!isAborted(failure)) setSourceError(failure instanceof Error ? failure : new Error(errorMessage(failure))); })
      .finally(() => { if (!controller.signal.aborted) setSourcesLoading(false); });
    return () => controller.abort();
  }, [active, sourcesOpen, reload, sourcesRetry]);
  const invalidTime = (route.tab === "usage") && route.window === "custom" && !!route.from && !!route.to && route.from > route.to;
  const overviewRanking = route.tab === "usage";
  const mapView = overviewRanking && route.view === "map";
  const overviewData = mapView ? map : overview;
  const overviewLabel = t("resources.overview", { kind: route.kind === "skill" ? t("resources.kind.skill") : t("resources.kind.mcp") });
  const scopeQuery = useMemo<ResourceUsageFilters>(() => ({ kind: route.kind,
    client: route.client === "all" ? undefined : route.client as Client,
    project: route.project === "all" ? undefined : route.project,
    ...timeFilters(route.window, route.from, route.to, timeAnchor),
  }), [route.kind, route.client, route.project, route.window, route.from, route.to, timeAnchor, overviewRanking]);
  const query = useMemo<ResourceUsageFilters>(() => ({ ...scopeQuery, q: queryText, sort: route.sort as ResourceUsageFilters["sort"],
    order: route.order, page: route.page, pageSize: route.pageSize, favorite: route.favorite || undefined,
  }), [scopeQuery, queryText, route.sort, route.order, route.page, route.pageSize, route.favorite]);
  const positionQuery = useMemo(() => ({ presence: route.presence === "all" ? undefined : route.presence, scope: route.scope === "all" ? undefined : route.scope,
    locationProject: route.locationProject === "all" ? undefined : route.locationProject, historyProject: scopeQuery.project }), [route.presence, route.scope, route.locationProject, scopeQuery.project]);
  const overviewQuery = useMemo<ResourceOverviewQuery>(() => ({ ...query, ...positionQuery, candidate: overviewCandidates.some(candidate => candidate.value === route.candidate) ? route.candidate as ResourceOverviewCandidate : "all", lowSessions: route.low, inactiveDays: route.inactive }), [query, positionQuery, route.candidate, route.low, route.inactive]);
  const mapQuery = useMemo<ResourceMapQuery>(() => ({ ...scopeQuery, ...positionQuery, q: queryText,
    candidate: overviewCandidates.some(candidate => candidate.value === route.candidate) ? route.candidate as ResourceOverviewCandidate : "all",
    favorite: route.favorite || undefined, lowSessions: route.low, inactiveDays: route.inactive,
    metric: route.metric, maxValue: route.maxValue === "" ? undefined : Number(route.maxValue),
  }), [scopeQuery, positionQuery, queryText, route.candidate, route.favorite, route.low, route.inactive, route.metric, route.maxValue]);
  const listRequestQuery = mapView ? mapQuery : overviewQuery;
  const mapRequestKey = JSON.stringify([mapQuery, reload, historyReload, favoriteReload, managementReload]);
  const evidenceRequestKey = JSON.stringify([scopeQuery, route.evidencePage, route.tool, reload, historyReload]);
  const hasListData = mapView ? !!map : overviewRanking ? !!overview : route.tab === "operations" ? !!operations : !!archives;
  const listProgress = <span className="resource-list-progress" role={listLoading && hasListData ? "status" : undefined} aria-label={listLoading && hasListData ? t("resources.loading.resources") : undefined}>{listLoading && hasListData && <ArrowClockwise size={14} className="spinning" aria-hidden="true" />}</span>;
  useEffect(() => { try { localStorage.setItem("agent-manor:resource-view", route.view); } catch { /* 存储不可用时视图仍可切换。 */ } }, [route.view]);
  const managementQuery = useMemo(() => ({ kind: route.kind, q: queryText, page: route.page, pageSize: route.pageSize }), [route.kind, queryText, route.page, route.pageSize]);
  useEffect(() => {
    if (!active || invalidTime || route.tab !== "usage") return;
    // 证据页返回时复用同范围的完整地图，保持已挂载相机的缩放与位置。
    if (mapView && map && mapLoadedQuery.current === mapRequestKey) { setListLoading(false); setError(null); return; }
    const controller = new AbortController(); setListLoading(true); setError(null);
    const revision = favoriteRevision.current;
    const done = () => { if (!controller.signal.aborted) setListLoading(false); };
    if (mapView) { void resourceApi.map(mapQuery, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      mapLoadedQuery.current = mapRequestKey; setMap(favoriteBase.current ? mapFavorites(result, currentFavorites()) : result);
    }).catch(failure => { if (!isAborted(failure)) setError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }).finally(done); }
    else void resourceApi.overview(overviewQuery, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      const favorites = result.favoriteIds ? acceptFavoriteIds(result.favoriteIds, revision) : currentFavorites();
      setOverview(overviewFavorites(result, favorites)); setStatus(current => current ? { ...current, favoriteIds: [...favorites] } : current);
      if (result.page !== routeRef.current.page) update({ page: result.page });
    }).catch(failure => { if (!isAborted(failure)) setError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }).finally(done);
    return () => controller.abort();
  }, [active, mapView, listRequestQuery, mapRequestKey, overviewRanking, route.tab, reload, historyReload, favoriteReload, managementReload, invalidTime]);
  useEffect(() => {
    if (!active || route.tab === "usage") return;
    const controller = new AbortController(); setListLoading(true); setError(null);
    const task = route.tab === "operations" ? resourceApi.operations(managementQuery, controller.signal).then(result => { if (!controller.signal.aborted) setOperations(result); })
      : resourceApi.archives("recoverable", managementQuery, controller.signal).then(result => { if (!controller.signal.aborted) { setArchives(result); if (result.page !== routeRef.current.page) update({ page: result.page }); } });
    void task.catch(failure => { if (!isAborted(failure)) setError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }).finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => controller.abort();
  }, [active, route.tab, managementQuery, reload, managementReload]);
  useEffect(() => {
    if (!active) return;
    if (!route.id || invalidTime || route.tab !== "usage") { setUsageDetail(null); setOverviewDetail(null); setDetailLoading(false); setDetailError(null); setEvidenceError(null); detailTarget.current = ""; return; }
    const target = JSON.stringify([route.tab, route.kind, route.id]);
    if (detailTarget.current !== target) { setUsageDetail(null); setOverviewDetail(null); setEvidence(null); }
    detailTarget.current = target;
    const controller = new AbortController(); setDetailLoading(true); setDetailError(null); setEvidenceError(null);
    detailPending.current = true;
    const revision = favoriteRevision.current;
    const task = resourceApi.overviewDetail(route.id, { ...scopeQuery, ...positionQuery, lowSessions: route.low, inactiveDays: route.inactive }, controller.signal).then(async result => {
      // 详情与证据同版准备成功后一起替换，更新期间保留完整旧内容。
      const nextEvidence = result.history ? evidenceLoaded.current?.id === result.history.resource.identity.id
        && evidenceLoaded.current.key === evidenceRequestKey && evidence?.version === result.history.version ? evidence : await resourceApi.evidence(result.history.resource.identity.id,
        { ...scopeQuery, version: result.history.version, page: route.evidencePage, pageSize: 10, tool: route.tool || undefined }, controller.signal) : null;
      if (controller.signal.aborted) return;
      if (result.favoriteIds) acceptFavoriteIds(result.favoriteIds, revision);
      if (result.history) evidenceLoaded.current = { id: result.history.resource.identity.id, key: evidenceRequestKey };
      setEvidence(nextEvidence); setEvidenceLoading(false); setOverviewDetail(result); setUsageDetail(result.history); syncFavorites();
    });
    void task.catch(failure => { if (!isAborted(failure)) setDetailError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }).finally(() => { if (!controller.signal.aborted) { detailPending.current = false; setDetailLoading(false); } });
    return () => { controller.abort(); detailPending.current = false; };
  }, [active, route.id, route.tab, scopeQuery, positionQuery, overviewRanking, route.low, route.inactive, reload, historyReload, managementReload, invalidTime]);
  const evidenceId = overviewRanking ? usageDetail?.resource.identity.id : route.id;
  useEffect(() => {
    if (detailPending.current || detailError) return;
    if (!active || !evidenceId || route.tab !== "usage" || invalidTime) { setEvidence(null); setEvidenceLoading(false); return; }
    if (evidenceLoaded.current?.id === evidenceId && evidenceLoaded.current.key === evidenceRequestKey) return;
    const controller = new AbortController(); setEvidenceLoading(true); setEvidenceError(null);
    void resourceApi.evidence(evidenceId, { ...scopeQuery, version: usageDetail?.version, page: route.evidencePage, pageSize: 10, tool: route.tool || undefined }, controller.signal)
      .then(result => { if (!controller.signal.aborted) { evidenceLoaded.current = { id: evidenceId, key: evidenceRequestKey }; setEvidence(result); } }).catch(failure => { if (!isAborted(failure)) setEvidenceError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }).finally(() => { if (!controller.signal.aborted) setEvidenceLoading(false); });
    return () => controller.abort();
  }, [active, evidenceId, evidenceRequestKey, route.tab, route.evidencePage, route.tool, scopeQuery, usageDetail?.version, reload, historyReload, detailLoading, detailError, invalidTime]);
  useEffect(() => {
    if (!active || listLoading || !restoreScroll.current) return;
    const frame = requestAnimationFrame(() => {
      if (!busy.current.list && restoreScroll.current && listScroll.current) { listScroll.current.scrollTop = savedScroll.current; restoreScroll.current = false; }
    });
    return () => cancelAnimationFrame(frame);
  }, [active, listLoading, route.tab, route.kind]);
  useEffect(() => {
    if (!active || detailLoading || evidenceLoading || !returnFromEvidence.current || !usageDetail) return;
    const frame = requestAnimationFrame(() => {
      const element = compact ? detailDialogScroll.current : detailScroll.current;
      if (!busy.current.detail && element && returnFromEvidence.current) { element.scrollTop = savedDetailScroll.current; returnFromEvidence.current = false; }
    });
    return () => cancelAnimationFrame(frame);
  }, [active, detailLoading, evidenceLoading, usageDetail, compact]);

  const favorite = async (id: string, current = !!status?.favoriteIds.includes(id)) => {
    if (favoriteActions.current.has(id)) return;
    favoriteBase.current ??= status?.favoriteIds ?? overview?.favoriteIds ?? [];
    const row = overview?.resources.find(row => row.identity.id === id) ?? (overviewDetail?.resource.identity.id === id ? overviewDetail.resource : null);
    const removedIds = id.startsWith("resource:") ? row?.favoriteIds ?? usageDetail?.origins.map(origin => origin.id).concat(id) ?? [id] : [id];
    favoriteActions.current.set(id, { value: !current, removedIds }); favoriteRevision.current++;
    setFavoritePending(new Set(favoriteActions.current.keys())); setError(null); syncFavorites();
    // 写入按点击顺序保存，各资源仍即时响应；全量收藏响应不会相互覆盖。
    const task = favoriteQueue.current.then(async () => {
      let saved = false;
      try {
        const result = await resourceApi.favorite(id, !current);
        favoriteBase.current = result.favoriteIds;
        saved = true;
      } catch (failure) { setError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }
      finally {
        favoriteActions.current.delete(id); favoriteRevision.current++;
        setFavoritePending(new Set(favoriteActions.current.keys())); syncFavorites();
        const currentRoute = routeRef.current;
        const visible = overviewRef.current?.resources.some(row => row.favoriteIds?.includes(id) || row.localFavoriteIds?.includes(id));
        // 详情可能来自其他分页；只重查列表计数，不重取详情和证据。
        if (saved && (currentRoute.candidate === "favorite" || currentRoute.favorite || currentRoute.view === "map"
          || currentRoute.tab === "usage" && !visible)) setFavoriteReload(value => value + 1);
      }
    });
    favoriteQueue.current = task; await task;
  };
  const refresh = async () => {
    setRefreshing(true); setError(null); setInventoryError(null);
    try { setStatus(await resourceApi.refresh()); setReload(value => value + 1); }
    catch (failure) { setInventoryError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }
    finally { setRefreshing(false); }
  };
  const addSource = async (event: FormEvent) => {
    event.preventDefault(); setSourcePending(true); setSourceError(null);
    try {
      const result = await resourceApi.addSource({ ...source, path: source.path.trim(), keyPath: source.kind === "mcp" ? sourceKeys.split(".").map(key => key.trim()).filter(Boolean) : undefined });
      setStatus(result); setSourceAdding(false); setReload(value => value + 1);
    } catch (failure) { setSourceError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }
    finally { setSourcePending(false); }
  };
  const removeSource = async (id: string) => {
    setSourcePending(true); setSourceError(null);
    try { setStatus(await resourceApi.removeSource(id)); setReload(value => value + 1); }
    catch (failure) { setSourceError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }
    finally { setSourcePending(false); }
  };
  const managementFocusTarget = () => {
    if (managementFocus.current?.isConnected) return managementFocus.current;
    const selector = managementFocusAction.current ? `[data-resource-action="${CSS.escape(managementFocusAction.current)}"]` : null;
    return selector ? document.querySelector<HTMLElement>(`.resource-detail-dialog ${selector}`) ?? document.querySelector<HTMLElement>(selector) : null;
  };
  const showManagement = async (input: ResourceManagementInput) => {
    {
      managementFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      managementFocusAction.current = managementFocus.current?.dataset.resourceAction ?? null;
    }
    const sequence = ++managementRequest.current;
    previewAbort.current?.abort();
    const controller = new AbortController(); previewAbort.current = controller;
    completedPreview.current = null;
    setManagementInput(input); setManagementOpen(true); setDetailsCollapsed(false); setPreview(null); setManagementError(null); setManagementResult(null); setPurgeConfirmed(false); setPreviewLoading(true);
    try {
      const result = await resourceApi.preview(input, controller.signal);
      if (sequence === managementRequest.current) setPreview(result);
    } catch (failure) { if (sequence === managementRequest.current) setManagementError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }
    finally { if (sequence === managementRequest.current) setPreviewLoading(false); }
  };
  const closeManagement = (open: boolean) => {
    if (applying) return;
    if (!open) { managementRequest.current++; previewAbort.current?.abort(); setPreview(null); }
    setManagementOpen(open);
    if (!open) { managementReturnPending.current = true; update({ detail: "locations", ...(routeRef.current.tab === "recovery" && managementResult?.status === "success" ? { id: "" } : {}) }); }
  };
  useEffect(() => {
    if (!managementOpen) return;
    const frame = requestAnimationFrame(() => managementHeading.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [managementOpen]);
  useEffect(() => {
    if (managementOpen || detailLoading || !managementReturnPending.current) return;
    const frame = requestAnimationFrame(() => {
      (managementFocusTarget() ?? document.querySelector<HTMLElement>(".resource-detail-tabs [aria-current=page]"))?.focus();
      managementReturnPending.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [managementOpen, detailLoading, compact]);
  const applyManagement = async () => {
    if (!preview || applying || preview.action === "purge" && !purgeConfirmed) return;
    setApplying(true); setManagementError(null);
    try {
      const result = await resourceApi.apply(preview.id);
      setManagementResult(result); setPreview(null); setManagementReload(value => value + 1);
      completedPreview.current = preview;
    } catch (failure) { setManagementError(failure instanceof Error ? failure : new Error(errorMessage(failure))); setPreview(null); }
    finally { setApplying(false); }
  };
  const reset = () => {
    const defaults = { ...readRoute(), client: "all", project: "all", window: "all", from: "", to: "", q: "", sort: "uses", metric: "uses" as const, order: "desc" as const, candidate: "all" as const, low: 2, inactive: 90, favorite: false, page: 1, pageSize: 20, maxValue: "", presence: "all" as const, scope: "all" as const, locationProject: "all" };
    setQueryText(""); update(defaults);
  };
  const clientOptions = route.tab === "usage" ? status?.clientOptions?.[route.kind].usage : undefined;
  useEffect(() => {
    if (active && !clientCandidatesPending.current && clientOptions && route.client !== "all" && !clientOptions.includes(route.client as Client)) filter({ client: "all" });
  }, [active, clientOptions, route.kind, route.tab, route.client]);
  const projectOptions = [{ value: "all", label: t("resources.project.all") }, { value: "none", label: t("resources.project.none") }, ...(status?.projects ?? []).map(path => ({ value: path, label: shortPath(path), description: path }))];
  const sourceInScope = (item: { client: Client; kind: ResourceKind; scope: "user" | "project"; project?: string }) => item.kind === route.kind && (route.client === "all" || item.client === route.client)
    && (overviewRanking || route.project === "all" || item.scope === "user" || item.project === route.project);
  const visibleSources = sourcesOpen && active ? [...new Map(sourceStatus?.sources.filter(sourceInScope).map(source => [JSON.stringify([source.path, source.scope, source.project]), source]) ?? []).values()] : [];
  const sourceCurrentPage = Math.min(sourcePage, Math.max(1, Math.ceil(visibleSources.length / 50)));
  const visibleSourcePaths = new Map(sourceStatus?.sources.filter(sourceInScope).map(item => [item.id, item.path]));
  const visibleGaps = sourcesOpen && active ? [...new Map(sourceStatus?.gaps.filter(gap => visibleSourcePaths.has(gap.sourceId) && ["unreadable", "invalid", "limit"].includes(gap.reason)).map(gap => [JSON.stringify([visibleSourcePaths.get(gap.sourceId), gap.reason]), gap]) ?? []).values()] : [];
  const visibleDiagnostics = sourcesOpen && active ? [...new Map(sourceStatus?.diagnostics?.filter(item => sourceInScope(item) && ["conflict", "invalid_reference"].includes(item.reason)).map(item => [JSON.stringify([item.path, item.reason]), item]) ?? []).values()] : [];
  const historyView = route.tab === "usage";
  const filters = historyView ? <div className="resource-filter-content" id={compact ? undefined : "resource-filter-content"}>
    {historyView && <>
      <div className="resource-field"><span>{t("resources.workspace.localState")}</span><FilterSelect label={t("resources.workspace.localState")} value={route.presence} options={["all", "present", "missing", "unknown"].map(value => ({ value, label: t(`resources.workspace.presence.${value}`) }))} onChange={value => filter({ presence: value as ResourceRoute["presence"] })} /></div>
      <div className="resource-field"><span>{t("resources.workspace.locationScope")}</span><FilterSelect label={t("resources.workspace.locationScope")} value={route.scope} options={[{ value: "all", label: t("resources.workspace.allScopes") }, { value: "user", label: t("resources.scope.user") }, { value: "project", label: t("resources.scope.project") }]} onChange={value => filter({ scope: value as ResourceRoute["scope"], locationProject: "all" })} /></div>
      {route.scope === "project" && <div className="resource-field"><span>{t("resources.workspace.locationProject")}</span><ProjectPicker label={t("resources.workspace.locationProject")} value={route.locationProject} options={projectOptions.filter(option => option.value !== "none")} onChange={value => filter({ locationProject: value })} /></div>}
      <div className="resource-field"><span>{t("resources.time.label")}</span><FilterSelect label={t("resources.time.filter")} value={route.window} options={[{ value: "all", label: t("resources.time.all") }, { value: "7", label: t("resources.time.seven") }, { value: "30", label: t("resources.time.thirty") }, { value: "90", label: t("resources.time.ninety") }, { value: "custom", label: t("resources.time.custom") }]} onChange={value => { setTimeAnchor(Date.now()); filter({ window: value }); }} /></div>
      {route.window === "custom" && <div className="resource-date-fields"><div className="resource-field"><span>{t("resources.time.from")}</span><DatePicker label={t("resources.time.startDate")} value={route.from} onChange={value => filter({ from: value })} /></div><div className="resource-field"><span>{t("resources.time.to")}</span><DatePicker label={t("resources.time.endDate")} value={route.to} onChange={value => filter({ to: value })} /></div></div>}
    </>}
    <details className="resource-more-filters"><summary>{t("resources.workspace.moreFilters")}</summary>
      <div className="resource-field"><span>{t("resources.workspace.usageClient")}</span><FilterSelect label={t("resources.workspace.usageClient")} value={route.client} options={[{ value: "all", label: t("resources.client.all") }, ...availableClientOptions(status?.clientOptions?.[route.kind].usage)]} onChange={value => filter({ client: value })} /></div>
      <div className="resource-field"><span>{t("resources.workspace.usageProject")}</span><ProjectPicker label={t("resources.workspace.usageProject")} value={route.project} options={projectOptions} onChange={value => filter({ project: value })} /></div>
      {historyView && <div className="resource-field"><span>{t("resources.attention.filter")}</span><FilterSelect label={t("resources.attention.filter")} value={["low", "old"].includes(route.candidate) ? route.candidate : "all"} options={[{ value: "all", label: t("resources.attention.any") }, ...overviewCandidates.filter(candidate => ["low", "old"].includes(candidate.value)).map(candidate => ({ value: candidate.value, label: t(candidate.labelKey) }))]} onChange={value => filter({ candidate: value as ResourceRoute["candidate"] })} /></div>}
      {route.candidate === "low" && <label className="resource-field">{t("resources.candidate.lowThreshold")}<input type="number" min="1" max="10000" aria-label={t("resources.candidate.lowThresholdAria")} value={route.low} onChange={event => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value > 0 && value <= 10000) filter({ low: value }); }} /></label>}
      {route.candidate === "old" && <label className="resource-field">{t("resources.candidate.oldThreshold")}<input type="number" min="1" max="3650" aria-label={t("resources.candidate.oldThresholdAria")} value={route.inactive} onChange={event => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value > 0 && value <= 3650) filter({ inactive: value }); }} /></label>}
    </details>
    <button className="button subtle resource-reset" onClick={reset}>{t("resources.filters.reset")}</button>
  </div> : null;

  const selectedArchive = archives?.archives.find(item => item.id === route.id);
  const selectedOperation = operations?.operations.find(item => item.id === route.id);
  const selectedResource = overviewDetail?.resource;
  const locations = useMemo(() => resourceLocationGroups(overviewDetail?.local ?? [], route.kind), [overviewDetail?.local, route.kind]);
  const hasDetailData = !!overviewDetail;
  const evidenceLinks = (limit?: number) => evidence?.events.length ? <>
    <div className="resource-evidence">{evidence.events.slice(0, limit).map(event => <a key={event.id} href={`#sessions?${new URLSearchParams({ id: event.sessionId, mode: "trace", message: event.messageId, branch: "all" })}`} onClick={click => { if (!click.metaKey && !click.ctrlKey && !click.shiftKey && click.button === 0) { click.preventDefault(); savedScroll.current = listScroll.current?.scrollTop ?? 0; savedDetailScroll.current = (compact ? detailDialogScroll.current : detailScroll.current)?.scrollTop ?? 0; returnFromEvidence.current = true; onSession({ sessionId: event.sessionId, messageId: event.messageId }); } }}>
      <div><strong>{event.tool ?? t(evidenceNames[event.kind])}</strong><span className={`resource-result is-${event.status}`}>{t(resultNames[event.status])}</span><ArrowSquareOut size={14} /></div><span>{t(evidenceNames[event.kind])} · {dateLabel(event.occurredAt)}</span>{event.pairing === "ambiguous" && <span className="resource-result is-unknown">{t("resources.evidence.pairingAmbiguous")}</span>}
    </a>)}</div>{!limit && <ResourcePagination page={evidence.page} total={evidence.total} pageSize={evidence.pageSize} label={t("resources.evidence.title")} onChange={page => update({ evidencePage: page })} />}
  </> : <ResourceEmpty>{t("resources.evidence.empty")}</ResourceEmpty>;
  const knownAffected = [...new Map((preview?.affectedEntries ?? []).map(entry => [entry.entryPath, entry])).values()];
  const relatedLocations = knownAffected.filter(entry => entry.entryPath !== (preview?.originalPath ?? preview?.destinationPath ?? preview?.sourcePath));
  const knownRevealed = [...new Map((preview?.revealedEntries ?? []).map(entry => [JSON.stringify([entry.entryPath, entry.scope, entry.project]), entry])).values()];
  const confirmationKey = preview ? preview.action === "restore" ? restoreActionKey(preview) : preview.action === "disable" ? disableActionKey(undefined, preview) : preview.action === "trash" ? preview.configuration?.kind === "registration" ? "resources.workspace.removeRegistration" : preview.link ? "resources.management.linkAction" : "resources.workspace.trashLocation" : "resources.management.confirm" : "";
  const management = <section className="resource-preview-panel" aria-label={t("resources.workspace.changePreview")}>
    <button className="text-button resource-preview-back" disabled={applying} onClick={() => closeManagement(false)}><CaretLeft size={14} />{t(route.tab === "recovery" ? "resources.recovery.back" : "resources.workspace.backToLocations")}</button>
    <h2 tabIndex={-1} ref={managementHeading}>{managementResult ? t("resources.recovery.resultTitle") : managementInput ? t("resources.management.actionPreview", { action: preview?.action === "restore" ? t(restoreActionKey(preview)) : t(actionNames[managementInput.action]) }) : t("resources.management.preview")}</h2>

      {previewLoading ? <div className="resource-loading" role="status">{t("resources.management.loading")}</div> : preview ? <>
        <div className="resource-preview-heading"><strong>{preview.resource.name}</strong></div>
        <ResourceChange preview={preview} />
        {!(preview.action === "restore" && preview.link) && <p className="resource-management-note">{t(preview.action === "purge" ? preview.link ? "resources.workspace.purgeLinkEffect" : "resources.workspace.purgeEffect" : preview.action === "restore" ? "resources.workspace.restoreEffect" : preview.configuration ? "resources.workspace.configRecovery" : "resources.workspace.fileRecovery")}</p>}

        {preview.protected && <div className="resource-alert" role="alert">{preview.protectionReasons.length ? formatList(preview.protectionReasons.map(reason => protectionNames[reason] ? t(protectionNames[reason]!) : t("common.originalDetail", { detail: reason }))) : t("resources.management.protected")}</div>}
        {!preview.configuration && !!relatedLocations.length && <details className="resource-data-details"><summary>{t("resources.workspace.relatedLocations")}</summary><div className="resource-preview-entries">{relatedLocations.map(entry => <div key={entry.entryPath}><p>{entry.entryPath}</p></div>)}</div><p className="resource-management-note">{t("resources.management.referencesUnknown")}</p></details>}

        {!!knownRevealed.length && <section className="resource-detail-section"><header><h3>{t("resources.management.revealedEntries")}</h3><span className="resource-state is-warning">{t("resources.entryCount", { count: knownRevealed.length })}</span></header><div className="resource-preview-entries">{knownRevealed.map((entry, index) => <div key={`${entry.client}:${entry.scope}:${entry.project ?? ""}:${entry.entryPath}:${index}`}><strong>{entry.name}</strong><span>{entry.scope === "user" ? t("resources.scope.userDefault") : entry.project ?? t("resources.project.unknown")}</span><p>{entry.entryPath}</p></div>)}</div></section>}
        {preview.action === "purge" && <label className="resource-checkbox resource-purge-confirm"><input type="checkbox" checked={purgeConfirmed} onChange={event => setPurgeConfirmed(event.target.checked)} />{t("resources.management.confirmPurge")}</label>}
        <div className="dialog-end"><button className="button subtle" disabled={applying} onClick={() => closeManagement(false)}>{t("common.cancel")}</button><button className={`button ${preview.action === "trash" || preview.action === "purge" ? "resource-danger-button" : "primary"}`} disabled={applying || preview.action === "purge" && !purgeConfirmed} onClick={() => void applyManagement()}>{applying ? t("resources.management.applying") : t(confirmationKey, { action: t(actionNames[preview.action]) })}</button></div>
      </> : managementResult ? <>
        <div className="resource-preview-heading"><strong>{managementResult.name}</strong></div>
        <div className={`resource-${managementResult.status === "success" ? "feedback" : "alert"}`} role={managementResult.status === "success" ? "status" : "alert"}>{t(managementResult.status === "success" && completedPreview.current ? managementSuccessKey(completedPreview.current, managementResult) : operationStatusNames[managementResult.status])}</div>
        {managementResult.status !== "success" && <ResourceMessage descriptor={managementResult.messageDescriptor} original={managementResult.message} details={managementResult.details} />}
        <div className="dialog-end">{managementResult.archiveId && ["disable", "trash", "standby"].includes(managementResult.action) && <button className="button" onClick={() => void showManagement({ action: "restore", operationId: managementResult.id })}>{t("resources.recovery.previewAction", { action: completedPreview.current ? t(restoreActionKey(completedPreview.current)) : t("resources.action.restore") })}</button>}{managementResult.status !== "success" && managementInput && <button className="button" onClick={() => void showManagement(managementInput)}>{t("resources.management.previewAgain")}</button>}<button className="button primary" onClick={() => closeManagement(false)}>{t("resources.done")}</button></div>
      </> : null}
      {managementError && <div className="resource-alert" role="alert"><ResourceErrorText error={managementError} /></div>}
      {managementError && !preview && managementInput && <div className="dialog-end"><button className="button subtle" onClick={() => closeManagement(false)}>{t("common.cancel")}</button><button className="button" onClick={() => void showManagement(managementInput)}>{t("resources.management.previewAgain")}</button></div>}
  </section>;
  const detail = managementOpen ? management : <>
    {(detailError || evidenceError) && <div className="resource-alert" role="alert"><ResourceErrorText error={detailError ?? evidenceError!} /><button className="text-button" onClick={() => setReload(value => value + 1)}>{t("common.retry")}</button></div>}
    <div className="resource-detail-body" aria-busy={detailLoading || evidenceLoading} inert={detailLoading || evidenceLoading || refreshing || !!detailError || !!evidenceError}>
    {detailError && !hasDetailData ? null : detailLoading && !hasDetailData ? <div role="status" className="resource-loading">{t("resources.loading.detail")}</div> : overviewDetail && selectedResource ? <>
      <div className="resource-detail-heading"><h2>{messageText(selectedResource.identity.nameDescriptor, selectedResource.identity.name)}</h2><FavoriteButton name={messageText(selectedResource.identity.nameDescriptor, selectedResource.identity.name)} favorite={selectedResource.favorite} disabled={favoritePending.has(selectedResource.identity.id)} onClick={() => void favorite(selectedResource.identity.id, selectedResource.favorite)} /></div>
      <SkillDescription description={selectedResource.description} />
      <nav className="resource-detail-tabs" aria-label={t("resources.workspace.detailSections")}>{["overview", "locations", "history"].map(value => <button key={value} aria-current={route.detail === value ? "page" : undefined} onClick={() => update({ detail: value as ResourceRoute["detail"] })}>{t(value === "locations" ? route.kind === "skill" ? "resources.workspace.fileLocations" : "resources.workspace.configLocations" : `resources.workspace.${value}`)}</button>)}</nav>
      {route.detail === "locations" ? <div className="resource-location-list">
        {locations.length ? locations.map((row, index) => {
          const legacyIds = [...new Set(row.entries.flatMap(entry => [entry.bodyId, entry.id]))].filter(id => status?.favoriteIds.includes(id));
          return <ManagementBody key={row.key ?? row.body.id} row={row} index={index} onManage={input => void showManagement(input)} legacyFavorite={!!legacyIds.length} onClearFavorite={() => { for (const id of legacyIds) void favorite(id, true); }} />;
        }) : <ResourceEmpty>{t("resources.management.historyOnly")}</ResourceEmpty>}
      </div> : route.detail === "history" ? <>
        <Stats stats={selectedResource.stats} kind={route.kind} />
        {usageDetail ? <>
        <ResourceTrend rows={usageDetail.trend} timeZone={usageDetail.timeZone} kind={route.kind} />
        <Distribution rows={usageDetail.clients} title={t("resources.distribution.clients")} label={value => value ? clientLabel(value as Client) : t("resources.client.notRecorded")} />
        <Distribution rows={usageDetail.projects} title={t("resources.distribution.projects")} label={value => value ? shortPath(value) : t("resources.project.none")} />
        <HistoryGaps gaps={usageDetail.coverage.gaps} />
        {route.kind === "mcp" && <section className="resource-detail-section"><header><h3>{t("resources.stat.toolCalls")}</h3></header><div className="resource-tool-list">{usageDetail.tools.map(tool => <button key={tool.name} className={route.tool === tool.name ? "is-selected" : ""} aria-pressed={route.tool === tool.name} onClick={() => update({ tool: route.tool === tool.name ? "" : tool.name, evidencePage: 1 })}><strong>{tool.name}</strong><span>{t("resources.callCount", { count: tool.stats.mcpCalls })}</span><small>{t("resources.toolResults", { failure: tool.stats.results.failure, unknown: tool.stats.results.unknown, duration: tool.stats.duration.samples ? t("resources.durationSamples", { duration: Math.round(tool.stats.duration.averageMs!), count: tool.stats.duration.samples }) : t("resources.evidence.durationMissing") })}</small></button>)}</div></section>}
        <section className="resource-detail-section"><header><h3>{route.tool ? t("resources.toolEvidence", { name: route.tool }) : t("resources.evidence.title")}</h3>{route.tool && <button className="text-button" onClick={() => update({ tool: "", evidencePage: 1 })}>{t("resources.evidence.allTools")}</button>}</header>{evidenceLinks()}</section>
      </> : <ResourceEmpty>{t("resources.evidence.empty")}</ResourceEmpty>}</> : <>
        <p className="resource-history-scope">{t("resources.workspace.historyScope", { client: route.client === "all" ? t("resources.client.all") : clientLabel(route.client as Client), project: route.project === "all" ? t("resources.project.all") : shortPath(route.project) })}</p>
        <div className="resource-overview-stats"><div><span>{usageMetricLabel(route.kind)}</span><strong>{selectedResource.stats ? fmt(selectedResource.stats.events) : "—"}</strong></div><div><span>{t("resources.column.sessions")}</span><strong>{selectedResource.stats ? fmt(selectedResource.stats.sessions) : "—"}</strong></div><div><span>{t("resources.column.recent")}</span><strong className="resource-overview-date">{selectedResource.stats?.lastUsedAt ? dateLabel(selectedResource.stats.lastUsedAt) : "—"}</strong></div></div>
        <section className="resource-detail-section"><header><h3>{t(route.kind === "skill" ? "resources.workspace.fileLocations" : "resources.workspace.configLocations")}</h3><button className="text-button" onClick={() => update({ detail: "locations" })}>{t("resources.workspace.viewLocations")}<CaretRight size={14} /></button></header>
          {locations.length ? locations.map(row => <button className="resource-location-link" key={row.key ?? row.body.id} onClick={() => update({ detail: "locations" })}><span>{formatList(resourceLocationScopes(row.entries).map(scope => t(scope === "user" ? "resources.scope.user" : "resources.scope.project")))}</span><code>{row.body.targetPath ?? row.entries[0]?.entryPath}</code></button>) : <p className="resource-management-note">{t(selectedResource.localSummary?.presence === "unknown" ? "resources.workspace.presenceUnknown" : "resources.management.historyOnly")}</p>}
        </section>
        {usageDetail && <section className="resource-detail-section"><header><h3>{t("resources.workspace.recentUsage")}</h3><button className="text-button" onClick={() => update({ detail: "history" })}>{t("resources.workspace.allRecords")}<CaretRight size={14} /></button></header>{evidenceLinks(3)}</section>}
      </>}
    </> : selectedArchive && !historyView && route.tab !== "operations" ? <>
      <div className="resource-detail-heading"><div><h2>{selectedArchive.entry.name}</h2></div></div>
      <p className="resource-recovery-description">{t(`resources.recovery.description.${recoveryKind(selectedArchive)}`)}</p>{selectedArchive.operationStatus === "partial" && <p className="resource-state is-warning">{t("resources.operation.partial")}</p>}
      <dl className="resource-facts"><dt>{t("resources.facts.original")}</dt><dd>{selectedArchive.originalPath}</dd>{selectedArchive.state !== "disabled" && <><dt>{t("resources.facts.scope")}</dt><dd>{selectedArchive.entry.scope === "user" ? t("resources.scope.user") : selectedArchive.entry.project ?? t("resources.project.unknown")}</dd></>}<dt>{t("resources.facts.managementTime")}</dt><dd>{dateLabel(selectedArchive.createdAt)}</dd></dl>
      {selectedArchive.entry.entryType === "symlink" && selectedArchive.state !== "disabled" && selectedArchive.entry.readState === "broken" && <p className="resource-management-note">{t("resources.workspace.removedBrokenLink")}</p>}
      <div className="resource-entry-actions"><button className="button primary" disabled={!selectedArchive.restorable} onClick={() => void showManagement({ action: "restore", operationId: selectedArchive.operationId })}>{t("resources.recovery.previewAction", { action: t(`resources.recovery.restore.${recoveryKind(selectedArchive)}`) })}</button>
        {selectedArchive.storedPath && <DropdownMenu.Root><DropdownMenu.Trigger className="icon-button" aria-label={t("resources.recovery.moreActions")}><DotsThree size={22} /></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="resource-tools-menu" align="start" sideOffset={7}><DropdownMenu.Item className="resource-tools-item" onSelect={() => void showManagement({ action: "purge", operationId: selectedArchive.operationId })}>{t("resources.recovery.clearMaterial")}</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}
      </div>
    </> : selectedOperation && route.tab === "operations" ? <>
      <div className="resource-detail-heading"><div><h2>{selectedOperation.name}</h2></div></div>
      <div className="resource-tags"><span>{t(actionNames[selectedOperation.action])}</span><span className={selectedOperation.status === "success" ? "" : "is-warning"}>{t(operationStatusNames[selectedOperation.status])}</span></div>
      {selectedOperation.status !== "success" && <ResourceMessage descriptor={selectedOperation.messageDescriptor} original={selectedOperation.message} details={selectedOperation.details} />}
      <dl className="resource-facts"><dt>{t("resources.facts.executionTime")}</dt><dd>{dateLabel(selectedOperation.createdAt)}</dd><dt>{t("resources.facts.scope")}</dt><dd>{selectedOperation.resource.scope === "user" ? t("resources.scope.user") : selectedOperation.resource.project ?? t("resources.project.unknown")}</dd><dt>{t("resources.facts.localState")}</dt><dd>{selectedOperation.localState === "changed" ? t("resources.localState.changed") : selectedOperation.localState === "partial" ? t("resources.localState.partial") : t("resources.localState.unchanged")}</dd></dl>
      {selectedOperation.archiveId && ["disable", "standby", "trash"].includes(selectedOperation.action) && <button className="button" onClick={() => switchView("recovery", { q: selectedOperation.name, id: "", page: 1 })}>{t("resources.archive.viewRecovery")}</button>}
    </> : <ResourceEmpty>{t("resources.detail.empty")}</ResourceEmpty>}
    </div>
  </>;

  const navigation = (mobile = false) => <nav className={mobile ? "resource-mobile-navigation" : "resource-management-nav"} aria-label={t("resources.recovery.navigation")}>{tabs.map(tab => {
    const Icon = tab.value === "usage" ? List : tab.value === "recovery" ? ArrowCounterClockwise : ClockCounterClockwise;
    return <button key={tab.value} disabled={applying} aria-current={route.tab === tab.value ? "page" : undefined} onClick={() => switchView(tab.value)}><Icon size={17} aria-hidden="true" />{t(tab.labelKey)}</button>;
  })}</nav>;
  const tools = <DropdownMenu.Root><DropdownMenu.Trigger className="icon-button" aria-label={t("resources.workspace.tools")}><DotsThree size={22} /></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="resource-tools-menu" align="end" sideOffset={7} collisionPadding={12}>
    <DropdownMenu.Item className="resource-tools-item" onSelect={() => setSourcesOpen(true)}>{t("resources.workspace.scanSettings")}</DropdownMenu.Item>
  </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>;

  return <div className="resources-shell" aria-label={t("resources.title")} data-compact={compact} data-resource-view={mapView ? "map" : "list"} onKeyDown={event => { if (event.key === "Escape" && !compact && !document.fullscreenElement && !event.defaultPrevented && !(event.target instanceof Element && event.target.closest("input, [role=combobox], [role=dialog], [role=menu]"))) { event.preventDefault(); if (managementOpen) closeManagement(false); else closeDetails(); } }}>
    <ResizableWorkspace variant="resources" sidebarCollapsed={sidebarCollapsed} detailsCollapsed={detailsCollapsed} semantics={{ sidebar: { label: t("resources.layout.sidebarWidth"), controls: "resource-sidebar-content" }, details: { label: t("resources.layout.detailsWidth"), controls: "resource-detail-content" } }}>
      <aside className={`sidebar resource-sidebar${sidebarCollapsed ? " panel-collapsed" : ""}`} aria-label={t("resources.recovery.navigation")}>
        <div className="pane-heading"><span>{t("resources.recovery.navigation")}</span><button className="icon-button panel-toggle" aria-label={sidebarCollapsed ? t("resources.recovery.expandSidebar") : t("resources.recovery.collapseSidebar")} aria-expanded={!sidebarCollapsed} aria-controls="resource-sidebar-content" onClick={() => setSidebarCollapsed(value => !value)}>{sidebarCollapsed ? <CaretRight size={17} /> : <CaretLeft size={17} />}</button></div><div id="resource-sidebar-content" className="resource-sidebar-content" hidden={sidebarCollapsed || compact}>{!sidebarCollapsed && !compact && <>{navigation()}{historyView && <div className="resource-sidebar-filters">{filters}</div>}</>}</div>
      </aside>
      <main className="resources-main">
        <header className="resources-heading"><h1>{t("resources.title")}</h1><div className="resource-kind-tabs" role="group" aria-label={t("resources.kind.label")}>{(["skill", "mcp"] as const).map(kind => <button key={kind} disabled={applying} aria-pressed={route.kind === kind} className={route.kind === kind ? "is-selected" : ""} onClick={() => switchView(route.tab, {}, kind)}>{kind === "skill" ? t("resources.kind.skill") : t("resources.kind.mcp")}</button>)}<UsageHelp kind={route.kind} /></div><div className="resources-heading-actions">{historyView && <button className="icon-button resource-mobile-filter" aria-label={t("resources.filters.open")} onClick={() => setFiltersOpen(true)}><Funnel size={18} /></button>}<RefreshControl label={t("resources.refresh.label")} busy={refreshing} onRefresh={() => void refresh()} error={!!inventoryError} completedAt={status?.observedAt ?? undefined} details={<p>{t("common.refresh.resourceScope")}</p>} />{tools}</div></header>

        {navigation(true)}
        <div className="resource-list-toolbar">
          <label className="resource-search"><MagnifyingGlass size={16} aria-hidden="true" /><input aria-label={t("resources.search.label")} value={route.q} placeholder={t("resources.search.label")} onChange={event => filter({ q: event.target.value })} />{route.q && <button className="icon-button" aria-label={t("resources.search.clear")} onClick={() => filter({ q: "" })}><X size={14} /></button>}</label>
          {overviewRanking && <div className="resource-display-switch" role="group" aria-label={t("resources.view.display")}>{(["list", "map"] as const).map(view => <button key={view} aria-pressed={route.view === view} onClick={() => update({ view })}>{view === "list" ? <List size={15} aria-hidden="true" /> : <MapTrifold size={15} aria-hidden="true" />}{view === "list" ? t("resources.view.list") : t("resources.view.map")}</button>)}</div>}
        </div>
        {!overviewRanking && <div className="resource-list-summary">
          {listProgress}
          {!historyView && <strong>{t(tabs.find(tab => tab.value === route.tab)!.labelKey)}</strong>}
          {route.tab === "operations" && operations && <span>{t("resources.operationCount", { count: operations.total })}</span>}{!historyView && route.tab !== "operations" && archives && <span>{t("resources.resourceCount", { count: archives.total })}</span>}
        </div>}
        {mapView && <div className="resource-map-settings">
          {mapView && <><FilterSelect label={t("resources.map.metricFilter")} value={route.metric} options={[{ value: "uses", label: usageMetricLabel(route.kind) }, { value: "sessions", label: t("resources.sort.sessions") }]} onChange={value => filter({ metric: value as ResourceRoute["metric"], maxValue: "" })} /><label className="resource-map-limit">{(route.metric === "sessions" ? t("resources.sort.sessions") : usageMetricLabel(route.kind))} ≤<input type="number" min="0" step="1" aria-label={t("resources.map.limit", { metric: (route.metric === "sessions" ? t("resources.sort.sessions") : usageMetricLabel(route.kind)) })} value={route.maxValue} placeholder={t("resources.map.unlimited")} onChange={event => { const value = event.target.value; if (value === "" || /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) filter({ maxValue: value }); }} /></label></>}
        </div>}
        {invalidTime && <div className="resource-alert" role="alert">{t("resources.time.invalidRange")}</div>}
        {inventoryError && <div className="resource-alert" role="alert"><ResourceErrorText error={inventoryError} /><button className="text-button" disabled={refreshing} onClick={() => void refresh()}>{t("common.retry")}</button></div>}
        {error && <div className="resource-alert" role="alert"><ResourceErrorText error={error} /><button className="text-button" onClick={() => setReload(value => value + 1)}>{t("common.retry")}</button></div>}
        {overviewRanking && overviewData && <>
          <div className="resource-quick-filters" role="group" aria-label={t("resources.quickFilters", { kind: route.kind === "skill" ? t("resources.kind.skill") : t("resources.kind.mcp") })}>
            <div className="resource-usage-filters" role="group" aria-label={t("resources.usageStates")}>{overviewCandidates.slice(0, 3).map(candidate => <button key={candidate.value} aria-pressed={route.candidate === candidate.value || candidate.value === "all" && !overviewCandidates.some(item => item.value === route.candidate)} onClick={() => filter({ candidate: candidate.value, favorite: false })}>{t(candidate.labelKey)}<strong>{fmt(overviewData.counts[candidate.value])}</strong></button>)}</div>
            <div className="resource-attention-filters" data-active={["low", "old"].includes(route.candidate)} role="group" aria-label={t("resources.attention.filter")}>
              {listProgress}

              <button aria-pressed={route.candidate === "favorite"} onClick={() => filter({ candidate: route.candidate === "favorite" ? "all" : "favorite", favorite: false })}><Star size={14} weight={route.candidate === "favorite" ? "fill" : "regular"} aria-hidden="true" />{t("resources.candidate.favorite")}<strong>{fmt(overviewData.counts.favorite)}</strong></button>
            </div>
          </div>

        </>}
        <div className={`resource-list-scroll${mapView ? " resource-map-scroll" : ""}`} ref={listScroll} aria-busy={listLoading} inert={listLoading || refreshing || !!error}>
          {listLoading && !hasListData ? <div role="status" className="resource-loading">{t("resources.loading.resources")}</div> : invalidTime ? null : mapView ? map && <ResourceMap data={map} selected={route.id} onSelect={select} /> : overviewRanking ? overview?.resources.length ? <OverviewTable rows={overview.resources} route={route} onSort={sort} onSelect={select} onFavorite={(id, current) => void favorite(id, current)} favoritePending={favoritePending} /> : <ResourceEmpty>{t("resources.empty.kind", { kind: route.kind === "skill" ? t("resources.kind.skill") : t("resources.kind.mcp") })}</ResourceEmpty> : route.tab === "operations" ? operations?.operations.length ? <div className="resource-rows">{operations.operations.map(operation => <div className={`resource-row${route.id === operation.id ? " is-selected" : ""}`} key={operation.id}><button className="resource-row-main" aria-label={t("resources.viewOperation", { name: operation.name, action: t(actionNames[operation.action]) })} onClick={() => select(operation.id)}><div className="resource-row-heading"><strong>{operation.name}</strong><span>{t(actionNames[operation.action])}</span></div><div className="resource-row-metrics"><span>{t(operation.resource.scope === "user" ? "resources.scope.user" : "resources.scope.project")}</span><span>{dateLabel(operation.createdAt)}</span></div><div className="resource-tags"><span className={operation.status === "success" ? "" : "is-warning"}>{t(operationStatusNames[operation.status])}</span></div></button></div>)}</div> : <ResourceEmpty>{t("resources.empty.operations")}</ResourceEmpty> : archives?.archives.length ? <div className="resource-rows">{archives.archives.map(archive => <div className={`resource-row${route.id === archive.id ? " is-selected" : ""}`} key={archive.id}><button className="resource-row-main" aria-label={t("resources.viewRecovery", { name: archive.entry.name })} onClick={() => select(archive.id)}><div className="resource-row-heading"><strong>{archive.entry.name}</strong></div><div className="resource-row-subtitle" title={archive.originalPath}>{archive.originalPath}</div><div className="resource-row-metrics"><span>{dateLabel(archive.createdAt)}</span></div><div className="resource-row-metrics"><span>{t(`resources.recovery.description.${recoveryKind(archive)}`)}</span>{archive.operationStatus === "partial" && <span className="is-warning">{t("resources.operation.partial")}</span>}</div></button></div>)}</div> : <ResourceEmpty>{t("resources.recovery.empty")}</ResourceEmpty>}
        </div>
        {overviewRanking && !mapView && overview && <ResourcePagination page={overview.page} total={overview.total} pageSize={overview.pageSize} label={overviewLabel} onPageSizeChange={pageSize => filter({ pageSize })} onChange={pageChange} />}
        {route.tab === "operations" && operations && <ResourcePagination page={operations.page} total={operations.total} pageSize={operations.pageSize} label={t("resources.tab.operations")} onPageSizeChange={pageSize => filter({ pageSize })} onChange={pageChange} />}
        {!historyView && route.tab !== "operations" && archives && <ResourcePagination page={archives.page} total={archives.total} pageSize={archives.pageSize} label={t("resources.archive.records")} onPageSizeChange={pageSize => filter({ pageSize })} onChange={pageChange} />}
      </main>
      <aside className={`resource-details${detailsCollapsed ? " panel-collapsed" : ""}`} aria-label={t("resources.detail.title")}>
        <div className="pane-heading"><span className="resource-detail-label">{t("resources.detail.title")}<span className="resource-detail-progress" role={detailLoading && hasDetailData ? "status" : undefined} aria-label={detailLoading && hasDetailData ? t("resources.loading.detail") : undefined}>{detailLoading && hasDetailData && <ArrowClockwise size={14} className="spinning" aria-hidden="true" />}</span></span><button className="icon-button panel-toggle" aria-label={detailsCollapsed ? t("resources.detail.expand") : t("resources.detail.collapse")} aria-expanded={!detailsCollapsed} aria-controls="resource-detail-content" onClick={() => detailsCollapsed ? setDetailsCollapsed(false) : closeDetails()}>{detailsCollapsed ? <CaretLeft size={17} /> : <CaretRight size={17} />}</button></div>
        <div className="resource-detail-scroll" ref={detailScroll} id="resource-detail-content" hidden={detailsCollapsed}>{!compact && detail}</div>
      </aside>
    </ResizableWorkspace>
    <ResourceDialog open={compact && historyView && filtersOpen && active} onOpenChange={setFiltersOpen} title={t("resources.filters.title")} description={t("resources.filters.description")} className="resource-filter-dialog">{filters}<div className="dialog-end"><button className="button primary" onClick={() => setFiltersOpen(false)}>{t("resources.done")}</button></div></ResourceDialog>
    <ResourceDialog open={compact && (!!route.id || managementOpen) && active} onOpenChange={open => { if (!open) { if (managementOpen) closeManagement(false); else update({ id: "" }); } }} title={t("resources.detail.title")} description={route.kind === "skill" ? t("resources.detail.skillDescription") : t("resources.detail.mcpDescription")} className="resource-detail-dialog" contentRef={detailDialogScroll}>{detail}</ResourceDialog>
    <ResourceDialog open={sourcesOpen && active} onOpenChange={setSourcesOpen} title={t("resources.source.title")} description={t("resources.source.lastScanned", { date: status?.observedAt ? dateLabel(status.observedAt) : t("resources.source.neverScanned") })}>
      {sourceError && <div className="resource-alert" role="alert"><ResourceErrorText error={sourceError} /><button className="text-button" onClick={() => setSourcesRetry(value => value + 1)}>{t("common.retry")}</button></div>}
      {sourcesLoading && <div className="resource-loading" role="status">{t("resources.loading.detail")}</div>}
      <div className="resource-scan-actions"><button className="button" onClick={() => { const client = route.client === "all" ? "codex" : route.client as Client; setSource({ client, kind: route.kind, path: "", format: route.kind === "skill" ? "skill-directory" : client === "codex" ? "toml" : "json" }); setSourceKeys(registrationKeys(client)); setSourceError(null); setSourcesOpen(false); setSourceAdding(true); }}><Plus size={14} />{t("resources.source.add")}</button></div>
      {!visibleGaps.length && !visibleDiagnostics.length && !sourcesLoading && <p className="resource-management-note">{t("resources.workspace.scanClear")}</p>}
      <details className="resource-data-details" open={sourceLocationsOpen} onToggle={event => setSourceLocationsOpen(event.currentTarget.open)}><summary>{t("resources.workspace.scanLocations", { count: visibleSources.length })}</summary>
      <div className="resource-source-list">{sourceLocationsOpen && visibleSources.slice((sourceCurrentPage - 1) * 50, sourceCurrentPage * 50).map(item => { const manual = item.manualSourceId ? sourceStatus?.manualSources.find(source => source.id === item.manualSourceId) : undefined; return <div key={item.id}><header><strong>{clientLabel(item.client)} · {item.kind === "skill" ? t("resources.kind.skill") : t("resources.kind.mcp")}</strong><span className={`resource-state${item.readState !== "ok" ? " is-warning" : ""}`}>{t(sourceStateNames[item.readState])}</span></header><p>{item.path}</p><div className="resource-tags"><span>{item.scope === "user" ? t("resources.scope.user") : t("resources.scope.project")}</span><span>{item.format}</span><span>{item.verified ? t("resources.source.verified") : t("resources.source.readOnlyUnsupported")}</span>{item.origin === "plugin" && <span>{t("resources.source.pluginOwner", { owner: item.owner ?? t("common.unknown") })}</span>}{(item.origin === "system" || item.origin === "managed") && <span>{t(protectionNames[item.origin]!)}</span>}{item.project && <span title={item.project}>{shortPath(item.project)}</span>}</div>{manual?.id && <button className="text-button" disabled={sourcePending} onClick={() => void removeSource(manual.id!)}>{t("resources.source.remove")}</button>}</div>; })}</div>{sourceLocationsOpen && <ResourcePagination page={sourceCurrentPage} pageSize={50} total={visibleSources.length} label={t("resources.workspace.scanSettings")} onChange={setSourcePage} />}      </details>
      <SourceDiagnostics diagnostics={visibleDiagnostics} />
      {!!visibleGaps.length && <details className="resource-data-details" open={sourceGapsOpen} onToggle={event => setSourceGapsOpen(event.currentTarget.open)}><summary>{t("resources.source.gapCount", { count: visibleGaps.length })}</summary>{sourceGapsOpen && <div className="resource-source-gaps">{visibleGaps.map((gap, index) => <div key={index}><p className="resource-path">{visibleSourcePaths.get(gap.sourceId)}</p><p>{gap.reason === "limit" ? t("resources.source.limit") : t(sourceStateNames[gap.reason as keyof typeof sourceStateNames])}</p></div>)}</div>}</details>}
    </ResourceDialog>
    <ResourceDialog open={sourceAdding && active} onOpenChange={open => { if (!sourcePending) setSourceAdding(open); }} title={t("resources.source.addTitle")} description={t("resources.source.addDescription")}>
      <form className="resource-source-form" onSubmit={event => void addSource(event)}>
        <div className="resource-field"><span>{t("resources.client.label")}</span><FilterSelect label={t("resources.source.client")} value={source.client} options={CLIENTS.map(client => ({ value: client.id, label: clientLabel(client.id) }))} onChange={value => { setSource(current => ({ ...current, client: value as Client, format: current.kind === "skill" ? current.format : value === "codex" ? "toml" : "json" })); setSourceKeys(registrationKeys(value as Client)); }} /></div>
        <div className="resource-field"><span>{t("resources.kind.label")}</span><FilterSelect label={t("resources.source.kind")} value={source.kind} options={[{ value: "skill", label: t("resources.kind.skill") }, { value: "mcp", label: t("resources.kind.mcp") }]} onChange={value => setSource(current => ({ ...current, kind: value as ResourceKind, format: value === "skill" ? "skill-directory" : current.client === "codex" ? "toml" : "json" }))} /></div>
        <label className="resource-field">{t("resources.source.absolutePath")}<input required value={source.path} onChange={event => setSource(current => ({ ...current, path: event.target.value }))} placeholder="/absolute/path/to/resources" aria-label={t("resources.source.absolutePathAria")} autoComplete="off" /></label>
        <div className="resource-field"><span>{t("resources.source.format")}</span><FilterSelect label={t("resources.source.formatAria")} value={source.format!} options={source.kind === "skill" ? [{ value: "skill-directory", label: t("resources.source.skillDirectory") }, { value: "skill-files", label: t("resources.source.skillFiles") }] : [{ value: "json", label: "JSON" }, { value: "jsonc", label: "JSONC" }, { value: "toml", label: "TOML" }]} onChange={value => setSource(current => ({ ...current, format: value as ResourceManualSource["format"] }))} /></div>
        <label className="resource-field">{t("resources.source.projectPath")}<input value={source.project ?? ""} onChange={event => setSource(current => ({ ...current, project: event.target.value || undefined }))} placeholder={t("resources.source.projectPlaceholder")} aria-label={t("resources.source.projectPathAria")} autoComplete="off" /></label>
        {source.kind === "mcp" && <label className="resource-field">{t("resources.source.keyPath")}<input value={sourceKeys} onChange={event => setSourceKeys(event.target.value)} placeholder="mcpServers" aria-label={t("resources.source.keyPathAria")} /></label>}
        {sourceError && <div className="resource-alert" role="alert"><ResourceErrorText error={sourceError} /></div>}
        <div className="dialog-end"><button type="button" className="button subtle" disabled={sourcePending} onClick={() => setSourceAdding(false)}>{t("common.cancel")}</button><button className="button primary" disabled={sourcePending || !source.path.trim()}>{sourcePending ? t("resources.source.adding") : t("resources.source.addAndScan")}</button></div>
      </form>
    </ResourceDialog>


  </div>;
}

function entryReadOnlyKey(entry: ResourceInventoryEntry): string {
  const desktopMcp = entry.client === "codeflicker-desktop" && entry.kind === "mcp";
  return entry.protectionReason === "system" ? "resources.management.systemReadOnly"
    : entry.protectionReason === "plugin" ? "resources.management.pluginReadOnly"
    : entry.protectionReason === "managed" ? "resources.management.managedReadOnly"
    : desktopMcp ? "resources.management.desktopMcpReadOnly"
    : entry.readState !== "present" ? "resources.management.unreadable"
    : "resources.management.readOnly";
}

function ManagementBody({ row, index, onManage, legacyFavorite, onClearFavorite }: { row: ResourceLocationGroup; index: number; onManage: (input: ResourceManagementInput) => void; legacyFavorite?: boolean; onClearFavorite?: () => void }) {
  useI18n();
  const uniqueByLocation = new Map<string, ResourceInventoryEntry>();
  for (const entry of row.entries) {
    const key = JSON.stringify([entry.entryPath, entry.locator.keyPath ?? []]);
    const previous = uniqueByLocation.get(key);
    uniqueByLocation.set(key, physicalLocationEntry(previous ? [previous, entry] : [entry])!);
  }
  const unique = [...uniqueByLocation.values()];
  const files = row.entries.filter(entry => entry.kind === "skill" && ["file", "directory"].includes(entry.entryType));
  const file = physicalLocationEntry(files);
  const links = unique.filter(entry => entry.entryType === "symlink");
  const registration = row.body.kind === "mcp" ? physicalLocationEntry(row.entries) : undefined;
  const controls = [...new Map(row.entries.filter(entry => entry.entryType !== "symlink" && entry.capabilities.disable)
    .map(entry => [JSON.stringify([entry.locator.controlPath, entry.locator.nativeRule ?? entry.locator.nativeControl]), entry])).values()];
  return <section className="resource-management-body" aria-label={t("resources.bodyName", { name: row.body.name, index: index + 1 })}>
    {file ? <>
      <header><strong>{t(file.scope === "user" ? "resources.scope.user" : "resources.scope.project")}</strong><span>{t(methodNames[file.entryType])}</span></header>
      <p className="resource-path">{file.entryPath}</p>
      <div className="resource-entry-actions">{file.capabilities.trash && <button className="button resource-danger-button" data-resource-action={`${file.id}:trash`} aria-label={t("resources.management.trashFile", { path: file.entryPath })} onClick={() => onManage({ entryId: file.id, action: "trash" })}>{t("resources.workspace.previewTrash")}</button>}</div>
      {!file.capabilities.trash && <p className="resource-management-note" role="status">{t(entryReadOnlyKey(row.entries.find(entry => entry.protected) ?? file))}</p>}
      {controls.map(entry => <Entry key={entry.id} entry={entry} onManage={onManage} controlOnly />)}
      {!!links.length && <details className="resource-data-details resource-linked-locations"><summary>{t("resources.workspace.linkCount", { count: links.length })}</summary>{links.map(entry => <Entry key={entry.id} entry={entry} onManage={onManage} />)}</details>}
    </> : registration ? <>
      <Entry entry={registration} onManage={onManage} />
      {controls.some(entry => entry.id !== registration.id) && <details className="resource-data-details"><summary>{t("resources.workspace.additionalControls")}</summary>{controls.filter(entry => entry.id !== registration.id).map(entry => <Entry key={entry.id} entry={entry} onManage={onManage} controlOnly />)}</details>}
    </> : unique.map(entry => <Entry key={entry.id} entry={entry} onManage={onManage} />)}
    {legacyFavorite && <button className="text-button resource-legacy-favorite" onClick={onClearFavorite}>{t("resources.workspace.clearLocationFavorite")}</button>}
  </section>;
}

function Entry({ entry, onManage, controlOnly = false }: { entry: ResourceInventoryEntry; onManage: (input: ResourceManagementInput) => void; controlOnly?: boolean }) {
  useI18n();
  const file = entry.kind === "skill" && (entry.entryType === "file" || entry.entryType === "directory");
  const unavailable = !entry.capabilities.disable && !entry.capabilities.trash;
  return <div className="resource-entry"><header><strong>{controlOnly ? t("resources.workspace.existingControl") : entry.entryType === "symlink" ? t(methodNames.symlink) : clientLabel(entry.client)}</strong><span>{controlOnly ? t(`resources.workspace.controlScope.${resourceControlScope(entry)?.controlScope ?? "path"}`) : entry.scope === "user" ? t("resources.scope.user") : t("resources.scope.project")}</span></header>{entry.project && <p className="resource-path">{entry.project}</p>}<p className="resource-path">{controlOnly ? entry.locator.controlPath ?? entry.entryPath : entry.entryPath}</p>
    {entry.entryType === "registration" && entry.locator.keyPath?.length && <p className="resource-path">{entry.locator.keyPath.join(".")}</p>}
    {entry.entryType === "symlink" && <p className="resource-path">→ {entry.targetPath ?? entry.linkTarget ?? t("resources.entry.targetUnknown")}</p>}
    <div className="resource-tags"><span>{t(methodNames[entry.entryType])}</span>{entry.entryType === "registration" && entry.nativeState !== "unknown" && <span>{nativeStateLabel(entry.nativeState)}</span>}{entry.invocationMode === "user-only" && <span>{t("resources.entry.userOnly")}</span>}{entry.readState !== "present" && <span className="is-warning">{entry.readState === "broken" ? t("resources.entry.broken") : t("resources.source.unreadable")}</span>}</div>

    {unavailable && <p className="resource-management-note" role="status">{t(entryReadOnlyKey(entry))}</p>}
    <div className="resource-entry-actions">{entry.capabilities.disable && entry.nativeState !== "disabled" && <button className="button" data-resource-action={`${entry.id}:disable`} aria-label={t("resources.management.previewEntry", { action: t(actionNames.disable), name: entry.name, client: clientLabel(entry.client) })} onClick={() => onManage({ entryId: entry.id, action: "disable" })}>{t(disableActionKey(entry))}</button>}{entry.capabilities.trash && !file && !controlOnly && <button className="button resource-danger-button" data-resource-action={`${entry.id}:trash`} aria-label={entry.entryType === "symlink" ? t("resources.management.removeLink", { path: entry.entryPath }) : t("resources.management.previewEntry", { action: t(actionNames.trash), name: entry.name, client: clientLabel(entry.client) })} onClick={() => onManage({ entryId: entry.id, action: "trash" })}>{t(entry.entryType === "symlink" ? "resources.workspace.previewLink" : "resources.workspace.previewRemoveRegistration")}</button>}</div>
  </div>;
}
