import { unified } from "unified";
import remarkParse from "remark-parse";

const parser = unified().use(remarkParse);
type TextNode = { type: string; value?: string; alt?: string; children?: TextNode[] };

/** 目录只提取可读文字；技能正文仍完整保留在原始轮次中。 */
export function questionPreview(question: string): { text: string; skills: string[] } {
  const skills: string[] = [];
  const prose = question.replace(/<skill\b[^>]*>[\s\S]*?(?:<\/skill>|$)/gi, block => {
    const name = block.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1];
    if (name && !skills.includes(name)) skills.push(name);
    // 无法识别的 XML 不作为技能注入删除。
    return name ? " " : block;
  });
  const read = (node: TextNode): string => {
    if (node.type === "image") return node.alt ?? "";
    if (node.type === "html") return node.value?.replace(/<[^>]*>/g, " ") ?? "";
    if (node.value !== undefined) return node.value;
    return (node.children ?? []).map(read).join(["root", "list", "listItem", "blockquote"].includes(node.type) ? " " : "");
  };
  const text = read(parser.parse(prose) as TextNode).replace(/\s+/g, " ").trim();
  return { text, skills };
}
