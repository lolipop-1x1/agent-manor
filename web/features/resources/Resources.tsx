import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowClockwise, ArrowSquareOut, CaretLeft, CaretRight, ClockCounterClockwise, Funnel, List, MagnifyingGlass, MapTrifold, Plus, Prohibit, Star, Trash, X } from "@phosphor-icons/react";
import { CLIENTS, type Client } from "../../../src/clients";
import type { ResourceKind, ResourceUsageDetail, ResourceUsageDistribution, ResourceUsageEvidenceResult, ResourceUsageStats, ResourceUsageTrend } from "../../../src/resource-contracts";
import type { ResourceInventoryDiagnostic, ResourceInventoryEntry, ResourceManualSource } from "../../../src/resource-inventory-contracts";
import type { ResourceManagementAction, ResourceManagementInput, ResourceManagementOperation, ResourceManagementOperations, ResourceManagementPreview } from "../../../src/resource-management-contracts";
import type { ResourceCandidate, ResourceLocalDetail, ResourceLocalQuery, ResourceLocalResult, ResourceLocalRow, ResourceMapQuery, ResourceMapSummary, ResourceOverviewCandidate, ResourceOverviewDetail, ResourceOverviewQuery, ResourceOverviewSummary, ResourceOverviewRow, ResourceStatus, ResourceStatusSummary } from "../../../src/resource-service-contracts";
import { ApiError, errorMessage, isAborted } from "../../shared/api";
import { DatePicker } from "../../shared/ui/DatePicker";
import { FilterSelect } from "../../shared/ui/FilterSelect";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { ProjectPicker } from "../../shared/ui/ProjectPicker";
import { ResourcePagination } from "../../shared/ui/ResourcePagination";
import { ResourceMap } from "./ResourceMap";
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

type ResourceTab = "usage" | "local" | "disabled" | "trash" | "operations";
interface ResourceRoute {
  kind: ResourceKind; tab: ResourceTab; client: string; project: string; window: string;
  from: string; to: string; q: string; sort: string; order: "asc" | "desc"; candidate: Exclude<ResourceCandidate | ResourceOverviewCandidate, "review">;
  low: number; inactive: number; favorite: boolean; page: number; pageSize: number; id: string; evidencePage: number; tool: string;
  view: "list" | "map"; metric: "uses" | "sessions"; maxValue: string;
  zeroPage: number; zeroSize: number;
}
const tabs: { value: ResourceTab; labelKey: string }[] = [
  { value: "usage", labelKey: "resources.tab.usage" }, { value: "local", labelKey: "resources.tab.local" },
  { value: "disabled", labelKey: "resources.tab.disabled" },
  { value: "trash", labelKey: "resources.tab.trash" }, { value: "operations", labelKey: "resources.tab.operations" },
];
const candidates = [
  { value: "all", labelKey: "resources.candidate.allResources" }, { value: "favorite", labelKey: "resources.candidate.favorite" },
  { value: "unused", labelKey: "resources.candidate.unused" }, { value: "low", labelKey: "resources.candidate.lowUsage" },
  { value: "old", labelKey: "resources.candidate.old" }, { value: "broken", labelKey: "resources.candidate.broken" },
  { value: "duplicate", labelKey: "resources.candidate.duplicate" },
];
const overviewCandidates: { value: Exclude<ResourceOverviewCandidate, "review">; labelKey: string }[] = [
  { value: "all", labelKey: "resources.candidate.all" }, { value: "used", labelKey: "resources.candidate.used" }, { value: "unused", labelKey: "resources.candidate.unused" },
  { value: "low", labelKey: "resources.candidate.low" }, { value: "old", labelKey: "resources.candidate.old" }, { value: "favorite", labelKey: "resources.candidate.favorite" },
];
const overviewObservationNames = { used: "resources.candidate.used", unused: "resources.candidate.unused", unknown: "resources.observation.unknown", insufficient: "resources.observation.insufficient" };
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
    tab: params.get("tab") === "standby" ? "trash" : tabs.some(tab => tab.value === params.get("tab")) ? params.get("tab") as ResourceTab : "usage",
    client: CLIENTS.some(client => client.id === params.get("client")) ? params.get("client")! : "all",
    project: params.get("project") ?? "all", window: ["7", "30", "90", "custom"].includes(params.get("window") ?? "") ? params.get("window")! : "all",
    from: validDate(params.get("from")), to: validDate(params.get("to")),
    q: params.get("q") ?? "", sort: ["uses", "sessions", "recent", "name"].includes(params.get("sort") ?? "") ? params.get("sort")! : "uses",
    order: params.get("order") === "asc" ? "asc" : params.get("order") === "desc" ? "desc" : params.get("sort") === "name" ? "asc" : "desc",
    candidate: [...candidates, ...overviewCandidates].some(item => item.value === params.get("candidate")) ? params.get("candidate") as ResourceRoute["candidate"] : "all",
    low: Math.min(10000, positive(params.get("low"), 2)), inactive: Math.min(3650, positive(params.get("inactive"), 90)),
    favorite: params.get("favorite") === "true", page: positive(params.get("page")), pageSize: [20, 50, 100].includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 20, id: params.get("id") ?? "",
    evidencePage: positive(params.get("evidencePage")), tool: params.get("tool") ?? "",
    view: (params.get("view") ?? preferredView) === "map" ? "map" : "list",
    metric: params.get("metric") === "sessions" ? "sessions" : "uses",
    maxValue: maximum !== null && /^\d+$/.test(maximum) && Number.isSafeInteger(Number(maximum)) ? String(Number(maximum)) : "",
    zeroPage: positive(params.get("zeroPage")),
    zeroSize: [20, 50, 100].includes(Number(params.get("zeroSize"))) ? Number(params.get("zeroSize")) : 20,
  };
};
function address(route: ResourceRoute) {
  return `#resources${resourceQuery({ ...route, client: route.client === "all" ? undefined : route.client,
    project: route.project === "all" ? undefined : route.project, page: route.page === 1 ? undefined : route.page,
    evidencePage: route.evidencePage === 1 ? undefined : route.evidencePage })}`;
}
const shortPath = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const usageAgentLabel = (row: { clients: Client[] }) => row.clients.length ? t("resources.agentCount", { count: row.clients.length }) : t("resources.client.notRecorded");
const observationNames = { recorded: "resources.observation.recorded", unknown: "resources.observation.unknown", insufficient: "resources.observation.insufficient" };
const observationLabel = (row: ResourceLocalRow) => row.observation === "recorded" && row.usage?.events === 0 ? t("resources.candidate.unused") : t(observationNames[row.observation]);
const sourceStateNames = { ok: "resources.source.ok", missing: "resources.source.missing", unreadable: "resources.source.unreadable", invalid: "resources.source.invalid", unsupported: "resources.source.unsupported" };
const methodNames = { directory: "resources.entry.directory", symlink: "resources.entry.symlink", file: "resources.entry.file", registration: "resources.entry.registration" };
const resultNames = { success: "resources.result.success", failure: "resources.result.failure", unknown: "resources.result.unknown" };
const evidenceNames = { skill_call: "resources.evidence.skillCall", skill_read: "resources.evidence.skillRead", mcp: "resources.evidence.mcp" };
const actionNames: Record<ResourceManagementAction, string> = { disable: "resources.action.disable", standby: "resources.action.standby", trash: "resources.action.trash", restore: "resources.action.restore", purge: "resources.action.purge" };
const archiveNames = { disabled: "resources.tab.disabled", standby: "resources.tab.trash", trash: "resources.tab.trash", restored: "resources.archive.restored", purged: "resources.archive.purged" };
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
function ResourceEmpty({ children }: { children: ReactNode }) {
  return <div className="resource-empty"><MagnifyingGlass size={24} /><span>{children}</span></div>;
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
  onSelect(id);
}
function OverviewTable({ rows, route, onSort, onSelect, onFavorite, onManage, favoritePending }: {
  rows: ResourceOverviewRow[]; route: ResourceRoute; onSort: (sort: string) => void; onSelect: (id: string) => void;
  onFavorite: (id: string, favorite: boolean) => void; onManage: (row: ResourceOverviewRow) => void; favoritePending: ReadonlySet<string>;
}) {
  useI18n();
  const columns = [{ value: "name", label: route.kind === "skill" ? t("resources.kind.skill") : t("resources.column.server") }, { value: "uses", label: t("resources.column.calls") }, { value: "sessions", label: t("resources.column.sessions") }, { value: "recent", label: t("resources.column.recent") }];
  const heading = (column: { value: string; label: string }) => <th key={column.value} scope="col" aria-sort={route.sort === column.value ? route.order === "asc" ? "ascending" : "descending" : "none"}>
    <button aria-label={t("resources.sortColumn", { column: column.label })} onClick={() => onSort(column.value)}>{column.label}<span aria-hidden="true">{route.sort === column.value ? route.order === "asc" ? "↑" : "↓" : "↕"}</span></button>
  </th>;
  return <div className="resource-overview-scroll"><table className="resource-overview-table" aria-label={t("resources.overview", { kind: route.kind === "skill" ? t("resources.kind.skill") : t("resources.kind.mcp") })}>
    <thead><tr>{heading(columns[0]!)}<th scope="col">{t("resources.agent.involved")}</th>{columns.slice(1).map(heading)}<th scope="col">{t("resources.column.management")}</th></tr></thead>
    <tbody>{rows.map(row => <tr className={`resource-overview-row${route.id === row.identity.id ? " is-selected" : ""}`} key={row.identity.id} onClick={event => selectResourceRow(event, row.identity.id, onSelect)}>
      <th scope="row"><div className="resource-overview-name"><button aria-label={t("resources.viewUsage", { name: messageText(row.identity.nameDescriptor, row.identity.name) })} onClick={() => onSelect(row.identity.id)}>{messageText(row.identity.nameDescriptor, row.identity.name)}</button><FavoriteButton name={messageText(row.identity.nameDescriptor, row.identity.name)} favorite={row.favorite} disabled={favoritePending.has(row.identity.id)} onClick={() => onFavorite(row.identity.id, row.favorite)} /></div></th>
      <td className="resource-overview-agents" title={formatList(row.clients.map(clientLabel))}>{usageAgentLabel(row)}</td>
      <td>{row.stats ? fmt(row.stats.events) : "—"}</td>
      <td>{row.stats ? fmt(row.stats.sessions) : "—"}</td>
      <td className="resource-overview-time">{row.stats?.lastUsedAt ? dateLabel(row.stats.lastUsedAt) : "—"}</td>
      <td><button className="button resource-manage" aria-label={t("resources.management.resource", { name: messageText(row.identity.nameDescriptor, row.identity.name) })} data-manage-resource={row.identity.id} onClick={() => onManage(row)}>{t("resources.management.manage")}</button></td>
    </tr>)}</tbody>
  </table></div>;
}
function Stats({ stats, kind }: { stats: ResourceUsageStats | null; kind: ResourceKind }) {
  const { percent } = useI18n();
  return <div className="resource-stats">
    <div><strong>{stats ? fmt(stats.events) : t("common.unknown")}</strong><span>{t("resources.column.calls")}</span></div>
    <div><strong>{stats ? fmt(stats.sessions) : t("common.unknown")}</strong><span>{t("resources.stat.sessions")}</span></div>
    {kind === "skill" && <div><strong>{stats ? fmt(stats.explicitCalls) : t("common.unknown")}</strong><span>{t("resources.stat.explicitCalls")}</span></div>}
    {kind === "skill" && <div><strong>{stats ? fmt(stats.successfulReads) : t("common.unknown")}</strong><span>{t("resources.stat.successfulReads")}</span></div>}
    <div><strong>{stats?.results.successRate === null || !stats ? t("common.notRecorded") : percent(stats.results.successRate, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</strong><span>{t("resources.stat.successRate")}</span></div>
    <div><strong>{stats?.duration.averageMs === null || !stats ? t("common.notRecorded") : t("resources.stat.milliseconds", { value: Math.round(stats.duration.averageMs) })}</strong><span>{t("resources.stat.averageDuration", { count: stats?.duration.samples ?? 0 })}</span></div>
    {stats && <div><strong>{fmt(stats.results.unknown)}</strong><span>{t("resources.result.unknown")}</span></div>}
  </div>;
}
function Trend({ rows, timeZone }: { rows: ResourceUsageTrend[]; timeZone: string }) {
  const { date } = useI18n();
  const trendDate = (value: string) => date(`${value}T00:00:00`);
  const max = rows.reduce((maximum, row) => Math.max(maximum, row.stats.events), 1);
  const start = rows.length ? Date.parse(rows[0]!.date) : 0;
  const end = rows.length ? Date.parse(rows.at(-1)!.date) : start;
  const x = (date: string) => 38 + (end === start ? .5 : (Date.parse(date) - start) / (end - start)) * 238;
  const y = (events: number) => 127 - events / max * 90;
  return <section className="resource-detail-section">
    <header><h3>{t("resources.trend.title")}</h3><HelpPopover label={t("resources.trend.help")}><p>{t("resources.trend.helpText", { timeZone })}</p></HelpPopover></header>
    {!rows.length ? <ResourceEmpty>{t("resources.trend.empty")}</ResourceEmpty> : <>
      <svg className="resource-trend" viewBox="0 0 300 163" role="img" aria-label={t("resources.trend.aria")}>
        {[0, max].map(value => <g key={value}><line x1="38" x2="279" y1={y(value)} y2={y(value)} /><text x="31" y={y(value) + 4} textAnchor="end">{fmt(value)}</text></g>)}
        <text x="38" y="18">{t("resources.trend.count")}</text>
        <polyline points={rows.map(row => `${x(row.date)},${y(row.stats.events)}`).join(" ")} />
        {rows.map(row => <circle key={row.date} cx={x(row.date)} cy={y(row.stats.events)} r="2.5"><title>{t("resources.trend.point", { date: trendDate(row.date), events: t("resources.map.metricValue", { count: row.stats.events }), sessions: t("resources.map.sessionValue", { count: row.stats.sessions }) })}</title></circle>)}
        <text x="38" y="150">{trendDate(rows[0]!.date)}</text><text x="279" y="150" textAnchor="end">{trendDate(rows.at(-1)!.date)}</text>
      </svg>
      <details className="resource-data-details"><summary>{t("resources.trend.data", { count: rows.length })}</summary><div className="resource-table-scroll"><table><thead><tr><th>{t("resources.trend.date")}</th><th>{t("resources.trend.events")}</th><th>{t("resources.trend.sessions")}</th></tr></thead><tbody>{rows.map(row => <tr key={row.date}><td>{trendDate(row.date)}</td><td>{fmt(row.stats.events)}</td><td>{fmt(row.stats.sessions)}</td></tr>)}</tbody></table></div></details>
    </>}
  </section>;
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
    <div><dt>{t("resources.column.calls")}</dt><dd>{t(kind === "skill" ? "resources.help.skillCalls" : "resources.help.mcpCalls")}</dd></div>
    <div><dt>{t("resources.stat.sessions")}</dt><dd>{t(kind === "skill" ? "resources.help.skillSessions" : "resources.help.mcpSessions")}</dd></div>
    <div><dt>{t("resources.help.knownResults")}</dt><dd>{t("resources.help.knownResultsText")}</dd></div>
    <div><dt>{t("resources.help.association")}</dt><dd>{t("resources.help.associationText")}</dd></div>
    <div><dt>{t("resources.help.organization")}</dt><dd>{t("resources.help.organizationText")}</dd></div>
  </dl></HelpPopover>;
}

export default function Resources({ active, onSession }: { active: boolean; onSession: (target: { sessionId: string; messageId: string }) => void }) {
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
  const [local, setLocal] = useState<ResourceLocalResult | null>(null);
  const [usageDetail, setUsageDetail] = useState<ResourceUsageDetail | null>(null);
  const [localDetail, setLocalDetail] = useState<ResourceLocalDetail | null>(null);
  const [evidence, setEvidence] = useState<ResourceUsageEvidenceResult | null>(null);
  const [archives, setArchives] = useState<ResourceArchiveResult | null>(null);
  const [operations, setOperations] = useState<ResourceManagementOperations | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [detailError, setDetailError] = useState<Error | null>(null);
  const [evidenceError, setEvidenceError] = useState<Error | null>(null);
  const [feedback, setFeedback] = useState<MessageDescriptor | null>(null);
  const [reload, setReload] = useState(0);
  const [favoriteReload, setFavoriteReload] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
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
  const [sourceAdding, setSourceAdding] = useState(false);
  const [sourcePending, setSourcePending] = useState(false);
  const [sourceError, setSourceError] = useState<Error | null>(null);
  const [source, setSource] = useState<ResourceManualSource>({ client: "codex", kind: "skill", path: "", format: "skill-directory" });
  const [sourceKeys, setSourceKeys] = useState("mcpServers");
  const [entriesOpen, setEntriesOpen] = useState(false);
  const [entriesTarget, setEntriesTarget] = useState<{ id: string; name: string; rows: ResourceLocalRow[] | null } | null>(null);
  const [entriesError, setEntriesError] = useState<Error | null>(null);
  const entriesRequest = useRef(0);
  const managementFocus = useRef<HTMLElement | null>(null);
  const managementFocusAction = useRef<string | null>(null);
  const pendingManagement = useRef<ResourceManagementInput | null>(null);
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
  const routeRef = useRef(route);
  const managementRequest = useRef(0);
  routeRef.current = route;

  const update = useCallback((patch: Partial<ResourceRoute>, push = false) => {
    const next = { ...routeRef.current, ...patch }; routeRef.current = next; setRoute(next);
    if (location.hash.startsWith("#resources")) history[push ? "pushState" : "replaceState"]({}, "", address(next));
  }, []);
  useEffect(() => {
    if (!active || !location.hash.startsWith("#resources")) return;
    const params = new URLSearchParams(location.hash.split("?")[1]);
    if (!["uses", "sessions"].includes(params.get("metric") ?? "") || ["calls", "reads"].includes(params.get("sort") ?? "") || params.get("tab") === "standby" || params.get("candidate") === "review" || params.has("reviewPage") || params.has("reviewSize")) history.replaceState({}, "", address(route));
  }, [active, route]);
  const filter = (patch: Partial<ResourceRoute>) => { if (listScroll.current) listScroll.current.scrollTop = 0; update({ ...patch, page: 1, evidencePage: 1, zeroPage: 1 }); };
  const sort = (value: string) => filter({ sort: value, order: route.sort === value ? route.order === "asc" ? "desc" : "asc" : value === "name" ? "asc" : "desc" });
  const pageChange = (page: number) => { if (listScroll.current) listScroll.current.scrollTop = 0; update({ page }); };
  const showLocal = (id: string) => { savedScroll.current = 0; update({ tab: "local", id, project: "all", page: 1, q: "", candidate: "all", favorite: false, evidencePage: 1, tool: "" }, true); };
  const select = (id: string) => { savedScroll.current = listScroll.current?.scrollTop ?? 0; setDetailsCollapsed(false); update({ id, evidencePage: 1, tool: "" }, true); };
  const showHistory = (id: string) => { savedScroll.current = 0; update({ tab: "usage", id, page: 1, q: "", candidate: "all", favorite: false, evidencePage: 1, tool: "" }, true); };
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
    setLocal(current => current ? { ...current, rows: current.rows.map(row => localFavoriteRow(row, favorites)) } : current);
    setUsageDetail(current => current ? { ...current, resource: applyResourceFavorites(current.resource, favorites) } : current);
    setOverviewDetail(current => current ? { ...current, favoriteIds, resource: applyResourceFavorites(current.resource, favorites),
      history: current.history ? { ...current.history, resource: applyResourceFavorites(current.history.resource, favorites) } : null,
      local: current.local.map(row => localFavoriteRow(row, favorites)) } : current);
    setLocalDetail(current => current ? { ...current, row: localFavoriteRow(current.row, favorites) } : current);
    setEntriesTarget(current => current?.rows ? { ...current, rows: current.rows.map(row => localFavoriteRow(row, favorites)) } : current);
  };
  useEffect(() => {
    const navigate = () => {
      if (!location.hash.startsWith("#resources")) return;
      const next = readRoute(); routeRef.current = next; setRoute(next); setQueryText(next.q); restoreScroll.current = true;
    };
    globalThis.addEventListener("hashchange", navigate); globalThis.addEventListener("popstate", navigate);
    return () => { globalThis.removeEventListener("hashchange", navigate); globalThis.removeEventListener("popstate", navigate); };
  }, []);
  useEffect(() => {
    const resize = () => setCompact(globalThis.innerWidth < 1024);
    globalThis.addEventListener("resize", resize); return () => globalThis.removeEventListener("resize", resize);
  }, []);
  useEffect(() => { const timer = globalThis.setTimeout(() => setQueryText(route.q), 250); return () => clearTimeout(timer); }, [route.q]);
  useEffect(() => {
    if (!active || status && !reload) return;
    const controller = new AbortController();
    const revision = favoriteRevision.current;
    void resourceApi.status(controller.signal).then(result => {
      if (!controller.signal.aborted) { setStatus({ ...result, favoriteIds: [...acceptFavoriteIds(result.favoriteIds, revision)] }); syncFavorites(); }
    }).catch(failure => { if (!isAborted(failure)) setError(failure instanceof Error ? failure : new Error(errorMessage(failure))); });
    return () => controller.abort();
  }, [active, reload]);
  useEffect(() => {
    if (!active || !sourcesOpen) return;
    const controller = new AbortController();
    setSourcesLoading(true); setSourceError(null); setSourceStatus(null);
    void resourceApi.sources(controller.signal).then(setSourceStatus)
      .catch(failure => { if (!isAborted(failure)) setSourceError(failure instanceof Error ? failure : new Error(errorMessage(failure))); })
      .finally(() => { if (!controller.signal.aborted) setSourcesLoading(false); });
    return () => controller.abort();
  }, [active, sourcesOpen, reload, sourcesRetry]);
  const invalidTime = (route.tab === "usage" || route.tab === "local") && route.window === "custom" && !!route.from && !!route.to && route.from > route.to;
  const overviewRanking = route.tab === "usage";
  const mapView = overviewRanking && route.view === "map";
  const overviewData = mapView ? map : overview;
  const overviewLabel = t("resources.overview", { kind: route.kind === "skill" ? t("resources.kind.skill") : t("resources.kind.mcp") });
  const scopeQuery = useMemo<ResourceUsageFilters>(() => ({ kind: route.kind,
    client: route.client === "all" ? undefined : route.client as Client,
    project: overviewRanking || route.project === "all" ? undefined : route.project,
    ...timeFilters(route.window, route.from, route.to, timeAnchor),
  }), [route.kind, route.client, route.project, route.window, route.from, route.to, timeAnchor, overviewRanking]);
  const query = useMemo<ResourceUsageFilters>(() => ({ ...scopeQuery, q: queryText, sort: route.sort as ResourceUsageFilters["sort"],
    order: route.order, page: route.page, pageSize: route.pageSize, favorite: route.favorite || undefined,
  }), [scopeQuery, queryText, route.sort, route.order, route.page, route.pageSize, route.favorite]);
  const localQuery = useMemo<ResourceLocalQuery>(() => ({ ...query, favorite: undefined, candidate: route.candidate === "used" ? "all" : route.candidate, lowSessions: route.low, inactiveDays: route.inactive }), [query, route.candidate, route.low, route.inactive]);
  const overviewQuery = useMemo<ResourceOverviewQuery>(() => ({ ...query, candidate: overviewCandidates.some(candidate => candidate.value === route.candidate) ? route.candidate as ResourceOverviewCandidate : "all", lowSessions: route.low, inactiveDays: route.inactive }), [query, route.candidate, route.low, route.inactive]);
  const mapQuery = useMemo<ResourceMapQuery>(() => ({ ...scopeQuery, q: queryText,
    candidate: overviewCandidates.some(candidate => candidate.value === route.candidate) ? route.candidate as ResourceOverviewCandidate : "all",
    favorite: route.favorite || undefined, lowSessions: route.low, inactiveDays: route.inactive,
    metric: route.metric, maxValue: route.maxValue === "" ? undefined : Number(route.maxValue),
  }), [scopeQuery, queryText, route.candidate, route.favorite, route.low, route.inactive, route.metric, route.maxValue]);
  const listRequestQuery = mapView ? mapQuery : overviewRanking ? overviewQuery : localQuery;
  const mapRequestKey = JSON.stringify([mapQuery, reload, favoriteReload]);
  const hasListData = mapView ? !!map : overviewRanking ? !!overview : route.tab === "local" ? !!local : route.tab === "operations" ? !!operations : !!archives;
  useEffect(() => { try { localStorage.setItem("agent-manor:resource-view", route.view); } catch { /* 存储不可用时视图仍可切换。 */ } }, [route.view]);
  const managementQuery = useMemo(() => ({ kind: route.kind, client: route.client === "all" ? undefined : route.client, project: route.project === "all" ? undefined : route.project, q: queryText, page: route.page, pageSize: route.pageSize }), [route.kind, route.client, route.project, queryText, route.page, route.pageSize]);
  useEffect(() => {
    if (!active || invalidTime || route.tab !== "usage" && route.tab !== "local") return;
    // 证据页返回时复用同范围的完整地图，保持已挂载相机的缩放与位置。
    if (mapView && map && mapLoadedQuery.current === mapRequestKey) { setListLoading(false); setError(null); return; }
    const controller = new AbortController(); setListLoading(true); setError(null);
    const revision = favoriteRevision.current;
    const done = () => { if (!controller.signal.aborted) setListLoading(false); };
    if (mapView) { void resourceApi.map(mapQuery, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      mapLoadedQuery.current = mapRequestKey; setMap(favoriteBase.current ? mapFavorites(result, currentFavorites()) : result);
    }).catch(failure => { if (!isAborted(failure)) setError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }).finally(done); }
    else if (overviewRanking) void resourceApi.overview(overviewQuery, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      const favorites = result.favoriteIds ? acceptFavoriteIds(result.favoriteIds, revision) : currentFavorites();
      setOverview(overviewFavorites(result, favorites)); setStatus(current => current ? { ...current, favoriteIds: [...favorites] } : current);
      if (result.page !== routeRef.current.page) update({ page: result.page });
    }).catch(failure => { if (!isAborted(failure)) setError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }).finally(done);
    else void resourceApi.local(localQuery, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setLocal(favoriteBase.current ? { ...result, rows: result.rows.map(row => localFavoriteRow(row, currentFavorites())) } : result);
      if (result.page !== routeRef.current.page) update({ page: result.page });
    }).catch(failure => { if (!isAborted(failure)) setError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }).finally(done);
    return () => controller.abort();
  }, [active, mapView, listRequestQuery, mapRequestKey, overviewRanking, route.tab, reload, favoriteReload, invalidTime]);
  useEffect(() => {
    if (!active || route.tab === "usage" || route.tab === "local") return;
    const controller = new AbortController(); setListLoading(true); setError(null);
    const task = route.tab === "operations" ? resourceApi.operations(managementQuery, controller.signal).then(setOperations)
      : resourceApi.archives(route.tab, managementQuery, controller.signal).then(setArchives);
    void task.catch(failure => { if (!isAborted(failure)) setError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }).finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => controller.abort();
  }, [active, route.tab, managementQuery, reload]);
  useEffect(() => {
    if (!active) return;
    if (!route.id || invalidTime || route.tab !== "usage" && route.tab !== "local") { setUsageDetail(null); setOverviewDetail(null); setLocalDetail(null); setDetailLoading(false); return; }
    const controller = new AbortController(); setDetailLoading(true); setDetailError(null); setUsageDetail(null); setOverviewDetail(null); setLocalDetail(null);
    const revision = favoriteRevision.current;
    const task = overviewRanking ? resourceApi.overviewDetail(route.id, { ...scopeQuery, lowSessions: route.low, inactiveDays: route.inactive }, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.favoriteIds) acceptFavoriteIds(result.favoriteIds, revision);
      setOverviewDetail(result); setUsageDetail(result.history); syncFavorites();
    }) : resourceApi.localDetail(route.id, { ...scopeQuery, lowSessions: route.low, inactiveDays: route.inactive }, controller.signal).then(result => {
      if (!controller.signal.aborted) setLocalDetail(favoriteBase.current ? { ...result, row: localFavoriteRow(result.row, currentFavorites()) } : result);
    });
    void task.catch(failure => { if (!isAborted(failure)) setDetailError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [active, route.id, route.tab, scopeQuery, overviewRanking, route.low, route.inactive, reload, invalidTime]);
  const evidenceId = overviewRanking ? usageDetail?.resource.identity.id : route.id;
  useEffect(() => {
    if (!active || !evidenceId || route.tab !== "usage" || invalidTime) { setEvidence(null); setEvidenceLoading(false); return; }
    const controller = new AbortController(); setEvidenceLoading(true); setEvidenceError(null);
    void resourceApi.evidence(evidenceId, { ...scopeQuery, page: route.evidencePage, pageSize: 10, tool: route.tool || undefined }, controller.signal)
      .then(setEvidence).catch(failure => { if (!isAborted(failure)) setEvidenceError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }).finally(() => { if (!controller.signal.aborted) setEvidenceLoading(false); });
    return () => controller.abort();
  }, [active, evidenceId, route.tab, route.evidencePage, route.tool, scopeQuery, reload, invalidTime]);
  useEffect(() => {
    if (!active || listLoading || !restoreScroll.current) return;
    const frame = requestAnimationFrame(() => {
      if (!busy.current.list && restoreScroll.current && listScroll.current) { listScroll.current.scrollTop = savedScroll.current; restoreScroll.current = false; }
    });
    return () => cancelAnimationFrame(frame);
  }, [active, listLoading]);
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
    setRefreshing(true); setError(null);
    try { setStatus(await resourceApi.refresh()); setReload(value => value + 1); setFeedback({ key: "resources.feedback.inventoryUpdated" }); }
    catch (failure) { setError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }
    finally { setRefreshing(false); }
  };
  const addSource = async (event: FormEvent) => {
    event.preventDefault(); setSourcePending(true); setSourceError(null);
    try {
      const result = await resourceApi.addSource({ ...source, path: source.path.trim(), keyPath: source.kind === "mcp" ? sourceKeys.split(".").map(key => key.trim()).filter(Boolean) : undefined });
      setStatus(result); setSourceAdding(false); setReload(value => value + 1); setFeedback({ key: "resources.feedback.sourceAdded" });
    } catch (failure) { setSourceError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }
    finally { setSourcePending(false); }
  };
  const removeSource = async (id: string) => {
    setSourcePending(true); setSourceError(null);
    try { setStatus(await resourceApi.removeSource(id)); setReload(value => value + 1); setFeedback({ key: "resources.feedback.sourceRemoved" }); }
    catch (failure) { setSourceError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }
    finally { setSourcePending(false); }
  };
  const openEntries = async (id: string, name: string, rows?: ResourceLocalRow[]) => {
    managementFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    managementFocusAction.current = null;
    const sequence = ++entriesRequest.current;
    setEntriesTarget({ id, name, rows: rows ?? null }); setEntriesError(null); setEntriesOpen(true);
    if (rows) return;
    try {
      const result = await resourceApi.overviewDetail(id, { ...scopeQuery, lowSessions: route.low, inactiveDays: route.inactive });
      if (sequence === entriesRequest.current) setEntriesTarget({ id, name, rows: result.local });
    } catch (failure) { if (sequence === entriesRequest.current) setEntriesError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }
  };
  const closeEntries = (open: boolean) => { if (!open) entriesRequest.current++; setEntriesOpen(open); };
  const managementFocusTarget = () => {
    if (managementFocus.current?.isConnected) return managementFocus.current;
    const selector = managementFocusAction.current ? `[data-resource-action="${CSS.escape(managementFocusAction.current)}"]`
      : entriesTarget ? `[data-manage-resource="${CSS.escape(entriesTarget.id)}"]` : null;
    return selector ? document.querySelector<HTMLElement>(`.resource-detail-dialog ${selector}`) ?? document.querySelector<HTMLElement>(selector) : null;
  };
  const chooseEntryAction = (input: ResourceManagementInput) => { pendingManagement.current = input; closeEntries(false); };
  const afterEntriesClose = () => {
    const input = pendingManagement.current; pendingManagement.current = null;
    if (input) requestAnimationFrame(() => void showManagement(input, true));
  };
  const showManagement = async (input: ResourceManagementInput, fromEntries = false) => {
    if (!fromEntries) {
      managementFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      managementFocusAction.current = managementFocus.current?.dataset.resourceAction ?? null;
    }
    const sequence = ++managementRequest.current;
    setManagementInput(input); setManagementOpen(true); setPreview(null); setManagementError(null); setManagementResult(null); setPurgeConfirmed(false); setPreviewLoading(true);
    try {
      const result = await resourceApi.preview(input);
      if (sequence === managementRequest.current) setPreview(result);
    } catch (failure) { if (sequence === managementRequest.current) setManagementError(failure instanceof Error ? failure : new Error(errorMessage(failure))); }
    finally { if (sequence === managementRequest.current) setPreviewLoading(false); }
  };
  const closeManagement = (open: boolean) => {
    if (applying) return;
    if (!open) { managementRequest.current++; setPreview(null); }
    setManagementOpen(open);
  };
  const applyManagement = async () => {
    if (!preview || applying || preview.action === "purge" && !purgeConfirmed) return;
    setApplying(true); setManagementError(null);
    try {
      const result = await resourceApi.apply(preview.id);
      setManagementResult(result); setPreview(null); setReload(value => value + 1);
      if (result.status === "success") { if (!overviewRanking) update({ id: "" }); setFeedback({ key: result.clientEffect === "pending_reload" ? "resources.feedback.completePending" : "resources.feedback.completeUnknown" }); }
    } catch (failure) { setManagementError(failure instanceof Error ? failure : new Error(errorMessage(failure))); setPreview(null); }
    finally { setApplying(false); }
  };
  const reset = () => {
    const defaults = { ...readRoute(), client: "all", project: "all", window: "all", from: "", to: "", q: "", sort: "uses", metric: "uses" as const, order: "desc" as const, candidate: "all" as const, low: 2, inactive: 90, favorite: false, page: 1, pageSize: 20, maxValue: "", zeroPage: 1 };
    setQueryText(""); update(defaults);
  };
  const projectOptions = [{ value: "all", label: t("resources.project.all") }, { value: "none", label: t("resources.project.none") }, ...(status?.projects ?? []).map(path => ({ value: path, label: shortPath(path), description: path }))];
  const sourceInScope = (item: { client: Client; kind: ResourceKind; scope: "user" | "project"; project?: string }) => item.kind === route.kind && (route.client === "all" || item.client === route.client)
    && (overviewRanking || route.project === "all" || item.scope === "user" || item.project === route.project);
  const visibleSources = sourcesOpen && active ? sourceStatus?.sources.filter(sourceInScope) ?? [] : [];
  const visibleSourceIds = new Set(visibleSources.map(item => item.id));
  const visibleGaps = sourcesOpen && active ? sourceStatus?.gaps.filter(gap => visibleSourceIds.has(gap.sourceId)) ?? [] : [];
  const visibleDiagnostics = sourcesOpen && active ? sourceStatus?.diagnostics?.filter(item => sourceInScope(item) && (overviewRanking || route.project === "all" || (route.project === "none" ? !item.project : item.project === route.project))) ?? [] : [];
  const localIssues = route.tab === "local" && !local?.rows.length && !route.q.trim() ? status?.sourceIssues.filter(sourceInScope) ?? [] : [];
  const emptyLocalKey = localIssues.some(issue => issue.reason === "unreadable" || issue.reason === "invalid") ? "resources.empty.localUnreadable"
    : localIssues.some(issue => issue.reason === "unsupported") ? "resources.empty.localUnsupported" : "resources.empty.local";
  const historyView = route.tab === "usage" || route.tab === "local";
  const filters = <div className="resource-filter-content" id={compact ? undefined : "resource-filter-content"}>
    <div className="resource-field"><span>{overviewRanking ? t("resources.agent.label") : t("resources.client.label")}</span><FilterSelect label={overviewRanking ? t("resources.client.resourceAgent") : t("resources.client.resourceClient")} value={route.client} options={[{ value: "all", label: overviewRanking ? t("resources.client.allAgents") : t("resources.client.all") }, ...CLIENTS.map(client => ({ value: client.id, label: clientLabel(client.id) }))]} onChange={value => filter({ client: value })} /></div>
    {!overviewRanking && <div className="resource-field"><span>{t("resources.project.label")}</span><ProjectPicker value={route.project} options={projectOptions} onChange={value => filter({ project: value })} /></div>}
    {historyView && <><div className="resource-field"><span>{t("resources.time.label")}</span><FilterSelect label={t("resources.time.filter")} value={route.window} options={[{ value: "all", label: t("resources.time.all") }, { value: "7", label: t("resources.time.seven") }, { value: "30", label: t("resources.time.thirty") }, { value: "90", label: t("resources.time.ninety") }, { value: "custom", label: t("resources.time.custom") }]} onChange={value => { setTimeAnchor(Date.now()); filter({ window: value }); }} /></div>
      {route.window === "custom" && <div className="resource-date-fields"><div className="resource-field"><span>{t("resources.time.from")}</span><DatePicker label={t("resources.time.startDate")} value={route.from} onChange={value => filter({ from: value })} /></div><div className="resource-field"><span>{t("resources.time.to")}</span><DatePicker label={t("resources.time.endDate")} value={route.to} onChange={value => filter({ to: value })} /></div></div>}
      {!mapView && <><div className="resource-field"><span>{t("resources.sort.label")}</span><FilterSelect label={t("resources.sort.filter")} value={route.sort} options={[{ value: "uses", label: t("resources.sort.calls") }, { value: "sessions", label: t("resources.sort.sessions") }, { value: "recent", label: t("resources.column.recent") }, { value: "name", label: t("resources.sort.name") }]} onChange={value => filter({ sort: value, order: value === "name" ? "asc" : "desc" })} /></div>
      <div className="resource-field"><span>{t("resources.sort.direction")}</span><FilterSelect label={t("resources.sort.directionFilter")} value={route.order} options={[{ value: "desc", label: t("resources.sort.desc") }, { value: "asc", label: t("resources.sort.asc") }]} onChange={value => filter({ order: value as ResourceRoute["order"] })} /></div></>}
    </>}
    {route.tab === "local" && <><div className="resource-field"><span>{t("resources.candidate.label")}</span><FilterSelect label={t("resources.candidate.filter")} value={route.candidate === "used" ? "all" : route.candidate} options={(route.kind === "mcp" ? candidates.filter(candidate => candidate.value !== "duplicate") : candidates).map(item => ({ value: item.value, label: t(item.labelKey) }))} onChange={value => filter({ candidate: value as ResourceRoute["candidate"] })} /></div>
    </>}
    {(route.tab === "local" || overviewRanking) && <>
      {route.candidate === "low" && <label className="resource-field">{t("resources.candidate.lowThreshold")}<input type="number" min="1" max="10000" aria-label={t("resources.candidate.lowThresholdAria")} value={route.low} onChange={event => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value > 0 && value <= 10000) filter({ low: value }); }} /></label>}
      {route.candidate === "old" && <label className="resource-field">{t("resources.candidate.oldThreshold")}<input type="number" min="1" max="3650" aria-label={t("resources.candidate.oldThresholdAria")} value={route.inactive} onChange={event => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value > 0 && value <= 3650) filter({ inactive: value }); }} /></label>}
    </>}
    <button className="button subtle resource-reset" onClick={reset}>{t("resources.filters.reset")}</button>
    <nav className="resource-management-nav" aria-label={t("resources.management.views")}>
      {tabs.slice(2).map(tab => <button key={tab.value} aria-current={route.tab === tab.value ? "page" : undefined} onClick={() => { update({ tab: tab.value, id: "", page: 1, tool: "" }, true); setFiltersOpen(false); }}>
        {tab.value === "disabled" ? <Prohibit size={17} aria-hidden="true" /> : tab.value === "trash" ? <Trash size={17} aria-hidden="true" /> : <ClockCounterClockwise size={17} aria-hidden="true" />}{t(tab.labelKey)}
      </button>)}
    </nav>
    <div className="resource-filter-footer"><button className="text-button" onClick={() => setSourcesOpen(true)}>{t("resources.source.title")}</button><button className="text-button" onClick={() => { const client = route.client === "all" ? "codex" : route.client as Client; setSource({ client, kind: route.kind, path: "", format: route.kind === "skill" ? "skill-directory" : client === "codex" ? "toml" : "json" }); setSourceKeys(registrationKeys(client)); setSourceError(null); setSourceAdding(true); }}><Plus size={14} />{t("resources.source.add")}</button></div>
  </div>;

  const selectedArchive = archives?.archives.find(item => item.id === route.id);
  const selectedOperation = operations?.operations.find(item => item.id === route.id);
  const overviewLocal = overviewDetail && <section className="resource-detail-section resource-local-entries"><header><h3>{t("resources.detail.bodies")}</h3><span>{t("resources.bodyCount", { count: overviewDetail.local.length })}</span></header>
    {overviewDetail.local.length ? overviewDetail.local.map((row, index) => <div className="resource-entry" key={row.body.id}>
      <header><strong>{row.body.name}</strong><FavoriteButton name={t("resources.bodyName", { name: row.body.name, index: index + 1 })} favorite={!!status?.favoriteIds.includes(row.body.id)} disabled={favoritePending.has(row.body.id) || !status} onClick={() => void favorite(row.body.id)} /></header>
      {row.entries.map(entry => <Entry key={entry.id} entry={entry} onManage={input => void showManagement(input)} />)}
      <p className="resource-path">{t("resources.detail.realTarget")}: {row.body.targetPath ?? row.entries[0]?.entryPath ?? t("resources.detail.bodyUnknown")}</p>
      <div className="resource-tags"><span>{formatList([...new Set(row.entries.map(entry => clientLabel(entry.client)))]) || t("resources.client.notRecorded")}</span><span>{t("resources.entryCount", { count: row.entries.length })}</span><span className={row.observation === "recorded" ? "" : "is-warning"}>{observationLabel(row)}</span></div>
      <div className="resource-entry-actions"><button className="button" aria-label={t("resources.viewBody", { name: row.body.name, index: index + 1 })} onClick={() => showLocal(row.body.id)}>{t("resources.detail.localEntries")}<CaretRight size={14} /></button></div>

    </div>) : <ResourceEmpty>{route.kind === "skill" ? t("resources.detail.skillMissing") : t("resources.detail.mcpMissing")}</ResourceEmpty>}
  </section>;
  const detailManagement = overviewDetail
    ? <button className="button resource-manage" data-manage-resource={overviewDetail.resource.identity.id} aria-label={t("resources.management.resource", { name: messageText(overviewDetail.resource.identity.nameDescriptor, overviewDetail.resource.identity.name) })} onClick={() => void openEntries(overviewDetail.resource.identity.id, messageText(overviewDetail.resource.identity.nameDescriptor, overviewDetail.resource.identity.name), overviewDetail.local)}>{t("resources.management.manage")}</button>
    : localDetail ? <button className="button resource-manage" data-manage-resource={localDetail.row.body.id} aria-label={t("resources.management.resource", { name: localDetail.row.body.name })} onClick={() => void openEntries(localDetail.row.body.id, localDetail.row.body.name, [localDetail.row])}>{t("resources.management.manage")}</button> : null;
  const detail = <>
    {detailLoading ? <div role="status" className="resource-loading">{t("resources.loading.detail")}</div> : detailError ? <div className="resource-alert" role="alert"><ResourceErrorText error={detailError} /><button className="text-button" onClick={() => setReload(value => value + 1)}>{t("common.retry")}</button></div> : usageDetail ? <>
      <div className="resource-detail-heading"><div><span>{usageAgentLabel(overviewDetail?.resource ?? usageDetail.resource)}</span><h2>{messageText(usageDetail.resource.identity.nameDescriptor, usageDetail.resource.identity.name)}</h2></div><FavoriteButton name={messageText(usageDetail.resource.identity.nameDescriptor, usageDetail.resource.identity.name)} favorite={overviewDetail?.resource.favorite ?? usageDetail.resource.favorite} disabled={favoritePending.has(route.id)} onClick={() => void favorite(overviewDetail?.resource.identity.id ?? route.id, overviewDetail?.resource.favorite ?? usageDetail.resource.favorite)} /></div>
      {detailManagement}
      {overviewDetail && <div className="resource-tags"><span className={overviewDetail.resource.observation === "unknown" || overviewDetail.resource.observation === "insufficient" ? "is-warning" : ""}>{t(overviewObservationNames[overviewDetail.resource.observation])}</span></div>}
      {overviewLocal}
      {usageDetail.resource.identity.path && <p className="resource-path">{usageDetail.resource.identity.path}</p>}
      <details className="resource-usage-summary"><summary>{t("resources.detail.usageSummary")}</summary>
      <Stats stats={overviewDetail ? overviewDetail.resource.stats : usageDetail.resource.stats} kind={route.kind} /><p className="resource-last-used">{t("resources.lastUsed", { date: dateLabel((overviewDetail ? overviewDetail.resource.stats : usageDetail.resource.stats)?.lastUsedAt ?? undefined) })}</p>
      <Trend rows={usageDetail.trend} timeZone={usageDetail.timeZone} />
      <Distribution rows={usageDetail.clients} title={t("resources.distribution.agents")} label={value => value ? clientLabel(value as Client) : t("resources.client.notRecorded")} />
      <Distribution rows={usageDetail.projects} title={t("resources.distribution.projects")} label={value => value ? shortPath(value) : t("resources.project.none")} />
      </details>
      <details className="resource-data-details"><summary>{t("resources.originCount", { count: usageDetail.origins.length })}</summary><div className="resource-origin-list">{usageDetail.origins.map(origin => <div key={origin.id}><strong>{clientLabel(origin.client)}</strong><span title={origin.project}>{origin.project ? shortPath(origin.project) : t("resources.project.none")}</span><p className="resource-path">{origin.path ?? t("resources.path.notRecorded")}</p></div>)}</div></details>
      <HistoryGaps gaps={usageDetail.coverage.gaps} />
      {route.kind === "mcp" && <section className="resource-detail-section"><header><h3>{t("resources.stat.toolCalls")}</h3><span>{t("resources.toolCount", { count: usageDetail.tools.length })}</span></header><div className="resource-tool-list">{usageDetail.tools.map(tool => <button key={tool.name} className={route.tool === tool.name ? "is-selected" : ""} aria-pressed={route.tool === tool.name} onClick={() => update({ tool: route.tool === tool.name ? "" : tool.name, evidencePage: 1 })}><strong>{tool.name}</strong><span>{t("resources.callCount", { count: tool.stats.mcpCalls })}</span><small>{t("resources.toolResults", { failure: tool.stats.results.failure, unknown: tool.stats.results.unknown, duration: tool.stats.duration.samples ? t("resources.durationSamples", { duration: Math.round(tool.stats.duration.averageMs!), count: tool.stats.duration.samples }) : t("resources.evidence.durationMissing") })}</small></button>)}</div></section>}
      <section className="resource-detail-section"><header><h3>{route.tool ? t("resources.toolEvidence", { name: route.tool }) : t("resources.evidence.title")}</h3>{route.tool && <button className="text-button" onClick={() => update({ tool: "", evidencePage: 1 })}>{t("resources.evidence.allTools")}</button>}</header>
        {evidenceLoading ? <div role="status" className="resource-loading">{t("resources.loading.evidence")}</div> : evidenceError ? <div role="alert" className="resource-alert"><ResourceErrorText error={evidenceError} /></div> : evidence?.events.length ? <>
          <div className="resource-evidence">{evidence.events.map(event => <a key={event.id} href={`#sessions?${new URLSearchParams({ id: event.sessionId, mode: "trace", message: event.messageId, branch: "all" })}`} onClick={click => { if (!click.metaKey && !click.ctrlKey && !click.shiftKey && click.button === 0) { click.preventDefault(); savedScroll.current = listScroll.current?.scrollTop ?? 0; savedDetailScroll.current = (compact ? detailDialogScroll.current : detailScroll.current)?.scrollTop ?? 0; returnFromEvidence.current = true; onSession({ sessionId: event.sessionId, messageId: event.messageId }); } }}>
            <div><strong>{event.tool ?? t(evidenceNames[event.kind])}</strong><span className={`resource-result is-${event.status}`}>{t(resultNames[event.status])}</span><ArrowSquareOut size={14} /></div><span>{t(evidenceNames[event.kind])} · {dateLabel(event.occurredAt)}</span>{event.pairing === "ambiguous" && <span className="resource-result is-unknown">{t("resources.evidence.pairingAmbiguous")}</span>}
          </a>)}</div><ResourcePagination page={evidence.page} total={evidence.total} pageSize={evidence.pageSize} label={t("resources.evidence.title")} onChange={page => update({ evidencePage: page })} />
        </> : <ResourceEmpty>{t("resources.evidence.empty")}</ResourceEmpty>}
      </section>
    </> : overviewDetail ? <>
      <div className="resource-detail-heading"><div><span>{usageAgentLabel(overviewDetail.resource)}</span><h2>{messageText(overviewDetail.resource.identity.nameDescriptor, overviewDetail.resource.identity.name)}</h2></div><FavoriteButton name={messageText(overviewDetail.resource.identity.nameDescriptor, overviewDetail.resource.identity.name)} favorite={overviewDetail.resource.favorite} disabled={favoritePending.has(route.id)} onClick={() => void favorite(overviewDetail.resource.identity.id, overviewDetail.resource.favorite)} /></div>
      {detailManagement}
      <div className="resource-tags"><span className={overviewDetail.resource.observation === "unknown" || overviewDetail.resource.observation === "insufficient" ? "is-warning" : ""}>{t(overviewObservationNames[overviewDetail.resource.observation])}</span></div>
      {overviewLocal}
      <details className="resource-usage-summary"><summary>{t("resources.detail.usageSummary")}</summary><Stats stats={overviewDetail.resource.stats} kind={route.kind} /></details>
    </> : localDetail ? <>
      <div className="resource-detail-heading"><div><span>{route.kind === "skill" ? t("resources.detail.localSkill") : t("resources.detail.localMcp")}</span><h2>{localDetail.row.body.name}</h2></div><FavoriteButton name={localDetail.row.body.name} favorite={!!status?.favoriteIds.includes(route.id)} disabled={favoritePending.has(route.id) || !status} onClick={() => void favorite(route.id)} /></div>
      {detailManagement}
      <div className="resource-tags"><span className={localDetail.row.observation !== "recorded" ? "is-warning" : ""}>{observationLabel(localDetail.row)}</span></div>
      <section className="resource-detail-section"><header><h3>{t("resources.detail.clientEntries")}</h3><span>{t("resources.entryCount", { count: localDetail.row.entries.length })}</span></header>{localDetail.row.entries.map(entry => <Entry key={entry.id} entry={entry} onManage={input => void showManagement(input)} />)}</section>
      <SourceDiagnostics diagnostics={localDetail.inventory.diagnostics} />
      <details className="resource-data-details"><summary>{t("resources.detail.realTarget")}</summary><p className="resource-path">{localDetail.row.body.targetPath ?? localDetail.row.entries[0]?.entryPath}</p></details>
      <details className="resource-usage-summary"><summary>{t("resources.detail.usageSummary")}</summary>
      <Stats stats={localDetail.row.usage} kind={route.kind} />
      <Trend rows={localDetail.trend} timeZone={localDetail.timeZone} />
      <Distribution rows={localDetail.clients} title={t("resources.distribution.clients")} label={value => value ? clientLabel(value as Client) : t("resources.client.unknown")} />
      <Distribution rows={localDetail.projects} title={t("resources.distribution.projects")} label={value => value ? shortPath(value) : t("resources.project.none")} />

      </details>
      <section className="resource-detail-section"><header><h3>{t("resources.detail.history")}</h3></header>{localDetail.row.historyIds.length ? <div className="resource-history-links">{localDetail.row.historyIds.map((id, index) => <button key={id} className="button subtle" onClick={() => showHistory(id)}>{localDetail.row.historyIds.length > 1 ? t("resources.viewHistoryNumber", { index: index + 1 }) : t("resources.viewHistory")}<CaretRight size={14} /></button>)}</div> : <ResourceEmpty>{t("resources.detail.historyEmpty")}</ResourceEmpty>}</section>
      <details className="resource-data-details"><summary>{t("resources.detail.discovery")}</summary><dl className="resource-facts"><dt>{t("resources.detail.firstSeen")}</dt><dd>{dateLabel(localDetail.row.firstSeenAt)}</dd><dt>{t("resources.detail.inventoryTime")}</dt><dd>{dateLabel(localDetail.inventory.observedAt)}</dd>{localDetail.row.body.targetPath && <><dt>{t("resources.detail.realTarget")}</dt><dd>{localDetail.row.body.targetPath}</dd></>}</dl></details>
    </> : selectedArchive && !historyView && route.tab !== "operations" ? <>
      <div className="resource-detail-heading"><div><span>{clientLabel(selectedArchive.entry.client)}</span><h2>{selectedArchive.entry.name}</h2></div></div>
      <div className="resource-tags"><span>{t(archiveNames[selectedArchive.state])}</span><span>{selectedArchive.restorable ? t("resources.archive.restorable") : t("resources.archive.unavailable")}</span>{selectedArchive.operationStatus === "partial" && <span className="is-warning">{t("resources.operation.partial")}</span>}</div>
      <dl className="resource-facts"><dt>{t("resources.facts.original")}</dt><dd>{selectedArchive.originalPath}</dd><dt>{t("resources.facts.scope")}</dt><dd>{selectedArchive.entry.scope === "user" ? t("resources.scope.user") : selectedArchive.entry.project ?? t("resources.project.unknown")}</dd><dt>{t("resources.facts.managementTime")}</dt><dd>{dateLabel(selectedArchive.createdAt)}</dd>{selectedArchive.storedPath && <><dt>{t("resources.facts.recovery")}</dt><dd>{selectedArchive.storedPath}</dd></>}</dl>
      <div className="resource-entry-actions"><button className="button primary" disabled={!selectedArchive.restorable} onClick={() => void showManagement({ action: "restore", operationId: selectedArchive.operationId })}>{t("resources.archive.previewRestore")}</button>{["trash", "standby"].includes(selectedArchive.state) && <button className="button resource-danger-button" onClick={() => void showManagement({ action: "purge", operationId: selectedArchive.operationId })}>{t("resources.archive.previewPurge")}</button>}</div>
    </> : selectedOperation && route.tab === "operations" ? <>
      <div className="resource-detail-heading"><div><span>{clientLabel(selectedOperation.resource.client)}</span><h2>{selectedOperation.name}</h2></div></div>
      <div className="resource-tags"><span>{t(actionNames[selectedOperation.action])}</span><span className={selectedOperation.status === "success" ? "" : "is-warning"}>{t(operationStatusNames[selectedOperation.status])}</span><span>{selectedOperation.clientEffect === "pending_reload" ? t("resources.clientEffect.pending") : t("resources.clientEffect.unknown")}</span></div>
      <ResourceMessage descriptor={selectedOperation.messageDescriptor} original={selectedOperation.message} details={selectedOperation.details} />
      <dl className="resource-facts"><dt>{t("resources.facts.executionTime")}</dt><dd>{dateLabel(selectedOperation.createdAt)}</dd><dt>{t("resources.facts.scope")}</dt><dd>{selectedOperation.resource.scope === "user" ? t("resources.scope.user") : selectedOperation.resource.project ?? t("resources.project.unknown")}</dd><dt>{t("resources.facts.localState")}</dt><dd>{selectedOperation.localState === "changed" ? t("resources.localState.changed") : selectedOperation.localState === "partial" ? t("resources.localState.partial") : t("resources.localState.unchanged")}</dd></dl>
      {selectedOperation.archiveId && ["disable", "standby", "trash"].includes(selectedOperation.action) && <button className="button" onClick={() => update({ tab: selectedOperation.action === "disable" ? "disabled" : "trash", q: selectedOperation.name, id: "", page: 1 }, true)}>{t("resources.archive.viewRecovery")}</button>}
    </> : <ResourceEmpty>{t("resources.detail.empty")}</ResourceEmpty>}
  </>;

  return <div className="resources-shell" aria-label={t("resources.title")} data-compact={compact}>
    <ResizableWorkspace variant="resources" sidebarCollapsed={sidebarCollapsed} detailsCollapsed={detailsCollapsed} semantics={{ sidebar: { label: t("resources.layout.sidebarWidth"), controls: "resource-filter-content" }, details: { label: t("resources.layout.detailsWidth"), controls: "resource-detail-content" } }}>
      <aside className={`sidebar resource-sidebar${sidebarCollapsed ? " panel-collapsed" : ""}`} aria-label={t("resources.filters.title")}>
        <div className="pane-heading"><span>{t("resources.filters.label")}</span><button className="icon-button panel-toggle" aria-label={sidebarCollapsed ? t("resources.filters.expand") : t("resources.filters.collapse")} aria-expanded={!sidebarCollapsed} aria-controls="resource-filter-content" onClick={() => setSidebarCollapsed(value => !value)}>{sidebarCollapsed ? <CaretRight size={17} /> : <CaretLeft size={17} />}</button></div>{!sidebarCollapsed && !compact && filters}
      </aside>
      <main className="resources-main">
        <header className="resources-heading"><h1>{t("resources.title")}</h1><div className="resource-kind-tabs" role="group" aria-label={t("resources.kind.label")}>{(["skill", "mcp"] as const).map(kind => <button key={kind} aria-pressed={route.kind === kind} className={route.kind === kind ? "is-selected" : ""} onClick={() => update({ kind, id: "", page: 1, tool: "", zeroPage: 1, metric: kind === route.kind ? route.metric : "uses", maxValue: kind === route.kind ? route.maxValue : "", candidate: kind === "mcp" && route.candidate === "duplicate" ? "all" : route.candidate, sort: kind === route.kind ? route.sort : "uses", order: kind === route.kind ? route.order : "desc" })}>{kind === "skill" ? t("resources.kind.skill") : t("resources.kind.mcp")}</button>)}<UsageHelp kind={route.kind} /></div><div className="resources-heading-actions"><button className="icon-button resource-mobile-filter" aria-label={t("resources.filters.open")} onClick={() => setFiltersOpen(true)}><Funnel size={18} /></button><button className="button" disabled={refreshing} onClick={() => void refresh()}><ArrowClockwise size={15} className={refreshing ? "spinning" : ""} />{refreshing ? t("resources.refresh.loading") : t("resources.refresh.label")}</button></div></header>

        <div className="resource-list-toolbar">
          <nav className="resource-view-tabs" aria-label={t("resources.view.label")}>
            {tabs.slice(0, 2).map(tab => <button key={tab.value} aria-current={route.tab === tab.value ? "page" : undefined} onClick={() => update({ tab: tab.value, id: "", page: 1, tool: "" }, true)}>{t(tab.labelKey)}</button>)}
          </nav>
          <label className="resource-search"><MagnifyingGlass size={16} aria-hidden="true" /><input aria-label={t("resources.search.label")} value={route.q} placeholder={t("resources.search.label")} onChange={event => filter({ q: event.target.value })} />{route.q && <button className="icon-button" aria-label={t("resources.search.clear")} onClick={() => filter({ q: "" })}><X size={14} /></button>}</label>
          {overviewRanking && <div className="resource-display-switch" role="group" aria-label={t("resources.view.display")}>{(["list", "map"] as const).map(view => <button key={view} aria-pressed={route.view === view} onClick={() => update({ view })}>{view === "list" ? <List size={15} aria-hidden="true" /> : <MapTrifold size={15} aria-hidden="true" />}{view === "list" ? t("resources.view.list") : t("resources.view.map")}</button>)}</div>}
        </div>
        <div className="resource-list-summary">
          <span className="resource-list-progress" role={listLoading && hasListData ? "status" : undefined} aria-label={listLoading && hasListData ? t("resources.loading.resources") : undefined}>{listLoading && hasListData && <ArrowClockwise size={14} className="spinning" aria-hidden="true" />}</span>
          {!historyView && <strong>{t(tabs.find(tab => tab.value === route.tab)!.labelKey)}</strong>}
          {overviewRanking && overviewData && <span>{t(route.kind === "skill" ? "resources.skillCount" : "resources.mcpCount", { count: overviewData.total })}</span>}{route.tab === "local" && local && <span>{t("resources.localCount", { count: local.total })}</span>}
          {route.tab === "operations" && operations && <span>{t("resources.operationCount", { count: operations.total })}</span>}{!historyView && route.tab !== "operations" && archives && <span>{t("resources.resourceCount", { count: archives.total })}</span>}
        </div>
        {mapView && <div className="resource-map-settings">
          {mapView && <><FilterSelect label={t("resources.map.metricFilter")} value={route.metric} options={[{ value: "uses", label: t("resources.sort.calls") }, { value: "sessions", label: t("resources.sort.sessions") }]} onChange={value => filter({ metric: value as ResourceRoute["metric"], maxValue: "" })} /><label className="resource-map-limit">{t(route.metric === "sessions" ? "resources.sort.sessions" : "resources.sort.calls")} ≤<input type="number" min="0" step="1" aria-label={t("resources.map.limit", { metric: t(route.metric === "sessions" ? "resources.sort.sessions" : "resources.sort.calls") })} value={route.maxValue} placeholder={t("resources.map.unlimited")} onChange={event => { const value = event.target.value; if (value === "" || /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) filter({ maxValue: value }); }} /></label></>}
        </div>}
        {invalidTime && <div className="resource-alert" role="alert">{t("resources.time.invalidRange")}</div>}
        {error && <div className="resource-alert" role="alert"><ResourceErrorText error={error} /><button className="text-button" onClick={() => setReload(value => value + 1)}>{t("common.retry")}</button></div>}
        {feedback && <div className={`resource-feedback${mapView ? " resource-map-feedback" : ""}`} role="status">{t(feedback.key, feedback.params)}<button className="icon-button" aria-label={t("resources.feedback.close")} onClick={() => setFeedback(null)}><X size={14} /></button></div>}
        {overviewRanking && overviewData && <>
          <div className="resource-quick-filters" role="group" aria-label={t("resources.quickFilters", { kind: route.kind === "skill" ? t("resources.kind.skill") : t("resources.kind.mcp") })}>
            <div className="resource-usage-filters" role="group" aria-label={t("resources.usageStates")}>{overviewCandidates.slice(0, 3).map(candidate => <button key={candidate.value} aria-pressed={route.candidate === candidate.value || candidate.value === "all" && !overviewCandidates.some(item => item.value === route.candidate)} onClick={() => filter({ candidate: candidate.value, favorite: false })}>{t(candidate.labelKey)}<strong>{fmt(overviewData.counts[candidate.value])}</strong></button>)}</div>
            <div className="resource-attention-filters" data-active={["low", "old"].includes(route.candidate)} role="group" aria-label={t("resources.attention.filter")}>
              <FilterSelect label={t("resources.attention.filter")} value={["low", "old"].includes(route.candidate) ? route.candidate : "all"} options={[{ value: "all", label: t("resources.attention.any") }, ...overviewCandidates.filter(candidate => ["low", "old"].includes(candidate.value)).map(candidate => ({ value: candidate.value, label: t("resources.candidate.withCount", { label: t(candidate.labelKey), count: overviewData.counts[candidate.value] }) }))]} onChange={value => filter({ candidate: value as ResourceRoute["candidate"], favorite: false })} />
              <button aria-pressed={route.candidate === "favorite"} onClick={() => filter({ candidate: route.candidate === "favorite" ? "all" : "favorite", favorite: false })}><Star size={14} weight={route.candidate === "favorite" ? "fill" : "regular"} aria-hidden="true" />{t("resources.candidate.favorite")}<strong>{fmt(overviewData.counts.favorite)}</strong></button>
            </div>
          </div>
          {!!overviewData.coverage?.missingTimeEvents && <div className="resource-range-summary"><span className="resource-state is-warning">{t("resources.missingTimeCount", { count: overviewData.coverage.missingTimeEvents })}</span></div>}
        </>}
        <div className={`resource-list-scroll${mapView ? " resource-map-scroll" : ""}`} ref={listScroll} aria-busy={listLoading}>
          {listLoading && !hasListData ? <div role="status" className="resource-loading">{t("resources.loading.resources")}</div> : invalidTime ? null : mapView ? map && <ResourceMap data={map} selected={route.id} onSelect={select} zeroPage={route.zeroPage} zeroSize={route.zeroSize} onZeroPage={zeroPage => update({ zeroPage })} onZeroSize={zeroSize => update({ zeroSize, zeroPage: 1 })} /> : overviewRanking ? overview?.resources.length ? <OverviewTable rows={overview.resources} route={route} onSort={sort} onSelect={select} onManage={row => void openEntries(row.identity.id, messageText(row.identity.nameDescriptor, row.identity.name))} onFavorite={(id, current) => void favorite(id, current)} favoritePending={favoritePending} /> : <ResourceEmpty>{t("resources.empty.kind", { kind: route.kind === "skill" ? t("resources.kind.skill") : t("resources.kind.mcp") })}</ResourceEmpty> : route.tab === "local" ? local?.rows.length ? <div className="resource-overview-scroll"><table className="resource-overview-table resource-local-table" aria-label={t("resources.tab.local")}>
            <thead><tr><th scope="col">{t("resources.sort.name")}</th><th scope="col">{t("resources.client.label")}</th><th scope="col">{t("resources.facts.scope")}</th><th scope="col">{t("resources.detail.clientEntries")}</th><th scope="col">{t("resources.detail.observation")}</th></tr></thead>
            <tbody>{local.rows.map(row => <tr className={`resource-overview-row${route.id === row.body.id ? " is-selected" : ""}`} key={row.body.id} onClick={event => selectResourceRow(event, row.body.id, select)}>
              <th scope="row"><div className="resource-overview-name"><button onClick={() => select(row.body.id)} aria-label={t("resources.viewLocal", { name: row.body.name })}>{row.body.name}</button><FavoriteButton name={row.body.name} favorite={!!status?.favoriteIds.includes(row.body.id)} disabled={favoritePending.has(row.body.id) || !status} onClick={() => void favorite(row.body.id)} /></div><div className="resource-row-subtitle" title={row.body.targetPath ?? row.entries[0]?.entryPath}>{row.body.targetPath ?? row.entries[0]?.entryPath}</div></th>
              <td>{formatList([...new Set(row.entries.map(entry => clientLabel(entry.client)))])}</td>
              <td>{formatList([...new Set(row.entries.map(entry => t(entry.scope === "user" ? "resources.scope.user" : "resources.scope.project")))])}</td>
              <td>{t("resources.entryCount", { count: row.entries.length })}</td>
              <td><div className="resource-tags"><span className={row.observation === "recorded" ? "" : "is-warning"}>{observationLabel(row)}</span>{row.candidates.includes("broken") && <span className="is-warning">{t("resources.candidate.broken")}</span>}</div>{row.usage && <span className="resource-row-subtitle">{t("resources.map.callValue", { count: row.usage.events })} · {t("resources.sessionCount", { count: row.usage.sessions })}</span>}</td>
            </tr>)}</tbody></table></div> : <ResourceEmpty>{t(emptyLocalKey)}{emptyLocalKey !== "resources.empty.local" && <button className="text-button" onClick={() => setSourcesOpen(true)}>{t("resources.source.title")}</button>}</ResourceEmpty> : route.tab === "operations" ? operations?.operations.length ? <div className="resource-rows">{operations.operations.map(operation => <div className={`resource-row${route.id === operation.id ? " is-selected" : ""}`} key={operation.id}><button className="resource-row-main" aria-label={t("resources.viewOperation", { name: operation.name, action: t(actionNames[operation.action]) })} onClick={() => select(operation.id)}><div className="resource-row-heading"><strong>{operation.name}</strong><span>{t(actionNames[operation.action])}</span></div><div className="resource-row-metrics"><span>{clientLabel(operation.resource.client)}</span><span>{dateLabel(operation.createdAt)}</span></div><div className="resource-tags"><span className={operation.status === "success" ? "" : "is-warning"}>{t(operationStatusNames[operation.status])}</span><span>{operation.clientEffect === "pending_reload" ? t("resources.clientEffect.pending") : t("resources.clientEffect.unknown")}</span></div></button></div>)}</div> : <ResourceEmpty>{t("resources.empty.operations")}</ResourceEmpty> : archives?.archives.length ? <div className="resource-rows">{archives.archives.map(archive => <div className={`resource-row${route.id === archive.id ? " is-selected" : ""}`} key={archive.id}><button className="resource-row-main" aria-label={t("resources.viewRecovery", { name: archive.entry.name })} onClick={() => select(archive.id)}><div className="resource-row-heading"><strong>{archive.entry.name}</strong><span>{clientLabel(archive.entry.client)}</span></div><div className="resource-row-subtitle" title={archive.originalPath}>{archive.originalPath}</div><div className="resource-row-metrics"><span>{dateLabel(archive.createdAt)}</span></div><div className="resource-tags"><span>{t(archiveNames[archive.state])}</span><span className={!archive.restorable ? "is-warning" : ""}>{archive.restorable ? t("resources.archive.restorable") : t("resources.archive.unavailable")}</span>{archive.operationStatus === "partial" && <span className="is-warning">{t("resources.operation.partial")}</span>}</div></button></div>)}</div> : <ResourceEmpty>{t("resources.empty.archive", { state: t(tabs.find(tab => tab.value === route.tab)!.labelKey) })}</ResourceEmpty>}
        </div>
        {overviewRanking && !mapView && overview && <ResourcePagination page={overview.page} total={overview.total} pageSize={overview.pageSize} label={overviewLabel} onPageSizeChange={pageSize => filter({ pageSize })} onChange={pageChange} />}
        {route.tab === "local" && local && <ResourcePagination page={local.page} total={local.total} pageSize={local.pageSize} label={t("resources.tab.local")} onPageSizeChange={pageSize => filter({ pageSize })} onChange={pageChange} />}
        {route.tab === "operations" && operations && <ResourcePagination page={operations.page} total={operations.total} pageSize={operations.pageSize} label={t("resources.tab.operations")} onPageSizeChange={pageSize => filter({ pageSize })} onChange={pageChange} />}
        {!historyView && route.tab !== "operations" && archives && <ResourcePagination page={archives.page} total={archives.total} pageSize={archives.pageSize} label={t("resources.archive.records")} onPageSizeChange={pageSize => filter({ pageSize })} onChange={pageChange} />}
      </main>
      <aside className={`resource-details${detailsCollapsed ? " panel-collapsed" : ""}`} aria-label={t("resources.detail.title")}>
        <div className="pane-heading"><span>{t("resources.detail.title")}</span><button className="icon-button panel-toggle" aria-label={detailsCollapsed ? t("resources.detail.expand") : t("resources.detail.collapse")} aria-expanded={!detailsCollapsed} aria-controls="resource-detail-content" onClick={() => setDetailsCollapsed(value => !value)}>{detailsCollapsed ? <CaretLeft size={17} /> : <CaretRight size={17} />}</button></div>
        <div className="resource-detail-scroll" ref={detailScroll} id="resource-detail-content" hidden={detailsCollapsed}>{!compact && detail}</div>
      </aside>
    </ResizableWorkspace>
    <ResourceDialog open={compact && filtersOpen && active} onOpenChange={setFiltersOpen} title={t("resources.filters.title")} description={t("resources.filters.description")} className="resource-filter-dialog">{filters}<div className="dialog-end"><button className="button primary" onClick={() => setFiltersOpen(false)}>{t("resources.done")}</button></div></ResourceDialog>
    <ResourceDialog open={compact && !!route.id && active && !entriesOpen && !managementOpen} onOpenChange={open => { if (!open) update({ id: "" }); }} title={t("resources.detail.title")} description={route.kind === "skill" ? t("resources.detail.skillDescription") : t("resources.detail.mcpDescription")} className="resource-detail-dialog" contentRef={detailDialogScroll}>{detail}</ResourceDialog>
    <ResourceDialog open={sourcesOpen && active} onOpenChange={setSourcesOpen} title={t("resources.source.title")} description={t("resources.source.lastScanned", { date: status?.observedAt ? dateLabel(status.observedAt) : t("resources.source.neverScanned") })}>
      {sourceError && <div className="resource-alert" role="alert"><ResourceErrorText error={sourceError} /><button className="text-button" onClick={() => setSourcesRetry(value => value + 1)}>{t("common.retry")}</button></div>}
      {sourcesLoading && <div className="resource-loading" role="status">{t("resources.loading.detail")}</div>}
      <div className="resource-source-list">{visibleSources.map(item => { const manual = item.manualSourceId ? sourceStatus?.manualSources.find(source => source.id === item.manualSourceId) : undefined; return <div key={item.id}><header><strong>{clientLabel(item.client)} · {item.kind === "skill" ? t("resources.kind.skill") : t("resources.kind.mcp")}</strong><span className={`resource-state${item.readState !== "ok" ? " is-warning" : ""}`}>{t(sourceStateNames[item.readState])}</span></header><p>{item.path}</p><div className="resource-tags"><span>{item.scope === "user" ? t("resources.scope.user") : t("resources.scope.project")}</span><span>{item.format}</span><span>{item.verified ? t("resources.source.verified") : t("resources.source.readOnlyUnsupported")}</span>{item.origin === "plugin" && <span>{t("resources.source.pluginOwner", { owner: item.owner ?? t("common.unknown") })}</span>}{(item.origin === "system" || item.origin === "managed") && <span>{t(protectionNames[item.origin]!)}</span>}{item.project && <span title={item.project}>{shortPath(item.project)}</span>}</div>{manual?.id && <button className="text-button" disabled={sourcePending} onClick={() => void removeSource(manual.id!)}>{t("resources.source.remove")}</button>}</div>; })}</div>
      <SourceDiagnostics diagnostics={visibleDiagnostics} />
      {!!visibleGaps.length && <details className="resource-data-details"><summary>{t("resources.source.gapCount", { count: visibleGaps.length })}</summary><div className="resource-source-gaps">{visibleGaps.map((gap, index) => <p key={index}>{clientLabel(gap.client)} · {gap.reason === "project_missing" ? t("resources.source.projectMissing") : gap.reason === "limit" ? t("resources.source.limit") : t(sourceStateNames[gap.reason])}</p>)}</div></details>}
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
    <ResourceDialog open={entriesOpen && active} onOpenChange={closeEntries} title={t("resources.detail.manageEntries")} description={t("resources.management.chooseEntry")} className="resource-entry-dialog" focusTarget={managementFocusTarget} afterClose={afterEntriesClose}>
      {entriesTarget && <div className="resource-preview-heading"><strong>{entriesTarget.name}</strong></div>}
      {entriesError ? <div className="resource-alert" role="alert"><ResourceErrorText error={entriesError} /><button className="text-button" onClick={() => entriesTarget && void openEntries(entriesTarget.id, entriesTarget.name)}>{t("common.retry")}</button></div>
        : !entriesTarget?.rows ? <div className="resource-loading" role="status">{t("resources.loading.detail")}</div>
        : entriesTarget.rows.length ? <>
          {entriesTarget.rows.some(row => row.usageUnassociated) && <p className="resource-management-note">{t("resources.management.unlinkedUsage")}</p>}
          <div className="resource-management-bodies">{entriesTarget.rows.map((row, index) => <ManagementBody key={row.body.id} row={row} index={index} onManage={chooseEntryAction} />)}</div>
        </> : <div className="resource-management-unavailable" role="status"><p>{t("resources.management.historyOnly")}</p></div>}
    </ResourceDialog>
    <ResourceDialog open={managementOpen && active} onOpenChange={closeManagement} focusTarget={managementFocusTarget} title={managementInput ? t("resources.management.actionPreview", { action: t(actionNames[managementInput.action]) }) : t("resources.management.preview")} description={t("resources.management.description")}>
      {previewLoading ? <div className="resource-loading" role="status">{t("resources.management.loading")}</div> : preview ? <>
        <div className="resource-preview-heading"><strong>{preview.resource.name}</strong><div className="resource-tags"><span>{clientLabel(preview.resource.client)}</span><span>{preview.resource.scope === "user" ? t("resources.scope.user") : t("resources.scope.project")}</span></div></div>
        {preview.action === "trash" && preview.resource.kind === "skill" && <p className="resource-management-note">{t(preview.target === "file" ? "resources.management.fileEffect" : "resources.management.linkEffect")}</p>}
        <p className="resource-management-note">{t("resources.management.referencesUnknown")}</p>
        <dl className="resource-facts"><dt>{t("resources.facts.method")}</dt><dd>{t(operationMethodNames[preview.method])}</dd><dt>{t("resources.facts.original")}</dt><dd>{preview.sourcePath}</dd>{preview.destinationPath && <><dt>{t(preview.action === "disable" ? "resources.facts.backupDestination" : preview.action === "restore" ? "resources.facts.restoreDestination" : "resources.facts.trashDestination")}</dt><dd>{preview.destinationPath}</dd></>}{preview.resource.project && <><dt>{t("resources.project.label")}</dt><dd>{preview.resource.project}</dd></>}<dt>{t("resources.facts.restoration")}</dt><dd><ResourceMessage descriptor={preview.restorationDescriptor} original={preview.restoration} /></dd><dt>{t("resources.facts.expires")}</dt><dd>{dateLabel(preview.expiresAt)}</dd></dl>
        {preview.protected && <div className="resource-alert" role="alert">{preview.protectionReasons.length ? formatList(preview.protectionReasons.map(reason => protectionNames[reason] ? t(protectionNames[reason]!) : t("common.originalDetail", { detail: reason }))) : t("resources.management.protected")}</div>}
        <section className="resource-detail-section"><header><h3>{t("resources.management.affectedEntries")}</h3><span>{t("resources.entryCount", { count: preview.affectedEntries.length })}</span></header><div className="resource-preview-entries">{preview.affectedEntries.map(entry => <div key={`${entry.id}:${entry.scope}:${entry.project ?? ""}:${entry.entryPath}`}><strong>{clientLabel(entry.client)} · {entry.name}</strong><span>{entry.scope === "user" ? t("resources.scope.user") : entry.project ?? t("resources.project.unknown")}</span><p>{entry.entryPath}</p></div>)}</div></section>
        {!!preview.revealedEntries?.length && <section className="resource-detail-section"><header><h3>{t("resources.management.revealedEntries")}</h3><span className="resource-state is-warning">{t("resources.entryCount", { count: preview.revealedEntries.length })}</span></header><div className="resource-preview-entries">{preview.revealedEntries.map((entry, index) => <div key={`${entry.client}:${entry.scope}:${entry.project ?? ""}:${entry.entryPath}:${index}`}><strong>{clientLabel(entry.client)} · {entry.name}</strong><span>{entry.scope === "user" ? t("resources.scope.userDefault") : entry.project ?? t("resources.project.unknown")}</span><p>{entry.entryPath}</p></div>)}</div></section>}
        {preview.action === "purge" && <label className="resource-checkbox resource-purge-confirm"><input type="checkbox" checked={purgeConfirmed} onChange={event => setPurgeConfirmed(event.target.checked)} />{t("resources.management.confirmPurge")}</label>}
        <div className="dialog-end"><button className="button subtle" disabled={applying} onClick={() => closeManagement(false)}>{t("common.cancel")}</button><button className={`button ${preview.action === "trash" || preview.action === "purge" ? "resource-danger-button" : "primary"}`} disabled={applying || preview.action === "purge" && !purgeConfirmed} onClick={() => void applyManagement()}>{applying ? t("resources.management.applying") : t("resources.management.confirm", { action: t(actionNames[preview.action]) })}</button></div>
      </> : managementResult ? <>
        <div className={`resource-${managementResult.status === "success" ? "feedback" : "alert"}`} role={managementResult.status === "success" ? "status" : "alert"}>{t(operationStatusNames[managementResult.status])}</div><ResourceMessage descriptor={managementResult.messageDescriptor} original={managementResult.message} details={managementResult.details} />
        <div className="resource-tags"><span>{managementResult.localState === "changed" ? t("resources.management.changed") : managementResult.localState === "partial" ? t("resources.management.partial") : t("resources.management.unchanged")}</span><span>{managementResult.clientEffect === "pending_reload" ? t("resources.clientEffect.pending") : t("resources.clientEffect.unknown")}</span></div>
        <div className="dialog-end">{managementResult.status !== "success" && managementInput && <button className="button" onClick={() => void showManagement(managementInput)}>{t("resources.management.previewAgain")}</button>}<button className="button primary" onClick={() => closeManagement(false)}>{t("resources.done")}</button></div>
      </> : null}
      {managementError && <div className="resource-alert" role="alert"><ResourceErrorText error={managementError} /></div>}
      {managementError && !preview && managementInput && <div className="dialog-end"><button className="button subtle" onClick={() => closeManagement(false)}>{t("common.cancel")}</button><button className="button" onClick={() => void showManagement(managementInput)}>{t("resources.management.previewAgain")}</button></div>}
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

function ManagementBody({ row, index, onManage }: { row: ResourceLocalRow; index: number; onManage: (input: ResourceManagementInput) => void }) {
  const { language } = useI18n();
  const files = row.entries.filter(entry => entry.kind === "skill" && (entry.entryType === "file" || entry.entryType === "directory"));
  const file = files.find(entry => entry.capabilities.trash) ?? files[0];
  const links = new Map<string, ResourceInventoryEntry>();
  for (const entry of row.entries.filter(entry => entry.entryType === "symlink")) {
    const previous = links.get(entry.entryPath);
    if (!previous || !previous.capabilities.trash && entry.capabilities.trash) links.set(entry.entryPath, entry);
  }
  const clients = new Intl.ListFormat(language, { style: "short", type: "conjunction" }).format([...new Set(row.entries.map(entry => clientLabel(entry.client)))]);
  return <section className="resource-management-body" aria-label={t("resources.bodyName", { name: row.body.name, index: index + 1 })}>
    <header><strong>{row.body.name}</strong>{!file && <span>{t("resources.entryCount", { count: row.entries.length })}</span>}</header>
    <p className="resource-path">{file?.entryPath ?? row.body.targetPath ?? row.entries[0]?.entryPath ?? t("resources.detail.bodyUnknown")}</p>
    {file && <>
      <p className="resource-management-note">{t("resources.management.discoveredClients", { clients })}</p>
      <div className="resource-entry-actions"><button className="button resource-danger-button" disabled={!file.capabilities.trash} data-resource-action={`${file.id}:trash`} aria-label={t("resources.management.trashFile", { path: file.entryPath })} onClick={() => onManage({ entryId: file.id, action: "trash" })}>{t("resources.action.trash")}</button></div>
      {!file.capabilities.trash && <p className="resource-management-note" role="status">{t(entryReadOnlyKey(row.entries.find(entry => entry.protected) ?? file))}</p>}
    </>}
    {row.entries.filter(entry => (!file || entry.entryType === "symlink" || entry.capabilities.disable)
      && (entry.entryType !== "symlink" || entry.capabilities.disable || links.get(entry.entryPath)?.id === entry.id)).map(entry => <Entry key={entry.id} entry={entry} onManage={onManage} hideTrash={entry.entryType === "symlink" && links.get(entry.entryPath)?.id !== entry.id} />)}
  </section>;
}

function Entry({ entry, onManage, hideTrash = false }: { entry: ResourceInventoryEntry; onManage: (input: ResourceManagementInput) => void; hideTrash?: boolean }) {
  useI18n();
  const file = entry.kind === "skill" && (entry.entryType === "file" || entry.entryType === "directory");
  const unavailable = !entry.capabilities.disable && !entry.capabilities.trash;
  return <div className="resource-entry"><header><strong>{clientLabel(entry.client)}</strong><span>{entry.scope === "user" ? t("resources.scope.user") : t("resources.scope.project")}</span></header>{entry.project && <p className="resource-path">{entry.project}</p>}<p className="resource-path">{entry.entryPath}</p>
    {entry.entryType === "registration" && entry.locator.keyPath?.length && <p className="resource-path">{entry.locator.keyPath.join(".")}</p>}
    {entry.entryType === "symlink" && <p className="resource-path">→ {entry.targetPath ?? entry.linkTarget ?? t("resources.entry.targetUnknown")}</p>}
    <div className="resource-tags"><span>{t(methodNames[entry.entryType])}</span>{entry.nativeState !== "unknown" && <span>{nativeStateLabel(entry.nativeState)}</span>}{entry.invocationMode === "user-only" && <span>{t("resources.entry.userOnly")}</span>}{entry.readState !== "present" && <span className="is-warning">{entry.readState === "broken" ? t("resources.entry.broken") : t("resources.source.unreadable")}</span>}</div>
    {entry.selectionScopes?.length ? <details className="resource-data-details"><summary>{t("resources.entry.selectionScopes", { count: entry.selectionScopes.length })}</summary><div className="resource-selection-scopes">{entry.selectionScopes.map((item, index) => <div key={`${item.scope}:${item.project ?? ""}:${index}`}><strong>{item.scope === "user" ? t("resources.scope.userDefault") : item.project ?? t("resources.project.unknown")}</strong><div className="resource-tags">{item.nativeState !== "unknown" && <span>{nativeStateLabel(item.nativeState)}</span>}{item.invocationMode === "user-only" && <span>{t("resources.entry.userOnly")}</span>}</div>{item.controlPath && <p className="resource-path">{item.controlPath}</p>}</div>)}</div></details> : null}
    {unavailable && <p className="resource-management-note" role="status">{t(entryReadOnlyKey(entry))}</p>}
    <div className="resource-entry-actions">{entry.capabilities.disable && entry.nativeState !== "disabled" && <button className="button" data-resource-action={`${entry.id}:disable`} aria-label={t("resources.management.previewEntry", { action: t(actionNames.disable), name: entry.name, client: clientLabel(entry.client) })} onClick={() => onManage({ entryId: entry.id, action: "disable" })}>{t("resources.entry.previewDisable")}</button>}{entry.capabilities.trash && !file && !hideTrash && <button className="button resource-danger-button" data-resource-action={`${entry.id}:trash`} aria-label={entry.entryType === "symlink" ? t("resources.management.removeLink", { path: entry.entryPath }) : t("resources.management.previewEntry", { action: t(actionNames.trash), name: entry.name, client: clientLabel(entry.client) })} onClick={() => onManage({ entryId: entry.id, action: "trash" })}>{t(entry.entryType === "symlink" ? "resources.management.linkAction" : "resources.action.trash")}</button>}</div>
  </div>;
}
