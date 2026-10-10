import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import type { LineRange } from "../../../src/contracts";
import type { Theme } from "../../shared/theme";
import { t, useI18n } from "../../shared/i18n";

const editorPhraseKeys: Record<string, string> = {
  Find: "find", Replace: "replace", next: "next", previous: "previous", all: "all", "match case": "matchCase",
  regexp: "regexp", "by word": "byWord", close: "close", "Go to line": "goToLine", go: "go",
  "Folded lines": "foldedLines", "Unfolded lines": "unfoldedLines", to: "to", "folded code": "foldedCode",
  unfold: "unfold", "Fold line": "foldLine", "Unfold line": "unfoldLine", "Control character": "controlCharacter",
  "current match": "currentMatch", "on line": "onLine",
};
const editorPhrases = () => Object.fromEntries(Object.entries(editorPhraseKeys).map(([phrase, key]) => [phrase, t(`codeMap.editor.${key}`)]));

/** CodeMirror 保留编辑状态，按稳定控件身份更新已打开的面板与折叠标记。 */
function localizeEditorControls(host: HTMLElement) {
  for (const marker of host.querySelectorAll<HTMLElement>(".cm-foldGutter .cm-gutterElement > span")) {
    marker.title = t(marker.textContent === "⌄" ? "codeMap.editor.foldLine" : "codeMap.editor.unfoldLine");
  }
  for (const folded of host.querySelectorAll<HTMLElement>(".cm-foldPlaceholder")) {
    folded.title = t("codeMap.editor.unfold"); folded.setAttribute("aria-label", t("codeMap.editor.foldedCode"));
  }
  const lineLabel = host.querySelector('.cm-goto-line input[name="line"]')?.parentElement;
  if (lineLabel?.firstChild?.nodeType === Node.TEXT_NODE) lineLabel.firstChild.textContent = `${t("codeMap.editor.goToLine")}: `;
  const go = host.querySelector<HTMLButtonElement>('.cm-goto-line button[type="submit"]');
  if (go) go.textContent = t("codeMap.editor.go");
  host.querySelector(".cm-goto-line .cm-dialog-close")?.setAttribute("aria-label", t("codeMap.editor.close"));
  const panel = host.querySelector(".cm-search");
  if (!panel) return;
  const fields = { search: "find", replace: "replace" };
  for (const [name, key] of Object.entries(fields)) {
    const input = panel.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (input) { input.placeholder = t(`codeMap.editor.${key}`); input.setAttribute("aria-label", t(`codeMap.editor.${key}`)); }
  }
  for (const [name, key] of Object.entries({ next: "next", prev: "previous", select: "all" })) {
    const button = panel.querySelector<HTMLButtonElement>(`button[name="${name}"]`);
    if (button) button.textContent = t(`codeMap.editor.${key}`);
  }
  for (const [name, key] of Object.entries({ case: "matchCase", re: "regexp", word: "byWord" })) {
    const label = panel.querySelector(`input[name="${name}"]`)?.parentElement;
    if (label?.lastChild?.nodeType === Node.TEXT_NODE) label.lastChild.textContent = t(`codeMap.editor.${key}`);
  }
  panel.querySelector('[name="close"]')?.setAttribute("aria-label", t("codeMap.editor.close"));
}

function rangeDecorations(state: EditorState, exact: LineRange[], near: LineRange[]): DecorationSet {
  const lines = new Map<number, string>();
  for (const [ranges, className] of [[near, "cm-coverage-near"], [exact, "cm-coverage-exact"]] as const) {
    for (const range of ranges) {
      for (let line = Math.max(1, range.start); line <= Math.min(state.doc.lines, range.end); line += 1) lines.set(line, className);
    }
  }
  return Decoration.set([...lines].sort(([a], [b]) => a - b).map(([line, className]) => Decoration.line({ class: className }).range(state.doc.line(line).from)));
}

export function CodeViewer({ content, path, exact, near, theme, jumpLine }: {
  content: string; path: string; exact: LineRange[]; near: LineRange[]; theme: Theme; jumpLine?: number;
}) {
  const { language: displayLanguage } = useI18n();
  const labels = useRef(new Compartment());
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  useEffect(() => {
    const coverage = StateField.define<DecorationSet>({
      create: state => rangeDecorations(state, exact, near),
      update: value => value,
      provide: field => EditorView.decorations.from(field),
    });
    const language = /\.(jsx?|tsx?|mjs|cjs|mts|cts)$/.test(path) ? javascript({ typescript: /\.(tsx?|mts|cts)$/.test(path), jsx: /\.[jt]sx$/.test(path) })
      : /\.json[cl]?$/.test(path) ? json() : [];
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: content,
        extensions: [basicSetup, language, EditorState.readOnly.of(true), EditorView.editable.of(false), coverage,
          labels.current.of([EditorView.contentAttributes.of({ "aria-label": t("codeMap.code.current", { path }), tabindex: "0" }), EditorState.phrases.of(editorPhrases())]),
          EditorView.theme({ "&": { backgroundColor: "var(--surface)", color: "var(--text)" },
            ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "12px", lineHeight: "1.8" },
            ".cm-gutters": { backgroundColor: "var(--surface-alt)", color: "var(--muted)", borderRight: "1px solid var(--border)" },
            ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--surface-alt)" },
            ".cm-coverage-exact": { backgroundColor: "var(--code-exact)", borderLeft: "2px solid var(--accent)" },
            ".cm-coverage-near": { backgroundColor: "var(--code-near)", borderLeft: "2px dashed var(--near)" },
            ".cm-cursor": { borderLeftColor: "var(--accent)" },
          }, { dark: theme === "dark" }),
        ],
      }),
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, [content, path, exact, near, theme]);
  useEffect(() => {
    view.current?.dispatch({ effects: labels.current.reconfigure([
      EditorView.contentAttributes.of({ "aria-label": t("codeMap.code.current", { path }), tabindex: "0" }), EditorState.phrases.of(editorPhrases()),
    ]) });
    if (host.current) localizeEditorControls(host.current);
  }, [displayLanguage, path]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || jumpLine === undefined) return;
    const line = editor.state.doc.line(Math.max(1, Math.min(jumpLine, editor.state.doc.lines)));
    editor.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    editor.focus();
  }, [jumpLine, content, exact, near]);
  return <div ref={host} className="code-viewer" />;
}
