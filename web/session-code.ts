import { unified } from "unified";
import remarkParse from "remark-parse";

type MarkdownNode = { type: string; value?: string; position?: { start: { offset?: number } }; children?: MarkdownNode[] };
const parser = unified().use(remarkParse);

/** 与阅读区采用同一 Markdown 解析规则，取完整代码，保留引用和列表的嵌套语义。 */
export function completeCodeBlocks(source: string): Map<number, string> {
  const blocks = new Map<number, string>();
  const visit = (node: MarkdownNode) => {
    if (node.type === "code" && node.position?.start.offset !== undefined) blocks.set(node.position.start.offset, `${node.value ?? ""}\n`);
    for (const child of node.children ?? []) visit(child);
  };
  visit(parser.parse(source));
  return blocks;
}
