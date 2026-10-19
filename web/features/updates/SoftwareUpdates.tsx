import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowCircleUp, ArrowClockwise, Check, Copy, X } from "@phosphor-icons/react";
import type { ReleaseStatus, UpdateSettings } from "../../../src/updates/contracts";
import { errorMessage, request } from "../../shared/api";
import { messageText, useI18n } from "../../shared/i18n";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { Hint } from "../../shared/ui/Hint";
import { Loading } from "../../shared/ui/Loading";
import { updateReminderVisible, updateSummaryKey } from "./update-model";
import "./updates.css";

export function SoftwareUpdates() {
  const { t, dateTime } = useI18n();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ReleaseStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [failureKey, setFailureKey] = useState("updateUi.failed");
  const [action, setAction] = useState<"check" | "save" | null>(null);
  const [reading, setReading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const revision = useRef(0);
  const pending = useRef(false);
  const readController = useRef<AbortController | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);

  const readStatus = useCallback(async () => {
    if (pending.current) return;
    const current = ++revision.current;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    setReading(true);
    try {
      const next = await request<ReleaseStatus>("/update/status", { signal: controller.signal });
      if (mounted.current && current === revision.current) { setStatus(next); setError(null); }
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && current === revision.current) { setError(failure); setFailureKey("updateUi.readFailed"); }
    } finally {
      if (mounted.current && current === revision.current) setReading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void readStatus();
    // 状态读取只访问本地缓存；切回页面或等待期间发现的更新不弹出对话框。
    const refresh = () => { if (!document.hidden) void readStatus(); };
    const timer = setInterval(refresh, 60_000);
    globalThis.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mounted.current = false;
      readController.current?.abort();
      clearInterval(timer);
      clearTimeout(copyTimer.current);
      globalThis.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [readStatus]);

  const perform = async (kind: "check" | "save", settings?: Partial<UpdateSettings>) => {
    if (pending.current) return;
    pending.current = true;
    const current = ++revision.current;
    readController.current?.abort();
    setReading(false); setAction(kind); setError(null);
    try {
      const next = await request<ReleaseStatus>(kind === "check" ? "/update/check" : "/update/settings", {
        method: kind === "check" ? "POST" : "PATCH", ...(settings ? { body: settings } : {}),
      });
      if (mounted.current && current === revision.current) setStatus(next);
    } catch (failure) {
      if (mounted.current && current === revision.current) { setError(failure); setFailureKey(kind === "check" ? "updateUi.failed" : "updateUi.saveFailed"); }
    } finally {
      pending.current = false;
      if (mounted.current && current === revision.current) setAction(null);
    }
  };

  const copyCommand = async () => {
    if (!status) return;
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(status.updateCommand);
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => { if (mounted.current) setCopied(false); }, 2_500);
    } catch { setCopyError(true); }
  };
  useEffect(() => { setCopied(false); setCopyError(false); }, [status?.updateCommand]);

  const badge = !error && updateReminderVisible(status);
  const checking = action === "check" || status?.checkState === "checking";
  const failure = error ? errorMessage(error) : status?.error ? messageText(status.error.messageDescriptor, status.error.message) : null;
  const ignored = status?.latestVersion && status.ignoredVersion === status.latestVersion;
  const unsupportedKey = status?.installationKind === "source" ? "updateUi.source"
    : status?.installationKind === "ephemeral" ? "updateUi.ephemeral" : "updateUi.unsupported";

  return <Dialog.Root open={open} onOpenChange={next => { setOpen(next); if (next) void readStatus(); }}>
    <Hint label={t(badge ? "updateUi.available" : "updateUi.open")}><Dialog.Trigger className="icon-button software-updates-trigger" aria-label={t("updateUi.open")} aria-description={badge ? t("updateUi.available") : undefined}>
      <ArrowCircleUp size={19} aria-hidden="true" />{badge && <span className="software-updates-badge" aria-hidden="true" />}
    </Dialog.Trigger></Hint>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content ref={setContainer} className="dialog-content software-updates-dialog" aria-describedby={undefined}>
      <header><Dialog.Title>{t("updateUi.open")}</Dialog.Title>
        <HelpPopover label={t("updateUi.help")} iconOnly container={container}><p>{t("updateUi.helpScope")}</p><p>{t("updateUi.helpPrivacy")}</p></HelpPopover>
        <Dialog.Close className="icon-button" aria-label={t("common.closeNamed", { label: t("updateUi.open") })}><X size={18} aria-hidden="true" /></Dialog.Close>
      </header>
      <div className="software-updates-body">
        <div className="software-updates-summary" role="status">
          <span className="software-updates-progress">{(checking || reading) && <Loading variant="inline" size={20} label={t(checking ? "updateUi.checking" : "common.loading")} />}</span>
          <strong>{error ? t(failureKey) : status ? t(updateSummaryKey(status)) : t("updateUi.unknown")}</strong>
        </div>
        <dl className="software-updates-versions">
          <div><dt>{t("updateUi.current")}</dt><dd>{status?.currentVersion ?? "—"}</dd></div>
          <div><dt>{t("updateUi.latest")}</dt><dd>{status?.latestVersion ?? "—"}</dd></div>
          <div><dt>{t("updateUi.checkedAt")}</dt><dd>{status?.checkedAt ? dateTime(status.checkedAt) : t("updateUi.neverChecked")}</dd></div>
        </dl>
        {failure && <div className="software-updates-error" role="alert">{failure}</div>}
        {status && !status.compatibility.compatible && <p className="software-updates-boundary">{messageText(status.compatibility.messageDescriptor, status.compatibility.reason ?? t("updateUi.incompatible"))}</p>}
        {status && !status.selfUpdateSupported && <p className="software-updates-boundary">{t(unsupportedKey)}</p>}
        <div className="software-updates-actions">
          <button className="button" disabled={!!action || checking} onClick={() => void perform("check")}><ArrowClockwise size={16} aria-hidden="true" />{t("updateUi.check")}</button>
          {status?.updateAvailable && <button className="text-button" disabled={!!action} onClick={() => void perform("save", { ignoredVersion: ignored ? null : status.latestVersion })}>{t(ignored ? "updateUi.restore" : "updateUi.ignore")}</button>}
          {status?.ignoredVersion && !status.updateAvailable && <button className="text-button" disabled={!!action} onClick={() => void perform("save", { ignoredVersion: null })}>{t("updateUi.restore")}</button>}
        </div>
        {ignored && <p className="software-updates-boundary">{t("updateUi.ignored", { version: status.latestVersion! })}</p>}
        {status && <label className="software-updates-auto"><input type="checkbox" checked={status.autoCheck} disabled={!!action} onChange={event => void perform("save", { autoCheck: event.target.checked })} /><span>{t("updateUi.autoCheck")}</span><span className="software-updates-progress">{action === "save" && <Loading variant="inline" size={18} label={t("updateUi.saving")} />}</span></label>}
        {status?.updateCommand && <section className="software-updates-command">
          <div><h3>{t(status.selfUpdateSupported ? "updateUi.command" : "updateUi.commandAlternative")}</h3><button className="icon-button" onClick={() => void copyCommand()} aria-label={t(copied ? "updateUi.copied" : "updateUi.copy")} title={t(copied ? "updateUi.copied" : "updateUi.copy")}>{copied ? <Check size={17} aria-hidden="true" /> : <Copy size={17} aria-hidden="true" />}</button></div>
          <pre aria-label={t(status.shell === "powershell" ? "updateUi.powershell" : "updateUi.posix")}><code>{status.updateCommand}</code></pre>
          <span role="status" className="sr-only">{copied ? t("updateUi.copied") : ""}</span>
          {copyError && <p className="software-updates-error" role="alert">{t("updateUi.copyFailed")}</p>}
        </section>}
      </div>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
