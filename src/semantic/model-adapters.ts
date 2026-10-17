import type { SemanticConnection } from "../semantic-contracts.js";

/** 只匹配明确支持的模型名；未知模型保持服务默认输入格式。 */
export function automaticModelPrefixes(model: string): Pick<SemanticConnection, "documentPrefix" | "queryPrefix"> {
  const name = model.trim().toLowerCase();
  if (/^(?:(?:qwen|library)\/)?qwen3-embedding(?:-(?:0\.6b|4b|8b))?(?::[^/]+)?$/.test(name)) {
    return { documentPrefix: "", queryPrefix: "Instruct: Retrieve past conversations relevant to the search query.\nQuery:" };
  }
  if (/^(?:intfloat\/)?multilingual-e5-(?:small|base|large)(?::[^/]+)?$/.test(name)) {
    return { documentPrefix: "passage: ", queryPrefix: "query: " };
  }
  const bge = /^(?:baai\/)?bge-(?:small|base|large)-(en|zh)-v1\.5(?::[^/]+)?$/.exec(name);
  if (bge) return { documentPrefix: "", queryPrefix: bge[1] === "zh" ? "为这个句子生成表示以用于检索相关文章：" : "Represent this sentence for searching relevant passages: " };
  if (/^(?:(?:nomic-ai|library)\/)?nomic-embed-text(?:-v1\.5)?(?::[^/]+)?$/.test(name)) {
    return { documentPrefix: "search_document: ", queryPrefix: "search_query: " };
  }
  return { documentPrefix: "", queryPrefix: "" };
}

/** 已保存的前缀就是编码规则快照，升级或修改调用策略时不能重新推导。 */
export function resolveModelConnection(connection: SemanticConnection, previous?: SemanticConnection): SemanticConnection {
  const same = previous?.model && connection.url.trim() === previous.url.trim() && connection.model.trim() === previous.model.trim();
  const prefixes = same ? { documentPrefix: previous.documentPrefix, queryPrefix: previous.queryPrefix } : automaticModelPrefixes(connection.model);
  return { ...connection, ...prefixes };
}
