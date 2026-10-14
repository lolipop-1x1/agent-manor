import type { Client } from "../clients.js";
import { createHash } from "node:crypto";
import type { ResourceKind } from "../resource-contracts.js";
import type { NativeResourceRule, ResourceInventoryDiagnostic, ResourceInventoryEntry, ResourceInventoryGap, ResourceSourceFormat } from "../resource-inventory-contracts.js";
import type { InventorySourcePlan } from "./codeflicker-inventory.js";

export const nativeClients = ["gemini", "qwen", "kimi", "omp", "grok", "reasonix", "codewhale"] as const;
export type NativeClient = typeof nativeClients[number];
export interface NativeResourceState {
  nativeState: ResourceInventoryEntry["nativeState"];
  invocationMode?: ResourceInventoryEntry["invocationMode"];
  rule?: NativeResourceRule;
  controlPath?: string;
}
/** 仅在扫描内存中保存原生选择规则，配置正文与回调不会投影到公开快照。 */
export interface NativeInventoryMetadata {
  priority: number;
  namespace?: string;
  nameFor?: (rawName: string) => string;
  acceptsSkill?: (frontmatter: Record<string, unknown> | undefined, path: string) => boolean;
  skillNameFor?: (frontmatter: Record<string, unknown> | undefined, path: string, text: string) => string | undefined;
  collisionNamespace?: string;
  collisionPolicy?: "omp-skill";
  direct?: boolean;
  containmentRoot?: string;
  depth?: number;
  skipRootSkill?: boolean;
  scanRootAndChildren?: boolean;
  frontmatterByName?: Map<string, Record<string, unknown>>;
  dependencyPaths: string[];
  eligibleFor?: (project?: string) => boolean | undefined;
  stateFor: (name: string, project?: string, frontmatter?: Record<string, unknown>) => NativeResourceState;
  rows?: { name: string; value: Record<string, unknown>; keyPath: string[] }[];
  registrationWritable?: boolean;
}
export interface NativePlannerOptions {
  userHome: string;
  projects: string[];
  environment: Readonly<Record<string, string | undefined>>;
  add: (client: Client, kind: ResourceKind, path: string, format: ResourceSourceFormat, extra?: Partial<InventorySourcePlan>) => InventorySourcePlan;
  parseConfig: (path: string, format: ResourceSourceFormat) => Promise<Record<string, unknown> | undefined>;
  gaps: ResourceInventoryGap[];
  diagnostics: ResourceInventoryDiagnostic[];
}

/** 同名选择分别按工作区计算；只留下能被至少一个已知上下文选中的入口。 */
export function projectNativeEntries(entries: ResourceInventoryEntry[], sources: InventorySourcePlan[], projects: string[], diagnostics: ResourceInventoryDiagnostic[]): ResourceInventoryEntry[] {
  const plans = new Map(sources.map(source => [source.id, source]));
  const native = entries.filter(entry => plans.get(entry.sourceId)?.native);
  const selected = new Map<string, ResourceInventoryEntry>();
  for (const project of [undefined, ...projects]) {
    const groups = new Map<string, ResourceInventoryEntry[]>();
    for (const entry of native) {
      if (entry.project && entry.project !== project) continue;
      if (plans.get(entry.sourceId)!.native!.eligibleFor?.(project) === false) continue;
      const key = JSON.stringify([entry.client, entry.kind, entry.name]);
      groups.set(key, [...groups.get(key) ?? [], entry]);
    }
    for (const values of groups.values()) {
      values.sort((left, right) => plans.get(right.sourceId)!.native!.priority - plans.get(left.sourceId)!.native!.priority);
      const winner = values[0]!;
      const retain = (candidate: ResourceInventoryEntry, name = candidate.name) => {
        const plan = plans.get(candidate.sourceId)!; const state = plan.native!.stateFor(name, project, plan.native!.frontmatterByName?.get(candidate.name));
        const id = name === candidate.name ? candidate.id : `${candidate.id}:${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
        let entry = selected.get(id);
        if (!entry) {
          entry = { ...candidate, id, name, nativeState: name === candidate.name ? candidate.nativeState : state.nativeState,
            selectionScopes: [], nativeNames: [...new Set([...(candidate.nativeNames ?? []), name])],
            locator: { ...candidate.locator, nativeRule: !candidate.protected ? state.rule : undefined, controlPath: state.controlPath,
              nativeControl: !candidate.protected && state.rule ? "native-rule" : undefined } };
          selected.set(id, entry);
        }
        entry.selectionScopes!.push({ scope: project ? "project" : "user", project, nativeState: state.nativeState, invocationMode: state.invocationMode ?? candidate.invocationMode, controlPath: state.controlPath });
      };
      retain(winner);
      const fingerprints = new Set([winner.contentFingerprint]);
      const aliases = new Map<string, number>();
      for (const shadow of values.slice(1)) {
        const metadata = plans.get(shadow.sourceId)!.native!;
        if (metadata.collisionPolicy === "omp-skill" && shadow.contentFingerprint && !fingerprints.has(shadow.contentFingerprint)) {
          fingerprints.add(shadow.contentFingerprint);
          const alias = `${metadata.collisionNamespace ?? "omp"}/${shadow.name}`;
          const count = (aliases.get(alias) ?? 0) + 1; aliases.set(alias, count);
          retain(shadow, count === 1 ? alias : `${alias}~${count}`);
        } else diagnostics.push({ sourceId: shadow.sourceId, client: shadow.client, kind: shadow.kind, scope: project ? "project" : "user", project,
          reason: "shadowed", name: shadow.name, path: shadow.entryPath, selectedPath: winner.entryPath, selectedEntryId: winner.id });
      }
    }
  }
  return [...entries.filter(entry => !plans.get(entry.sourceId)?.native), ...selected.values()];
}
