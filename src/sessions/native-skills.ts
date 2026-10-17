import { isAbsolute, join } from "node:path";
import type { SessionResource } from "../session-contracts.js";
import { normalizeHistoryPath } from "../history/adapters/common.js";
import { object, string } from "./parser-usage.js";

function skillDirectoryBody(body: string): string | undefined {
  const expanded = /^\s*Base directory for this skill:\s*([^\n]+)\r?\n\s*\n([\s\S]+)$/.exec(body);
  const directory = expanded ? normalizeHistoryPath(expanded[1]!.trim()) : undefined;
  return directory && isAbsolute(directory) && expanded![2]!.trim() ? join(directory, "SKILL.md") : undefined;
}

/** 只采用客户端明确标记的完整指令注入，不从用户提及或任意 XML 示例推断使用。 */
export function codexSkillInstructions(body: string, kinds: unknown): SessionResource[] {
  if (!Array.isArray(kinds) || !kinds.length || kinds.some(kind => kind !== "skills.selected_skill_instructions")) return [];
  const resources: SessionResource[] = [];
  let rest = body.trim();
  while (rest) {
    const match = /^<skill>\s*<name>([^<>\n]+)<\/name>\s*<path>([^<>\n]+)<\/path>([\s\S]*?)<\/skill>/.exec(rest);
    if (!match) return [];
    const name = match[1]!.trim(), path = normalizeHistoryPath(match[2]!.trim());
    if (!name || !path || !isAbsolute(path) || !/(?:^|[/\\])SKILL\.md$/.test(path) || !match[3]!.trim()) return [];
    resources.push({ kind: "skill_read", name, path });
    rest = rest.slice(match[0].length).trim();
  }
  return [...new Map(resources.map(resource => [JSON.stringify(resource), resource])).values()];
}

/** CLI 的触发、隐藏命令与正文共享 parentUuid 链，只在正文处计一次。 */
export class CliSkillInstructions {
  private readonly records = new Map<string, { name: string; command?: boolean; bodyId?: string }>();

  read(record: Record<string, unknown>, body: string): SessionResource | undefined {
    if (record.type !== "message" || record.role !== "user" || record.entrypoint !== "cli") return undefined;
    const id = string(record.uuid), parent = string(record.parentUuid);
    if (!id) return undefined;
    const hidden = record.hidden === true;
    const origin = string(object(object(record.metadata).origin).kind);
    const trigger = !hidden && origin === "command-input" ? /^\/([^\s<>]+)(?:\s|$)/.exec(body.trim()) : undefined;
    if (trigger) this.save(id, { name: trigger[1]! });
    const previous = parent ? this.records.get(parent) : undefined;
    const command = hidden && record.isMeta === true ? /^<command-message>([^<>\n]+)<\/command-message>\s*<command-name>\/([^<>\n]+)<\/command-name>(?:\s*<command-args>[\s\S]*<\/command-args>)?\s*$/.exec(body.trim()) : undefined;
    if (command && previous && !previous.command && command[1] === previous.name && command[2] === previous.name) this.save(id, { name: previous.name, command: true });
    if (!hidden || !previous?.command || previous.bodyId && previous.bodyId !== id) return undefined;
    const path = skillDirectoryBody(body);
    if (!path) return undefined;
    previous.bodyId = id;
    return { kind: "skill_read", name: previous.name, path };
  }

  private save(id: string, record: { name: string; command?: boolean }) {
    if (this.records.has(id)) return;
    this.records.set(id, record);
    if (this.records.size > 1024) this.records.delete(this.records.keys().next().value!);
  }
}
