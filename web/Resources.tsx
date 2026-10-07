import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowClockwise, ArrowSquareOut, CaretLeft, CaretRight, Funnel, MagnifyingGlass, Plus, ShieldCheck, Star, X } from "@phosphor-icons/react";
import { CLIENTS, clientName, type Client } from "../src/clients";
import type { ResourceKind, ResourceUsageDetail, ResourceUsageDistribution, ResourceUsageEvidenceResult, ResourceUsageStats, ResourceUsageTrend } from "../src/resource-contracts";
import type { ResourceInventoryEntry, ResourceManualSource } from "../src/resource-inventory-contracts";
import type { ResourceManagementAction, ResourceManagementInput, ResourceManagementOperation, ResourceManagementOperations, ResourceManagementPreview } from "../src/resource-management-contracts";
import type { ResourceCandidate, ResourceLocalDetail, ResourceLocalQuery, ResourceLocalResult, ResourceLocalRow, ResourceOverviewCandidate, ResourceOverviewDetail, ResourceOverviewQuery, ResourceOverviewResult, ResourceOverviewRow, ResourceStatus } from "../src/resource-service-contracts";
import { errorMessage, isAborted } from "./api";
import { DatePicker } from "./DatePicker";
import { FilterSelect } from "./FilterSelect";
import { HelpPopover } from "./HelpPopover";
import { ProjectPicker } from "./ProjectPicker";
import { ResourcePagination } from "./ResourcePagination";
import { ResizableWorkspace } from "./ResizableWorkspace";
import { dateLabel, fmt, timeFilters } from "./model";
import { resourceApi, resourceQuery, type FavoriteResult, type ResourceArchiveResult, type ResourceUsageFilters } from "./resource-api";
import "./resources.css";

type ResourceTab = "usage" | "local" | "disabled" | "standby" | "trash" | "operations";
interface ResourceRoute {
  kind: ResourceKind; tab: ResourceTab; client: string; project: string; window: string;
  from: string; to: string; q: string; sort: string; order: "asc" | "desc"; candidate: ResourceCandidate | ResourceOverviewCandidate;
  low: number; inactive: number; favorite: boolean; page: number; pageSize: number; id: string; evidencePage: number; tool: string;
}
const tabs: { value: ResourceTab; label: string }[] = [
  { value: "usage", label: "使用排行" }, { value: "local", label: "本地资源" },
  { value: "disabled", label: "已停用" }, { value: "standby", label: "备用" },
  { value: "trash", label: "回收区" }, { value: "operations", label: "操作记录" },
];
const candidates = [
  { value: "all", label: "全部资源" }, { value: "favorite", label: "已收藏" },
  { value: "unused", label: "未发现使用" }, { value: "low", label: "低频使用" },
  { value: "old", label: "长期未用" }, { value: "broken", label: "断链／缺失" },
  { value: "duplicate", label: "SKILL.md 相同" }, { value: "review", label: "待检查" },
];
const overviewCandidates: { value: ResourceOverviewCandidate; label: string }[] = [
  { value: "all", label: "全部" }, { value: "used", label: "已使用" }, { value: "unused", label: "未发现使用" },
  { value: "low", label: "低频" }, { value: "old", label: "长期未用" }, { value: "review", label: "待检查" }, { value: "favorite", label: "已收藏" },
];
const overviewObservationNames = { used: "已使用", unused: "未发现使用", unknown: "使用未知", insufficient: "观测不足" };
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
  const params = new URLSearchParams(location.hash.startsWith("#resources") ? location.hash.split("?")[1] : "");
  const kind = params.get("kind") === "mcp" ? "mcp" : "skill";
  return {
    kind,
    tab: tabs.some(tab => tab.value === params.get("tab")) ? params.get("tab") as ResourceTab : "usage",
    client: CLIENTS.some(client => client.id === params.get("client")) ? params.get("client")! : "all",
    project: params.get("project") ?? "all", window: ["7", "30", "90", "custom"].includes(params.get("window") ?? "") ? params.get("window")! : "all",
    from: validDate(params.get("from")), to: validDate(params.get("to")),
    q: params.get("q") ?? "", sort: ["sessions", "calls", "recent", "name", ...(kind === "skill" ? ["reads"] : [])].includes(params.get("sort") ?? "") ? params.get("sort")! : kind === "mcp" ? "calls" : "sessions",
    order: params.get("order") === "asc" ? "asc" : params.get("order") === "desc" ? "desc" : params.get("sort") === "name" ? "asc" : "desc",
    candidate: [...candidates, ...overviewCandidates].some(item => item.value === params.get("candidate")) ? params.get("candidate") as ResourceRoute["candidate"] : "all",
    low: Math.min(10000, positive(params.get("low"), 2)), inactive: Math.min(3650, positive(params.get("inactive"), 90)),
    favorite: params.get("favorite") === "true", page: positive(params.get("page")), pageSize: [20, 50, 100].includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : 20, id: params.get("id") ?? "",
    evidencePage: positive(params.get("evidencePage")), tool: params.get("tool") ?? "",
  };
};
function address(route: ResourceRoute) {
  return `#resources${resourceQuery({ ...route, client: route.client === "all" ? undefined : route.client,
    project: route.project === "all" ? undefined : route.project, page: route.page === 1 ? undefined : route.page,
    evidencePage: route.evidencePage === 1 ? undefined : route.evidencePage })}`;
}
const shortPath = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const usageAgentLabel = (row: { clients: Client[] }) => row.clients.length === 1 ? clientName(row.clients[0]!) : row.clients.length ? `${fmt(row.clients.length)} 个 Agent` : "Agent 未记录";
const associationNames = { linked: "已关联本地入口", partial: "部分未关联", ambiguous: "关联有歧义", unassociated: "未关联本地资源" };
const observationNames = { recorded: "已关联使用", unknown: "使用未知", insufficient: "观测不足" };
const observationLabel = (row: ResourceLocalRow) => row.observation === "recorded" && row.usage?.events === 0 ? "未发现使用" : observationNames[row.observation];
const sourceStateNames = { ok: "可读取", missing: "来源缺失", unreadable: "不可读取", invalid: "格式异常", unsupported: "待适配" };
const methodNames = { directory: "目录", symlink: "链接", file: "文件", registration: "注册配置" };
const resultNames = { success: "成功", failure: "失败", unknown: "结果未知" };
const evidenceNames = { skill_call: "Skill 调用", skill_read: "Skill 读取", mcp: "MCP 调用" };
const actionNames: Record<ResourceManagementAction, string> = { disable: "停用", standby: "移到备用", trash: "移入回收区", restore: "恢复", purge: "永久清除" };
const archiveNames = { disabled: "已停用", standby: "备用", trash: "回收区", restored: "已恢复", purged: "已永久清除" };
const operationStatusNames = { success: "本地修改完成", failure: "执行失败", conflict: "来源冲突", partial: "部分完成" };
const operationMethodNames = { native_toggle: "客户端原生开关", entry_isolation: "隔离所选入口", registration_remove: "移除所选注册", restore: "恢复原入口", permanent_purge: "清除恢复材料" };
const protectionNames: Record<string, string> = { favorite: "此资源已收藏", system: "系统默认资源", plugin: "插件管理资源" };
const registrationKeys = (client: Client) => client === "codex" ? "mcp_servers" : client === "opencode" ? "mcp" : "mcpServers";

function ResourceDialog({ open, onOpenChange, title, description, children, className = "", contentRef }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: ReactNode; className?: string; contentRef?: RefObject<HTMLDivElement | null>;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" /><Dialog.Content ref={contentRef} className={`dialog-content resource-dialog ${className}`}
      onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={event => {
        const target = returnFocus.current;
        if (target?.isConnected && target !== document.body && target.getClientRects().length) { event.preventDefault(); target.focus(); }
      }}>
      <Dialog.Title>{title}</Dialog.Title><Dialog.Description className="dialog-description">{description}</Dialog.Description>
      <Dialog.Close asChild><button className="icon-button dialog-close" aria-label={`关闭${title}`}><X size={18} /></button></Dialog.Close>
      {children}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
function ResourceEmpty({ children }: { children: ReactNode }) {
  return <div className="resource-empty"><MagnifyingGlass size={24} /><span>{children}</span></div>;
}
function FavoriteButton({ name, favorite, disabled, onClick }: { name: string; favorite: boolean; disabled?: boolean; onClick: () => void }) {
  return <button className={`icon-button resource-favorite${favorite ? " is-favorite" : ""}`} aria-label={`${favorite ? "取消收藏" : "收藏"}${name}`}
    aria-pressed={favorite} disabled={disabled} onClick={onClick}><Star size={17} weight={favorite ? "fill" : "regular"} /></button>;
}
function OverviewTable({ rows, route, onSort, onSelect, onFavorite, favoritePending }: {
  rows: ResourceOverviewRow[]; route: ResourceRoute; onSort: (sort: string) => void; onSelect: (id: string) => void;
  onFavorite: (id: string, favorite: boolean) => void; favoritePending: string | null;
}) {
  const columns = [{ value: "name", label: route.kind === "skill" ? "Skill" : "服务器" }, { value: "sessions", label: "会话" }, { value: "calls", label: "调用" }, ...(route.kind === "skill" ? [{ value: "reads", label: "读取" }] : []), { value: "recent", label: "最近使用" }];
  const heading = (column: { value: string; label: string }) => <th key={column.value} scope="col" aria-sort={route.sort === column.value ? route.order === "asc" ? "ascending" : "descending" : "none"}>
    <button aria-label={`按${column.label}排序`} onClick={() => onSort(column.value)}>{column.label}<span aria-hidden="true">{route.sort === column.value ? route.order === "asc" ? "↑" : "↓" : "↕"}</span></button>
  </th>;
  return <div className="resource-overview-scroll"><table className={`resource-overview-table${route.kind === "mcp" ? " resource-mcp-overview" : ""}`} aria-label={`${route.kind === "skill" ? "Skill" : "MCP"} 总览`}>
    <thead><tr>{heading(columns[0]!)}<th scope="col">Agent</th>{columns.slice(1).map(heading)}<th scope="col">状态</th></tr></thead>
    <tbody>{rows.map(row => <tr className={`resource-overview-row${route.id === row.identity.id ? " is-selected" : ""}`} key={row.identity.id}>
      <th scope="row"><div className="resource-overview-name"><button aria-label={`查看${row.identity.name}的使用详情`} onClick={() => onSelect(row.identity.id)}>{row.identity.name}</button><FavoriteButton name={row.identity.name} favorite={row.favorite} disabled={favoritePending === row.identity.id} onClick={() => onFavorite(row.identity.id, row.favorite)} /></div></th>
      <td className="resource-overview-agents" title={row.clients.map(clientName).join(" · ")}>{usageAgentLabel(row)}</td>
      <td>{row.stats ? fmt(row.stats.sessions) : "—"}</td><td>{row.stats ? fmt(route.kind === "skill" ? row.stats.explicitCalls : row.stats.mcpCalls) : "—"}</td>{route.kind === "skill" && <td>{row.stats ? fmt(row.stats.successfulReads) : "—"}</td>}
      <td className="resource-overview-time">{row.stats?.lastUsedAt ? dateLabel(row.stats.lastUsedAt) : "—"}</td>
      <td><div className="resource-tags"><span className={row.observation === "unknown" || row.observation === "insufficient" ? "is-warning" : ""}>{overviewObservationNames[row.observation]}</span>{row.protected && <span><ShieldCheck size={12} />受保护</span>}{!row.localBodyIds.length && row.hasHistory && <span>仅历史</span>}</div></td>
    </tr>)}</tbody>
  </table></div>;
}
function Stats({ stats, kind }: { stats: ResourceUsageStats | null; kind: ResourceKind }) {
  return <div className="resource-stats">
    <div><strong>{stats ? fmt(stats.sessions) : "未知"}</strong><span>使用会话</span></div>
    <div><strong>{stats ? fmt(kind === "skill" ? stats.explicitCalls : stats.mcpCalls) : "未知"}</strong><span>{kind === "skill" ? "显式调用" : "工具调用"}</span></div>
    {kind === "skill" && <div><strong>{stats ? fmt(stats.successfulReads) : "未知"}</strong><span>成功读取</span></div>}
    <div><strong>{stats?.results.successRate === null || !stats ? "未记录" : `${(stats.results.successRate * 100).toFixed(1)}%`}</strong><span>已知结果成功率</span></div>
    <div><strong>{stats?.duration.averageMs === null || !stats ? "未记录" : `${Math.round(stats.duration.averageMs)} ms`}</strong><span>平均耗时 · {fmt(stats?.duration.samples ?? 0)} 样本</span></div>
    {stats && <div><strong>{fmt(stats.results.unknown)}</strong><span>结果未知</span></div>}
  </div>;
}
function Trend({ rows, timeZone }: { rows: ResourceUsageTrend[]; timeZone: string }) {
  const max = rows.reduce((maximum, row) => Math.max(maximum, row.stats.events), 1);
  const start = rows.length ? Date.parse(rows[0]!.date) : 0;
  const end = rows.length ? Date.parse(rows.at(-1)!.date) : start;
  const x = (date: string) => 38 + (end === start ? .5 : (Date.parse(date) - start) / (end - start)) * 238;
  const y = (events: number) => 127 - events / max * 90;
  return <section className="resource-detail-section">
    <header><h3>使用趋势</h3><HelpPopover label="趋势口径"><p>按 {timeZone} 的事件日期统计全部已记录调用与成功读取。时间缺失另列，不推入某一天；次数表示使用活动，不表示任务效果。</p></HelpPopover></header>
    {!rows.length ? <ResourceEmpty>当前范围没有可归入日期的记录</ResourceEmpty> : <>
      <svg className="resource-trend" viewBox="0 0 300 163" role="img" aria-label="每日资源使用次数">
        {[0, max].map(value => <g key={value}><line x1="38" x2="279" y1={y(value)} y2={y(value)} /><text x="31" y={y(value) + 4} textAnchor="end">{fmt(value)}</text></g>)}
        <text x="38" y="18">次数</text>
        <polyline points={rows.map(row => `${x(row.date)},${y(row.stats.events)}`).join(" ")} />
        {rows.map(row => <circle key={row.date} cx={x(row.date)} cy={y(row.stats.events)} r="2.5"><title>{row.date} · {fmt(row.stats.events)} 次 · {fmt(row.stats.sessions)} 个会话</title></circle>)}
        <text x="38" y="150">{rows[0]!.date}</text><text x="279" y="150" textAnchor="end">{rows.at(-1)!.date}</text>
      </svg>
      <details className="resource-data-details"><summary>查看趋势数据 · {fmt(rows.length)} 天</summary><div className="resource-table-scroll"><table><thead><tr><th>日期</th><th>活动次数</th><th>会话数</th></tr></thead><tbody>{rows.map(row => <tr key={row.date}><td>{row.date}</td><td>{fmt(row.stats.events)}</td><td>{fmt(row.stats.sessions)}</td></tr>)}</tbody></table></div></details>
    </>}
  </section>;
}
function Distribution({ rows, title, label }: { rows: ResourceUsageDistribution[]; title: string; label: (value: string | null) => string }) {
  const max = rows.reduce((maximum, row) => Math.max(maximum, row.stats.events), 1);
  return <section className="resource-detail-section"><header><h3>{title}</h3><span>{fmt(rows.length)} 项</span></header>
    <div className="resource-distribution">{rows.map(row => <div key={row.value ?? "unknown"} title={row.value ?? "未记录"}><span>{label(row.value)}</span><i style={{ width: `${Math.max(2, row.stats.events / max * 100)}%` }} /><strong>{fmt(row.stats.events)}</strong></div>)}</div>
  </section>;
}
function UsageHelp({ kind }: { kind: ResourceKind }) {
  return <HelpPopover label="使用统计口径"><dl>
    <div><dt>{kind === "skill" ? "Skill" : "MCP"} 总览</dt><dd>{kind === "skill" ? "按完整名称汇总当前本地与历史 Skill" : "按完整服务器名称汇总当前本地注册与历史 MCP"}，使用会话去重；同名不能证明实例相同，名称汇总不合并本地管理对象，具体本体与入口在详情中回查。</dd></div>
    <div><dt>使用会话</dt><dd>{kind === "skill" ? "同一会话中的显式调用与成功读取合并计一次" : "同一会话中的 MCP 工具调用合并计一次"}；文本提及、声明或未证实的脚本嵌套调用不计使用。全部实际分支活动均保留。</dd></div>
    <div><dt>已知结果</dt><dd>成功率以成功与失败之和为分母，未知结果单列。耗时仅使用日志实际记录值，并列出有效样本数。</dd></div>
    <div><dt>关联与观测</dt><dd>名称相同不能证明是当前安装实例。缺少路径、对应能力或充分观测时显示未关联或未知；未发现使用不等于从未使用。</dd></div>
    <div><dt>整理与收藏</dt><dd>低频按所选范围的使用会话数判断；长期未用按最近使用和天数阈值判断。待检查包含未知、观测不足及来源异常。名称收藏与具体本体收藏独立，已收藏筛选也包含受独立收藏保护的本体。</dd></div>
  </dl></HelpPopover>;
}

export default function Resources({ active, onSession }: { active: boolean; onSession: (target: { sessionId: string; messageId: string }) => void }) {
  const [route, setRoute] = useState<ResourceRoute>(readRoute);
  const [status, setStatus] = useState<ResourceStatus | null>(null);
  const [overview, setOverview] = useState<FavoriteResult<ResourceOverviewResult> | null>(null);
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
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [favoritePending, setFavoritePending] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);
  const [compact, setCompact] = useState(() => globalThis.innerWidth < 1024);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sourceAdding, setSourceAdding] = useState(false);
  const [sourcePending, setSourcePending] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [source, setSource] = useState<ResourceManualSource>({ client: "codex", kind: "skill", path: "", format: "skill-directory" });
  const [sourceKeys, setSourceKeys] = useState("mcpServers");
  const [managementOpen, setManagementOpen] = useState(false);
  const [managementInput, setManagementInput] = useState<ResourceManagementInput | null>(null);
  const [preview, setPreview] = useState<ResourceManagementPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [managementError, setManagementError] = useState<string | null>(null);
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
  const filter = (patch: Partial<ResourceRoute>) => { if (listScroll.current) listScroll.current.scrollTop = 0; update({ ...patch, page: 1, evidencePage: 1 }); };
  const sort = (value: string) => filter({ sort: value, order: route.sort === value ? route.order === "asc" ? "desc" : "asc" : value === "name" ? "asc" : "desc" });
  const pageChange = (page: number) => { if (listScroll.current) listScroll.current.scrollTop = 0; update({ page }); };
  const showLocal = (id: string) => { savedScroll.current = 0; update({ tab: "local", id, project: "all", page: 1, q: "", candidate: "all", favorite: false, evidencePage: 1, tool: "" }, true); };
  const select = (id: string) => { savedScroll.current = listScroll.current?.scrollTop ?? 0; setDetailsCollapsed(false); update({ id, evidencePage: 1, tool: "" }, true); };
  const showHistory = (id: string) => { savedScroll.current = 0; update({ tab: "usage", id, page: 1, q: "", candidate: "all", favorite: false, evidencePage: 1, tool: "" }, true); };
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
    void resourceApi.status(controller.signal).then(setStatus).catch(failure => { if (!isAborted(failure)) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [active, reload]);
  const invalidTime = (route.tab === "usage" || route.tab === "local") && route.window === "custom" && !!route.from && !!route.to && route.from > route.to;
  const overviewRanking = route.tab === "usage";
  const overviewLabel = `${route.kind === "skill" ? "Skill" : "MCP"} 总览`;
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
  const managementQuery = useMemo(() => ({ kind: route.kind, client: route.client === "all" ? undefined : route.client, project: route.project === "all" ? undefined : route.project, q: queryText, page: route.page, pageSize: route.pageSize }), [route.kind, route.client, route.project, queryText, route.page, route.pageSize]);
  useEffect(() => {
    if (!active || invalidTime || route.tab !== "usage" && route.tab !== "local") return;
    const controller = new AbortController(); setListLoading(true); setError(null);
    const done = () => { if (!controller.signal.aborted) setListLoading(false); };
    if (overviewRanking) void resourceApi.overview(overviewQuery, controller.signal).then(result => {
      setOverview(result); if (result.favoriteIds) setStatus(current => current ? { ...current, favoriteIds: result.favoriteIds! } : current);
    }).catch(failure => { if (!isAborted(failure)) setError(errorMessage(failure)); }).finally(done);
    else void resourceApi.local(localQuery, controller.signal).then(setLocal).catch(failure => { if (!isAborted(failure)) setError(errorMessage(failure)); }).finally(done);
    return () => controller.abort();
  }, [active, query, localQuery, overviewQuery, overviewRanking, route.tab, reload, invalidTime]);
  useEffect(() => {
    if (!active || route.tab === "usage" || route.tab === "local") return;
    const controller = new AbortController(); setListLoading(true); setError(null);
    const task = route.tab === "operations" ? resourceApi.operations(managementQuery, controller.signal).then(setOperations)
      : resourceApi.archives(route.tab, managementQuery, controller.signal).then(setArchives);
    void task.catch(failure => { if (!isAborted(failure)) setError(errorMessage(failure)); }).finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => controller.abort();
  }, [active, route.tab, managementQuery, reload]);
  useEffect(() => {
    if (!active) return;
    if (!route.id || invalidTime || route.tab !== "usage" && route.tab !== "local") { setUsageDetail(null); setOverviewDetail(null); setLocalDetail(null); setDetailLoading(false); return; }
    const controller = new AbortController(); setDetailLoading(true); setDetailError(null); setUsageDetail(null); setOverviewDetail(null); setLocalDetail(null);
    const task = overviewRanking ? resourceApi.overviewDetail(route.id, { ...scopeQuery, lowSessions: route.low, inactiveDays: route.inactive }, controller.signal).then(result => { setOverviewDetail(result); setUsageDetail(result.history); if (result.favoriteIds) setStatus(current => current ? { ...current, favoriteIds: result.favoriteIds! } : current); })
      : resourceApi.localDetail(route.id, { ...scopeQuery, lowSessions: route.low, inactiveDays: route.inactive }, controller.signal).then(setLocalDetail);
    void task.catch(failure => { if (!isAborted(failure)) setDetailError(errorMessage(failure)); }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [active, route.id, route.tab, scopeQuery, overviewRanking, route.low, route.inactive, reload, invalidTime]);
  const evidenceId = overviewRanking ? usageDetail?.resource.identity.id : route.id;
  useEffect(() => {
    if (!active || !evidenceId || route.tab !== "usage" || invalidTime) { setEvidence(null); setEvidenceLoading(false); return; }
    const controller = new AbortController(); setEvidenceLoading(true); setEvidenceError(null);
    void resourceApi.evidence(evidenceId, { ...scopeQuery, page: route.evidencePage, pageSize: 10, tool: route.tool || undefined }, controller.signal)
      .then(setEvidence).catch(failure => { if (!isAborted(failure)) setEvidenceError(errorMessage(failure)); }).finally(() => { if (!controller.signal.aborted) setEvidenceLoading(false); });
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
    setFavoritePending(id); setError(null);
    try {
      const result = await resourceApi.favorite(id, !current);
      setStatus(current => current ? { ...current, favoriteIds: result.favoriteIds } : current); setReload(value => value + 1);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setFavoritePending(null); }
  };
  const refresh = async () => {
    setRefreshing(true); setError(null);
    try { setStatus(await resourceApi.refresh()); setReload(value => value + 1); setFeedback("本地资源清单已更新"); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setRefreshing(false); }
  };
  const addSource = async (event: FormEvent) => {
    event.preventDefault(); setSourcePending(true); setSourceError(null);
    try {
      const result = await resourceApi.addSource({ ...source, path: source.path.trim(), keyPath: source.kind === "mcp" ? sourceKeys.split(".").map(key => key.trim()).filter(Boolean) : undefined });
      setStatus(result); setSourceAdding(false); setReload(value => value + 1); setFeedback("手动来源已添加");
    } catch (failure) { setSourceError(errorMessage(failure)); }
    finally { setSourcePending(false); }
  };
  const removeSource = async (id: string) => {
    setSourcePending(true); setSourceError(null);
    try { setStatus(await resourceApi.removeSource(id)); setReload(value => value + 1); setFeedback("手动来源已移出盘点范围"); }
    catch (failure) { setSourceError(errorMessage(failure)); }
    finally { setSourcePending(false); }
  };
  const showManagement = async (input: ResourceManagementInput) => {
    const sequence = ++managementRequest.current;
    setManagementInput(input); setManagementOpen(true); setPreview(null); setManagementError(null); setManagementResult(null); setPurgeConfirmed(false); setPreviewLoading(true);
    try {
      const result = await resourceApi.preview(input);
      if (sequence === managementRequest.current) setPreview(result);
    } catch (failure) { if (sequence === managementRequest.current) setManagementError(errorMessage(failure)); }
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
      if (result.status === "success") { update({ id: "" }); setFeedback(`${operationStatusNames[result.status]} · ${result.clientEffect === "pending_reload" ? "待重新加载" : "客户端生效状态未知"}`); }
    } catch (failure) { setManagementError(errorMessage(failure)); setPreview(null); }
    finally { setApplying(false); }
  };
  const reset = () => {
    const defaults = { ...readRoute(), client: "all", project: "all", window: "all", from: "", to: "", q: "", sort: route.kind === "mcp" ? "calls" : "sessions", order: "desc" as const, candidate: "all" as const, low: 2, inactive: 90, favorite: false, page: 1, pageSize: 20 };
    setQueryText(""); update(defaults);
  };
  const projectOptions = [{ value: "all", label: "全部项目" }, { value: "none", label: "无项目" }, ...(status?.projects ?? []).map(path => ({ value: path, label: shortPath(path), description: path }))];
  const historyView = route.tab === "usage" || route.tab === "local";
  const filters = <div className="resource-filter-content" id={compact ? undefined : "resource-filter-content"}>
    <div className="resource-field"><span>{overviewRanking ? "Agent" : "客户端"}</span><FilterSelect label={overviewRanking ? "资源Agent" : "资源客户端"} value={route.client} options={[{ value: "all", label: overviewRanking ? "全部 Agent" : "全部客户端" }, ...CLIENTS.map(client => ({ value: client.id, label: client.name }))]} onChange={value => filter({ client: value })} /></div>
    {!overviewRanking && <div className="resource-field"><span>项目</span><ProjectPicker value={route.project} options={projectOptions} onChange={value => filter({ project: value })} /></div>}
    {historyView && <><div className="resource-field"><span>使用时间</span><FilterSelect label="资源使用时间" value={route.window} options={[{ value: "all", label: "全部历史" }, { value: "7", label: "近 7 天" }, { value: "30", label: "近 30 天" }, { value: "90", label: "近 90 天" }, { value: "custom", label: "自定义日期" }]} onChange={value => { setTimeAnchor(Date.now()); filter({ window: value }); }} /></div>
      {route.window === "custom" && <div className="resource-date-fields"><div className="resource-field"><span>从</span><DatePicker label="资源开始日期" value={route.from} onChange={value => filter({ from: value })} /></div><div className="resource-field"><span>到</span><DatePicker label="资源结束日期" value={route.to} onChange={value => filter({ to: value })} /></div></div>}
      <div className="resource-field"><span>排序</span><FilterSelect label="资源排序" value={route.sort} options={[{ value: "sessions", label: "使用会话数" }, { value: "calls", label: "调用次数" }, ...(route.kind === "skill" ? [{ value: "reads", label: "读取次数" }] : []), { value: "recent", label: "最近使用" }, { value: "name", label: "名称" }]} onChange={value => filter({ sort: value, order: value === "name" ? "asc" : "desc" })} /></div>
      <div className="resource-field"><span>排序方向</span><FilterSelect label="资源排序方向" value={route.order} options={[{ value: "desc", label: "降序" }, { value: "asc", label: "升序" }]} onChange={value => filter({ order: value as ResourceRoute["order"] })} /></div>
    </>}
    {route.tab === "local" && <><div className="resource-field"><span>整理候选</span><FilterSelect label="资源整理候选" value={route.candidate === "used" ? "all" : route.candidate} options={route.kind === "mcp" ? candidates.filter(candidate => candidate.value !== "duplicate") : candidates} onChange={value => filter({ candidate: value as ResourceCandidate })} /></div>
    </>}
    {(route.tab === "local" || overviewRanking) && <>
      {route.candidate === "low" && <label className="resource-field">使用会话数不超过<input type="number" min="1" max="10000" aria-label="低频使用会话阈值" value={route.low} onChange={event => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value > 0 && value <= 10000) filter({ low: value }); }} /></label>}
      {route.candidate === "old" && <label className="resource-field">未使用天数至少<input type="number" min="1" max="3650" aria-label="长期未用天数阈值" value={route.inactive} onChange={event => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value > 0 && value <= 3650) filter({ inactive: value }); }} /></label>}
    </>}
    <button className="button subtle resource-reset" onClick={reset}>重置筛选</button>
    <div className="resource-filter-footer"><button className="text-button" onClick={() => setSourcesOpen(true)}>来源与能力</button><button className="text-button" onClick={() => { const client = route.client === "all" ? "codex" : route.client as Client; setSource({ client, kind: route.kind, path: "", format: route.kind === "skill" ? "skill-directory" : client === "codex" ? "toml" : "json" }); setSourceKeys(registrationKeys(client)); setSourceError(null); setSourceAdding(true); }}><Plus size={14} />添加来源</button></div>
  </div>;

  const selectedArchive = archives?.archives.find(item => item.id === route.id);
  const selectedOperation = operations?.operations.find(item => item.id === route.id);
  const overviewLocal = overviewDetail && <section className="resource-detail-section"><header><h3>本地本体与入口</h3><span>{fmt(overviewDetail.local.length)} 个本体</span></header>
    {overviewDetail.local.length ? overviewDetail.local.map((row, index) => <div className="resource-entry" key={row.body.id}>
      <header><strong>{row.body.name}</strong><FavoriteButton name={`${row.body.name}本体 ${index + 1}`} favorite={!!status?.favoriteIds.includes(row.body.id)} disabled={favoritePending === row.body.id || !status} onClick={() => void favorite(row.body.id)} /></header>
      <p className="resource-path">{row.body.targetPath ?? row.entries[0]?.entryPath ?? "本体路径未知"}</p>
      <div className="resource-tags"><span>{[...new Set(row.entries.map(entry => clientName(entry.client)))].join(" · ") || "Agent 未记录"}</span><span>{fmt(row.entries.length)} 个入口</span>{row.protected && <span>受保护</span>}</div>
      <div className="resource-entry-actions"><button className="button" aria-label={`查看${row.body.name}的本地本体 ${index + 1}`} onClick={() => showLocal(row.body.id)}>查看本地入口<CaretRight size={14} /></button></div>
    </div>) : <ResourceEmpty>{route.kind === "skill" ? "当前清单没有此 Skill 的本地本体" : "当前清单没有此 MCP 的本地注册"}</ResourceEmpty>}
  </section>;
  const detail = <>
    {detailLoading ? <div role="status" className="resource-loading">正在读取资源详情…</div> : detailError ? <div className="resource-alert" role="alert">{detailError}<button className="text-button" onClick={() => setReload(value => value + 1)}>重试</button></div> : usageDetail ? <>
      <div className="resource-detail-heading"><div><span>{usageAgentLabel(overviewDetail?.resource ?? usageDetail.resource)}</span><h2>{usageDetail.resource.identity.name}</h2></div><FavoriteButton name={usageDetail.resource.identity.name} favorite={overviewDetail?.resource.favorite ?? usageDetail.resource.favorite} disabled={favoritePending === route.id} onClick={() => void favorite(overviewDetail?.resource.identity.id ?? route.id, overviewDetail?.resource.favorite ?? usageDetail.resource.favorite)} /></div>
      <div className="resource-tags">{overviewDetail && <><span className={overviewDetail.resource.observation === "unknown" || overviewDetail.resource.observation === "insufficient" ? "is-warning" : ""}>{overviewObservationNames[overviewDetail.resource.observation]}</span>{overviewDetail.resource.protected && <span><ShieldCheck size={12} />受保护</span>}{!overviewDetail.resource.localBodyIds.length && <span>仅历史</span>}</>}<span className={usageDetail.resource.association.state !== "linked" ? "is-warning" : ""}>{associationNames[usageDetail.resource.association.state]}</span>{usageDetail.coverage.partial && <span className="is-warning">部分记录</span>}{usageDetail.resource.stats.missingTimeEvents > 0 && <span className="is-warning">{fmt(usageDetail.resource.stats.missingTimeEvents)} 条时间缺失</span>}</div>
      {usageDetail.resource.identity.path && <p className="resource-path">{usageDetail.resource.identity.path}</p>}
      <Stats stats={overviewDetail ? overviewDetail.resource.stats : usageDetail.resource.stats} kind={route.kind} /><p className="resource-last-used">最近使用 · {dateLabel((overviewDetail ? overviewDetail.resource.stats : usageDetail.resource.stats)?.lastUsedAt ?? undefined)}</p>
      <Trend rows={usageDetail.trend} timeZone={usageDetail.timeZone} />
      <Distribution rows={usageDetail.clients} title="Agent 分布" label={value => value ? clientName(value as Client) : "Agent 未记录"} />
      <Distribution rows={usageDetail.projects} title="项目分布" label={value => value ? shortPath(value) : "无项目"} />
      <details className="resource-data-details"><summary>历史来源 · {fmt(usageDetail.origins.length)} 个</summary><div className="resource-origin-list">{usageDetail.origins.map(origin => <div key={origin.id}><strong>{clientName(origin.client)}</strong><span title={origin.project}>{origin.project ? shortPath(origin.project) : "无项目"}</span><p className="resource-path">{origin.path ?? "路径未记录"}</p></div>)}</div></details>
      {route.kind === "mcp" && <section className="resource-detail-section"><header><h3>工具调用</h3><span>{fmt(usageDetail.tools.length)} 个工具</span></header><div className="resource-tool-list">{usageDetail.tools.map(tool => <button key={tool.name} className={route.tool === tool.name ? "is-selected" : ""} aria-pressed={route.tool === tool.name} onClick={() => update({ tool: route.tool === tool.name ? "" : tool.name, evidencePage: 1 })}><strong>{tool.name}</strong><span>{fmt(tool.stats.mcpCalls)} 次</span><small>失败 {fmt(tool.stats.results.failure)} · 未知 {fmt(tool.stats.results.unknown)} · {tool.stats.duration.samples ? `${Math.round(tool.stats.duration.averageMs!)} ms / ${fmt(tool.stats.duration.samples)} 样本` : "耗时未记录"}</small></button>)}</div></section>}
      <section className="resource-detail-section"><header><h3>{route.tool ? `${route.tool} 的证据` : "使用证据"}</h3>{route.tool && <button className="text-button" onClick={() => update({ tool: "", evidencePage: 1 })}>全部工具</button>}</header>
        {evidenceLoading ? <div role="status" className="resource-loading">正在读取使用证据…</div> : evidenceError ? <div role="alert" className="resource-alert">{evidenceError}</div> : evidence?.events.length ? <>
          <div className="resource-evidence">{evidence.events.map(event => <a key={event.id} href={`#sessions?${new URLSearchParams({ id: event.sessionId, mode: "trace", message: event.messageId, branch: "all" })}`} onClick={click => { if (!click.metaKey && !click.ctrlKey && !click.shiftKey && click.button === 0) { click.preventDefault(); savedScroll.current = listScroll.current?.scrollTop ?? 0; savedDetailScroll.current = (compact ? detailDialogScroll.current : detailScroll.current)?.scrollTop ?? 0; returnFromEvidence.current = true; onSession({ sessionId: event.sessionId, messageId: event.messageId }); } }}>
            <div><strong>{event.tool ?? evidenceNames[event.kind]}</strong><span className={`resource-result is-${event.status}`}>{resultNames[event.status]}</span><ArrowSquareOut size={14} /></div><span>{evidenceNames[event.kind]} · {dateLabel(event.occurredAt)}</span>{event.pairing === "ambiguous" && <span className="resource-result is-unknown">结果配对有歧义</span>}
          </a>)}</div><ResourcePagination page={evidence.page} total={evidence.total} pageSize={evidence.pageSize} label="使用证据" onChange={page => update({ evidencePage: page })} />
        </> : <ResourceEmpty>当前范围没有使用证据</ResourceEmpty>}
      </section>
      {overviewLocal}
    </> : overviewDetail ? <>
      <div className="resource-detail-heading"><div><span>{usageAgentLabel(overviewDetail.resource)}</span><h2>{overviewDetail.resource.identity.name}</h2></div><FavoriteButton name={overviewDetail.resource.identity.name} favorite={overviewDetail.resource.favorite} disabled={favoritePending === route.id} onClick={() => void favorite(overviewDetail.resource.identity.id, overviewDetail.resource.favorite)} /></div>
      <div className="resource-tags"><span className={overviewDetail.resource.observation === "unknown" || overviewDetail.resource.observation === "insufficient" ? "is-warning" : ""}>{overviewObservationNames[overviewDetail.resource.observation]}</span>{overviewDetail.resource.protected && <span><ShieldCheck size={12} />受保护</span>}</div>
      <Stats stats={overviewDetail.resource.stats} kind={route.kind} />
      {overviewLocal}
    </> : localDetail ? <>
      <div className="resource-detail-heading"><div><span>{route.kind === "skill" ? "本地 Skill" : "本地 MCP 注册"}</span><h2>{localDetail.row.body.name}</h2></div><FavoriteButton name={localDetail.row.body.name} favorite={!!status?.favoriteIds.includes(route.id)} disabled={favoritePending === route.id || !status} onClick={() => void favorite(route.id)} /></div>
      <div className="resource-tags"><span className={localDetail.row.observation !== "recorded" ? "is-warning" : ""}>{observationLabel(localDetail.row)}</span>{localDetail.row.protected && <span><ShieldCheck size={12} />受保护</span>}{localDetail.row.favorite && !status?.favoriteIds.includes(route.id) && <span>关联收藏保护</span>}{localDetail.row.candidates.includes("duplicate") && <span>SKILL.md 相同</span>}</div>
      <Stats stats={localDetail.row.usage} kind={route.kind} />
      <Trend rows={localDetail.trend} timeZone={localDetail.timeZone} />
      <Distribution rows={localDetail.clients} title="客户端分布" label={value => value ? clientName(value as Client) : "客户端未知"} />
      <Distribution rows={localDetail.projects} title="项目分布" label={value => value ? shortPath(value) : "无项目"} />
      <section className="resource-detail-section"><header><h3>客户端入口</h3><span>{fmt(localDetail.row.entries.length)} 个</span></header>{localDetail.row.entries.map(entry => <Entry key={entry.id} entry={entry} onManage={input => void showManagement(input)} />)}</section>
      <section className="resource-detail-section"><header><h3>关联历史</h3></header>{localDetail.row.historyIds.length ? <div className="resource-history-links">{localDetail.row.historyIds.map((id, index) => <button key={id} className="button subtle" onClick={() => showHistory(id)}>查看使用分布与证据{localDetail.row.historyIds.length > 1 ? ` ${index + 1}` : ""}<CaretRight size={14} /></button>)}</div> : <ResourceEmpty>尚无可确认归属的历史入口</ResourceEmpty>}</section>
      <details className="resource-data-details"><summary>发现信息</summary><dl className="resource-facts"><dt>首次发现</dt><dd>{dateLabel(localDetail.row.firstSeenAt)}</dd><dt>本次盘点</dt><dd>{dateLabel(localDetail.inventory.observedAt)}</dd>{localDetail.row.body.targetPath && <><dt>真实目标</dt><dd>{localDetail.row.body.targetPath}</dd></>}</dl></details>
    </> : selectedArchive && !historyView && route.tab !== "operations" ? <>
      <div className="resource-detail-heading"><div><span>{clientName(selectedArchive.entry.client)}</span><h2>{selectedArchive.entry.name}</h2></div></div>
      <div className="resource-tags"><span>{archiveNames[selectedArchive.state]}</span><span>{selectedArchive.restorable ? "可恢复" : "恢复材料不可用"}</span>{selectedArchive.operationStatus === "partial" && <span className="is-warning">部分完成</span>}</div>
      <dl className="resource-facts"><dt>原位置</dt><dd>{selectedArchive.originalPath}</dd><dt>作用范围</dt><dd>{selectedArchive.entry.scope === "user" ? "用户范围" : selectedArchive.entry.project ?? "项目未知"}</dd><dt>管理时间</dt><dd>{dateLabel(selectedArchive.createdAt)}</dd>{selectedArchive.storedPath && <><dt>恢复材料</dt><dd>{selectedArchive.storedPath}</dd></>}</dl>
      <div className="resource-entry-actions"><button className="button primary" disabled={!selectedArchive.restorable} onClick={() => void showManagement({ action: "restore", operationId: selectedArchive.operationId })}>预览恢复</button>{selectedArchive.state === "trash" && <button className="button resource-danger-button" onClick={() => void showManagement({ action: "purge", operationId: selectedArchive.operationId })}>预览永久清除</button>}</div>
    </> : selectedOperation && route.tab === "operations" ? <>
      <div className="resource-detail-heading"><div><span>{clientName(selectedOperation.resource.client)}</span><h2>{selectedOperation.name}</h2></div></div>
      <div className="resource-tags"><span>{actionNames[selectedOperation.action]}</span><span className={selectedOperation.status === "success" ? "" : "is-warning"}>{operationStatusNames[selectedOperation.status]}</span><span>{selectedOperation.clientEffect === "pending_reload" ? "待重新加载" : "客户端生效状态未知"}</span></div>
      <p className="resource-operation-message">{selectedOperation.message}</p>
      <dl className="resource-facts"><dt>执行时间</dt><dd>{dateLabel(selectedOperation.createdAt)}</dd><dt>作用范围</dt><dd>{selectedOperation.resource.scope === "user" ? "用户范围" : selectedOperation.resource.project ?? "项目未知"}</dd><dt>本地状态</dt><dd>{selectedOperation.localState === "changed" ? "已修改" : selectedOperation.localState === "partial" ? "部分修改" : "未修改"}</dd></dl>
      {selectedOperation.archiveId && ["disable", "standby", "trash"].includes(selectedOperation.action) && <button className="button" onClick={() => update({ tab: selectedOperation.action === "disable" ? "disabled" : selectedOperation.action === "trash" ? "trash" : "standby", q: selectedOperation.name, id: "", page: 1 }, true)}>查看恢复记录</button>}
    </> : <ResourceEmpty>选择一个资源查看详情</ResourceEmpty>}
  </>;

  return <div className="resources-shell" aria-label="资源管理" data-compact={compact}>
    <ResizableWorkspace sidebarCollapsed={sidebarCollapsed} detailsCollapsed={detailsCollapsed} semantics={{ sidebar: { label: "调整资源筛选宽度", controls: "resource-filter-content" }, details: { label: "调整资源详情宽度", controls: "resource-detail-content" } }}>
      <aside className={`sidebar resource-sidebar${sidebarCollapsed ? " panel-collapsed" : ""}`} aria-label="资源筛选">
        <div className="pane-heading"><span>筛选</span><button className="icon-button panel-toggle" aria-label={sidebarCollapsed ? "展开资源筛选" : "收起资源筛选"} aria-expanded={!sidebarCollapsed} aria-controls="resource-filter-content" onClick={() => setSidebarCollapsed(value => !value)}>{sidebarCollapsed ? <CaretRight size={17} /> : <CaretLeft size={17} />}</button></div>{!sidebarCollapsed && !compact && filters}
      </aside>
      <main className="resources-main">
        <header className="resources-heading"><div><h1>资源管理</h1></div><div className="resources-heading-actions"><button className="icon-button resource-mobile-filter" aria-label="打开资源筛选" onClick={() => setFiltersOpen(true)}><Funnel size={18} /></button><button className="button" disabled={refreshing} onClick={() => void refresh()}><ArrowClockwise size={15} className={refreshing ? "spinning" : ""} />{refreshing ? "正在盘点" : "刷新清单"}</button></div></header>
        <div className="resource-kind-tabs" role="group" aria-label="资源类型">{(["skill", "mcp"] as const).map(kind => <button key={kind} aria-pressed={route.kind === kind} className={route.kind === kind ? "is-selected" : ""} onClick={() => update({ kind, id: "", page: 1, tool: "", candidate: kind === "mcp" && route.candidate === "duplicate" ? "all" : route.candidate, sort: kind === route.kind ? route.sort : kind === "mcp" ? "calls" : "sessions", order: kind === route.kind ? route.order : "desc" })}>{kind === "skill" ? "Skill" : "MCP"}</button>)}<UsageHelp kind={route.kind} /></div>
        <nav className="resource-view-tabs" aria-label="资源视图">{tabs.map(tab => <button key={tab.value} aria-current={route.tab === tab.value ? "page" : undefined} onClick={() => update({ tab: tab.value, id: "", page: 1, tool: "" }, true)}>{tab.value === "usage" ? overviewLabel : tab.label}</button>)}</nav>
        <div className="resource-list-toolbar"><label className="resource-search"><MagnifyingGlass size={16} /><input aria-label="搜索资源名称或路径" value={route.q} placeholder="搜索资源名称或路径" onChange={event => filter({ q: event.target.value })} />{route.q && <button className="icon-button" aria-label="清空资源搜索" onClick={() => filter({ q: "" })}><X size={14} /></button>}</label>
          {overviewRanking && !listLoading && overview && <span>{fmt(overview.total)} {route.kind === "skill" ? "个 Skill" : "个 MCP"}</span>}{route.tab === "local" && !listLoading && local && <span>{fmt(local.total)} 个资源</span>}
          {route.tab === "operations" && !listLoading && operations && <span>{fmt(operations.total)} 条操作</span>}{!historyView && route.tab !== "operations" && !listLoading && archives && <span>{fmt(archives.total)} 个资源</span>}
        </div>
        {invalidTime && <div className="resource-alert" role="alert">开始日期不能晚于结束日期</div>}
        {error && <div className="resource-alert" role="alert">{error}<button className="text-button" onClick={() => setReload(value => value + 1)}>重试</button></div>}
        {feedback && <div className="resource-feedback" role="status">{feedback}<button className="icon-button" aria-label="关闭资源操作反馈" onClick={() => setFeedback(null)}><X size={14} /></button></div>}
        {overviewRanking && overview && !listLoading && <>
          <div className="resource-quick-filters" role="group" aria-label={`${route.kind === "skill" ? "Skill" : "MCP"} 快速筛选`}>{overviewCandidates.map(candidate => <button key={candidate.value} aria-pressed={route.candidate === candidate.value || candidate.value === "all" && !overviewCandidates.some(item => item.value === route.candidate)} onClick={() => filter({ candidate: candidate.value, favorite: false })}>{candidate.label}<strong>{fmt(overview.counts[candidate.value])}</strong></button>)}</div>
          {(overview.partial || !!overview.coverage?.missingTimeEvents) && <div className="resource-range-summary">{overview.partial && <span className="resource-state is-warning">部分来源或记录</span>}{!!overview.coverage?.missingTimeEvents && <span className="resource-state is-warning">{fmt(overview.coverage.missingTimeEvents)} 条时间缺失</span>}</div>}
        </>}
        {route.tab === "local" && local?.partial && !listLoading && <div className="resource-range-summary"><span className="resource-state is-warning">部分来源未读取</span></div>}
        <div className="resource-list-scroll" ref={listScroll} aria-busy={listLoading}>
          {listLoading ? <div role="status" className="resource-loading">正在读取资源…</div> : invalidTime ? null : overviewRanking ? overview?.resources.length ? <OverviewTable rows={overview.resources} route={route} onSort={sort} onSelect={select} onFavorite={(id, current) => void favorite(id, current)} favoritePending={favoritePending} /> : <ResourceEmpty>没有匹配的{route.kind === "skill" ? " Skill" : " MCP"}</ResourceEmpty> : route.tab === "local" ? local?.rows.length ? <div className="resource-rows">{local.rows.map(row => <div className={`resource-row${route.id === row.body.id ? " is-selected" : ""}`} key={row.body.id}>
            <button className="resource-row-main" onClick={() => select(row.body.id)} aria-label={`查看${row.body.name}的本地详情`}><div className="resource-row-heading"><strong>{row.body.name}</strong><span>{fmt(row.entries.length)} 个入口</span></div><div className="resource-row-subtitle" title={row.body.targetPath}>{row.body.targetPath ?? row.entries[0]?.entryPath}</div><div className="resource-row-metrics"><span>{[...new Set(row.entries.map(entry => clientName(entry.client)))].join(" · ")}</span>{row.usage && <span><b>{fmt(row.usage.sessions)}</b> 使用会话</span>}</div><div className="resource-tags"><span className={row.observation === "recorded" ? "" : "is-warning"}>{observationLabel(row)}</span>{row.protected && <span><ShieldCheck size={12} />受保护</span>}{row.favorite && !status?.favoriteIds.includes(row.body.id) && <span>关联收藏保护</span>}{row.entries.some(entry => !entry.capabilities.standby && !entry.capabilities.disable && !entry.capabilities.trash) && <span>只读</span>}{row.candidates.includes("broken") && <span className="is-warning">断链／缺失</span>}{row.candidates.includes("duplicate") && <span>SKILL.md 相同</span>}</div></button><FavoriteButton name={row.body.name} favorite={!!status?.favoriteIds.includes(row.body.id)} disabled={favoritePending === row.body.id || !status} onClick={() => void favorite(row.body.id)} />
          </div>)}</div> : <ResourceEmpty>没有匹配的本地资源</ResourceEmpty> : route.tab === "operations" ? operations?.operations.length ? <div className="resource-rows">{operations.operations.map(operation => <div className={`resource-row${route.id === operation.id ? " is-selected" : ""}`} key={operation.id}><button className="resource-row-main" aria-label={`查看${operation.name}的${actionNames[operation.action]}记录`} onClick={() => select(operation.id)}><div className="resource-row-heading"><strong>{operation.name}</strong><span>{actionNames[operation.action]}</span></div><div className="resource-row-metrics"><span>{clientName(operation.resource.client)}</span><span>{dateLabel(operation.createdAt)}</span></div><div className="resource-tags"><span className={operation.status === "success" ? "" : "is-warning"}>{operationStatusNames[operation.status]}</span><span>{operation.clientEffect === "pending_reload" ? "待重新加载" : "客户端生效状态未知"}</span></div></button></div>)}</div> : <ResourceEmpty>没有匹配的操作记录</ResourceEmpty> : archives?.archives.length ? <div className="resource-rows">{archives.archives.map(archive => <div className={`resource-row${route.id === archive.id ? " is-selected" : ""}`} key={archive.id}><button className="resource-row-main" aria-label={`查看${archive.entry.name}的恢复记录`} onClick={() => select(archive.id)}><div className="resource-row-heading"><strong>{archive.entry.name}</strong><span>{clientName(archive.entry.client)}</span></div><div className="resource-row-subtitle" title={archive.originalPath}>{archive.originalPath}</div><div className="resource-row-metrics"><span>{dateLabel(archive.createdAt)}</span></div><div className="resource-tags"><span>{archiveNames[archive.state]}</span><span className={!archive.restorable ? "is-warning" : ""}>{archive.restorable ? "可恢复" : "恢复材料不可用"}</span>{archive.operationStatus === "partial" && <span className="is-warning">部分完成</span>}</div></button></div>)}</div> : <ResourceEmpty>当前范围没有{tabs.find(tab => tab.value === route.tab)?.label}资源</ResourceEmpty>}
        </div>
        {overviewRanking && overview && !listLoading && <ResourcePagination page={overview.page} total={overview.total} pageSize={overview.pageSize} label={overviewLabel} onPageSizeChange={pageSize => filter({ pageSize })} onChange={pageChange} />}
        {route.tab === "local" && local && !listLoading && <ResourcePagination page={local.page} total={local.total} pageSize={local.pageSize} label="本地资源" onPageSizeChange={pageSize => filter({ pageSize })} onChange={pageChange} />}
        {route.tab === "operations" && operations && !listLoading && <ResourcePagination page={operations.page} total={operations.total} pageSize={operations.pageSize} label="操作记录" onPageSizeChange={pageSize => filter({ pageSize })} onChange={pageChange} />}
        {!historyView && route.tab !== "operations" && archives && !listLoading && <ResourcePagination page={archives.page} total={archives.total} pageSize={archives.pageSize} label="恢复记录" onPageSizeChange={pageSize => filter({ pageSize })} onChange={pageChange} />}
      </main>
      <aside className={`resource-details${detailsCollapsed ? " panel-collapsed" : ""}`} aria-label="资源详情">
        <div className="pane-heading"><span>资源详情</span><button className="icon-button panel-toggle" aria-label={detailsCollapsed ? "展开资源详情" : "收起资源详情"} aria-expanded={!detailsCollapsed} aria-controls="resource-detail-content" onClick={() => setDetailsCollapsed(value => !value)}>{detailsCollapsed ? <CaretLeft size={17} /> : <CaretRight size={17} />}</button></div>
        <div className="resource-detail-scroll" ref={detailScroll} id="resource-detail-content" hidden={detailsCollapsed}>{!compact && detail}</div>
      </aside>
    </ResizableWorkspace>
    <ResourceDialog open={compact && filtersOpen && active} onOpenChange={setFiltersOpen} title="资源筛选" description="选择资源范围" className="resource-filter-dialog">{filters}<div className="dialog-end"><button className="button primary" onClick={() => setFiltersOpen(false)}>完成</button></div></ResourceDialog>
    <ResourceDialog open={compact && !!route.id && active} onOpenChange={open => { if (!open) update({ id: "" }); }} title="资源详情" description={route.kind === "skill" ? "Skill 使用与本地入口" : "MCP 使用与本地入口"} className="resource-detail-dialog" contentRef={detailDialogScroll}>{detail}</ResourceDialog>
    <ResourceDialog open={sourcesOpen && active} onOpenChange={setSourcesOpen} title="来源与能力" description={`最近盘点 · ${status?.observedAt ? dateLabel(status.observedAt) : "尚未盘点"}`}>
      {sourceError && <div className="resource-alert" role="alert">{sourceError}</div>}
      <div className="resource-source-list">{status?.sources.map(item => { const manual = item.manualSourceId ? status.manualSources.find(source => source.id === item.manualSourceId) : undefined; return <div key={item.id}><header><strong>{clientName(item.client)} · {item.kind === "skill" ? "Skill" : "MCP"}</strong><span className={`resource-state${item.readState !== "ok" ? " is-warning" : ""}`}>{sourceStateNames[item.readState]}</span></header><p>{item.path}</p><div className="resource-tags"><span>{item.scope === "user" ? "用户范围" : "项目范围"}</span><span>{item.format}</span><span>{item.verified ? "已核验格式" : "只读／待适配"}</span>{item.origin === "plugin" && <span>所属插件 {item.owner ?? "未知"}</span>}</div>{manual?.id && <button className="text-button" disabled={sourcePending} onClick={() => void removeSource(manual.id!)}>移出盘点范围</button>}</div>; })}</div>
      {!!status?.gaps.length && <details className="resource-data-details"><summary>来源缺口 · {fmt(status.gaps.length)}</summary><div className="resource-source-gaps">{status.gaps.map((gap, index) => <p key={index}>{clientName(gap.client)} · {gap.reason === "project_missing" ? "项目已缺失" : gap.reason === "limit" ? "来源数量受限" : sourceStateNames[gap.reason]}</p>)}</div></details>}
    </ResourceDialog>
    <ResourceDialog open={sourceAdding && active} onOpenChange={open => { if (!sourcePending) setSourceAdding(open); }} title="添加资源来源" description="仅盘点指定路径；未经核验的格式保持只读。">
      <form className="resource-source-form" onSubmit={event => void addSource(event)}>
        <div className="resource-field"><span>客户端</span><FilterSelect label="来源客户端" value={source.client} options={CLIENTS.map(client => ({ value: client.id, label: client.name }))} onChange={value => { setSource(current => ({ ...current, client: value as Client, format: current.kind === "skill" ? current.format : value === "codex" ? "toml" : "json" })); setSourceKeys(registrationKeys(value as Client)); }} /></div>
        <div className="resource-field"><span>资源类型</span><FilterSelect label="来源资源类型" value={source.kind} options={[{ value: "skill", label: "Skill" }, { value: "mcp", label: "MCP" }]} onChange={value => setSource(current => ({ ...current, kind: value as ResourceKind, format: value === "skill" ? "skill-directory" : current.client === "codex" ? "toml" : "json" }))} /></div>
        <label className="resource-field">绝对路径<input required value={source.path} onChange={event => setSource(current => ({ ...current, path: event.target.value }))} placeholder="/absolute/path/to/resources" aria-label="资源来源绝对路径" autoComplete="off" /></label>
        <div className="resource-field"><span>配置格式</span><FilterSelect label="来源配置格式" value={source.format!} options={source.kind === "skill" ? [{ value: "skill-directory", label: "Skill 目录" }, { value: "skill-files", label: "独立 Skill 文件" }] : [{ value: "json", label: "JSON" }, { value: "jsonc", label: "JSONC" }, { value: "toml", label: "TOML" }]} onChange={value => setSource(current => ({ ...current, format: value as ResourceManualSource["format"] }))} /></div>
        <label className="resource-field">项目路径（可选）<input value={source.project ?? ""} onChange={event => setSource(current => ({ ...current, project: event.target.value || undefined }))} placeholder="用户级来源留空" aria-label="资源来源项目路径" autoComplete="off" /></label>
        {source.kind === "mcp" && <label className="resource-field">注册字段路径<input value={sourceKeys} onChange={event => setSourceKeys(event.target.value)} placeholder="mcpServers" aria-label="MCP 注册字段路径" /></label>}
        {sourceError && <div className="resource-alert" role="alert">{sourceError}</div>}
        <div className="dialog-end"><button type="button" className="button subtle" disabled={sourcePending} onClick={() => setSourceAdding(false)}>取消</button><button className="button primary" disabled={sourcePending || !source.path.trim()}>{sourcePending ? "正在添加…" : "添加并盘点"}</button></div>
      </form>
    </ResourceDialog>
    <ResourceDialog open={managementOpen && active} onOpenChange={closeManagement} title={managementInput ? `${actionNames[managementInput.action]}预览` : "资源操作预览"} description="核对本次具体影响，再确认执行。">
      {previewLoading ? <div className="resource-loading" role="status">正在核验资源与恢复材料…</div> : preview ? <>
        <div className="resource-preview-heading"><strong>{preview.resource.name}</strong><div className="resource-tags"><span>{clientName(preview.resource.client)}</span><span>{preview.resource.scope === "user" ? "用户范围" : "项目范围"}</span>{preview.protected && <span className="is-warning"><ShieldCheck size={12} />受保护</span>}<span className="is-warning">引用范围待确认</span></div></div>
        <dl className="resource-facts"><dt>操作方式</dt><dd>{operationMethodNames[preview.method]}</dd><dt>原位置</dt><dd>{preview.sourcePath}</dd>{preview.destinationPath && <><dt>目标位置</dt><dd>{preview.destinationPath}</dd></>}{preview.resource.project && <><dt>项目</dt><dd>{preview.resource.project}</dd></>}<dt>恢复方式</dt><dd>{preview.restoration}</dd><dt>有效期至</dt><dd>{dateLabel(preview.expiresAt)}</dd></dl>
        {preview.protected && <div className="resource-alert" role="alert">{preview.protectionReasons.length ? preview.protectionReasons.map(reason => protectionNames[reason] ?? reason).join(" · ") : "此资源受到保护，请确认影响。"}</div>}
        <section className="resource-detail-section"><header><h3>已发现受影响入口</h3><span>{fmt(preview.affectedEntries.length)} 个</span></header><div className="resource-preview-entries">{preview.affectedEntries.map(entry => <div key={entry.id}><strong>{clientName(entry.client)} · {entry.name}</strong><span>{entry.scope === "user" ? "用户范围" : entry.project ?? "项目未知"}</span><p>{entry.entryPath}</p></div>)}</div></section>
        {preview.action === "purge" && <label className="resource-checkbox resource-purge-confirm"><input type="checkbox" checked={purgeConfirmed} onChange={event => setPurgeConfirmed(event.target.checked)} />我确认永久清除所列恢复材料</label>}
        <div className="dialog-end"><button className="button subtle" disabled={applying} onClick={() => closeManagement(false)}>取消</button><button className={`button ${preview.action === "trash" || preview.action === "purge" ? "resource-danger-button" : "primary"}`} disabled={applying || preview.action === "purge" && !purgeConfirmed} onClick={() => void applyManagement()}>{applying ? "正在执行…" : `确认${actionNames[preview.action]}`}</button></div>
      </> : managementResult ? <>
        <div className={`resource-${managementResult.status === "success" ? "feedback" : "alert"}`} role={managementResult.status === "success" ? "status" : "alert"}>{operationStatusNames[managementResult.status]}</div><p className="resource-operation-message">{managementResult.message}</p>
        <div className="resource-tags"><span>{managementResult.localState === "changed" ? "本地已修改" : managementResult.localState === "partial" ? "本地部分修改" : "本地未修改"}</span><span>{managementResult.clientEffect === "pending_reload" ? "待重新加载" : "客户端生效状态未知"}</span></div>
        <div className="dialog-end">{managementResult.status !== "success" && managementInput && <button className="button" onClick={() => void showManagement(managementInput)}>重新预览</button>}<button className="button primary" onClick={() => closeManagement(false)}>完成</button></div>
      </> : null}
      {managementError && <div className="resource-alert" role="alert">{managementError}</div>}
      {managementError && !preview && managementInput && <div className="dialog-end"><button className="button subtle" onClick={() => closeManagement(false)}>取消</button><button className="button" onClick={() => void showManagement(managementInput)}>重新预览</button></div>}
    </ResourceDialog>
  </div>;
}

function Entry({ entry, onManage }: { entry: ResourceInventoryEntry; onManage: (input: ResourceManagementInput) => void }) {
  return <div className="resource-entry"><header><strong>{clientName(entry.client)}</strong><span>{entry.scope === "user" ? "用户范围" : shortPath(entry.project ?? "项目未知")}</span></header><p className="resource-path">{entry.entryPath}</p>
    {entry.entryType === "symlink" && <p className="resource-path">→ {entry.targetPath ?? entry.linkTarget ?? "目标未知"}</p>}
    <div className="resource-tags"><span>{methodNames[entry.entryType]}</span><span>{entry.nativeState === "disabled" ? "已停用" : entry.nativeState === "enabled" ? "已启用" : "启用状态未知"}</span>{entry.readState !== "present" && <span className="is-warning">{entry.readState === "broken" ? "断链" : "不可读取"}</span>}{entry.protected && <span>受保护{entry.owner ? ` · ${entry.owner}` : ""}</span>}{!entry.capabilities.disable && !entry.capabilities.standby && !entry.capabilities.trash && <span>只读</span>}</div>
    <div className="resource-entry-actions">{entry.capabilities.disable && entry.nativeState !== "disabled" && <button className="button" aria-label={`预览停用${entry.name}的${clientName(entry.client)}入口`} onClick={() => onManage({ entryId: entry.id, action: "disable" })}>预览停用</button>}{entry.capabilities.standby && <button className="button" aria-label={`预览移到备用${entry.name}的${clientName(entry.client)}入口`} onClick={() => onManage({ entryId: entry.id, action: "standby" })}>移到备用</button>}{entry.capabilities.trash && <button className="button resource-danger-button" aria-label={`预览回收${entry.name}的${clientName(entry.client)}入口`} onClick={() => onManage({ entryId: entry.id, action: "trash" })}>移入回收区</button>}</div>
  </div>;
}
