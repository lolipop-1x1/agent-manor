import { useEffect, useMemo, useState } from "react";
import { CaretDown, CaretRight, Folder, MapTrifold } from "@phosphor-icons/react";
import type { FileCoverage } from "../src/contracts";
import { t, useI18n } from "./i18n";
import { directoryTree, filename, fmt, type DirectoryNode } from "./model";

export function DirectoryTree({ files, selected, browse }: {
  files: FileCoverage[]; selected: string; browse: (path: string) => void;
}) {
  useI18n();
  const tree = useMemo(() => directoryTree(files), [files]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    // 地图与面包屑也能选择深层目录，让它在目录树中保持可见。
    const parts = selected.split("/");
    setExpanded(current => {
      const next = new Set(current);
      for (let i = 1; i < parts.length; i += 1) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  }, [selected]);
  const toggle = (path: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const branch = (nodes: DirectoryNode[]) => <ul className="directory-branch">{nodes.map(node => {
    const open = expanded.has(node.path);
    const childrenId = `directory-${encodeURIComponent(node.path)}`;
    return <li key={node.path}>
      <div className={`directory-row${selected === node.path ? " active" : ""}`}>
        {node.children.length ? <button className="directory-toggle" aria-label={t(open ? "codeMap.directory.collapse" : "codeMap.directory.expand", { path: node.path })} aria-expanded={open} aria-controls={childrenId} onClick={() => toggle(node.path)}>{open ? <CaretDown size={12} /> : <CaretRight size={12} />}</button> : <span className="directory-toggle-spacer" />}
        <button className="directory-select" aria-label={t("codeMap.directory.select", { path: node.path })} aria-current={selected === node.path ? "location" : undefined} onClick={() => browse(node.path)} title={node.path}><Folder size={15} /><span>{filename(node.path)}</span><small>{fmt(node.count)}</small></button>
      </div>
      {node.children.length > 0 && <div id={childrenId} hidden={!open}>{open && branch(node.children)}</div>}
    </li>;
  })}</ul>;
  return <nav className="directory-nav" aria-label={t("codeMap.repository.directories")}>
    <div className={`directory-row${!selected ? " active" : ""}`}><button className="directory-select directory-root" aria-current={!selected ? "location" : undefined} onClick={() => browse("")}><MapTrifold size={17} /><span>{t("codeMap.directory.root")}</span><small>{fmt(files.length)}</small></button></div>
    {branch(tree)}
  </nav>;
}
