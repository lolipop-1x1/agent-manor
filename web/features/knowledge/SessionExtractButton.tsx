import { useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { BookOpen } from "@phosphor-icons/react";
import { useI18n } from "../../shared/i18n";
import { KnowledgeDialog } from "./KnowledgeCommon";

export function SessionExtractButton({ sessionId, sessionTitle, branch, currentTurn, totalTurns, disabled }: { sessionId?: string; sessionTitle?: string; branch: string; currentTurn: number; totalTurns: number; disabled?: boolean }) {
  const { t } = useI18n();
  const [range, setRange] = useState(false), [start, setStart] = useState(1), [end, setEnd] = useState(1);
  const navigate = (first?: number, last?: number) => {
    if (!sessionId) return;
    const params = new URLSearchParams({ page: "new", sessionId, branch });
    if (sessionTitle) params.set("sessionTitle", sessionTitle); if (totalTurns) params.set("totalTurns", String(totalTurns));
    if (first !== undefined) params.set("turnStart", String(first)); if (last !== undefined) params.set("turnEnd", String(last));
    setRange(false); location.hash = `#knowledge?${params}`;
  };
  return <><Dropdown.Root><Dropdown.Trigger className="button subtle" aria-label={t("knowledge.sessionExtract")} disabled={disabled || !sessionId}><BookOpen size={15} aria-hidden="true" />{t("knowledge.extract")}</Dropdown.Trigger><Dropdown.Portal><Dropdown.Content className="filter-menu" align="end" sideOffset={6} collisionPadding={12}>
    <Dropdown.Item className="filter-option" onSelect={() => navigate()}>{t("knowledge.sessionExtract")}</Dropdown.Item><Dropdown.Item className="filter-option" disabled={!totalTurns} onSelect={() => navigate(currentTurn, currentTurn)}>{t("knowledge.sessionExtractTurn")}</Dropdown.Item><Dropdown.Item className="filter-option" disabled={!totalTurns} onSelect={() => { setStart(currentTurn); setEnd(currentTurn); setRange(true); }}>{t("knowledge.sessionExtractRange")}</Dropdown.Item>
  </Dropdown.Content></Dropdown.Portal></Dropdown.Root>{range && <KnowledgeDialog open title={t("knowledge.rangeTitle")} onClose={() => setRange(false)} footer={<><button className="button" onClick={() => setRange(false)}>{t("knowledge.cancel")}</button><button className="button primary" disabled={!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > totalTurns} onClick={() => navigate(start, end)}>{t("knowledge.previewAction")}</button></>}><div className="knowledge-form-grid"><label className="knowledge-field"><span>{t("knowledge.turnStart")}</span><input type="number" min={1} max={totalTurns} value={start} onChange={event => setStart(Number(event.target.value))} /></label><label className="knowledge-field"><span>{t("knowledge.turnEnd")}</span><input type="number" min={1} max={totalTurns} value={end} onChange={event => setEnd(Number(event.target.value))} /></label></div>{end < start && <p className="knowledge-error" role="alert">{t("knowledge.invalidRange")}</p>}</KnowledgeDialog>}</>;
}
