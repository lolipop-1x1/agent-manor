import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Check, Copy, Cube, GithubLogo,
  HouseLine, Leaf, Pause, Play, ShieldCheck, TeaBag, TerminalWindow, X,
  ArrowsClockwise, Database, Path, GlobeHemisphereWest,
} from "@phosphor-icons/react";
import { ManorScene } from "./Scene";
import { useSiteLanguage } from "./i18n";

const github = "https://github.com/lolipop-1x1/agent-manor";
const guide = `${github}/blob/main/docs/usage.md`;
const features = ["overview", "sessions", "code-map", "resources"] as const;
type Feature = typeof features[number];
const commandSteps = [
  { key: "install", command: "npm install -g agent-manor" },
  { key: "launch", command: "agent-manor start" },
] as const;

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function Brand({ wordmark = true }: { wordmark?: boolean }) {
  const { t } = useSiteLanguage();
  return <span className="brand">
    <img src={`${import.meta.env.BASE_URL}favicon.svg`} width="34" height="34" alt="" />
    {wordmark && <span>{t("site.brand")}</span>}
  </span>;
}

export function App() {
  const { t, language, setLanguage } = useSiteLanguage();
  const [installationOpen, setInstallationOpen] = useState(false);
  const [paused, setPaused] = useState(prefersReducedMotion);
  const [view, setView] = useState<"estate" | "tea">("estate");
  const [resetKey, setResetKey] = useState(0);
  const [ready, setReady] = useState(false);
  const [sceneFailed, setSceneFailed] = useState(false);
  const [feature, setFeature] = useState<Feature>("overview");
  const [copyState, setCopyState] = useState<{ key: string; status: "copied" | "failed" } | null>(null);
  const heroRef = useRef<HTMLElement>(null);
  const productRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const openingScrollRef = useRef(0);
  const copyTimeoutRef = useRef<number | undefined>(undefined);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => { if (query.matches) setPaused(true); };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => () => window.clearTimeout(copyTimeoutRef.current), []);

  const showFeature = useCallback((selected: Feature) => {
    setFeature(selected);
    productRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? "instant" : "smooth", block: "start" });
    tabRefs.current[features.indexOf(selected)]?.focus({ preventScroll: true });
  }, []);
  const onSceneReady = useCallback(() => setReady(true), []);
  const onSceneError = useCallback(() => setSceneFailed(true), []);

  function openInstallation(event: MouseEvent<HTMLButtonElement>) {
    openerRef.current = event.currentTarget;
    openingScrollRef.current = window.scrollY;
    heroRef.current?.scrollIntoView({ behavior: "instant", block: "start" });
    setCopyState(null);
    setInstallationOpen(true);
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % features.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + features.length) % features.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = features.length - 1;
    else return;
    event.preventDefault();
    setFeature(features[next]!);
    tabRefs.current[next]?.focus();
  }

  async function copyCommand(key: string, command: string) {
    window.clearTimeout(copyTimeoutRef.current);
    try {
      await navigator.clipboard.writeText(command);
      setCopyState({ key, status: "copied" });
      copyTimeoutRef.current = window.setTimeout(() => setCopyState(null), 2400);
    } catch { setCopyState({ key, status: "failed" }); }
  }

  const screenshotLanguage = language === "zh-CN" ? "zh" : "en";

  return <Dialog.Root open={installationOpen} onOpenChange={setInstallationOpen}>
    <a className="skip-link" href="#product">{t("site.skip")}</a>
    <header className="site-header">
      <a className="brand-link" href="#manor" aria-label={t("site.brand")}><Brand /></a>
      <nav aria-label={t("site.nav.label")}>
        <a href="#product">{t("site.nav.product")}</a>
        <a href={guide} target="_blank" rel="noreferrer">{t("site.nav.guide")}</a>
        <a className="github-link" href={github} target="_blank" rel="noreferrer"><GithubLogo size={18} aria-hidden="true" />{t("site.nav.github")}</a>
        <span className="nav-divider" aria-hidden="true" />
        <button className="language-button" type="button" onClick={() => setLanguage(language === "zh-CN" ? "en" : "zh-CN")} aria-label={t("site.nav.language")}>
          <GlobeHemisphereWest size={17} aria-hidden="true" /><span>{t("site.nav.languageShort")}</span>
        </button>
        <button className="button button-small" type="button" onClick={openInstallation}>{t("site.start")}<ArrowUpRight size={15} aria-hidden="true" /></button>
      </nav>
    </header>

    <main>
      <section id="manor" className={`hero${sceneFailed ? " scene-unavailable" : ""}`} ref={heroRef}>
        <div className="scene-stage" aria-label={t("site.scene.label")}>
          {!sceneFailed && <ManorScene installationOpen={installationOpen} paused={paused} view={view} resetKey={resetKey}
            language={language} onFeature={showFeature} onReady={onSceneReady} onError={onSceneError} />}
          {sceneFailed && <div className="scene-fallback" role="status">
            <Cube size={36} weight="light" aria-hidden="true" />
            <h2>{t("site.scene.unavailableTitle")}</h2>
            <p>{t("site.scene.unavailable")}</p>
            <a className="text-link" href="#product">{t("site.scene.continue")}<ArrowDown size={16} aria-hidden="true" /></a>
          </div>}
        </div>
        <div className="hero-copy">
          <h1><span>{t("site.hero.titleFirst")}</span><span>{t("site.hero.titleSecond")}</span></h1>
          <p>{t("site.hero.description")}</p>
          <div className="hero-actions">
            <button className="button" type="button" onClick={openInstallation}>{t("site.start")}<ArrowRight size={18} aria-hidden="true" /></button>
            <a className="text-link" href="#product">{t("site.hero.explore")}<ArrowDown size={16} aria-hidden="true" /></a>
          </div>
          <span className="local-note"><Leaf size={15} aria-hidden="true" />{t("site.hero.local")}</span>
        </div>
        <div className="hero-bottom">
          <p className="scene-caption">{t("site.scene.caption")}</p>
          {!sceneFailed && <div className="scene-controls" role="group" aria-label={t("site.scene.controls")}>
            {!ready && <span className="scene-loading" role="status">{t("site.scene.loading")}</span>}
            <div className="view-switch">
              <button type="button" aria-pressed={view === "estate"} disabled={!ready} onClick={() => { setView("estate"); setResetKey(value => value + 1); }}><HouseLine size={16} aria-hidden="true" />{t("site.scene.estate")}</button>
              <button type="button" aria-pressed={view === "tea"} disabled={!ready} onClick={() => { setView("tea"); setResetKey(value => value + 1); }}><TeaBag size={16} aria-hidden="true" />{t("site.scene.tea")}</button>
            </div>
            <button className="scene-icon-button" type="button" aria-label={t(paused ? "site.scene.play" : "site.scene.pause")} title={t(paused ? "site.scene.play" : "site.scene.pause")} onClick={() => setPaused(value => !value)}>
              {paused ? <Play size={17} aria-hidden="true" /> : <Pause size={17} aria-hidden="true" />}
            </button>
            <button className="scene-icon-button" type="button" aria-label={t("site.scene.reset")} title={t("site.scene.reset")} disabled={!ready} onClick={() => setResetKey(value => value + 1)}><ArrowsClockwise size={17} aria-hidden="true" /></button>
            <span className="scene-instructions">{t("site.scene.instructions")}</span>
          </div>}
        </div>
      </section>

      <section id="product" className="product-section content-width" ref={productRef}>
        <div className="section-intro">
          <h2>{t("site.product.title")}</h2>
          <p>{t("site.product.description")}</p>
        </div>
        <div className="feature-tabs" role="tablist" aria-label={t("site.product.tabs")}>
          {features.map((item, index) => <button type="button" role="tab" id={`tab-${item}`} aria-selected={feature === item}
            aria-controls={`feature-${item}`} tabIndex={feature === item ? 0 : -1} key={item}
            ref={element => { tabRefs.current[index] = element; }} onClick={() => setFeature(item)} onKeyDown={event => onTabKeyDown(event, index)}>
            {t(`site.product.${item}.name`)}
          </button>)}
        </div>
        {features.map(item => <div className="feature-panel" role="tabpanel" id={`feature-${item}`} aria-labelledby={`tab-${item}`} hidden={feature !== item} key={item} tabIndex={0}>
          <div className="feature-copy">
            <h3>{t(`site.product.${item}.title`)}</h3>
            <p>{t(`site.product.${item}.description`)}</p>
            <a className="text-link" href={guide} target="_blank" rel="noreferrer">{t("site.product.guide")}<ArrowUpRight size={16} aria-hidden="true" /></a>
          </div>
          <figure className="product-preview">
            <div className="preview-image-frame"><img src={`${import.meta.env.BASE_URL}previews/${item}-${screenshotLanguage}.png`}
              alt={t(`site.product.${item}.alt`)} width="1440" height="1000" loading="lazy" decoding="async" /></div>
            <figcaption>{t("site.product.demo")}</figcaption>
          </figure>
        </div>)}
      </section>

      <section className="principles-section content-width">
        <h2>{t("site.principles.title")}</h2>
        <div className="principles-list">
          {([
            { key: "local", Icon: Database },
            { key: "evidence", Icon: Path },
            { key: "control", Icon: ShieldCheck },
          ] as const).map(({ key, Icon }) => <article key={key}>
            <Icon size={26} weight="light" aria-hidden="true" />
            <h3>{t(`site.principles.${key}.title`)}</h3>
            <p>{t(`site.principles.${key}.description`)}</p>
          </article>)}
        </div>
      </section>

      <section className="closing-section">
        <Brand wordmark={false} />
        <h2>{t("site.closing.title")}</h2>
        <p>{t("site.closing.description")}</p>
        <button className="button" type="button" onClick={openInstallation}>{t("site.start")}<ArrowRight size={18} aria-hidden="true" /></button>
      </section>
    </main>

    <footer className="site-footer content-width">
      <div><Brand /><span>{t("site.footer.description")}</span></div>
      <nav aria-label={t("site.nav.label")}>
        <a href={guide} target="_blank" rel="noreferrer">{t("site.nav.guide")}</a>
        <a href={github} target="_blank" rel="noreferrer">{t("site.nav.github")}</a>
        <a href="#manor">{t("site.footer.top")}<ArrowUpRight size={14} aria-hidden="true" /></a>
      </nav>
    </footer>

    <Dialog.Portal>
      <Dialog.Overlay className="install-overlay" />
      <Dialog.Content className="install-panel" onCloseAutoFocus={event => {
        event.preventDefault();
        openerRef.current?.focus({ preventScroll: true });
        window.scrollTo({ top: openingScrollRef.current, behavior: "instant" });
      }}>
        <div className="install-top"><Brand /><Dialog.Close className="close-button" aria-label={t("site.install.close")}><X size={20} aria-hidden="true" /></Dialog.Close></div>
        <div className="install-heading"><Dialog.Title>{t("site.install.title")}</Dialog.Title><Dialog.Description>{t("site.install.description")}</Dialog.Description></div>
        <div className="install-planning"><span>{t("site.install.planned")}</span><p>{t("site.install.notice")}</p></div>
        <ol className="install-steps">
          {commandSteps.map(({ key, command }) => <li key={key}>
            <h3>{t(`site.install.${key}`)}</h3>
            <div className="command-block"><TerminalWindow size={18} aria-hidden="true" /><code>{command}</code>
              <button type="button" className="copy-button" onClick={() => { void copyCommand(key, command); }} aria-label={t("site.install.copy", { step: t(`site.install.${key}`) })}>
                {copyState?.key === key && copyState.status === "copied" ? <Check size={18} aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}
              </button>
            </div>
            <div className="copy-status" role="status">{copyState?.key === key ? t(copyState.status === "copied" ? "site.install.copied" : "site.install.copyFailed") : ""}</div>
          </li>)}
        </ol>
        <p className="install-support">{t("site.install.support")}</p>
        <a className="button install-guide" href={guide} target="_blank" rel="noreferrer">{t("site.install.guide")}<ArrowUpRight size={17} aria-hidden="true" /></a>
        <Dialog.Close className="install-return text-link"><ArrowLeft size={16} aria-hidden="true" />{t("site.install.return")}</Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
