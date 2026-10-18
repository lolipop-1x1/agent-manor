import type { KnowledgeDraft } from "../knowledge-contracts.js";

export const knowledgeRelations = ["duplicate", "complement", "correction", "conflict", "related", "independent"] as const;
export type KnowledgeRelation = typeof knowledgeRelations[number];
export interface TopicCandidate extends KnowledgeDraft {
  topic: string;
  topicId?: string;
  candidateId?: string;
  relation?: KnowledgeRelation;
  relatedCandidateId?: string;
  references: string[];
}
export interface KnowledgeTopicCard { id: string; label: string; summary: string; applicability?: string; candidates: { id: string; title: string; summary: string }[] }

const stopWords = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "when", "then", "are", "was", "were", "have", "has", "will", "should", "can", "not", "use", "used", "using", "each", "only", "must", "after", "before", "during", "same", "other", "its", "their", "they", "these", "those", "been", "being", "such", "through", "than", "more", "most", "does", "without", "which"]);
function terms(value: string): Set<string> {
  const lower = value.toLowerCase(), result = new Set((lower.match(/[a-z0-9_./:-]{2,}/g) ?? []).filter(term => !stopWords.has(term)));
  for (const run of lower.match(/[\u3400-\u9fff]{2,}/g) ?? []) for (let index = 0; index < run.length - 1; index++) result.add(run.slice(index, index + 2));
  return result;
}
export function topicText(candidate: KnowledgeDraft & { topic?: string }): string {
  return [candidate.topic, candidate.title, candidate.summary, candidate.body.slice(0, 1800), candidate.applicability, ...(candidate.tags ?? [])].filter(Boolean).join(" ");
}
/** 相似度只排序可比较项，任何分数都不直接触发内容合并。 */
export function topicRelevance(candidate: KnowledgeDraft & { topic?: string }, other: KnowledgeDraft & { topic?: string }): number {
  if (candidate.scope.kind !== other.scope.kind || candidate.scope.project !== other.scope.project) return 0;
  const left = terms(topicText(candidate)), right = terms(topicText(other));
  const overlap = [...left].filter(item => right.has(item)).length;
  const sameTopic = candidate.topic && other.topic && candidate.topic.trim().toLowerCase() === other.topic.trim().toLowerCase();
  const sameTitle = candidate.title.trim().toLowerCase() === other.title.trim().toLowerCase();
  return sameTopic || sameTitle ? 1 : overlap / Math.max(1, Math.min(left.size, right.size));
}
export function knowledgeTopicCards(candidates: readonly TopicCandidate[], text: string, scope: KnowledgeDraft["scope"]): KnowledgeTopicCard[] {
  const query: KnowledgeDraft = { title: text.slice(0, 240), body: text.slice(0, 10_000), scope };
  const ranked = candidates.map((candidate, index) => ({ candidate, score: topicRelevance(query, candidate), index })).sort((a, b) => b.score - a.score || b.index - a.index);
  const cards = new Map<string, KnowledgeTopicCard>();
  for (const { candidate } of ranked) {
    if (!candidate.topicId || !candidate.candidateId) continue;
    if (!cards.has(candidate.topicId)) {
      if (cards.size >= 6) continue;
      cards.set(candidate.topicId, { id: candidate.topicId, label: candidate.topic, summary: (candidate.summary ?? candidate.body).slice(0, 320), applicability: candidate.applicability?.slice(0, 240), candidates: [] });
    }
    const card = cards.get(candidate.topicId)!;
    if (card.candidates.length < 3) card.candidates.push({ id: candidate.candidateId, title: candidate.title, summary: (candidate.summary ?? candidate.body).slice(0, 240) });
  }
  return [...cards.values()];
}
