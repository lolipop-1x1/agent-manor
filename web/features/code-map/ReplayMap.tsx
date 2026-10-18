import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CaretRight, Crosshair, Folder } from "@phosphor-icons/react";
import type { FileCoverage } from "../../../src/contracts";
import type { ReplayStep } from "../../../src/replay-contracts";
import { useI18n } from "../../shared/i18n";
import { FilterSelect } from "../../shared/ui/FilterSelect";
import { ProjectPicker } from "../../shared/ui/ProjectPicker";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { CodeMap } from "./CodeMap";
import { replayDirectories, replayFollowDirectory, replaySessionFiles, type ReplayMapPlayback } from "./replay-map-model";
import "./replay-map.css";

interface ReplayMapProps {
  files: FileCoverage[]; steps: ReplayStep[]; playback: ReplayMapPlayback; selected: string | null;
  select(path: string): void; scopeKey: string; legend: ReactNode; fullscreen: boolean;
  onFullscreen(): void; container?: HTMLElement | null; disabled?: boolean;
}

export function ReplayMap({ files, steps, playback, selected, select, scopeKey, legend, fullscreen, onFullscreen, container, disabled }: ReplayMapProps) {
  const { t } = useI18n();
  const [scope, setScope] = useState("session");
  const [directory, setDirectory] = useState("");
  const [follow, setFollow] = useState(false);
  useEffect(() => { setScope("session"); setDirectory(""); setFollow(false); }, [scopeKey]);
  const sessionFiles = useMemo(() => replaySessionFiles(files, steps), [files, steps]);
  const directories = useMemo(() => replayDirectories(files), [files]);
  const directorySet = useMemo(() => new Set(directories), [directories]);
  const options = useMemo(() => directories.map(path => ({ value: path, label: path.split("/").at(-1)!, description: path })), [directories]);
  const sessionFallback = scope === "session" && !sessionFiles.some(file => file.lineCount > 0);
  const included = scope === "session" && !sessionFallback ? sessionFiles : files;
  const includedPaths = useMemo(() => new Set([...replayDirectories(included), ...included.map(file => file.path)]), [included]);
  const parts = directory.split("/").filter(Boolean);
  const followDirectory = follow ? replayFollowDirectory([...playback.current.keys()].filter(path => path === "." || includedPaths.has(path)), directorySet) : null;
  const stopFollowing = useCallback(() => setFollow(false), []);
  const browse = useCallback((path: string) => { if (!disabled) { setDirectory(path); setFollow(false); } }, [disabled]);
  return <div className="replay-map-workspace" data-replay-scope={scope} data-directory={directory} data-following={follow} data-session-fallback={sessionFallback || undefined} data-disabled={disabled || undefined}>
    <div className="replay-map-scopebar">
      <FilterSelect label={t("replay.range")} value={scope} disabled={disabled} container={container} options={[
        { value: "session", label: t("replay.rangeSession") }, { value: "repository", label: t("replay.rangeRepository") }, { value: "directory", label: t("replay.rangeDirectory") },
      ]} onChange={value => { setScope(value); setDirectory(""); setFollow(false); }} />
      {sessionFallback && <HelpPopover label={t("replay.rangeHelp")} container={container}><p>{t("replay.rangeFallback")}</p></HelpPopover>}
      {scope === "directory" && <div className="replay-directory-picker" inert={disabled}><ProjectPicker value={directory} onChange={browse} options={options} label={t("replay.focusDirectory")} placeholder={t("replay.searchDirectory")} container={container} /></div>}
      <nav className="replay-map-breadcrumbs" aria-label={t("replay.directoryBreadcrumb")}>
        <button disabled={disabled} onClick={() => browse("")} aria-current={!directory ? "location" : undefined}><Folder size={14} />{t(scope === "session" ? "replay.rangeSession" : "replay.rangeRepository")}</button>
        {parts.map((part, index) => <span key={index}><CaretRight size={12} /><button disabled={disabled} aria-current={index === parts.length - 1 ? "location" : undefined} onClick={() => browse(parts.slice(0, index + 1).join("/"))}>{part}</button></span>)}
      </nav>
      <button className="map-tool-button replay-follow-toggle" aria-label={t("replay.followModule")} aria-pressed={follow} disabled={disabled} onClick={() => setFollow(value => !value)}><Crosshair size={15} /><span>{t("replay.followModule")}</span></button>
    </div>
    <CodeMap files={included} directory={directory} metric="activity" selected={selected} browse={browse} select={select}
      scopeKey={`${scopeKey}:${scope}:${directory}`} playback={playback} heading={null} legend={legend}
      replayReadable fullscreenControl={{ active: fullscreen, toggle: onFullscreen, container }} onManualCamera={stopFollowing} followDirectory={followDirectory} />
    {!included.some(file => file.lineCount > 0 && (!directory || file.path.startsWith(`${directory}/`))) && <p className="replay-map-empty" role="status">{t("replay.emptyMapRange")}</p>}
  </div>;
}
