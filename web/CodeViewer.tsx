import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorState, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import type { LineRange } from "../src/contracts";
import type { Theme } from "./model";

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
          EditorView.contentAttributes.of({ "aria-label": `当前代码：${path}`, tabindex: "0" }),
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
    const editor = view.current;
    if (!editor || jumpLine === undefined) return;
    const line = editor.state.doc.line(Math.max(1, Math.min(jumpLine, editor.state.doc.lines)));
    editor.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    editor.focus();
  }, [jumpLine, content, exact, near]);
  return <div ref={host} className="code-viewer" />;
}
