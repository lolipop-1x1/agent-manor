import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowClockwise, CaretDown } from "@phosphor-icons/react";
import { CLIENTS, clientName, type Client } from "../src/clients";
import type { SessionCheckMode, SessionClientCheck, SessionJob, SessionRefreshOptions } from "../src/session-contracts";
import "./filter-controls.css";

const scopeLabel = (client?: Client) => client ? clientName(client) : "全部客户端";
const modeLabel = (mode?: SessionCheckMode) => mode === "full" ? "完整校验" : mode === "quick" ? "快速检查" : "检查方式未记录";
const countLabel = (value: number) => value.toLocaleString("zh-CN");
const checkedAtLabel = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
const phaseLabels: Record<string, string> = { discover: "发现所选来源", index: "检查并更新来源", publish: "发布完整索引" };
const fallbackLabels: Record<string, string> = {
  cache_missing: "新增来源", check_record_missing: "缺少快检记录", unsupported_source: "格式依赖尚未核验",
  metadata_changed: "相关元信息已变化", source_changed: "来源文件已变化",
};

export function SessionRefreshActions({ client, disabled, onRefresh }: {
  client?: Client; disabled: boolean; onRefresh: (options: SessionRefreshOptions) => void;
}) {
  const scope = scopeLabel(client);
  return <div className="session-refresh-actions">
    <button className="icon-button" aria-label="刷新会话索引" title={`刷新${scope} · 快速检查`} disabled={disabled} onClick={() => onRefresh({ client, mode: "quick" })}>
      <ArrowClockwise size={16} className={disabled ? "is-spinning" : ""} aria-hidden="true" />
    </button>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="icon-button session-refresh-menu-trigger" aria-label="会话索引刷新选项" title="选择刷新范围和检查方式" disabled={disabled}>
        <CaretDown size={12} aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="filter-menu session-refresh-menu" align="end" sideOffset={6} collisionPadding={12}>
        <DropdownMenu.Label className="session-refresh-menu-label">刷新范围与检查方式</DropdownMenu.Label>
        <DropdownMenu.Item className="filter-option" onSelect={() => onRefresh({ mode: "quick" })}>刷新全部 · 快速检查</DropdownMenu.Item>
        <DropdownMenu.Separator className="session-refresh-menu-separator" />
        <DropdownMenu.Item className="filter-option" onSelect={() => onRefresh({ client, mode: "full" })}>{scope} · 完整校验</DropdownMenu.Item>
        {client && <DropdownMenu.Item className="filter-option" onSelect={() => onRefresh({ mode: "full" })}>全部客户端 · 完整校验</DropdownMenu.Item>}
        <p className="session-refresh-menu-note">完整校验核对来源内容，保留未变化的索引。</p>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
  </div>;
}

export function SessionRefreshStatus({ job }: { job?: SessionJob }) {
  if (!job) return null;
  const running = job.status === "running" || job.status === "queued";
  const counts = job.counts;
  const fallbackCount = counts?.fallbacks.reduce((sum, fallback) => sum + fallback.count, 0) ?? 0;
  return <section className="session-refresh-status" role="status" aria-label="会话索引刷新状态">
    <div className="session-refresh-status-heading"><strong>{scopeLabel(job.client)}</strong><span>{modeLabel(job.mode)} · {running ? job.status === "queued" ? "排队中" : "进行中" : job.status === "complete" ? "已完成" : "失败"}</span></div>
    {running && <div className="session-job"><span>{(phaseLabels[job.phase] ?? job.phase) || "正在刷新会话"}</span><progress aria-label="本次会话索引刷新进度" max="1" value={job.progress} /><small>{Math.round(job.progress * 100)}%</small></div>}
    {counts && <p className="session-refresh-counts">来源 {countLabel(counts.discovered)} · 快速复用 {countLabel(counts.quickReused)} · 内容复用 {countLabel(counts.verifiedReused)} · 重新解析 {countLabel(counts.parsed)} · 缺失 {countLabel(counts.missing)}</p>}
    {!!fallbackCount && <details className="session-refresh-fallbacks"><summary>{countLabel(fallbackCount)} 个来源回退内容检查</summary>
      <div>{counts?.fallbacks.map(fallback => <p key={fallback.reason}>{fallbackLabels[fallback.reason] ?? "需要内容检查"} · {countLabel(fallback.count)}</p>)}</div>
    </details>}
  </section>;
}

export function SessionClientChecks({ client, checks }: { client?: Client; checks?: SessionClientCheck[] }) {
  const selected = checks?.find(check => check.client === client);
  return <details className="session-client-checks">
    <summary>刷新范围：{scopeLabel(client)}<span>{client ? selected ? `最近 ${modeLabel(selected.mode)}：${checkedAtLabel(selected.checkedAt)}` : "最近检查：未记录" : "查看各客户端最近检查"}</span></summary>
    <div className="session-client-check-list">
      <p>仅记录成功检查；与全局结果发布时间分别计算。</p>
      {CLIENTS.map(item => {
        const check = checks?.find(value => value.client === item.id);
        return <div className="session-client-check" key={item.id}><strong>{item.name}</strong>
          <span>{check ? <>{modeLabel(check.mode)} · <time dateTime={check.checkedAt}>{checkedAtLabel(check.checkedAt)}</time></> : "未记录"}</span></div>;
      })}
    </div>
  </details>;
}
